# Weft Telefón

A small Android app (Android 8 and newer, as Tailscale) that sends Karchi's SMS and the notifications of the apps he
ticks to Weft's connector host (`server/connect/phone.ts`). It reads only what is already on the phone, so no
platform sees anything new and no account can be banned. It needs Tailscale on the phone: Weft is reached only there.

- Pairing: Weft → Settings → Účty → Telefón → „Pridať telefón“ gives an address and a code for ten minutes. The app
  fetches Weft's CA (Caddy's internal one) once, claims the code and from then on trusts only that CA.
- SMS: received and sent, read from the phone's SMS store (the first time the last 30 days); the server makes one
  chat per number, Karchi's own as his messages. RCS does not reach other apps: tick Google Messages for those.
- Notifications: each ticked app is one chat; chat apps' messages one by one (MessagingStyle).
- Everything waits in a queue on the phone until Weft took it; a job sends it at once and every 15 minutes.
- „Odpojiť od Weftu“ here, and „Odpojiť“ in Weft (which ends the token), are the ways out.

Build on asus: `./build.sh` (gets the SDK parts and Gradle, no daemons, about 2.5 GB at its peak), `./build.sh publish`
also puts the APK at `~/matrix-spike/connect/state/weft-telefon.apk`, which Weft links to. Kotlin, no libraries.
