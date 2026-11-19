#!/usr/bin/env python3
"""Build a versioned static client. Usage: tools/release-app.py <new staging directory>.

Copy releases/ first to the server, legacy root assets next, release.json and sw.js next,
and atomically replace index.html last. Keep published releases for open/offline windows.
"""
import hashlib
import json
import re
from pathlib import Path
import shutil
import sys

source = Path(__file__).resolve().parents[1] / 'app'
target = Path(sys.argv[1])
if target.exists():
    raise SystemExit('Staging directory already exists; use a new directory.')
files = sorted(p for p in source.rglob('*') if p.is_file())
digest = hashlib.sha256(Path(__file__).read_bytes())
for p in files:
    digest.update(str(p.relative_to(source)).encode() + b'\0' + p.read_bytes())
build = digest.hexdigest()[:20]
shutil.copytree(source, target)
release = target / 'releases' / build
release.mkdir(parents=True)
for p in files:
    if p.name in ('sw.js', 'index.html'):
        continue
    out = release / p.relative_to(source)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(p, out)
# Pin lazy imports, fetched data, icons and CSS fonts as well as static module imports.
asset_paths = ['/' + str(p.relative_to(source)) for p in files if p.name not in ('sw.js', 'index.html')]
for p in release.rglob('*'):
    if p.suffix in ('.js', '.css'):
        text = p.read_text()
        for asset in sorted(asset_paths, key=len, reverse=True):
            text = re.sub(r'''(?<=["'`(])''' + re.escape(asset) + r'''(?=[?\#"'`\s)]|$)''', lambda _: f'/releases/{build}' + asset, text)
        p.write_text(text)
index = (source / 'index.html').read_text().replace('href="/app.css"', f'href="/releases/{build}/app.css"').replace('src="/app.js"', f'src="/releases/{build}/app.js"')
(target / 'index.html').write_text(index)
(release / 'index.html').write_text(index)
assets = ['/' + str(p.relative_to(target)) for p in sorted(release.rglob('*')) if p.is_file()]
worker = (source / 'sw.js').read_text().replace("const RELEASE = '';", f'const RELEASE = {json.dumps(build)};').replace('const RELEASE_FILES = [];', f'const RELEASE_FILES = {json.dumps(assets)};')
(target / 'sw.js').write_text(worker)
(target / 'release.json').write_text(json.dumps({'id': build}) + '\n')
print(build)
