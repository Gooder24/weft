# Weft

Karchi's own Beeper: one inbox for EduPage, Messenger, Instagram, Discord and WhatsApp. Self-hosted on asus,
reached only over Tailscale. The product name is Weft (English, for marketing; chats are threads woven into one
inbox). The logo is `assets/icon.svg` (copied to `app/icon.svg` as the favicon). The folder is still `spojka`, and
the desktop shell keeps `app.setName('Správy')` so its profile and login survive.

Talk to Karchi in Slovak, briefly. Code and comments in English. Git: commit to `main` and push to github.com/Gooder24/weft (skill `github`). Never commit
secrets, tokens or screenshots of his chats.

The repo is public. Code, comments, docs and commit messages carry no real names, school, class, addresses, IDs
or other personal details: examples are made up, local values live in `~/.config/weft/weft.env` on asus. The
old private history is github.com/Gooder24/weft-archive; never push it here (a pre-push hook in each checkout
refuses it and scans for the names in `~/weft-private/`). `GOAL-*.md` plans stay local (ignored).

## Where things are

- `app/` is the live client: vanilla JS (`app.js`, `app.css`, `index.html`), no build. This folder is the source
  of truth. Asus serves a copy from `~/matrix-spike/app/` at https://<asus's Tailscale address>:8443 (and plain HTTP on
  127.0.0.1:8080 for SSH tunnels). Published clients use immutable `/releases/<hash>/` assets. Update detection compares the loaded release
  with `/release.json`; updates never automatically discard drafts, attachments or open editors.
- Rendering in `app/app.js`: views build a fresh tree with `h()` and `render()` patches it into the live DOM
  (`patchChildren`), keeping focus, caret and scroll. A handler must not use an element built in the same render
  (the patch may keep the old one): find it from the event (`e.currentTarget`, `closest`). Views that wire
  elements by hand are wrapped in `opaque()` and replaced whole. Lists pair children by `data-key`/`data-event`.
  The inbox draws only rows in sight. Checks: `overenie/rewrite/behave.cjs`, `noop-mutations.cjs`.
- Look: Weft wears Karchi's desktop (karchi-os `DESIGN.md`, desktop-future palette, Departure Mono 11 px),
  the same theme Kalendarix takes, with Kalendarix's rounding. New CSS uses the tokens at the top of `app.css`
  (`--accent` is a fill with `--accent-text` on it, `--link` the accent as text), no other colours, no shadows.
  Every button, row, icon and text follows `DESIGN.md` (icons only from `app/icons.js`, pixelarticons at 24 px;
  texts Slovak in `T()` with English in `app/i18n-en.js`, Settings → Správy → Jazyk); `tools/ui-check` checks it.
- `next/` is the old Svelte 5 demo (/next/index.html); it is no longer developed, the speed work happens in app/.
- `desktop/` is the Electron shell, installed on x270 in `~/.local/share/spravy`. Its login windows go out through
  an `ssh -D` tunnel to asus and wait until Meta's checks are done.
  Checks: `overenie/ig-checkpoint/` (`window.cjs`, `tunnel.cjs`).
- Server side lives only on asus in `~/matrix-spike/`: Tuwunel homeserver, bridges (mautrix-meta for
  Messenger and Instagram, legacy mautrix-discord, mautrix-whatsapp, own EduPage bridge), Caddy, systemd user
  units `matrix-spike-*` (`XDG_RUNTIME_DIR=/run/user/1000 systemctl --user ...`).
- `server/edupage/bridge.py` is the EduPage bridge source (asus `~/matrix-spike/edupage/bridge.py`, unit
  `matrix-spike-edupage`). It imports chat messages and school announcements into the inbox, including
  grade notifications, consent/sign-up requests and confirmations. Homework carries its deadline and the text
  and files of its material cards (read once, read-only; tests and cards that ask for an answer stay on EduPage). The full grade book stays in account data.
  Unknown text announcements are imported too; arrivals and meals remain optional. Each announcement type has
  its own name and mark in the inbox; a sign-up (Prihlasovanie) shows what it is, its window and Karchi's choice,
  and signing stays on EduPage. Which subjects and notices are Karchi's comes from EduPage's own data (bridge → account data
  `sk.karchi.edupage.facts`); Settings → EduPage (`sk.karchi.edupage.rules`) sets per notice type inbox/quiet/hidden,
  colour and mark, and overrides subjects; Weft, `weft read/search` and the Testy calendar follow it, and grades wear
  their subject's calendar colour (check: `overenie/edupage-rules/`). Ctrl+N reaches every current teacher (bridge `GET /contacts`), and messages and
  replies carry files (uploaded to EduPage like its own form, 25 MB each). Upcoming tests (exam events, homework titled as a test) go into the calendar „Testy“ at their lesson (uid `edupage-test-*`; the bridge writes through the calendar as Karchi's double puppet); a test naming pupils only when it names Karchi. Checks: `overenie/edupage-send/`, `overenie/run.sh --edupage`. Each successful poll logs counts and stores a `last_success` heartbeat. A new substitution or school event notice in the timeline makes the bridge ask the timetable backend to read EduPage again at once (`nudge_timetable`).
- `server/gmail/` is the Gmail bridge (deployed to asus `~/matrix-spike/gmail/`, unit `matrix-spike-gmail`,
  provisioning on 127.0.0.1:29323 behind Caddy's `/_bridges/gmail/`). It connects any number of Gmail
  accounts over IMAP, each signed in through Google (OAuth with Karchi's own Desktop client from
  `gmail/state/google-client.json`; he pastes the loopback address Google redirects to) or with a Google app
  password (state in `gmail/state/accounts.json`, mode 600).
  `import_mail.py` (unit `matrix-spike-gmail-import`) imports All Mail read-only into the archive, newest first,
  in resumable batches per account; it polls for new mail every five minutes. Attachments are content-addressed in `archive/media/gmail/` and served by the archive media API;
  `gmail_media_import` tracks read-only backfill of already archived mail.
  New mail (Ctrl+N → Nový mail, with files up to 25 MB) goes out through Gmail's SMTP with the same login
  (`POST /send/<login>`); Gmail keeps it in Sent. Checks: `overenie/gmail-send/run.sh`.
  One-time codes: the bridge watches each account's INBOX with IMAP IDLE (read-only, `server/gmail/codes.py`) and
  Weft shows a code in a small corner window within seconds (Enter copies, Esc closes; closing reaches every
  device); Settings → Účty → Gmail sets per account window / window and system notification / nothing. Codes
  stay in the bridge's memory only. „Window and notification“ also reaches a closed Weft: an empty Web Push
  (`server/gmail/push.py`, own VAPID key) to each phone or browser that allowed notifications, shown by `app/sw.js`
  without the code; the desktop shell has no push and instead keeps running hidden when its window is closed
  (Ctrl+Q quits, starting it again shows it). Checks: `overenie/gmail-codes/` (`heuristic_test.py`, `bridge.sh`,
  `ui.cjs`, `sw-push.cjs`, `shell.cjs`).
- `server/microsoft/bridge.py` is Outlook and Teams (asus `~/matrix-spike/microsoft/`, unit `matrix-spike-microsoft`,
  127.0.0.1:29330 behind Caddy's `/_bridges/outlook/` and `/_bridges/teams/`). Any number of Microsoft accounts of
  each, signed in on Microsoft's page through Microsoft Graph Command Line Tools (no own app needed; an Entra app in
  `microsoft/state/microsoft-client.json` replaces it; he pastes the `http://localhost` address it redirects to). Outlook works like Gmail: all mail read-only into the
  archive (`archive:outlook:…`, „Odpovedať mailom“), Nový mail and `weft mail` send through Graph (20 MB of files).
  Teams one-to-one, group and meeting chats are real rooms through the appservice `appservices/teams.yaml`
  (ghosts `@teams_<Entra id>`, polled every 20 s): text, mentions, photos, files, replies, edits, deletions and
  reactions both ways, and Karchi's reading as Teams „videné“ (whole chat, only once he reached its newest message); an ended call or meeting comes as a call row („Call (3:12)“ marked `com.beeper.action_message`, `call_log`); Ctrl+N finds people of the school or work directory. No team channels. Checks:
  `overenie/microsoft/` (`check.py` bridge against a fake Microsoft, `races.py`, `run.sh` UI, `cli_mail.sh`).
- `server/gmail/cleanup.py` and `matrix-spike-gmail-cleanup.timer` move explicitly enabled accounts'
  Gmail Promotions and Social categories to Trash every five minutes on asus, including old mail.
  Policy: `gmail/state/cleanup-policy.json`; private audit/status alongside it. Never empty Trash or
  expunge; connecting a new account does not enable cleanup. This runs without x270 and does not import mail into rooms.
- `server/calendar/kalendar.py` is Weft's calendar (asus `~/matrix-spike/calendar/`, unit `matrix-spike-calendar`,
  127.0.0.1:29327 behind Caddy's `/_calendar/`): a copy of Kalendarix's `calendars.json`, seeded from x270. The merge code in `server/calendar/x270/` is tested but its timer is not installed:
  ongoing two-way sync is still pending. The timetable calendar `lifeos-edupage` (uids `…@lifeos`) is not Karchi's to edit: the service mirrors it every 2 minutes from Kalendarix EduPage's backend on dell (`TIMETABLE_URL`, github.com/Gooder24/kalendarix-edupage, the same source x270's Kalendarix reads), substitutions („Suplovanie:“ with the substitute), cancelled („Odpadlo:“, struck through) and moved lessons included, and in a merge asus's copy of it wins; an open Weft rechecks `/_calendar/doc?have=<version>` every 2 minutes. Checks: `overenie/timetable/` (`mirror_test.py`, `notice_test.py`, `ui.cjs`). The shared workspace shows the message list and calendar at startup, and retains the calendar beside an open conversation (stacked in narrow windows); Ctrl+D focuses it (`app/calendar.js` +
  the calendar section of app.js); checks: `overenie/kalendar/run.sh`. Its editor does what Kalendarix's does: repetition
  (weekdays, nth/last weekday of the month, count or end date), reminder, category and second colour, and changing or
  deleting only one occurrence, it and the following, or the whole series; events move by dragging (a series moves
  whole); Settings → Kalendár hides calendars in Weft only (`sk.karchi.calendar.shown`). Off by default (Kalendarix gives every event 120 minutes for the phone), once Settings → Kalendár `notify` turns it on an event's reminder (`alarmMinutes`) shows a system notification at its time on each device where Weft runs
  (the desktop app keeps running hidden, so x270 hears it with the window closed; a missed one still comes until the event starts; a click
  opens the event with the keys in it); no Web Push to phones for it yet. Check: `overenie/pripomienky/run.sh`. A message that names a time
  („zajtra o 17:00 tréning“, „v piatok test z mat“) gets „Pridať do kalendára“ under it: on the device chrono-node
  (`app/chrono.js`, vendored) reads English and `app/when-sk.js` is its Slovak, and `app/when.js` judges what they
  found (rather none than a wrong one; corpus `tests/when/`); whether a doubted one („nemôžem“, „presúva sa“) is a
  plan the judge on asus decides (`server/when/judge.py`, POST `/_when/judge`, a small model in llama.cpp, units
  `matrix-spike-when` and `matrix-spike-when-llm`, set up by `server/when/setup.sh`; without it Weft offers only the
  undoubted ones); the click opens the editor filled over the chat, ✕ and Settings → Kalendár turn it off (`sk.karchi.calendar` `dismissed`, `suggest`); check `overenie/kalendar-navrh/run.sh`. `weft cal-*` reads and writes
  the same rules. Checks: `overenie/calendar-repeat/` (`ui.cjs`, `check_ops.py`, `parity.py`, `cli_rules.py`, `live.cjs`). Offline: `app/sw.js` keeps the app's files,
  app.js keeps the inbox in IndexedDB; check: `overenie/offline/offline.cjs`.
- Merged chats (like Beeper): one person's DMs on Messenger, Instagram, WhatsApp and Discord become one inbox row
  and one history. Clear cases merge on their own after each sync (`autoMerge`: the same full name, also with a middle
  name, only once on each network, or one person of the people map; same group ids on every device; Settings → Správy
  switches it off); others by Karchi's click (chat menu „Spojiť s…“, Ctrl+J, the suggestion under the title, or the
  list „Možno ten istý človek“ in Settings → Správy, where a short first name „Janka“/„Jana“ or a first name alone
  like „Majo“ is suggested but never merged on its own: Janko and Ján may be son and father). A pair taken apart or
  refused never merges again (`dismissed`). Account data `sk.karchi.merges`; the row's inbox state is under
  `merge:<id>`, `S.selected` stays a member room and the switch by the message box picks the network. Ctrl+K and `weft chats`
  show a merged chat as one row. Checks: `overenie/merged-chats/run.sh`, `overenie/auto-merge/run.sh`.
- People's look (Settings → Správy → Ľudia v chate): everyone's messages alike (default), „Farba“ (name and bubble
  edge in one of four palette colours: --message, --warning, --notice, --info) or „Farba a tvar“ (also the bubble's
  corners). A person's look comes from their id, a merged chat's from its group, so every device agrees; a group of
  up to 12 gives each joined member a different one, colours before shapes (so someone may look different there than
  in their own chat). The profile's „V správach“ picks one person's
  colour and shape, shown in every mode. Account data `sk.karchi.people.look` (`lookClass` in app.js; the class is
  part of bubbleKept's `sig`). Check: `overenie/ludia-vzhlad/run.sh`.
- A person's profile (their picture in the inbox, the chat's head or beside a group message, or chat menu → „Profil“;
  each network of a merged chat; on networks without one only name, picture and networks): WhatsApp's „about“ text and the
  person's statuses of the last day, Discord's bio, pronouns, banner or colour, activity, mutual servers and connected
  accounts. The bridges answer it through their provisioning APIs, patched (`server/bridges/whatsapp-weft-profile.patch`
  with `whatsmeow-status-stanza.patch`, which lets statuses into the status room, and `discord-weft-profile.patch`;
  build notes in each patch). The WhatsApp status room is no chat and never gets a receipt, so looking is never
  „videné“. Check: `overenie/profil-ludi/run.sh`.
  A click on the picture beside someone's message opens a small card out of it instead: how many messages the two
  wrote (theirs and Karchi's), since when, the longest run of days, how fast each answers and 24 months of counts,
  over the whole archive and every network of a merged chat (archive `GET /_archive/stats?room=…`, which first copies
  the rooms' newest messages from the homeserver); in a group it is Karchi's own chat with that person. Its name opens
  the profile. Check: `overenie/profil-karta/run.sh` (`stats_test.py`, `ui.cjs`).
- New chats (Ctrl+N): Weft's own people first; a full number typed there goes to WhatsApp at once, and „Hľadať mimo
  kontaktov“ asks one network (Messenger and Instagram by name, WhatsApp by number, Teams in the directory). „Nová
  skupina na WhatsAppe“ (also Ctrl+J) makes a group through the bridge's `POST /v3/create_group/group` after Karchi
  confirms; whom WhatsApp would not add gets the bridge's invitation in their chat only on a second yes. Following
  on Instagram and friend requests on Facebook or Discord stay in those apps (no bridge API, a ban risk). Check:
  `overenie/whatsapp-skupina/run.sh` (the bridge faked).
- Mentions (like Beeper): „@“ in a Messenger, Instagram, WhatsApp or Discord chat lists its people; a picked or fully
  typed „@Name“ goes out as a Matrix mention (`formatted_body` matrix.to link + `m.mentions`), which the mautrix
  bridges turn into the network's own. A picked name stays that person (two of the same name, text typed after it,
  a reload: picks are kept with the draft in localStorage `ep_picks:<user>`). Drafts, replies, edits, send-later and
  the merged chat's network switch keep it; incoming mentions show as pills (`mentionsIn`, `textMessage`, `readMentions` in app.js). The list shows each Messenger and
  Instagram person's @username and a name for ghosts Meta never named (archive `GET /_archive/rooms/{room}/people`: the
  bridge's database, else the export's sender at the same millisecond), never an internal id. Checks:
  `overenie/mentions/run.sh`, `overenie/mentions-ui/` (`run.sh` before/after screenshots, `people_test.py`, `picks.cjs`).
- A shared Instagram post or reel comes as its picture until Weft asks the bridge for it once in sight
  (`resolve_media`); a post with several photos or videos then lists them all in `com.beeper.meta.carousel`
  (`server/bridges/instagram-carousel.patch`, asus build/meta branch `weft-ig-carousel` on `weft-archive-ig`). The bubble
  shows each small under the large one and the viewer pages through them; the bridge's fill-in edit never waits for a
  reading window. Posts resolved before 2026-11-20 keep one photo. Check: `overenie/ig-carousel/ui.cjs`.
- `server/feed/feed.py` serves explicit daily reading on asus (unit `matrix-spike-feed`, localhost
  29328 behind `/_feed/`). Calendar occupies the unused message area and fits the full week/day without scrolling. Inbox, an open
  conversation and calendar share one workspace, without Calendar/Messages tabs. Feed opens through its
  bottom button or Ctrl+Shift+F without closing the conversation or discarding its draft.
  Feed and held messages share reading windows (`feed/data/window.json`, mirrored to account data
  `sk.karchi.window`): Karchi sets 1–8 a day himself in Settings → Správy (3 by default), each
  of 5–30 minutes (`feed/data/policy.json`, `POST /_feed/policy`). The feed server keeps the count. Feed's button,
  the eye, the chat's bar and the palette open the next one through `POST /_feed/window`. Opening again, reloads,
  other devices and restarts get the running one with the same end. Leaving Feed keeps it; „Skončiť okno“ ends it
  (`/window/close`, also offline) and it still counts. Messages that came before its end stay shown. „V časoch“
  batch times open their own windows of the same length. Every change of count, length, mode („Keď chcem“/„V
  časoch“), times or letting EduPage through applies from tomorrow (policy `next`, batches `pending`; new times
  count from that midnight, `timesFrom`), so changing a setting never shows anything early. Holding more starts at once.
  There is no „Hneď“ mode any more (Karchi, 16. 11.): a stored `live` turns into „Keď chcem“ on
  the next sync. Collection only happens inside Feed.
  People marked „Práca“ (chat menu → „Práca: ukázať hneď“, list in Settings → Správy; account data
  `sk.karchi.work`, `{ [user id]: { name, until? } }`) never wait: their messages show at once, in groups too;
  unmarking keeps `until`, so what was seen stays seen. Check: `overenie/work-people/run.sh`.
  Checks: `overenie/reading-window/run.sh`.
  Sources are RSS/Atom, YouTube channels (a channel, @handle or video address is stored as the channel's feed) and X
  profiles (`x.com/<name>`, read without a login through FxTwitter's public API `api.fxtwitter.com/2/profile/<name>/statuses`).
  Refresh reads them at most every 10 minutes and Instagram once a day; „Obnovené“ is the last successful read and
  expired stories are never shown. Check: `overenie/feed-sources/check.py` (offline, fakes every source).
  Instagram feed uses its own session (`feed/data/instagram-session.json`, mode 600); it never reads
  the message bridge's credentials. Connect/disconnect in Feed → Zdroje a filtre using the desktop login
  window. Connecting clears the previous IG cache and today's collection limit, not the reading window; disconnecting clears
  IG content and media while retaining RSS. Only an explicit feed refresh collects a bounded batch. Reconnect messages through Settings → Accounts →
  Instagram → Znova prihlásiť, retaining the existing login_id. Colours match Kalendarix 2 category/accent rules (`app/kalendarix-colors.js`); legacy school calendars
  default to automatic subject accents unless explicitly disabled. Checks: `overenie/shared-workspace/run.sh`.
- `server/cli/weft.py` is `weft`, Weft for agents (asus `~/matrix-spike/cli/`, its own device „Weft: agenti“,
  token in `cli/token`): chats, read, search, draft, send (with files; EduPage `--to` a teacher or `--reply`), Gmail
  mail, calendar. Every machine runs it as `weft` through
  karchi-skills `weft/` (over `ssh asus`). Drafts go to account data `sk.karchi.drafts`; Weft puts each on top of
  the chat's stash once (only `weft` prunes that list). Checks:
  `overenie/weft-cli/sends.sh`, `overenie/weft-cli/wrapper.sh`, `overenie/weft-cli/writes.py` (on asus) and `overenie/stash/cli.sh`.
- Stash („Odložené“, `app/stash.js`, account data `sk.karchi.stash`): drafts kept per chat for later, the same in every
  window and device; the message box itself stays per window. Ctrl+S (or „Odložiť“) asks when to remind: Ctrl+S
  again or Enter only stashes the box, 1–4 are Ctrl+L's times, and the chat goes away like Ctrl+L and comes back with
  that draft chosen (item `remind`, chat state `remind`). Ctrl+S in an empty box takes the only item or opens the list (Enter take, Ctrl+Enter send now, E edit, Alt+↑/↓ move, Delete, Ctrl+Z).
  Windows write only add/remove operations and apply them again until a sync shows them, so none undoes another; an
  item edited in two windows at once shows both versions. „Poslať“ (Ctrl+Enter) hands the draft to the send-later
  service as `stash-<id>`: it sends with one device and that id as the transaction id, so presses on several devices
  send it once. The window keeps its hand-over (localStorage `ep_stash_send:<user>`) and writes it again while the list
  lacks it (another window may overwrite the list); the draft shows „odosiela sa…“ and leaves only once the list says
  sent (in every window, also when the window that sent it is closed), a refused one stays with a note. The inbox row says „odložené N“. Checks: `overenie/stash/two.cjs` (two browser contexts against the
  fake homeserver `overenie/stash/fakehs.py`), `overenie/stash/send_once.py` (a throwaway Tuwunel).
- Old Discord messages (collect_history.py, GET only: the guild in `WEFT_DISCORD_GUILD` with DMs, another with `--guild ID --no-dms`) keep
  their attachments as rows without a file; the archive downloads one into `media/discord/` when Weft's file button
  or `weft file ID` asks, after Discord re-signs its expired link (`POST /attachments/refresh-urls`). A server's
  channels are titled „#kanál · Server“. Check: `overenie/discord-files/run.sh`. Collected Discord polls show as
  polls with Discord's counts as collected (archive `poll`, read-only); live ones come from the bridge patch
  `server/bridges/discord-polls.patch` on v0.7.7 (MSC3381 start with counts in `sk.karchi.discord.poll`, kept current
  by edits, Karchi's vote sent to Discord). `server/bridges/build-discord-weft` builds the running bridge: polls,
  `discord-weft.patch` (friends for Ctrl+N) and `discord-weft-profile.patch`, in that order, with `-tags nocrypto`, into asus
  `~/matrix-spike/bin/mautrix-discord` (the plain 0.7.7 is `mautrix-discord.bak-20261119-polls`). Check: `overenie/discord-ankety/run.sh`. Settings → Účty → Servery na
  Discorde switches each server on or off himself: on bridges a server the bridge does not have yet (provisioning
  `POST /v1/guilds/<id>`, all channels, no channel history), off only hides it in Weft and `weft`
  (`sk.karchi.discord.servers`; the bridge keeps it). Checks: `overenie/discord-servers/` (`run.sh`, `cli.py`).
- `server/links/links.py` reads shared links (asus `~/matrix-spike/links/`, unit `matrix-spike-links`,
  127.0.0.1:29329 behind Caddy's `/_links/`, Karchi's token only): one normalized card for IG/YouTube/TikTok/X/web
  from public pages only (no logins), refusing inside addresses and re-checking each redirect, with cache, dedup
  and its own rate limit. Weft asks for a card when it comes into sight (`app/links.js`), `weft read/search` print
  the same lines, `weft link <url>` reads one. A mail's generic links are read only on purpose (click tracking).
  Cards say plainly whether a transcript was read (TikTok subtitles) or only listed (YouTube). Checks:
  `overenie/shared-links/` (`cards.mjs`, `resolver_test.py`, `ui.cjs`, `live.txt`).
- `server/sendlater/` is the send-later service (source of truth here, deployed to asus `~/matrix-spike/sendlater/`,
  unit `matrix-spike-sendlater`): it sends the messages Weft keeps in account data `sk.karchi.sendlater` when due.
- GIFs (`/gif`, the GIF button) come from KLIPY with one key for the whole server, asus
  `~/matrix-spike/app/gifs.json` `{"klipy": "<key>"}` (not in git; a test key allows 100 requests an hour; a
  production key, asked for on partner.klipy.com, has no limit and no published price). KLIPY's terms want the browser to call it and load its media
  directly, so there is no proxy or cache. Check: `overenie/gify/run.sh`.

## Deploying app/

Compare the served stable app.js/app.css with the last deployment before writing; stop on concurrent changes.
Run `tools/deploy-app`: it builds immutable, content-addressed assets with `tools/release-app.py`, publishes
those first, retains stable root assets for old windows, then atomically switches index.html last. Keep old
release directories and shell caches for open/offline clients. Never publish app.js and app.css independently:
that can combine incompatible layouts. The generated release metadata and build directories are deployment
artifacts, not tracked source. Checks: `overenie/calendar-vanish/run.sh` covers old/new release transition,
draft protection and offline conversation/calendar.

## Rules that never bend

- Never send anything to real people: no message, reaction, read receipt or invite. Test sending against a
  fake, or intercept every non-GET request (see the test harness below).
- Test logins: `ssh asus 'python3 ~/matrix-spike/homeserver/mint-login-token.py'` gives an m.login.token;
  always log out at the end. Never print passwords or tokens.
- Karchi logs in to services himself. Never ask him for codes or QR codes; secrets only through
  `request_secret`. Never log in to Meta with a password through a bridge.
- No bans: do not change bridge backfill or rate limits and never start a mass history download without
  Karchi's explicit yes. Beeper Desktop is read-only, at most 1 request per second.
- `~/matrix-spike` has one owner thread at a time. Back up before every write there.
- Listen only on the Tailscale IP or localhost. Kill only PIDs you started. Keep the bridges' MemoryMax.
- Don't disturb the x270 desktop. Screenshots of his chats stay on his machines and get deleted.
- Decisions that need Karchi go to his inbox (asus `~/inbox/inbox.md`, skill `priority`), not as blocking
  questions.

## Testing

Real data through a tunnel, every write faked:

    ssh -N -L 18080:127.0.0.1:8080 asus &   # remember the PID and kill only it
    LOGIN_TOKEN=$(ssh asus 'python3 ~/matrix-spike/homeserver/mint-login-token.py') \
      NODE_PATH=/tmp/acc-test/node_modules tools/browser-slot node <test>.cjs

Every run that starts a browser goes through `tools/browser-slot` (`overenie/run.sh` does it by itself): one
browser per machine at a time, capped at 1.5 GB, so parallel threads queue instead of freezing a 3.7 GB machine.
Weft is developed on asus in `~/weft` (T3 project „Weft“ on asus), next to the server it serves, not on dell or
e540: their 3.7 GB could not hold several Weft threads with their browsers (dell froze on 2026-11-07 and again
later). Start a verifier (skill `overenie`) only with `tools/verify-on-asus <brief> [verdict]`: it runs as a
memory-capped unit in a copy of the tree, so it cannot hurt the live server. In a T3 thread run it in the
background and wait on the task. On asus `ssh asus` works too, so `tools/deploy-app` and the scripts in
`overenie/` run unchanged there.

For a mouse-driven desktop look, launch with `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`.

The release builder also rewrites absolute static resource paths inside published JS/CSS (lazy QR import,
emoji JSON, icons and font). Its own source participates in the release hash so changed transformation rules
never overwrite an existing immutable release.
