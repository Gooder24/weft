# Weft on each operating system

Weft is used every day on one Linux laptop (the desktop app) and in Chromium; every other system is built or
written for but not yet tried by a person. This page says what each system has, what is only checked by a machine,
and what someone has to try there. Change a row when a system is tried, not when code for it is written.

Words used below:

- **used**: in daily use on that system.
- **CI**: a GitHub Actions run on that system checks it, with stand-ins (no real accounts, no real window shown).
- **untried**: the code is meant to work there, but nobody has run it on that system.
- **no**: not available on that system.

## The desktop app (`desktop/`)

Built only for Windows (`Weft-Setup.exe` from `.github/workflows/windows-app.yml`) and run from source on Linux.
There is no macOS build: `desktop/package.json` has no `mac` target.

| Feature | Linux | Windows (Weft.exe) | macOS |
|---|---|---|---|
| The app starts and opens the server | used | CI (a hidden self-test against example.com) | no build |
| Sign-in windows for Messenger, Instagram and Discord | used, through an `ssh -D` tunnel to the server | untried; the installed app goes direct, without a tunnel | no build |
| Call windows (Messenger, Instagram, Discord) | self-test under Xvfb | untried (camera and microphone prompts) | no build |
| Follow window (Instagram, Facebook) | self-test under Xvfb | untried | no build |
| „Prejsť z Beeperu“ (Beeper Desktop's folder) | CI with a made-up Beeper folder | CI with a made-up Beeper folder | CI with a made-up Beeper folder, but no build to run it in |
| Nástenka (LocalSend) | `tests/localsend/` (with the official LocalSend CLI) and the self-test | untried: needs `tailscale` on the PATH, and Windows Firewall asks on the first listen | no build (Tailscale's app keeps its CLI outside the PATH) |
| System notifications (calls, calendar reminders) | checked in Chromium (`overenie/pripomienky/`) | untried: `main.js` sets no AppUserModelID, which Windows may need to show them | no build |
| Shortcuts | used (Ctrl, Super+W) | untried (Alt+F4 instead of Super+W) | no build (the app takes Cmd as Ctrl) |

## The web client (`app/`)

| Where | State |
|---|---|
| Chromium on Linux | used; every check in `overenie/` and `tests/` drives headless Chromium |
| Chrome or Edge on Windows, Chrome on macOS | untried |
| Firefox, Safari | untried |
| Android, Chrome | untried on a phone: offline mode and Web Push are checked only in headless Chromium |
| iPhone, Safari | untried; Web Push works there only after „Add to Home Screen“ |

## The server

| How | State |
|---|---|
| The owner's host (Debian 13, systemd user units, Caddy) | used |
| `install.sh` on Debian 13 | checked in a throwaway Debian 13 container, archive and `--remove` included |
| `install.sh` on Ubuntu | untried |
| `install.ps1` on Windows 10 or 11 (Debian in WSL) | untried |
| macOS | no |

## Weft Telefón (`android/`)

Built for Android 8 and newer and checked against stand-ins (`overenie/telefon/run.sh`). Untried on a real phone:
SMS both ways, app notifications, and answering through a notification's Reply button. There is no iPhone app.

## What to try on each system

Use a made-up account or your own, never send to other people while trying, and write the result into the tables
above.

**Windows 10 or 11 (Weft.exe):**

1. Install `Weft-Setup.exe` without administrator rights; Weft is in the Start menu and on the desktop and opens
   the server.
2. Sign in to Messenger or Instagram in its window; the session reaches the bridge.
3. Turn on calendar reminders and make an event in two minutes; a Windows notification comes and opens the event.
4. With Tailscale and LocalSend on another device, send a file through Nástenka both ways; it lands in
   Downloads\Weft. Note whether Windows Firewall asked.
5. „Prejsť z Beeperu“ with a real Beeper Desktop of someone who uses it (not the owner's): the count, the import,
   photos in the chats, and nothing changed in `%APPDATA%\BeeperTexts`.
6. A call window: the camera and microphone prompts, and the call ends when the window closes.

**Windows, the server (`install.ps1`):**

1. On a Windows without WSL: WSL and Debian install, restart, run again, and Weft opens on http://localhost:8790.
2. A user folder with a diacritic (`C:\Users\Lukáš`) works.
3. The uninstall steps at the top of `install.ps1` leave nothing behind.

**Ubuntu (`install.sh`):** the current LTS in a VM: install, first account, the daily update, `--remove`.

**macOS:** first a build (an electron-builder `mac` target, signed or with the steps to open an unsigned app),
then steps 1–5 of Windows, with Beeper in `~/Library/Application Support/BeeperTexts` and the Tailscale CLI found
where the Mac app keeps it.

**Phones:**

1. Android, Chrome: open Weft, allow notifications, close the tab; a one-time Gmail code brings a push.
2. Offline: open a chat, turn on airplane mode, reload; the inbox and the chat are there.
3. iPhone: add Weft to the Home Screen, then the same two steps.
4. Weft Telefón on a real Android: pair with the 10-minute code, an SMS comes into Weft and one goes out from it,
   and a ticked app's notification makes a chat.

**Other browsers:** Firefox and Safari: sign in, read, write a draft, search (Ctrl+K), the calendar and Feed.
