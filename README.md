# Weft

Weft is one inbox for a person's chats and mail. It brings EduPage, Messenger, Instagram, Discord, WhatsApp and Gmail
into one web client, next to a calendar and a daily reading feed. It is self-hosted and private.

This repository holds the web client in `app/` (plain JavaScript, no build step), the desktop shell in `desktop/`,
and the server-side code in `server/`, which runs on the owner's own host.

## Requirements

- To serve the client: Python 3, or any static file server.
- To run the checks: Node.js 22.12 or newer, npm, and Chrome or Chromium. If it is not in `/usr/bin/chromium`,
  `/usr/bin/chromium-browser`, `/usr/bin/google-chrome` or `/usr/bin/google-chrome-stable`, set `CHROME_PATH`.
- The server side is not needed for the client or for the checks.

## Quick start

Serve the client from `app/` on your own machine:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory app
```

Then open http://127.0.0.1:8000/. You will see the sign-in form.

## Usage

Signing in needs the server side in `server/`, which runs on the owner's host and is not part of this quick start.
The client then talks to it from the same origin.

## Tests

Install the test dependencies and run the accessibility checks:

```sh
npm ci --prefix tests/accessibility && npm test --prefix tests/accessibility
```

- `npm test --prefix tests/accessibility` runs axe-core on the sign-in screens and a keyboard-only smoke test, in
  headless Chromium. Requests that do not go to the local server are blocked.
- `python3 .github/scripts/check-docs.py` checks the Markdown files for heading order, image alt text and link text.
- `.github/workflows/accessibility.yml` runs both on every pull request.

Known problems are recorded in `.github/a11y-baseline.json`, `tests/accessibility/axe-baseline.json` and the `KNOWN`
list in `tests/accessibility/keyboard.cjs`. A new problem fails the checks.

## Accessibility

See [ACCESSIBILITY.md](ACCESSIBILITY.md) for the goals, what is tested, what is not, and how to report a barrier.

## License

Copyright (C) 2026 Gooder24

Weft is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public
License, version 3 or (at your option) any later version (`AGPL-3.0-or-later`), see [LICENSE](LICENSE). Among other
things, the AGPL asks that if you change Weft and let people use it over a network, you offer all of them the source
code of your version.

Parts by others keep their own licenses:

- In `app/`: [pixelarticons](app/pixelarticons-LICENSE) (MIT), qrcode-generator in `app/qrcode.js`
  ([MIT](app/qrcode-LICENSE)), the Kalendarix colour rules in `app/kalendarix-colors.js`
  ([MIT](app/kalendarix-LICENSE)), Departure Mono ([SIL Open Font License 1.1](app/fonts/DepartureMono-LICENSE)) and
  `app/emoji.json`, built from Unicode CLDR and Unicode emoji data ([Unicode License v3](app/emoji-LICENSE)).
- The service logos in `app/` (`*.png`, `*.ico`, `*.webp` and the Hermes Agent icon in `hermes.svg`) are trademarks
  of their owners and are not covered by this license.
- The patches in `server/archive/` and `server/bridges/` change the mautrix bridges and stay under their AGPL-3.0.
- `server/edupage/bridge.py` uses [edupage-api](https://pypi.org/project/edupage-api/) (GPL-3.0-or-later), which
  the AGPL allows to combine with it.
