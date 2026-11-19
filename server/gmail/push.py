"""Web Push for one-time codes: a phone or browser where Weft is closed still hears that a code came.

Each push is empty (no payload): the push service (Google's, Mozilla's, Apple's) learns only that something
happened, never the code or the sender; Weft's service worker shows "a code arrived" and opening Weft shows it.
An empty push needs no payload encryption, only the VAPID signature (ES256), made with the openssl command, so
the bridge needs no library beyond Python's own.

State in STATE_DIR (mode 600): vapid.pem, the signing key made on first use; push.json, the devices'
endpoints. A device whose endpoint the push service calls gone (404/410) is dropped.
"""
import base64
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TTL = 600  # a code is good for about ten minutes; a phone offline longer need not hear of it
SUBJECT = "mailto:weft@localhost.invalid"  # VAPID asks for a contact; this one names nobody
# The browsers' push services; the bridge posts to nothing else (PUSH_HOSTS adds hosts, for tests only).
HOSTS = ("fcm.googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com",
         *filter(None, os.environ.get("PUSH_HOSTS", "").split(",")))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A push service never redirects; following one would post outside the allowed hosts."""

    def redirect_request(self, *args, **kwargs):
        return None


def push_service(endpoint: str) -> bool:
    try:
        url = urllib.parse.urlsplit(endpoint)
        host, port = url.hostname or "", url.port
    except ValueError:
        return False
    if url.scheme != "https" or len(endpoint) > 2000 or url.username or url.password:
        return False
    known = any(host == h or (h.startswith(".") and host.endswith(h)) for h in HOSTS)
    return known and (port in (None, 443) or host in os.environ.get("PUSH_HOSTS", "").split(","))


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _der_to_raw(sig: bytes) -> bytes:
    """openssl writes ECDSA signatures as DER; JWT's ES256 wants r and s as 32 bytes each."""
    def read_int(at: int) -> tuple[int, int]:
        assert sig[at] == 0x02
        length = sig[at + 1]
        return int.from_bytes(sig[at + 2:at + 2 + length], "big"), at + 2 + length
    at = 2 if sig[1] < 0x80 else 3
    r, at = read_int(at)
    s, _ = read_int(at)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


class Push:
    def __init__(self, state_dir: Path, tls, log):
        self.key_file = state_dir / "vapid.pem"
        self.subs_file = state_dir / "push.json"
        self.log = log
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=tls), _NoRedirect())
        self.lock = threading.Lock()
        if not self.key_file.exists():
            old = os.umask(0o077)
            try:
                subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", str(self.key_file)],
                               check=True, capture_output=True)
            finally:
                os.umask(old)
        der = subprocess.run(["openssl", "ec", "-in", str(self.key_file), "-pubout", "-outform", "DER"],
                             check=True, capture_output=True).stdout
        self.public = b64url(der[-65:])  # the uncompressed point closes the SubjectPublicKeyInfo
        try:
            self.subs: dict[str, dict] = json.loads(self.subs_file.read_text())
        except (OSError, ValueError):
            self.subs = {}

    def _save(self) -> None:
        tmp = self.subs_file.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(self.subs, f)
        os.replace(tmp, self.subs_file)

    def subscribe(self, endpoint: str, key: str) -> bool:
        """A device asks for pushes: only at a browser's push service, and only for this bridge's current key."""
        if not push_service(endpoint) or key != self.public:
            return False
        with self.lock:
            self.subs[endpoint] = {"added": int(time.time())}
            self._save()
        return True

    def unsubscribe(self, endpoint: str) -> None:
        with self.lock:
            if self.subs.pop(endpoint, None) is not None:
                self._save()

    def _jwt(self, audience: str) -> str:
        head = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
        claims = b64url(json.dumps({"aud": audience, "exp": int(time.time()) + 12 * 3600, "sub": SUBJECT}).encode())
        signed = f"{head}.{claims}".encode()
        der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(self.key_file)], input=signed,
                             check=True, capture_output=True).stdout
        return f"{head}.{claims}.{b64url(_der_to_raw(der))}"

    def send_all(self) -> None:
        """Tells every device that a code came; in the background, so the watcher never waits on a push service."""
        with self.lock:
            endpoints = list(self.subs)
        for endpoint in endpoints:
            threading.Thread(target=self._send, args=(endpoint,), name="push", daemon=True).start()

    def _send(self, endpoint: str) -> None:
        if not push_service(endpoint):  # stored before the list of push services was this short
            return self.unsubscribe(endpoint)
        url = urllib.parse.urlsplit(endpoint)
        request = urllib.request.Request(endpoint, data=b"", method="POST", headers={
            "TTL": str(TTL), "Urgency": "high", "Content-Length": "0",
            "Authorization": f"vapid t={self._jwt(f'{url.scheme}://{url.netloc}')}, k={self.public}",
        })
        try:
            with self.opener.open(request, timeout=20):
                pass
        except urllib.error.HTTPError as err:
            if err.code in (404, 410):  # the device unsubscribed or the browser forgot it
                self.unsubscribe(endpoint)
                self.log("push: a device is gone")
            else:
                self.log("push: refused", err.code)
        except OSError as err:
            self.log("push: failed:", type(err).__name__)
