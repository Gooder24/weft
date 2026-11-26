# EduPage bridge

`bridge.py` is deployed on asus at `~/matrix-spike/edupage/bridge.py`, running in the existing
venv (`edupage_api` 0.13.3, requests) under `matrix-spike-edupage.service`.
The unit provides ADMIN_MXID, REGISTRATION, DOUBLEPUPPET and STATE_DIR; keep its 128 MB memory limit
and localhost-only provisioning listener. Credentials and SQLite state must stay outside git.

Messages become Matrix threads. School announcements, including grade notifications, events,
homework, sign-up/consent requests and unknown text announcements, become inbox notices. Confirmations
are replies to the original message. Source `data.edupageLink` actions appear beside the announcement with their original label and exact
school URL (for example, iBobor’s interest form). Opening a notice never executes the action.
What is Karchi's is worked out from EduPage's own data, never guessed: with the grade book every 30 minutes
the bridge writes `sk.karchi.edupage.facts`: each subject with whether it is his and why (his own timetable
from edupage.org, kept once seen; the calendar copy of it; a grade; EduPage listing him among an event's
pupils; a post to the subject group's own CustPlan), his groups, and per notice its subject and whether it is
for other pupils (pupils listed without him, another group of a kind he is in, a retake naming classmates).
Weft (Settings → EduPage, `sk.karchi.edupage.rules`) shows, mutes or hides each notice type, gives it a colour
(also its subject's calendar colour) and a mark, and hides notices of subjects that are not his and notices for
others; Karchi's word overrides each subject. `weft read/search` hides the same. Tests in subjects that are not
his stay out of the Testy calendar. Substitution notices only say a new substitution is up for the whole school
and are hidden by default; absence notices use an exclamation icon and remain informational.
Importing an announcement never confirms, signs or marks anything
read on EduPage. Links open actions on the school website. Arrivals and meals remain opt-in.
Homework titles are read from `data.nazov` when the timeline text is empty. Changed announcements
use Matrix edits, so their existing thread stays intact and polling does not repeat the edit.
The full grade book refreshes separately every 30 minutes, as before.

Before deployment, compare the live bridge SHA256 with the version you read, back it up, then copy
this file and restart only `matrix-spike-edupage`. Do not replace or reset state/backfill flags.
Check `journalctl --user -u matrix-spike-edupage`: each successful poll reports source and posted counts.
The SQLite kv `last_success` and provisioning `whoami.last_success` record successful polling.
Invalid timeline payloads trigger session recovery instead of being treated as empty successful polls.

Karchi's messages and replies may carry files (`sk.karchi.edupage.files`): the bridge reads them from the
homeserver, uploads them through EduPage's own `uploadAtt` and sends them as the message's attachments; a
refused file stops the message and says why. `GET /contacts` lists the school's current teachers, who can be
written to before they ever wrote. Sign-up notices carry `sk.karchi.edupage.signin` (name, type, window, choice).

A reply goes where Karchi chose, like edupage.org's reply box: in a thread that did not go to him alone the bridge
marks its first message in account data `sk.karchi.edupage.replies` (`all`: Weft asks „Len <autor> / Všetkým“,
the author by default; `author`: the author allowed only replies to themselves) and sends createReply's `recipient`
as the author's user string unless the reply says `sk.karchi.edupage.reply_to: all`. EduPage often answers a send
without its id (no `changes`); the bridge then finds the item among the thread's replies or the message tab, so it
is never reported as failed nor imported twice. Check: `tests/edupage/reply_test.py` (bridge venv).

Run `overenie/run.sh --edupage` for fake regression cases and read-only source-to-Matrix comparisons.
Those local checks live in the globally ignored `overenie/` directory, per the verification skill.
