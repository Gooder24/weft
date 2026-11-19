#!/usr/bin/env python3
"""x270: keeps Kalendarix's ~/.config/kalendarix/calendars.json and Weft's calendar on asus the same.

Sends the file and the base (what it last wrote from asus) to `kalendar.py merge` over ssh, then writes the
merged file the way Kalendarix does (a temporary file renamed over it) and only if nobody wrote it meanwhile;
Kalendarix 2 and its widget see the change within a second. The base moves on only after a successful write.
"""
import json, os, subprocess, sys

FILE = os.path.expanduser(os.environ.get("KALENDARIX_FILE", "~/.config/kalendarix/calendars.json"))
BASE = os.path.expanduser("~/.local/state/kalendarix-weft/base.json")
REMOTE = os.environ.get("WEFT_CALENDAR_CMD", "ssh -o BatchMode=yes -o ConnectTimeout=15 asus python3 matrix-spike/calendar/kalendar.py merge")

def stamp():
    st = os.stat(FILE)
    return st.st_ino, st.st_mtime_ns, st.st_size

def save(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.weft-sync"
    with open(tmp, "w", encoding="utf-8") as f: f.write(text)
    os.replace(tmp, path)

before = stamp()
with open(FILE, encoding="utf-8") as f: raw = f.read()
local = json.loads(raw)
try:
    with open(BASE, encoding="utf-8") as f: base = json.load(f)
except FileNotFoundError:
    base = None
p = subprocess.run(REMOTE.split(), input=json.dumps({"base": base, "local": local}), capture_output=True, text=True, timeout=120)
if p.returncode:
    sys.exit(f"merge failed: {p.stderr.strip()[-300:]}")
merged = json.loads(p.stdout)
if merged != local:
    # Kalendarix or the timetable sync wrote meanwhile: leave theirs, the next run merges it.
    if stamp() != before: sys.exit(0)
    save(FILE, json.dumps(merged, ensure_ascii=False, indent=2))
    print(f"calendars.json updated from Weft ({sum(len(c.get('events', [])) for c in merged['calendars'])} events)")
save(BASE, json.dumps(merged, ensure_ascii=False))
