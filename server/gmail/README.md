# Gmail accounts and category cleanup

`bridge.py` connects Gmail accounts for Weft using IMAP app passwords or Google
OAuth. `import_mail.py` reads Gmail All Mail into Weft's SQLite archive, grouped by
account and Gmail thread ID. It uses read-only SELECT and BODY.PEEK, imports newest
first in batches of 100 per account, and resumes using mailbox UIDVALIDITY and UID.
The service polls every five minutes once caught up; it does not send mail or
change mailbox flags. Sending is the bridge's `POST /send/<login>` (Weft's Nový mail): Gmail SMTP with the
account's own app password or Google login, attachments read from the homeserver, 25 MB in total. Mail is available in Archive and search. Attachments are stored under `archive/media/gmail/`
by SHA-256 and linked through `message_media`; old attachment-bearing messages are
backfilled read-only in resumable batches (`gmail_media_import`). UID state and
media rows commit together, so restart and repeated passes do not duplicate files.
Deploy `import_mail.py` next to `cleanup.py`, install `matrix-spike-gmail-import.service`
and enable it with `systemctl --user enable --now matrix-spike-gmail-import`.
Stop/disable that unit to stop importing; previously archived mail remains readable.

One-time codes: `bridge.py` keeps one IMAP IDLE connection on INBOX per account whose code setting is not
"nič" (Weft → Settings → Účty → Gmail: window, window and system notification, or nothing; stored as
`codes` in `accounts.json`, default window). INBOX is opened read-only and mail is fetched with BODY.PEEK, so
nothing is marked read. `codes.py` decides what is a code (a keyword such as code/kód/overovací near 4–8
digits or a short capital-and-digit token; discount, order, tracking and payment numbers are not). Codes of
the last ten minutes live only in the bridge's memory and reach Weft through a long poll (`GET /codes`),
usually within a second or two; the import's five minutes would be too late for codes that expire.
Only INBOX is watched: mail a Gmail filter archives, and Spam, never pops up. A restart of the bridge forgets
the codes and looks back over the last two minutes. An account set to "window and system notification" also
sends a Web Push (`push.py`) to every phone or browser where Weft once allowed notifications, so a closed Weft
hears of the code too. The push is empty and signed with the bridge's own VAPID key (`state/vapid.pem`, made by
openssl on first use; devices in `state/push.json`, both mode 600): Google's or Apple's push service learns only
that something happened. Checks: `overenie/gmail-codes/` (local, gitignored).

`cleanup.py` runs on asus independently of x270. It uses Gmail's actual
`category:promotions` and `category:social` search, including archived mail, and
atomically moves matching messages to the special-use Trash mailbox. Sent mail,
drafts, spam and existing trash are excluded. It never permanently deletes mail,
expunges, sends mail or marks mail read. Gmail's own Trash retention still applies.

The worker reuses `state/accounts.json` from the bridge. No new credentials are
needed. `state/cleanup-policy.json` explicitly enables selected accounts:

```json
{"enabled_accounts": ["your-account@gmail.com"]}
```

An absent policy fails closed; an empty list does nothing. Connecting another
account in Weft does not automatically opt it into cleanup. State files are private
(0600), and no account data belongs in this repository. `cleanup-status.json`
records the latest attempt and last successful run.
Configuration failures also update the attempt status while preserving the last
successful timestamp. A malformed previous status does not block a new run.
`cleanup-audit.jsonl` stores message UIDs, Gmail message IDs and pre-move flags
before each move and its result.
An intent without a completion may indicate a lost response; check the mailbox
before treating it as a failed move. UID values are local to the recorded source
mailbox, while Gmail message IDs survive moves.

Deployment on asus: copy the script alongside `bridge.py`, copy the service and
timer to `~/.config/systemd/user/`, then `systemctl --user daemon-reload` and
`systemctl --user enable --now matrix-spike-gmail-cleanup.timer`. Back up existing
files before changing them. `cleanup.py` alone is a read-only dry run; pass
`--apply` to move messages. The first apply cleans existing history in the two
categories. The timer checks every five minutes without AI calls, using a 64 MB
memory limit and no dependency on a desktop or SSH connection. Failures retry on
the next timer tick; missing Gmail extensions/folders fail rather than falling
back to delete commands.

Disable the timer with `systemctl --user disable --now matrix-spike-gmail-cleanup.timer`.
This does not restore moved messages or empty Trash. Restore selected mail in
Gmail's Trash if needed.

Verification: `overenie/gmail-cleanup/run.sh` (local, gitignored).
