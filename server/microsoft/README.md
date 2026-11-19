# Outlook and Teams

`bridge.py` connects Microsoft accounts for Weft (unit `matrix-spike-microsoft`, provisioning on
127.0.0.1:29330, behind Caddy's `/_bridges/outlook/` and `/_bridges/teams/`). Each account signs in on
Microsoft's page; Karchi pastes the `http://localhost/?code=…` address it sends him back to. Outlook and Teams
are connected separately, any number of each. State: `~/matrix-spike/microsoft/state/` (mode 600):
`accounts.json` (refresh tokens), `teams.db`, optionally `microsoft-client.json`.

## Which app signs in

Without `microsoft-client.json` the sign-in goes through Microsoft's own public app for using one's own Graph data,
Microsoft Graph Command Line Tools (`14d82eec-204b-4c2f-b7e8-296a70dab67e`): school, work and personal accounts,
redirect `http://localhost`, nothing to register. Microsoft asks for consent to the scopes on the first sign-in. A
school or firm that lets users consent to no app sends that to its admin; that is its rule, not something to work
around. An own Entra app („Public client“, `http://localhost`, public client flows on, the delegated Graph scopes
`offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `User.ReadBasic.All`, `Chat.ReadWrite`,
`Files.ReadWrite.All`) goes into `state/microsoft-client.json` as `{"client_id": "…"}`, mode 600, for new sign-ins.
Each login remembers its app and renews with it.

## Outlook

Like Gmail: mail of every folder (drafts excepted) goes into the archive, read-only, 100 messages a batch, newest
first, then new mail every five minutes (`outlook_import` in archive.db keeps where each account is). Chats are
`archive:outlook:…`, one per conversation, titled „account · subject“; attachment names stay in the text.
`POST /outlook/…/send/<login>` (Weft's Nový mail, „Odpovedať mailom“, `weft mail --from`) sends through Graph;
Outlook keeps it in Sent Items. Files up to 20 MB together; files under 3 MiB go inline, bigger ones in an upload
session. Nothing is marked read, moved or deleted.

## Teams

One-to-one, group and meeting chats become Matrix rooms through the appservice `appservices/teams.yaml`
(`@teamsbot`, ghosts `@teams_<Entra id>`): text, mentions, photos and files, replies, edits, deletions and
reactions both ways. Graph has no push for a personal login, so the bridge polls every 20 s (recent chats); each
round it also looks again at two recently active chats and at one more of all of them in turn, for edits, reactions
and deletions that do not move a chat. Messages are kept per room: a Teams message id is unique only in its chat. The first sync of a chat brings its last 14 days,
marked read. Team channels are not bridged (they need a tenant admin).

Karchi's reading goes to Teams („videné“): his public receipt in a Teams room marks that chat read
(`markChatReadForUser`, Graph marks only a whole chat), only when the receipt reaches the newest message someone else
wrote there, Teams' 50 newest messages hold one of someone else and every such one was brought by the bridge, and something
came since the last time; at most once per chat every 5 s (longer when Microsoft says so). Graph's action has no message
boundary: a message arriving in Teams between the bridge's last look at the chat (one request) and the mark is marked
read with it. Weft's receipt stops before a message waiting for its reading window, so that one is never
seen. History the bridge marks read itself never goes back to Teams. Whether the other person sees it depends on
read receipts being on in Teams for both of them (a school can turn them off). Teams' „píše…“ has no Graph API.

Appservice registration: `id: teams`, `url: http://127.0.0.1:29330`, `sender_localpart: teamsbot`, users
`^@teamsbot:<server>$` and `^@teams_.*:<server>$` exclusive, random `as_token`/`hs_token`, `receive_ephemeral: true`
and `de.sorunome.msc2409.push_ephemeral: true` (receipts); the homeserver reads it at start.

Stop: `systemctl --user disable --now matrix-spike-microsoft`; signing out an account in Weft drops its token.

Checks (local, gitignored): `overenie/microsoft/check.py` (fake Microsoft and a throwaway homeserver),
`races.py` (a refresh racing a new sign-in or a sign-out, the 3 MiB line), `run.sh` (UI), `cli_mail.sh` (`weft mail`).
