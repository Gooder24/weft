# Weft's design components

Weft wears Karchi's desktop: KarchiOS's `DESIGN.md` (desktop-future palette, Departure Mono 11 px, pixel icons),
rounded as Kalendarix. This file lists the pieces Weft has. A new button, row, icon or text uses one of them;
if none fits, add the new piece here in the same change. `tools/ui-check` checks the rules a script can check.

## Tokens (top of `app/app.css`)

- Colour only through the tokens. Surfaces rise `--page` → `--panel` → `--soft` → `--hover`; lines `--line`,
  `--line-strong`; text `--text`, `--muted`.
- One accent in two forms, never swapped: `--accent` is a fill (selected row, main button, own message) with
  `--accent-text` on it; `--link` is the accent as text (what is on, links, section titles).
- Colour means state: `--error` (failed, cannot be undone), `--warning`, `--notice`, `--info`.
- Photos, videos and the gallery sit on `--media-*`, dark in both themes.
- A network's own colour (Instagram, YouTube) is a brand, marked `/* brand */`; nothing else brings its own colour.
- Type: `--fs` (11 px) for everything, `--fs-2` for titles, `--lh` for wrapped lines. Radii: `--radius` controls,
  `--radius-s` small things inside them, `--radius-l` what floats. Borders `--bw`.
- No shadows (a ring `0 0 0 <width>` or `inset` is an outline), no animation that keeps running. The one exception
  (Karchi, 2026-11-25) is the dots of his own typing pill: one dot lifted at a time, in steps about 3× a second,
  only while a network shows his „píše…“.

## Icons (`app/icons.js`)

- `icon(name)` gives an `<svg>` of pixelarticons, the glyphs of KarchiOS's icon font: filled cells on the 24 grid,
  `fill: currentColor`, crisp. Only 24 px; `icon(name, 48)` where something is big (play over a video), and
  `icon(name, 12)` only for the send mark in a bubble's time line (one cell is one pixel, crisp too).
- An icon takes its text's colour; colour it with `color:` on the svg or its parent, never with stroke or fill.
- Icon + one word. An icon alone only where its meaning is settled (search, close, back, play, send) and it has a
  `title` naming the action with its shortcut.
- A new icon: copy its path from the pixelarticons package under the same name into `ICONS`. Draw one only if
  pixelarticons has none, on the same grid with 2 px lines. No other icon source, no emoji as an interface icon.
- A network is shown by its own picture (`appOf(id).icon`, 16 px in rows), not by an icon.

## Components

| Piece | Markup | Use |
|---|---|---|
| Main button | `button.primary` | The one action of a form or dialog; Enter triggers it |
| Quiet button | `button.ghost`, `.ghost.danger` | Secondary actions (Cancel, Remove); danger only for what cannot be undone |
| Link button | `button.linkbtn` | An action inside a sentence (Nastavenia → Účty) |
| Icon button | `button.filter` (bar), `.attach`/`.send` (composer), `.vbtn`/`.vnav` (viewer) | One `icon()` with a `title` |
| Segmented choice | `div.seg[role=radiogroup] > button[role=radio].on` | 2–4 exclusive options, all visible (language, modes) |
| Checkbox row | `label.bcheck > input + span > small` | An on/off setting with one line of why |
| Settings section | `h3` + `p.hint` / `p.bline` | Section title in `--link`; a hint says what it does, in one sentence |
| Field | `.form label > input` | A label above, a `small` under it for the format |
| Menu | `ctxMenu(o, groups)` of `ctxItem(glyph, label, note, fn, danger)` | Right-click menus: rows of icon + label + `kbd` shortcut, groups split by `hr`, the irreversible last and in `--error` |
| List row | `.item` (inbox), `.res` (search, palette) | Avatar, title, one muted line, time or `kbd` on the right |
| Chip | `.pchip` | A removable or toggled tag |
| Note in a chat | `.cnote`, `.rnote` | A muted line that explains a state; a button inside it is `.primary` or `.linkbtn` |
| Suggestion in a chat | `.cnote.calsug > .linkbtn + span + button.calsugoff` | A muted line under a message offering one action (icon + words, what it found) and ✕ to wave it off |
| Send mark | `.msg.mine .mtime > .mstate` + `.mwhen`; row: `.prev em.typingmark` | Left of the time in his own bubble, a slot kept while empty: the 12 px icon of how far it got or the 14 px face of whoever read up to it (its title says when); in an inbox row „píše…“ in `--link` stands for the preview |
| Status line | `.cstatus > .theirs` + `.own` (`.w`, `.tpill[data-step] > svg`) | One muted line of `--lh` between the messages and the message box, always there: left who is typing („píše…“), right his own typing as the network shows it (his `--accent` pill with `typingDots(24)`, one dot lifted and filled at a time, and „Na Instagrame vidno, že píšeš“; a refusal in words) or else one word for his newest message's mark (none for seen: the face says it). It never moves a message |
| Overlay | `.veil` (+ `.clear`, `.dark`, `.search`) | What floats over the app; Esc and a click outside close it |
| Shortcut | `kbd` | Right-aligned, muted; the same text as in Ctrl+/ |

## Words

- Every text in code is Slovak and wrapped: `T('Uložiť')`, `T`Prezývka pre ${name}``; its English goes into
  `app/i18n-en.js` under the same Slovak text (`app/i18n.js` says how). Text sent to other people is never wrapped.
- Labels say what happens, in Karchi's words, without "Click here". A shortcut is shown where the action is.

## Checks

    tools/ui-check      # tokens, shadows, animation, icons, then tools/i18n-check
