#!/usr/bin/env python3
"""Weft's link reader: what a shared link points to, for the app and for `weft read/search`.

  GET /_links/resolve?url=<link>   the link as one normalized result (see `result()`), for Karchi's token only
  GET /_links/image?url=<image>    a preview image that a resolved result named (no open proxy)

It reads only what anyone may read without logging in: YouTube and TikTok oEmbed, X's publish oEmbed, YouTube's
watch page for the description and the caption languages, TikTok's video page for the caption, author and subtitles
(read when TikTok hands them out), and the Open Graph tags of any other page (Instagram,
Facebook, the web). Nothing is fetched unless a message with the link is shown or read; there is no polling.

Every fetch goes through `fetch()`: http(s) on ports 80/443 only, every address the name resolves to must be public
(no localhost, private, link-local or reserved ranges), the connection is pinned to the checked address, each of at
most 5 redirects is checked again, the whole fetch ends within 8 s and reads at most a capped number of bytes.
Results are cached (a day, failures half an hour), a link asked for twice at once is fetched once, and fetches are
limited per minute overall and per host.
"""
import html
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "common"))
import weft_users

PORT = int(os.environ.get("LINKS_PORT", "29329"))
HS = os.environ.get("LINKS_HS", "http://127.0.0.1:8008")
OWNER = os.environ.get("LINKS_OWNER", "")  # the owner's Matrix ID, from ~/.config/weft/weft.env on asus; the service needs it
UA = "Mozilla/5.0 (X11; Linux x86_64) WeftLinkReader/1.0"
DEADLINE = 8.0          # seconds for one fetch, redirects included
MAX_REDIRECTS = 5
PAGE_CAP = 2_500_000    # bytes read from a page (YouTube's watch page is about 1.4 MB)
JSON_CAP = 300_000
IMAGE_CAP = 3_000_000
TTL_OK, TTL_FAIL = 24 * 3600, 1800
CACHE_MAX = 2000
RATE_ALL, RATE_HOST = 30, 8   # fetch starts per minute
RATE_PERSON = 10              # fetch starts per minute of one person other than the owner, so nobody uses up RATE_ALL


class Refused(Exception):
    """A URL this reader will not fetch (scheme, port, a non-public address)."""


class TooBig(Exception):
    pass


# ------------------------------------------------------------------ safe fetch

NAT64, NAT64_LOCAL = ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("64:ff9b:1::/48")


def lookup(host, port, left):
    """getaddrinfo within `left` seconds. It cannot be cancelled, so a slow lookup finishes in a thread nobody waits for."""
    out = {}

    def run():
        try:
            out["infos"] = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except Exception as e:  # also UnicodeError: an IDN label over 63 characters
            out["error"] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(max(left, 0))
    if t.is_alive():
        raise TimeoutError("timed out")
    if "error" in out:
        raise OSError(f"name not found: {host}") from out["error"]
    return out["infos"]


def public_addresses(host, port, left=10.0):
    """Every address `host` resolves to (within `left` seconds), or Refused when any of them is not on the public internet."""
    infos = lookup(host, port, left)
    addrs = []
    for family, _, _, _, sockaddr in infos:
        ip = ipaddress.ip_address(sockaddr[0].split("%")[0])
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        # NAT64 (64:ff9b::/96 and the local 64:ff9b:1::/48) carries an IPv4 address in its last 32 bits.
        if ip.version == 6 and (ip in NAT64 or ip in NAT64_LOCAL):
            if ip in NAT64_LOCAL:
                raise Refused(f"{host} nie je verejná adresa")
            ip = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
        if not ip.is_global or ip.is_multicast:
            raise Refused(f"{host} nie je verejná adresa")
        addrs.append((family, sockaddr))
    if not addrs:
        raise OSError(f"name not found: {host}")
    return addrs


def ascii_url(url):
    """The address as a browser writes it (WHATWG URL.href, as Weft's app sends it): the host lowercased and an IDN
    one in punycode, the default port dropped, non-ASCII and unsafe characters percent-encoded. ValueError if bad."""
    p = urllib.parse.urlsplit(url)
    scheme, host = p.scheme.lower(), p.hostname or ""
    try:
        host = host.lower() if host.isascii() else host.encode("idna").decode("ascii")
    except UnicodeError as e:
        raise ValueError(f"bad host: {e}") from None
    if ":" in host:
        host = f"[{host}]"
    port = p.port  # ValueError for a port that is not a number
    netloc = host + (f":{port}" if port is not None and port != {"http": 80, "https": 443}.get(scheme) else "")
    if "@" in p.netloc:
        netloc = p.netloc.rsplit("@", 1)[0] + "@" + netloc
    enc = lambda s, unsafe: "".join(c if c.isascii() and c > " " and c not in unsafe else urllib.parse.quote(c, safe="") for c in s)
    return urllib.parse.urlunsplit((scheme, netloc, enc(p.path or "/", '"<>`{}'), enc(p.query, "\"<>'"), enc(p.fragment, '"<>`')))


def check_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise Refused("iba odkazy http a https")
    if u.username or u.password:
        raise Refused("odkaz s menom a heslom")
    port = u.port or (443 if u.scheme == "https" else 80)
    if port not in (80, 443):
        raise Refused("iba štandardné webové porty")
    return u, port


class Pinned(http.client.HTTPSConnection):
    """An HTTP(S) connection to an address checked beforehand; TLS still verifies the host name. Connecting and the
    TLS handshake share the fetch's deadline (`end`); `late` is set by fetch()'s watchdog once it has passed."""

    def __init__(self, host, port, sockaddr, family, tls, end, late):
        super().__init__(host, port, timeout=max(0.01, end - time.monotonic()), context=ssl.create_default_context())
        self.sockaddr, self.family, self.tls, self.end, self.late = sockaddr, family, tls, end, late

    def connect(self):
        left = lambda: max(0.01, self.end - time.monotonic())
        sock = socket.socket(self.family, socket.SOCK_STREAM)
        sock.settimeout(left())
        sock.connect(self.sockaddr)
        if self.tls:
            sock.settimeout(left())
            sock = self._context.wrap_socket(sock, server_hostname=self.host)
        sock.settimeout(left())
        self.sock = sock
        # The watchdog may have fired while there was no socket to shut yet.
        if self.late.is_set() or time.monotonic() >= self.end:
            raise TimeoutError("timed out")


def fetch(url, cap=PAGE_CAP, accept="text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", connect=None):
    """GET `url` safely: (final url, status, content type, body). `connect(url, sockaddr)` replaces the socket in tests;
    the address checks run either way."""
    end = time.monotonic() + DEADLINE
    for _ in range(MAX_REDIRECTS + 1):
        try:
            url = ascii_url(url)
        except ValueError as e:
            raise Refused("neplatná adresa") from e
        u, port = check_url(url)
        left = end - time.monotonic()
        if left <= 0:
            raise TimeoutError("timed out")
        family, sockaddr = public_addresses(u.hostname, port, left)[0]
        if connect:  # tests: the checked address and the URL, answered without a network
            status, headers, body = connect(url, sockaddr)
        else:
            # A page that trickles its bytes never trips the socket's own timeout: at the deadline the socket shuts.
            late = threading.Event()
            conn = Pinned(u.hostname, port, sockaddr, family, u.scheme == "https", end, late)

            def cut(conn=conn):
                late.set()
                try:
                    if conn.sock: conn.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            watchdog = threading.Timer(left, cut)
            watchdog.daemon = True
            watchdog.start()
            try:
                path = urllib.parse.urlunsplit(("", "", u.path or "/", u.query, ""))
                conn.request("GET", path, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "sk,en;q=0.8",
                                                   "Accept-Encoding": "identity", "Host": u.netloc})
                resp = conn.getresponse()
                status, headers = resp.status, {k.lower(): v for k, v in resp.getheaders()}
                body = b""
                if not 300 <= status < 400:
                    length = int(headers.get("content-length") or 0)
                    if length > cap:
                        raise TooBig("too big")
                    while len(body) <= cap:
                        if time.monotonic() > end:
                            raise TimeoutError("timed out")
                        chunk = resp.read1(65536)
                        if not chunk:
                            break
                        body += chunk
            except (OSError, http.client.HTTPException):
                if late.is_set():
                    raise TimeoutError("timed out") from None
                raise
            finally:
                watchdog.cancel()
                conn.close()
            if late.is_set():
                raise TimeoutError("timed out")
        if 300 <= status < 400 and headers.get("location"):
            url = urllib.parse.urljoin(url, headers["location"])
            continue
        if len(body) > cap:
            raise TooBig("too big")
        return url, status, headers.get("content-type", ""), body
    raise Refused("priveľa presmerovaní")


# ------------------------------------------------------------------ what a link is

def classify(url):
    """(platform, kind) from the address alone."""
    try:
        u = urllib.parse.urlsplit(url)
        host = (u.hostname or "").lower()
    except ValueError:  # "http://[::1" and other broken brackets: an ordinary page that will fail to load
        return "web", "page"
    host = host.removeprefix("www.").removeprefix("m.")
    parts = [p for p in u.path.split("/") if p]
    if host in ("instagram.com", "instagr.am"):
        if parts[:1] in (["p"],):
            return "instagram", "post"
        if parts[:1] in (["reel"], ["reels"], ["tv"]):
            return "instagram", "reel"
        if parts[:1] == ["stories"]:
            return "instagram", "story"
        return "instagram", "profile" if parts else "page"
    if host in ("youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"):
        if host == "youtu.be" or parts[:1] in (["watch"], ["live"], ["embed"]):
            return "youtube", "video"
        if parts[:1] == ["shorts"]:
            return "youtube", "short"
        return "youtube", "profile" if parts and (parts[0].startswith("@") or parts[0] in ("channel", "c", "user")) else "page"
    if host in ("vm.tiktok.com", "vt.tiktok.com") or (host == "tiktok.com" and parts[:1] == ["t"]):
        return "tiktok", "short_link"
    if host == "tiktok.com":
        if len(parts) >= 3 and parts[1] in ("video", "photo"):
            return "tiktok", "video" if parts[1] == "video" else "post"
        return "tiktok", "profile" if parts[:1] and parts[0].startswith("@") else "page"
    if host in ("facebook.com", "fb.com", "fb.watch", "web.facebook.com"):
        if host == "fb.watch" or "videos" in parts or parts[:1] in (["watch"], ["reel"]):
            return "facebook", "video"
        if parts[:1] in (["share"],) or "posts" in parts or parts[:1] == ["permalink.php"]:
            return "facebook", "post"
        return "facebook", "profile" if parts else "page"
    if host in ("x.com", "twitter.com", "mobile.twitter.com"):
        return "x", "post" if "status" in parts else "profile" if parts else "page"
    return "web", "page"


def youtube_id(url):
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    parts = [p for p in u.path.split("/") if p]
    if host.endswith("youtu.be") and parts:
        return parts[0]
    if parts[:1] in (["shorts"], ["live"], ["embed"]) and len(parts) > 1:
        return parts[1]
    return urllib.parse.parse_qs(u.query).get("v", [""])[0]


class MetaParser:
    """Open Graph / Twitter card / <title> / description from the head of an HTML page."""
    META = re.compile(r"""<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>""", re.I)  # a quoted ">" does not end the tag
    ATTR = re.compile(r"""([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))""")
    TITLE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)

    @classmethod
    def parse(cls, text):
        head = text[:600_000]
        out = {}
        for tag in cls.META.findall(head):
            attrs = {m.group(1).lower(): html.unescape(m.group(3) or m.group(4) or m.group(5) or "") for m in cls.ATTR.finditer(tag)}
            key = (attrs.get("property") or attrs.get("name") or "").lower()
            if key and "content" in attrs and key not in out:
                out[key] = attrs["content"].strip()
        t = cls.TITLE.search(head)
        if t:
            out.setdefault("title", html.unescape(re.sub(r"\s+", " ", t.group(1))).strip())
        return out


def clean(text, most=2000):
    text = re.sub(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]", "", str(text or ""))
    return text.strip()[:most]


def safe_link(url):
    try:
        check_url(url)
        return url
    except Refused:
        return ""


def result(url, **kw):
    platform, kind = classify(url)
    out = {"url": url, "final_url": url, "platform": platform, "kind": kind, "author": None, "title": "", "description": "",
           "image": "", "captions": None, "playable": False, "source": "", "status": "ok", "reason": "", "fetched_at": int(time.time())}
    out.update(kw)
    for k in ("title", "description"):
        out[k] = clean(out[k], 300 if k == "title" else 2000)
    if out["author"]:
        out["author"] = {"name": clean(out["author"].get("name"), 200), "url": safe_link(out["author"].get("url") or "")}
    out["image"] = safe_link(out["image"] or "")
    return out


def get_json(url, fetcher):
    final, status, ctype, body = fetcher(url, JSON_CAP, "application/json")
    if status != 200:
        return status, None
    try:
        return status, json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return status, None


def from_page(url, fetcher, source="opengraph"):
    final, status, ctype, body = fetcher(url, PAGE_CAP, "text/html,application/xhtml+xml")
    platform, kind = classify(final)
    if status in (404, 410):
        return result(url, final_url=final, status="not_found", reason="Stránka neexistuje alebo bola odstránená.", source=source)
    if status in (401, 403):
        return result(url, final_url=final, status="private", reason="Stránka sa ukazuje iba prihláseným.", source=source)
    if status != 200 or "html" not in ctype.lower():
        return result(url, final_url=final, status="unavailable", reason=f"Stránka odpovedala {status} ({ctype or 'bez typu'}).", source=source)
    meta = MetaParser.parse(body.decode("utf-8", "replace"))
    title = meta.get("og:title") or meta.get("twitter:title") or meta.get("title", "")
    desc = meta.get("og:description") or meta.get("twitter:description") or meta.get("description", "")
    image = urllib.parse.urljoin(final, meta.get("og:image") or meta.get("twitter:image") or "") if (meta.get("og:image") or meta.get("twitter:image")) else ""
    out = result(url, final_url=final, title=title, description=desc, image=image, source=source)
    out["platform"], out["kind"] = platform, kind if kind != "short_link" else out["kind"]
    if platform in ("instagram", "facebook") and not (meta.get("og:title") or meta.get("og:description")):
        out.update(status="private", reason=f"{'Instagram' if platform == 'instagram' else 'Facebook'} tento obsah bez prihlásenia neukáže (súkromný, zmazaný alebo za prihlásením).")
    elif not (title or desc):
        out.update(status="partial", reason="Stránka nemá názov ani popis.")
    return out


def youtube(url, fetcher):
    vid = youtube_id(url)
    status, data = get_json("https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(url, safe=""), fetcher)
    if status in (401, 403):
        return result(url, status="private", reason="Video je súkromné alebo sa nedá vložiť.", source="oembed")
    if status in (400, 404) or not data:
        return result(url, status="not_found", reason="YouTube také video nepozná (zmazané alebo nesprávny odkaz).", source="oembed")
    out = result(url, title=data.get("title", ""), author={"name": data.get("author_name", ""), "url": data.get("author_url", "")},
                 image=data.get("thumbnail_url", ""), source="oembed")
    # The watch page carries the description and which caption tracks exist; the tracks themselves need a browser.
    try:
        if vid and re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid):
            _, st, _, body = fetcher(f"https://www.youtube.com/watch?v={vid}", PAGE_CAP, "text/html")
            m = re.search(rb"ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var |</script>)", body)
            if st == 200 and m:
                player = json.loads(m.group(1).decode("utf-8", "replace"))
                details = player.get("videoDetails") or {}
                out["description"] = clean(details.get("shortDescription", ""), 2000)
                out["source"] = "oembed+watch-page"
                tracks = ((player.get("captions") or {}).get("playerCaptionsTracklistRenderer") or {}).get("captionTracks") or []
                langs = [f"{t.get('languageCode')}{' (auto)' if t.get('kind') == 'asr' else ''}" for t in tracks if t.get("languageCode")]
                out["captions"] = {"state": "listed" if langs else "none", "languages": langs[:8], "text": ""}
    except Exception:
        pass
    if out["captions"] is None:
        out["captions"] = {"state": "unknown", "languages": [], "text": ""}
    return out


def vtt_text(raw, most=4000):
    """The words of a WebVTT file, without its header, cue numbers, timings and tags."""
    lines = []
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line or line == "WEBVTT" or "-->" in line or line.isdigit() or line.startswith(("NOTE", "Kind:", "Language:")):
            continue
        line = re.sub(r"<[^>]+>", "", line)
        if not lines or lines[-1] != line:
            lines.append(line)
    return clean(" ".join(lines), most)


def tiktok(url, fetcher):
    """TikTok's video page carries the caption, author, cover and subtitle tracks (its oEmbed no longer has them)."""
    final, status, ctype, body = fetcher(url, PAGE_CAP, "text/html")
    final = final.split("?")[0]
    kind = classify(final)[1]
    if kind not in ("video", "post"):
        return from_page(final, fetcher) | {"url": url}
    m = re.search(rb'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', body, re.S)
    detail = {}
    if status == 200 and m:
        try:
            detail = (json.loads(m.group(1)).get("__DEFAULT_SCOPE__") or {}).get("webapp.video-detail") or {}
        except ValueError:
            detail = {}
    item = (detail.get("itemInfo") or {}).get("itemStruct") or {}
    if detail and detail.get("statusCode") not in (0, None) and not item:
        return result(url, final_url=final, status="not_found" if detail.get("statusCode") == 10204 else "private",
                      reason="TikTok video neukáže (zmazané, súkromné alebo obmedzené).", source="video-page")
    if not item:
        st, data = get_json("https://www.tiktok.com/oembed?url=" + urllib.parse.quote(final, safe=""), fetcher)
        if not data or not (data.get("title") or data.get("author_name")):
            return result(url, final_url=final, status="unavailable", reason="TikTok o videu bez prihlásenia nič nepovedal.", source="oembed")
        out = result(url, final_url=final, title=data.get("title", ""), author={"name": data.get("author_name", ""), "url": data.get("author_url", "")},
                     image=data.get("thumbnail_url", ""), source="oembed")
        out["kind"], out["captions"] = kind, {"state": "unknown", "languages": [], "text": ""}
        return out
    author = item.get("author") or {}
    video = item.get("video") or {}
    out = result(url, final_url=final, title=item.get("desc", ""), image=video.get("cover") or video.get("originCover") or "",
                 author={"name": author.get("nickname") or author.get("uniqueId", ""), "url": f"https://www.tiktok.com/@{author['uniqueId']}" if author.get("uniqueId") else ""},
                 source="video-page")
    out["kind"] = kind
    subs = [x for x in video.get("subtitleInfos") or [] if isinstance(x, dict) and x.get("Url")]
    langs = [f"{x.get('LanguageCodeName')}{' (auto)' if x.get('Source') in ('ASR', 'MT') else ''}" for x in subs]
    out["captions"] = {"state": "listed" if subs else "none", "languages": langs[:8], "text": ""}
    # The speaker's own language (speech recognition) before a machine translation.
    pick = next((x for x in subs if x.get("Source") == "ASR"), subs[0] if subs else None)
    if pick:
        try:
            _, st, _, raw = fetcher(pick["Url"], 300_000, "text/vtt,*/*")
            text = vtt_text(raw) if st == 200 else ""
            if text:
                out["captions"] = {"state": "read", "languages": langs[:8], "text": text, "language": pick.get("LanguageCodeName", "")}
                out["source"] = "video-page+subtitles"
        except Exception:
            pass
    return out


def x_post(url, fetcher):
    status, data = get_json("https://publish.twitter.com/oembed?omit_script=1&url=" + urllib.parse.quote(url, safe=""), fetcher)
    if status == 404 or (status and status >= 400 and status != 429):
        return result(url, status="not_found" if status == 404 else "private", reason="X príspevok neukáže (zmazaný, súkromný alebo obmedzený).", source="oembed")
    if not data:
        return result(url, status="unavailable", reason="X neodpovedal.", source="oembed")
    text = re.sub(r"<[^>]+>", " ", (data.get("html") or "").split("&mdash;")[0])
    return result(url, title=f"Príspevok od {data.get('author_name', '')}".strip(), description=re.sub(r"\s+", " ", html.unescape(text)),
                  author={"name": data.get("author_name", ""), "url": data.get("author_url", "")}, source="oembed")


def resolve(url, fetcher=fetch):
    """The normalized result for one link; never raises."""
    try:
        check_url(url)
        platform, kind = classify(url)
        if platform == "instagram" and kind == "story":
            return result(url, status="unsupported", reason="Instagram príbehy sa bez prihlásenia čítať nedajú a po 24 hodinách zmiznú.")
        if platform == "youtube" and kind in ("video", "short"):
            return youtube(url, fetcher)
        if platform == "tiktok":
            return tiktok(url, fetcher)
        if platform == "x" and kind == "post":
            return x_post(url, fetcher)
        return from_page(url, fetcher)
    except Refused as e:
        return result(url, status="blocked", reason=f"Weft tento odkaz nečíta: {e}.")
    except (TimeoutError, socket.timeout):
        return result(url, status="timeout", reason="Stránka neodpovedala do 8 s.")
    except TooBig:
        return result(url, status="unavailable", reason="Stránka je príliš veľká na náhľad.")
    except (OSError, http.client.HTTPException, ssl.SSLError, ValueError) as e:
        return result(url, status="error", reason=f"Odkaz sa nepodarilo načítať ({type(e).__name__}).")


# ------------------------------------------------------------------ cache, dedup, limits

class Reader:
    def __init__(self, fetcher=fetch, clock=time.time):
        self.fetcher, self.clock = fetcher, clock
        # Keyed by (person, url): "" is the owner, anyone else their Matrix ID, so nobody can tell from a fast answer
        # which links another person opened.
        self.cache = {}          # (person, url) -> (expires, result)
        self.flying = {}         # (person, url) -> threading.Event, while one thread fetches it
        self.starts = []         # (time, host, person) of recent fetch starts
        self.images = {}         # (person, image url) -> expires: only images a result named may be proxied
        self.lock = threading.Lock()
        self.fetches = 0

    def allowed(self, host, person=""):
        now = self.clock()
        self.starts = [(t, h, p) for t, h, p in self.starts if now - t < 60]
        if len(self.starts) >= RATE_ALL or sum(1 for _, h, _ in self.starts if h == host) >= RATE_HOST:
            return False
        if person and sum(1 for _, _, p in self.starts if p == person) >= RATE_PERSON:
            return False
        self.starts.append((now, host, person))
        return True

    def get(self, url, person=""):
        url = url.strip()
        key = (person, url)
        while True:
            with self.lock:
                hit = self.cache.get(key)
                if hit and hit[0] > self.clock():
                    return hit[1]
                wait = self.flying.get(key)
                if not wait:
                    try:
                        host = (urllib.parse.urlsplit(url).hostname or "").lower()
                    except ValueError:  # "http://[::1" and other broken brackets
                        return result(url, status="error", reason="Neplatná adresa.")
                    if not self.allowed(host, person):
                        return result(url, status="limited", reason="Weft teraz číta priveľa odkazov naraz; skús o minútu.")
                    self.flying[key] = threading.Event()
                    break
            wait.wait(DEADLINE * 3)
        try:
            self.fetches += 1
            out = resolve(url, self.fetcher)
            with self.lock:
                ttl = TTL_OK if out["status"] in ("ok", "partial", "not_found", "private", "unsupported", "blocked") else TTL_FAIL
                self.cache[key] = (self.clock() + ttl, out)
                if out["image"]:
                    self.images[(person, out["image"])] = self.clock() + TTL_OK
                while len(self.cache) > CACHE_MAX:
                    self.cache.pop(next(iter(self.cache)))
            return out
        finally:
            with self.lock:
                self.flying.pop(key).set()

    def image_ok(self, url, person=""):
        with self.lock:
            return self.images.get((person, url), 0) > self.clock()


READER = Reader()


# ------------------------------------------------------------------ HTTP

USERS = weft_users.Users(HS, OWNER, ttl=300)


class Api(BaseHTTPRequestHandler):

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", cache="no-store"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def person(self):
        """"" for the owner, the Matrix ID of anyone else of this server, None for everyone else."""
        user = USERS.who((self.headers.get("Authorization") or "").removeprefix("Bearer ").strip())
        return None if user is None else "" if user == OWNER else user

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        url = urllib.parse.parse_qs(u.query).get("url", [""])[0]
        if u.path not in ("/_links/resolve", "/_links/image"):
            return self.send(404, {"error": "not found"})
        person = self.person()
        if person is None:
            return self.send(401, {"error": "a token of this server's people only"})
        if not url or len(url) > 2048:
            return self.send(400, {"error": "url missing or too long"})
        if u.path == "/_links/resolve":
            return self.send(200, READER.get(url, person))
        if not READER.image_ok(url, person):
            return self.send(404, {"error": "unknown image"})
        try:
            _, status, ctype, body = fetch(url, IMAGE_CAP, "image/avif,image/webp,image/png,image/jpeg,image/gif")
        except Exception:
            return self.send(502, {"error": "image unavailable"})
        if status != 200 or not re.fullmatch(r"image/(jpeg|png|webp|gif|avif)", ctype.split(";")[0].strip().lower()):
            return self.send(502, {"error": "not an image"})
        self.send(200, body, ctype.split(";")[0].strip(), "private, max-age=86400")


def main():
    if sys.argv[1:2] == ["resolve"]:
        for url in sys.argv[2:]:
            print(json.dumps(resolve(url), ensure_ascii=False, indent=1))
        return
    if not OWNER: sys.exit("LINKS_OWNER is not set: add it to ~/.config/weft/weft.env")
    ThreadingHTTPServer(("127.0.0.1", PORT), Api).serve_forever()


if __name__ == "__main__":
    main()
