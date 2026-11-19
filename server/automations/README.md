# Read-only automations

`/automatizacie/` ("Stroje a procesy", also in Weft's menu) is a task manager for all machines. On top, one tile per
machine with live CPU (6-minute graph), RAM, disk, temperature, battery and uptime. Below, per machine: failures,
what runs now (live CPU and RAM per service or container, from cgroups), what runs later (when and in how long),
then the folded off/finished list. Each row folds out its details. Machines with failures come first.
Browser Ctrl+F also reaches folded rows; Electron has a minimal Ctrl+F fallback that opens the matching row.
The page polls `/_automations/stats` every 5 s and `/_automations/data` every minute, only while visible.

Backend: karchi-skills `inventory/automations/{agent,stats,manager}.py`, loaded by `prehlad.service`.
Only GET `/_automations/data` and `/_automations/stats` are supported; POST is rejected and the host agent only collects. It needs no login:
Caddy serves it only on the tailnet address and localhost. Private configuration/deletion metadata is stripped.

Deploy `app/automatizacie/` alongside Weft. Caddy's Weft proxy adds `X-Weft-Route: 1` for
`/_automations/*` to localhost:3460. Legacy `/prehlad/*` proxies block that path and strip the marker.
Static routes use `try_files {path} {path}/index.html /index.html`. Restart prehlad after backend changes.
Local current checks: `overenie/automations-readonly/run.sh`. Earlier deletion tests are historical only.
