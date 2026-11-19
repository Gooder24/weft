#!/usr/bin/env python3
"""Daily RSS/Atom and Instagram reading for Weft. No scheduled worker or seen events.

Reading windows open Feed and Weft's waiting messages together: `count` a day, `minutes` long (policy.json,
Weft → Nastavenia → Správy; a change applies from the next day). Opening again while one runs, another window or
device and a restart return the same window; it never grows, and today's count never resets.

Instagram feed sessions are independent of message bridges; shared bridge credentials are never read.
Only explicit POST /unfollow mutates Instagram; collection only performs GETs.
"""
import base64
import copy
import datetime as dt
import email.utils
import fcntl
import hashlib
import ipaddress
import json
import os
import re
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('FEED_DATA', os.path.join(HERE, 'data'))
IG_SESSION = os.path.expanduser(os.environ.get('FEED_IG_SESSION', os.path.join(DATA, 'instagram-session.json')))
IG_PAUSED = os.environ.get('FEED_INSTAGRAM_PAUSED', '0') != '0'
HS = os.environ.get('HS', 'http://127.0.0.1:8008')
OWNER = os.environ.get('OWNER', '')  # the owner's Matrix ID, from ~/.config/weft/weft.env on asus; the service needs it
PORT = int(os.environ.get('PORT', '29328'))
MAX_BYTES = 8 * 1024 * 1024
COLLECT = threading.Lock()
LOCK = threading.RLock()
UNFOLLOW = threading.Lock()
WINDOW_MINUTES = int(os.environ.get('FEED_WINDOW_MINUTES', '10'))
WINDOW_COUNT = int(os.environ.get('FEED_WINDOW_COUNT', '3'))
COUNTS = range(1, 9)  # Karchi chooses 1–8 a day in Weft
MINUTES = (5, 10, 15, 20, 30)
WINDOW_TYPE = 'sk.karchi.window'  # account data mirror the message list reads through /sync
MIRROR = threading.Lock()
DEFAULTS = {'sources': [], 'instagram': True, 'daily': True, 'limitOnce': True, 'hiddenStories': {}}


def now_ms():
    return int(time.time() * 1000)


def today(ms=None):
    return dt.datetime.fromtimestamp((now_ms() if ms is None else ms) / 1000).astimezone().date().isoformat()


def read(name, default):
    try:
        with open(os.path.join(DATA, name), encoding='utf8') as f:
            return json.load(f)
    except FileNotFoundError:
        return copy.deepcopy(default)


def write(name, value):
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA)
    try:
        with os.fdopen(fd, 'w', encoding='utf8') as f:
            json.dump(value, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, os.path.join(DATA, name))
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def settings():
    return {**copy.deepcopy(DEFAULTS), **read('settings.json', {}), 'daily': True, 'limitOnce': True}


def safe_url(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ('https', 'http') or not u.hostname or u.username or u.password:
        raise ValueError('Použi verejnú HTTP alebo HTTPS adresu.')
    if u.port and u.port not in (80, 443):
        raise ValueError('RSS používa port 80 alebo 443.')
    addresses = socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('Zdroj musí byť na verejnej adrese.')
    return url


class PublicRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def public_bytes(url):
    req = urllib.request.Request(safe_url(url), headers={'User-Agent': 'Weft feed/1.0', 'Accept': 'application/rss+xml, application/atom+xml, */*'})
    with urllib.request.build_opener(PublicRedirect()).open(req, timeout=20) as r:
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES: raise ValueError('Zdroj je priveľký (maximum 8 MB).')
        return data


def clean(s):
    return re.sub(r'<[^>]*>', '', str(s or '')).strip()


def web_url(url):
    try:
        u = urllib.parse.urlsplit(url)
        return url if u.scheme in ('http', 'https') and u.hostname and not u.username else ''
    except ValueError:
        return ''


def timestamp(text):
    text = str(text or '')
    try: return int(dt.datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp() * 1000)
    except (ValueError, TypeError):
        try: return int(email.utils.parsedate_to_datetime(text).timestamp() * 1000)
        except (ValueError, TypeError, AttributeError): return 0


def parse_feed(data, source):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('RSS s externými entitami nie je podporované.')
    root = ET.fromstring(data)
    # Strip namespaces for both RSS and Atom without interpreting HTML content.
    for e in root.iter(): e.tag = e.tag.rsplit('}', 1)[-1]
    channel = root.find('channel') if root.tag in ('rss', 'RDF') else root
    if channel is None or root.tag not in ('rss', 'feed', 'RDF'):
        raise ValueError('Adresa neobsahuje RSS alebo Atom.')
    name = clean(channel.findtext('title')) or source.get('name') or source['url']
    entries = list(channel.findall('item')) + list(channel.findall('entry'))
    if root.tag == 'RDF': entries += list(root.findall('item'))
    out = []
    for e in entries[:200]:
        links = e.findall('link')
        link = next((x.get('href') for x in links if x.get('href') and x.get('rel', 'alternate') == 'alternate'), None)
        link = web_url(urllib.parse.urljoin(source['url'], link or e.findtext('link') or ''))
        if not link: continue
        uid = e.findtext('guid') or e.findtext('id') or link
        out.append({'id': 'rss:' + hashlib.sha256((source['id'] + uid).encode()).hexdigest()[:24],
                    'kind': 'youtube' if 'youtube.com/' in link or 'youtu.be/' in link else 'rss',
                    'source': source['id'], 'author': name, 'title': clean(e.findtext('title'))[:1000],
                    'text': clean(e.findtext('description') or e.findtext('summary') or e.findtext('content'))[:2000],
                    'url': link, 'at': timestamp(e.findtext('pubDate') or e.findtext('published') or e.findtext('updated') or e.findtext('date'))})
    return out


class InvalidSources(ValueError):
    def __init__(self, indices):
        super().__init__('Niektoré RSS adresy nie sú platné.')
        self.indices = indices


class InstagramError(Exception): pass


class Instagram:
    def __init__(self, cookies=None):
        if IG_PAUSED:
            raise InstagramError('Instagram feed je pozastavený. Prihlásenie správ sa obnovuje samostatne v Nastaveniach → Účty.')
        try:
            if cookies is None:
                with open(IG_SESSION, encoding='utf8') as f: cookies = json.load(f)['cookies']
            self.cookies = cookies
            if not self.cookies.get('sessionid'): raise ValueError('missing session')
        except (OSError, ValueError, KeyError):
            raise InstagramError('Feed potrebuje vlastné prihlásenie do Instagramu. Prihlásenie správ nepoužíva.') from None
        c = self.cookies
        token = base64.b64encode(json.dumps({'ds_user_id': c['ds_user_id'], 'sessionid': c['sessionid']}, separators=(',', ':')).encode()).decode()
        self.headers = {'User-Agent': 'Instagram 361.0.0.35.82 (iPad13,8; iOS 18_0; en_US; en-US; scale=2.00; 2048x2732; 674117118) AppleWebKit/420+',
                        'X-IG-App-ID': '124024574287414', 'X-IG-Capabilities': '36r/F/8=',
                        'Authorization': 'Bearer IGT:2:' + token, 'Cookie': '; '.join(k + '=' + v for k, v in c.items()),
                        'X-CSRFToken': c.get('csrftoken', ''), 'IG-Intended-User-ID': c['ds_user_id'],
                        'IG-U-DS-User-ID': c['ds_user_id'], 'X-IG-Device-ID': c.get('ig_did', ''), 'X-Mid': c.get('mid', ''),
                        'X-IG-WWW-Claim': '0', 'Accept': 'application/json'}

    def request(self, path, body=None):
        if IG_PAUSED: raise InstagramError('Instagram feed je pozastavený.')
        if path.startswith('friendships/destroy/') and body is not None:
            body = {'signed_body': 'SIGNATURE.' + json.dumps({**body, '_uuid': self.cookies.get('ig_did', '')}, separators=(',', ':'))}
        data = urllib.parse.urlencode(body).encode() if body is not None else None
        req = urllib.request.Request('https://i.instagram.com/api/v1/' + path, data=data, headers=self.headers)
        # Never forward credentials to a redirect or report a raw exception containing a URL/token.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args): return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(req, timeout=25) as r:
                raw = r.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES: raise InstagramError('Instagram vrátil priveľkú odpoveď.')
            res = json.loads(raw)
        except urllib.error.HTTPError as err:
            if err.code == 429: raise InstagramError('Instagram obmedzil požiadavky. Ďalší pokus bude zajtra.') from None
            raise InstagramError('Instagram žiada obnovenie prihlásenia alebo odmietol požiadavku. Prihlás feed znova cez Zdroje a filtre → Znova prihlásiť feed.') from None
        except (ValueError, OSError):
            raise InstagramError('Instagram neodpovedal. Uložený feed ostal zachovaný.') from None
        if res.get('status') != 'ok' or res.get('challenge') or res.get('checkpoint_url'):
            raise InstagramError('Instagram feed odmietol. Prihlás feed znova cez Zdroje a filtre; dnes ho automaticky neopakujem.')
        return res

    def collect(self, hidden):
        tray = self.request('feed/reels_tray/')
        users = {}
        ids = []
        for reel in tray.get('tray', []):
            u = reel.get('user') or {}
            pk = str(u.get('pk') or reel.get('id') or '')
            if not pk.isdecimal() or pk == self.cookies['ds_user_id']: continue
            users[pk] = {'id': pk, 'username': u.get('username', ''), 'name': u.get('full_name', ''), 'following': True}
            ids.append(pk) # Metadata remains available for reversible filters; media is always lazy.
        out = []
        # One bounded daily batch: do not crawl the following list or backfill history.
        if ids:
            reels = self.request('feed/reels_media/?' + urllib.parse.urlencode({'reel_ids': ','.join(ids[:25])}))
            values = reels.get('reels', reels.get('reels_media', []))
            if isinstance(values, dict): values = list(values.values())
            for reel in values:
                u = reel.get('user') or {}
                pk = str(u.get('pk') or reel.get('id') or '')
                if pk not in users: continue
                for item in reel.get('items', [])[:30]:
                    out.append(self.item(item, users[pk], 'story'))
        try:
            timeline = self.request('feed/timeline/?' + urllib.parse.urlencode({'count': 30, 'pagination_source': 'following', 'variant': 'following'}))
        except InstagramError:
            # The feed endpoint may reject a web-derived login even when stories work.
            # Keep the working stories; do not discard them or retry another identity.
            return out, list(users.values()), {'stories': len(ids), 'storyBatch': min(len(ids), 25), 'posts': 0,
                                               'bounded': bool(len(ids) > 25 or tray.get('remaining_reel_ids_to_fetch') or tray.get('cursor')), 'postsError': 'Instagram neposkytol príspevky sledovaných; stories ostali dostupné.'}
        posts = timeline.get('items', []) + [f.get('media_or_ad') for f in timeline.get('feed_items', []) if f.get('media_or_ad')]
        for item in posts[:100]:
            u = item.get('user') or {}
            pk = str(u.get('pk') or '')
            # Never mix recommendations or ads into a following feed.
            if item.get('ad_id') or item.get('is_ad') or not (u.get('friendship_status') or {}).get('following'): continue
            users[pk] = {'id': pk, 'username': u.get('username', ''), 'name': u.get('full_name', ''), 'following': True}
            out.append(self.item(item, users[pk], 'post'))
        return out, list(users.values()), {'stories': len(ids), 'storyBatch': min(len(ids), 25), 'posts': sum(i['kind'] == 'post' for i in out), 'bounded': bool(len(ids) > 25 or tray.get('remaining_reel_ids_to_fetch') or tray.get('cursor') or timeline.get('more_available'))}

    @staticmethod
    def item(item, user, kind):
        pk = str(item.get('pk') or item.get('id') or '')
        media = item.get('carousel_media') or [item]
        assets = []
        for m in media[:10]:
            videos = m.get('video_versions') or []
            images = (m.get('image_versions2') or {}).get('candidates') or []
            variants = videos or images
            if variants:
                v = min(variants, key=lambda x: abs(int(x.get('width', 720)) - 720))
                url = v.get('url', '')
                host = urllib.parse.urlsplit(url).hostname or ''
                if host.endswith('.cdninstagram.com') or host.endswith('.fbcdn.net'):
                    assets.append({'url': url, 'type': 'video' if videos else 'image'})
        username = user['username']
        return {'id': 'ig:' + kind + ':' + pk, 'kind': kind, 'source': 'instagram', 'user': user['id'], 'author': username,
                'title': 'Story' if kind == 'story' else clean((item.get('caption') or {}).get('text'))[:1000],
                'text': '', 'at': int(item.get('taken_at') or 0) * 1000, 'expires': int(item.get('expiring_at') or 0) * 1000,
                'url': 'https://www.instagram.com/' + ('stories/' + urllib.parse.quote(username) + '/' + pk.split('_')[0] + '/' if kind == 'story' else 'p/' + urllib.parse.quote(item.get('code') or '') + '/'),
                'media': assets}

    def unfollow(self, pk):
        res = self.request('friendships/destroy/' + pk + '/', {'_uid': self.cookies['ds_user_id'], '_csrftoken': self.cookies.get('csrftoken', ''), 'user_id': pk, 'container_module': 'profile'})
        if (res.get('friendship_status') or {}).get('following') is not False:
            raise InstagramError('Instagram nepotvrdil zrušenie sledovania. Stav sa nezmenil.')


def document():
    cfg = settings()
    doc = read('feed.json', {'day': '', 'items': [], 'users': [], 'errors': [], 'at': 0})
    locked = not window_active(reading_window())
    sources = {s['id'] for s in cfg['sources']}
    available = [i for i in doc['items'] if (cfg['instagram'] if i.get('source') == 'instagram' else i.get('source') in sources)]
    hidden = lambda i: i['kind'] == 'story' and i.get('user') in cfg['hiddenStories']
    items = [] if locked else [i for i in available if not hidden(i)]
    # The authenticated owner retains hidden stories for reversible offline filters.
    hidden_items = [] if locked else [i for i in available if hidden(i)]
    return {**doc, 'items': items, 'hiddenItems': hidden_items, 'settings': cfg, 'locked': bool(locked), 'busy': COLLECT.locked(), 'today': today()}


def tomorrow():
    return (dt.date.fromisoformat(today()) + dt.timedelta(days=1)).isoformat()


def policy():
    """Today's {count, minutes} and a change waiting for its day ({count, minutes, from}) or None."""
    p = read('policy.json', {})
    nxt = p.get('next')
    if nxt and nxt['from'] <= today():
        p = {'count': nxt['count'], 'minutes': nxt['minutes'], 'next': None}
        write('policy.json', p)
    return {'count': p.get('count', WINDOW_COUNT), 'minutes': p.get('minutes', WINDOW_MINUTES), 'next': p.get('next')}


def set_policy(body):
    """A new count or length applies from tomorrow, so changing it never opens anything today."""
    count, minutes = body.get('count'), body.get('minutes')
    if count not in COUNTS or minutes not in MINUTES or isinstance(count, bool) or isinstance(minutes, bool):
        raise ValueError('Neplatný počet alebo dĺžka okna.')
    with LOCK:
        now = policy()
        nxt = None if (count, minutes) == (now['count'], now['minutes']) else {'count': count, 'minutes': minutes, 'from': tomorrow()}
        write('policy.json', {'count': now['count'], 'minutes': now['minutes'], 'next': nxt})


def reading_window():
    """The latest reading window {day, start, end, used} in server milliseconds, with today's policy
    (count, minutes), or None."""
    w = read('window.json', None)
    day = today()
    if (not w or w.get('day') != day) and read('opened.json', {}).get('day') == day:
        # A feed session opened before the shared window existed already used one of today's.
        w = {'day': day, 'start': 0, 'end': 0, 'used': 1}
    if not w: return None
    p = policy()
    return {**w, 'used': w.get('used', 1), 'count': p['count'], 'minutes': p['minutes']}


def can_open(w):
    return not window_active(w) and (not w or w.get('day') != today() or w['used'] < w['count'])


def window_active(w, at=None):
    at = now_ms() if at is None else at
    return bool(w) and w['start'] <= at < w['end']


def open_window():
    """Opens the next of today's windows; while one runs (also past midnight) or when today's are used, returns
    the latest one."""
    with LOCK:
        w = reading_window()
        if not can_open(w): return w
        start = now_ms()
        used = w['used'] + 1 if w and w['day'] == today(start) else 1
        write('window.json', {'day': today(start), 'start': start, 'end': start + policy()['minutes'] * 60000, 'used': used})
        return reading_window()


def close_window(start=None):
    """Ends the running window now ("Skončiť okno"); `start` keeps a late offline close from ending a newer one."""
    with LOCK:
        w = reading_window()
        if window_active(w) and (start is None or start == w['start']):
            w = {**w, 'end': now_ms()}
            write('window.json', {k: w[k] for k in ('day', 'start', 'end', 'used')})
        return w


def has_access():
    return window_active(reading_window())


def mirror_window(token):
    """Puts the window into the owner's account data with his own token, so every Weft device learns it through
    /sync. Serialized and read inside the lock, so the last write always carries the newest window."""
    with MIRROR:
        w = reading_window()
        if not w: return
        try:
            url = f"{HS}/_matrix/client/v3/user/{urllib.parse.quote(OWNER)}/account_data/{WINDOW_TYPE}"
            req = urllib.request.Request(url, data=json.dumps(w).encode(), method='PUT',
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            urllib.request.urlopen(req, timeout=5).close()
        except Exception: pass  # clients also take the window from every response


def public_document():
    with LOCK:
        doc = document()
        w = reading_window()
        access = window_active(w)
        return {**doc, 'policy': policy(), 'items': doc['items'] if access else [], 'hiddenItems': doc['hiddenItems'] if access else [],
                'access': access, 'canOpen': can_open(w), 'locked': not access and not can_open(w), 'window': w, 'now': now_ms(),
                'instagramPaused': IG_PAUSED, 'instagramConnected': not IG_PAUSED and os.path.isfile(IG_SESSION)}


def connect_instagram(body):
    if IG_PAUSED: raise InstagramError('Instagram feed je vypnutý na serveri.')
    cookies = body.get('cookies')
    allowed = {'sessionid', 'ds_user_id', 'csrftoken', 'ig_did', 'mid', 'rur'}
    if not isinstance(cookies, dict) or any(k not in allowed or not isinstance(v, str) or len(v) > 8192 or any(c in v for c in '\r\n;') for k, v in cookies.items()):
        raise ValueError('Invalid cookies')
    if not cookies.get('sessionid') or not cookies.get('csrftoken') or not re.fullmatch(r'[0-9]+', cookies.get('ds_user_id', '')):
        raise ValueError('Incomplete cookies')
    with COLLECT, LOCK:
        # A closed checkpoint window may already have cookies; validate before persisting them.
        account = Instagram(cookies).request('accounts/current_user/?edit=true')
        if str((account.get('user') or {}).get('pk') or '') != cookies['ds_user_id']:
            raise InstagramError('Instagram nepotvrdil prihlásenie. Dokonči ho v prihlasovacom okne.')
        # Never touch message-bridge credentials. The desktop hands this service its own login.
        folder = os.path.dirname(IG_SESSION)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=folder)
        try:
            with os.fdopen(fd, 'w') as f: json.dump({'cookies': cookies}, f)
            os.replace(tmp, IG_SESSION)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
        clear_instagram_content()
        update_settings({'instagram': True})
        # A previously disabled feed collects the new account's first batch; the reading window stays as it is.
        write('attempt.json', {})


def clear_instagram_content():
    doc = read('feed.json', {'items': [], 'users': []})
    doc.update(items=[i for i in doc['items'] if i.get('source') != 'instagram'], users=[], coverage={})
    doc['errors'] = [e for e in doc.get('errors', []) if e.get('source') != 'instagram']
    # Force a fresh daily collection after the Instagram connection changes, so stories/posts
    # are actually fetched instead of waiting for the next calendar day.
    doc['day'] = ''
    write('feed.json', doc)
    write('unfollowed.json', {})
    # Media belongs to the disconnected account too.
    folder = os.path.join(DATA, 'media')
    if os.path.isdir(folder):
        for name in os.listdir(folder):
            path = os.path.join(folder, name)
            if os.path.isfile(path): os.unlink(path)
    write('media-types.json', {})


def disconnect_instagram():
    with COLLECT, LOCK:
        try: os.unlink(IG_SESSION)
        except FileNotFoundError: pass
        update_settings({'instagram': False})
        clear_instagram_content()


def collect():
    if not COLLECT.acquire(blocking=False): return document()
    try:
        started = time.time()
        cfg = settings()
        prev = read('feed.json', {'items': [], 'users': []})
        attempt = read('attempt.json', {})
        if (cfg['daily'] and attempt.get('day') == today()) or time.time() - attempt.get('at', 0) < 300: return document()
        # Persist before network access: failed attempts and concurrent windows never hammer Instagram.
        write('attempt.json', {'day': today(), 'at': time.time()})
        out, users, errors, coverage = [], [], [], {}
        for source in cfg['sources']:
            try: out += parse_feed(public_bytes(source['url']), source)
            except Exception:
                errors.append({'source': source['id'], 'message': 'RSS sa nenačítalo. Skontroluj adresu zdroja.'})
                out += [i for i in prev['items'] if i.get('source') == source['id']]
        if cfg['instagram']:
            try: ig, users, coverage = Instagram().collect(cfg['hiddenStories']); out += ig
            except InstagramError as e:
                errors.append({'source': 'instagram', 'message': str(e)})
                out += [i for i in prev['items'] if i.get('source') == 'instagram']
                users = prev.get('users', [])
        unique = {i['id']: i for i in out}
        with LOCK:
            removed = read('unfollowed.json', {})
            latest = read('feed.json', {'users': []})
            for user in users:
                if removed.get(user['id'], 0) >= started: user['following'] = False
            known = {u['id'] for u in users}
            users += [u for u in latest.get('users', []) if u.get('following') is False and u['id'] not in known][-100:]
            write('feed.json', {'day': today(), 'at': int(time.time() * 1000), 'items': sorted((i for i in unique.values() if removed.get(i.get('user'), 0) < started), key=lambda i: i.get('at', 0), reverse=True)[:1500], 'users': users, 'errors': errors, 'coverage': coverage})
        return document()
    finally: COLLECT.release()


def update_settings(body):
    with LOCK:
        cfg = settings()
        for key in ['instagram', 'daily', 'limitOnce']:
            if key in body:
                if not isinstance(body[key], bool): raise ValueError('Nastavenie musí byť zapnuté alebo vypnuté.')
                if key in ('daily', 'limitOnce') and not body[key]: raise ValueError('Feed sa dá otvoriť raz denne.')
                cfg[key] = body[key]
        if 'sources' in body:
            if not isinstance(body['sources'], list): raise ValueError('RSS zdroje musia byť zoznam.')
            sources = []
            invalid = list(range(30, len(body['sources'])))
            for index, source in enumerate(body['sources'][:30]):
                try:
                    if not isinstance(source, dict): raise ValueError('Neplatný RSS zdroj.')
                    url = safe_url(str(source.get('url', '')).strip())
                except (ValueError, OSError):
                    invalid.append(index)
                    continue
                sid = hashlib.sha256(url.encode()).hexdigest()[:16]
                if any(x['id'] == sid for x in sources): continue
                sources.append({'id': sid, 'url': url, 'name': clean(source.get('name'))[:120]})
            if invalid: raise InvalidSources(invalid)
            cfg['sources'] = sources
        if 'hiddenStories' in body:
            if not isinstance(body['hiddenStories'], dict) or len(body['hiddenStories']) > 5000: raise ValueError('Neplatný zoznam účtov.')
            cfg['hiddenStories'] = {str(k): clean(v)[:80] for k, v in body['hiddenStories'].items() if str(k).isdecimal()}
        write('settings.json', cfg)
        return document()


def unfollow(body):
    pk = str(body.get('user', ''))
    if not pk.isdecimal() or body.get('confirm') is not True: raise ValueError('Potvrď konkrétny účet.')
    # Serialize only mutations, not feed reads, while Instagram takes its time.
    with UNFOLLOW:
        with LOCK:
            doc = read('feed.json', {'users': []})
            user = next((u for u in doc['users'] if u['id'] == pk), None)
            if not user: raise ValueError('Účet nie je v načítanom feede.')
            if user.get('following') is False: return document()
            if body.get('username') != user['username']: raise ValueError('Účet sa zmenil. Obnov feed.')
        Instagram().unfollow(pk)
        with LOCK:
            doc = read('feed.json', {'users': [], 'items': []})
            removed = read('unfollowed.json', {})
            removed[pk] = time.time()
            write('unfollowed.json', removed)
            for current in doc['users']:
                if current['id'] == pk: current['following'] = False
            if not any(u['id'] == pk for u in doc['users']): doc['users'].append({**user, 'following': False})
            doc['items'] = [i for i in doc['items'] if i.get('user') != pk]
            write('feed.json', doc)
            return document()


def media_file(item_id, index):
    doc = read('feed.json', {'items': []})
    cfg = settings()
    if not has_access():
        raise ValueError('Okno na čítanie je zatvorené.')
    item = next((i for i in doc['items'] if i['id'] == item_id), None)
    if not cfg['instagram'] or not item or (item['kind'] == 'story' and item.get('user') in cfg['hiddenStories']):
        raise ValueError('Médium nie je v dnešnom feede.')
    assets = item.get('media') or []
    if index < 0 or index >= len(assets): raise ValueError('Neplatné médium.')
    asset = assets[index]
    url = asset['url']
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or ''
    if parsed.scheme != 'https' or not (host.endswith('.cdninstagram.com') or host.endswith('.fbcdn.net')):
        raise ValueError('Neplatná adresa média.')
    digest = hashlib.sha256(url.encode()).hexdigest()
    folder = os.path.join(DATA, 'media')
    os.makedirs(folder, mode=0o700, exist_ok=True)
    filename = os.path.join(folder, digest)
    kind = 'video/mp4' if asset['type'] == 'video' else 'image/jpeg'
    if os.path.isfile(filename):
        info = read('media-types.json', {})
        with open(filename, 'rb') as f: return f.read(), info.get(digest, kind)
    if IG_PAUSED: raise ValueError('Instagram feed je pozastavený.')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    with urllib.request.build_opener(NoRedirect()).open(url, timeout=25) as r:
        data = r.read(25 * 1024 * 1024 + 1)
        kind = r.headers.get_content_type()
    if len(data) > 25 * 1024 * 1024 or not kind.startswith(('image/', 'video/')):
        raise ValueError('Médium je priveľké alebo má nepodporovaný formát.')
    fd, tmp = tempfile.mkstemp(dir=folder)
    try:
        with os.fdopen(fd, 'wb') as f: f.write(data)
        os.replace(tmp, filename)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    with LOCK:
        types = read('media-types.json', {}); types[digest] = kind
        if len(types) > 150: types = dict(list(types.items())[-100:])
        write('media-types.json', types)
    # Bounded lazy cache, never a background history download.
    files = sorted((os.path.join(folder, f) for f in os.listdir(folder)), key=os.path.getmtime, reverse=True)
    for old in files[100:]:
        try: os.unlink(old)
        except FileNotFoundError: pass
    return data, kind


class Api(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def authorized(self):
        token = self.headers.get('Authorization', '').removeprefix('Bearer ').strip()
        if not token: return False
        try:
            req = urllib.request.Request(HS + '/_matrix/client/v3/account/whoami', headers={'Authorization': 'Bearer ' + token})
            with urllib.request.urlopen(req, timeout=10) as r: ok = json.load(r).get('user_id') == OWNER
        except Exception: return False
        if ok: self.token = token
        return ok

    def do_GET(self):
        if not self.authorized(): return self.send(401, {'error': 'Prihlás sa do Weftu.'})
        if self.path.split('?')[0] == '/_feed/media':
            if not has_access(): return self.send(403, {'error': 'Okno na čítanie je zatvorené.'})
            try:
                args = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                data, kind = media_file(args.get('id', [''])[0], int(args.get('n', ['0'])[0]))
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(data)
                return
            except (ValueError, urllib.error.URLError, OSError):
                return self.send(404, {'error': 'Médium sa nenačítalo alebo už vypršalo.'})
        if self.path.split('?')[0] != '/_feed/doc': return self.send(404, {'error': 'not found'})
        self.send(200, public_document())

    def do_POST(self):
        if not self.authorized(): return self.send(401, {'error': 'Prihlás sa do Weftu.'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n < 0 or n > 65536: raise ValueError('Požiadavka je priveľká.')
            body = json.loads(self.rfile.read(n) or '{}')
            if not isinstance(body, dict): raise ValueError('Neplatná požiadavka.')
            path = self.path.split('?')[0]
            if path in ('/_feed/instagram/connect', '/_feed/instagram/disconnect'):
                if path.endswith('/connect'): connect_instagram(body)
                else: disconnect_instagram()
                return self.send(200, public_document())
            # /open is the name clients before the shared window used; they still open the same window.
            if path in ('/_feed/window', '/_feed/open', '/_feed/window/close'):
                if path.endswith('/close'):
                    start = body.get('start')
                    if start is not None and not isinstance(start, int): raise ValueError('Neplatné okno.')
                    close_window(start)
                else: open_window()
                mirror_window(self.token)
                return self.send(200, public_document())
            if path == '/_feed/policy':
                set_policy(body)
                mirror_window(self.token)
                return self.send(200, public_document())
            if path == '/_feed/settings':
                update_settings(body)
                return self.send(200, public_document())
            # Older clients closed their feed session on leaving; leaving no longer ends the shared window.
            if path == '/_feed/finish': return self.send(200, public_document())
            if path in ('/_feed/refresh', '/_feed/unfollow'):
                if not has_access(): return self.send(403, {'error': 'Okno na čítanie je zatvorené.'})
                if path.endswith('/refresh'): collect()
                else: unfollow(body)
                return self.send(200, public_document())
            return self.send(404, {'error': 'not found'})
        except InvalidSources as e: self.send(400, {'error': str(e), 'field': 'sources', 'invalidIndices': e.indices})
        except (ValueError, TypeError, KeyError): self.send(400, {'error': 'Neplatné nastavenie alebo účet. Obnov feed a skús znova.'})
        except InstagramError as e: self.send(409, {'error': str(e)})
        except Exception: self.send(500, {'error': 'Feed sa nepodarilo uložiť. Skús neskôr.'})


if __name__ == '__main__':
    if not OWNER: raise SystemExit('OWNER is not set: add it to ~/.config/weft/weft.env')
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    with open(os.path.join(DATA, '.instance'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ThreadingHTTPServer(('127.0.0.1', PORT), Api).serve_forever()
