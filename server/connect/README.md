# Connectors

Chats made from the mails a platform already sends (design: `docs/navrhy/2026-11-konektory/`). The host never
talks to the platform: it reads new Gmail and Outlook mail in `archive.db` (read-only), each connector's rules turn
a mail into items, and the host posts them into one Matrix room per thread (a Vinted item, a parcel) through the
appservice `appservices/connect.yaml`. So no connector can get an account blocked. Rooms are read-only in Weft
(„Otvoriť Vinted“) and in `weft send`.

Runs on asus as `matrix-spike-connect` (Bun, `~/matrix-spike/connect/`, 127.0.0.1:29335 behind Caddy's
`/_connect/`). State: `state/connect.db` (where each connector is in the archive, rooms, ghosts, what was posted,
the switches). The first start, and a connector turned on again, looks back 30 days; items older than a day come
read. Settings → Účty → „Z mailov“ turns each one on or off (`GET`/`PUT /_connect/connectors[/<id>]`, Karchi's token).

## A new platform

1. `connectors/<id>.ts`: `export const <id>: Connector` with `mail.from(sender)` and `mail.parse(mail) → Item[]`
   (pure: no `fetch`, no files). One `thread` per chat; `from` names the person, else the connector speaks.
2. A line in `connectors/index.ts`, a test with made-up mails in `connect.test.ts`, `bun dry-run.ts` on asus to
   see what the last 30 days would give (writes nothing).
3. Its icon in `app/` and a line in `CONNECTORS` in `app/app.js` (and `NETWORKS`), and its id in `NETWORKS`
   and `READ_ONLY` of `server/cli/weft.py`.

Checks: `bun install && bun run check` (tsc strict and `bun test`: the rules, then the host against a fake
homeserver and a throwaway archive).

## Appservice registration

`id: connect`, `url: http://127.0.0.1:29335`, `sender_localpart: connectbot`, users `^@connectbot:<server>$` and
`^@cx_.*:<server>$` exclusive, random `as_token`/`hs_token`, mode 600. The homeserver reads it at start.

Stop: `systemctl --user disable --now matrix-spike-connect`; its rooms stay in Weft and can be archived there.
