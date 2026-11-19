#!/usr/bin/env python3
"""Builds app/emoji.json, the emoji list of the picker, from Unicode and CLDR data.

    curl -LO https://unicode.org/Public/emoji/latest/emoji-test.txt
    for f in full/annotations derived-full/annotationsDerived; do for l in sk en; do
      curl -Lo $l-$(basename $f).json \
        https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-annotations-$f/$l/annotations.json
    done; done
    python3 tools/make-emoji.py <that folder> > app/emoji.json

Skin tone variants are left out, and so are emoji newer than MAX_VERSION, which fonts do not draw yet.
"""
import json
import re
import sys
import unicodedata
from pathlib import Path

MAX_VERSION = 15.1
GROUPS = {
    'Smileys & Emotion': 'Smajlíky',
    'People & Body': 'Ľudia',
    'Animals & Nature': 'Zvieratá a príroda',
    'Food & Drink': 'Jedlo a pitie',
    'Travel & Places': 'Cestovanie',
    'Activities': 'Aktivity',
    'Objects': 'Predmety',
    'Symbols': 'Symboly',
    'Flags': 'Vlajky',
}
TONES = re.compile('[\U0001F3FB-\U0001F3FF]')


def norm(text):
    return ''.join(c for c in unicodedata.normalize('NFD', text.lower()) if not unicodedata.combining(c))


def main(src):
    src = Path(src)
    notes = {}
    for lang in ('sk', 'en'):
        merged = {}
        for name, key in (('annotations', 'annotations'), ('annotationsDerived', 'annotationsDerived')):
            merged.update(json.loads((src / f'{lang}-{name}.json').read_text())[key]['annotations'])
        notes[lang] = merged

    def note(lang, char):
        return notes[lang].get(char) or notes[lang].get(char.replace('️', '')) or {}

    groups, current = [], None
    for line in (src / 'emoji-test.txt').read_text().splitlines():
        if line.startswith('# group: '):
            name = GROUPS.get(line[9:].strip())
            current = [name, []] if name else None
            if current: groups.append(current)
            continue
        m = re.match(r'^[0-9A-F ]+; fully-qualified\s+# (\S+) E(\d+\.\d+) (.+)$', line)
        if not m or not current or float(m[2]) > MAX_VERSION or TONES.search(m[1]):
            continue
        char, english = m[1], m[3]
        sk, en = note('sk', char), note('en', char)
        name = (sk.get('tts') or [english])[0]
        words = []
        for text in [name, *sk.get('default', []), english, *en.get('tts', []), *en.get('default', [])]:
            for w in re.split(r'[^\w]+', norm(text)):
                if w and w not in words: words.append(w)
        current[1].append([char, name, ' '.join(words)])
    json.dump({'groups': groups}, sys.stdout, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main(sys.argv[1])
