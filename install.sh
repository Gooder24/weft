#!/usr/bin/env bash
# Weft on one Debian or Ubuntu machine, or on Windows inside Debian in WSL (install.ps1 runs this there):
# the homeserver, the app on http://localhost:8790 and a daily update from the repository.
#
#   sudo ./install.sh            install or repair; the last line is the address that creates the first account
#   sudo ./install.sh --update   what the daily timer runs: pull the repository, then install again
#   sudo ./install.sh --remove   stop and remove Weft's services and programs; the data in /var/lib/weft stays
#
# Chat networks (bridges) are not installed yet. Everything listens on this machine only (127.0.0.1).
set -euo pipefail

REPO_URL=${WEFT_REPO:-https://github.com/Gooder24/weft}
PORT=${WEFT_PORT:-8790}
BIND=${WEFT_BIND:-127.0.0.1 [::1]} # only tests in a container widen it
TUWUNEL_VERSION=1.9.4
TUWUNEL_SHA256=0c6fad8c69aaf8d8e6cc0c58a6d1f407c0009aafe53517b4d7784367a092664b
ROOT=/opt/weft SRC=/opt/weft/src DATA=/var/lib/weft ETC=/etc/weft UNITS=/etc/systemd/system

say() { printf 'weft: %s\n' "$*"; }
die() { printf 'weft: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || exec sudo -E "$0" "$@"

if [ "${1:-}" = --remove ]; then
  systemctl disable --now weft-update.timer weft-web.service weft-homeserver.service 2>/dev/null || true
  rm -f "$UNITS"/weft-{homeserver,web,update}.service "$UNITS"/weft-update.timer
  systemctl daemon-reload
  rm -rf "$ROOT"
  say "removed; your messages and settings are still in $DATA and $ETC (delete them to start over)"
  exit 0
fi

# The daily update: the new install.sh from the repository does the rest.
if [ "${1:-}" = --update ]; then
  # The copy in $SRC is Weft's own and follows the repository exactly, also when its history was rewritten.
  git -C "$SRC" fetch -q origin main
  git -C "$SRC" reset -q --hard FETCH_HEAD
  exec "$SRC/install.sh" --installed
fi

# WSL runs services only with systemd, which has to be switched on once and needs WSL to start again (exit 3).
if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && [ ! -d /run/systemd/system ]; then
  grep -q '^systemd *= *true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf
  say "systemd switched on in WSL; restart WSL (wsl --terminate <distribution>) and run this again"
  exit 3
fi
[ -d /run/systemd/system ] || die "needs a machine that runs systemd"
[ "$(uname -m)" = x86_64 ] || die "only x86_64 for now (this is $(uname -m))"

say "installing packages (git, curl, zstd, caddy)"
export DEBIAN_FRONTEND=noninteractive
had_caddy=$(dpkg-query -W -f='${Status}' caddy 2>/dev/null | grep -c 'install ok installed' || true)
apt-get update -qq
apt-get install -y -qq git curl zstd caddy ca-certificates >/dev/null
# Debian's caddy package also starts its own caddy.service on port 80 of every interface. Weft runs a separate Caddy,
# so when this installed the package, that one is switched off; a Caddy that was here before stays as it was.
[ "$had_caddy" = 1 ] || systemctl disable -q --now caddy.service

id weft >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin weft
install -d -m 755 "$ROOT" "$ROOT/bin" "$ETC"
install -d -m 750 -o weft -g weft "$DATA"

# The checkout that updates pull. Run from a clone (also one on Windows, under /mnt/c), it starts from that clone.
if [ ! -d "$SRC/.git" ]; then
  here=$(dirname "$(readlink -f "$0")")
  if [ -d "$here/.git" ]; then
    # The clone belongs to another user (root runs this; on Windows it is under /mnt/c), so git must trust it. A local
    # clone hides -c and GIT_CONFIG_* from the other side, hence root's own git configuration, for this one folder.
    for dir in "$here" "$here/.git"; do
      git config --global --get-all safe.directory | grep -qxF "$dir" || git config --global --add safe.directory "$dir"
    done
    origin=$(git -C "$here" remote get-url origin 2>/dev/null || echo "$REPO_URL")
    git clone -q "$here" "$SRC"
    git -C "$SRC" remote set-url origin "$origin"
  else
    git clone -q "$REPO_URL" "$SRC"
  fi
fi

if [ "$("$ROOT/bin/tuwunel" --version 2>/dev/null)" != "tuwunel $TUWUNEL_VERSION" ]; then
  say "downloading the homeserver (Tuwunel $TUWUNEL_VERSION)"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/tuwunel.zst" \
    "https://github.com/matrix-construct/tuwunel/releases/download/v$TUWUNEL_VERSION/v$TUWUNEL_VERSION-release-default-x86_64-v1-linux-gnu-tuwunel.zst"
  echo "$TUWUNEL_SHA256  $tmp/tuwunel.zst" | sha256sum -c --quiet || die "the homeserver download does not match its checksum"
  zstd -dq "$tmp/tuwunel.zst" -o "$tmp/tuwunel"
  install -m 755 "$tmp/tuwunel" "$ROOT/bin/tuwunel"
fi

# The token that lets the first account be created; made once, kept with the configuration.
if [ ! -s "$ETC/registration-token" ]; then
  (umask 027; head -c 18 /dev/urandom | base64 | tr '+/' '-_' > "$ETC/registration-token")
  chgrp weft "$ETC/registration-token"
fi
# The server's name is part of every account (@name:server) and can never change, so it is written only once.
if [ ! -f "$ETC/tuwunel.toml" ]; then
  name=$(hostname | tr 'A-Z' 'a-z' | tr -c 'a-z0-9.\n-' '-')
  cat > "$ETC/tuwunel.toml" <<EOF
[global]
server_name = "$name"
database_path = "$DATA/tuwunel"
address = ["127.0.0.1"]
port = 6167
allow_registration = true
registration_token_file = "$ETC/registration-token"
allow_federation = false
max_request_size = 104857600
new_user_displayname_suffix = ""
EOF
fi

cat > "$ETC/Caddyfile" <<EOF
{
	admin off
	auto_https off
}
:$PORT {
	bind $BIND
	handle /_matrix/* {
		reverse_proxy 127.0.0.1:6167
	}
	handle {
		root * $SRC/app
		file_server
	}
}
EOF

cat > "$UNITS/weft-homeserver.service" <<EOF
[Unit]
Description=Weft homeserver (Tuwunel)
After=network-online.target
Wants=network-online.target

[Service]
User=weft
ExecStart=$ROOT/bin/tuwunel --config $ETC/tuwunel.toml
Restart=on-failure
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
EOF
cat > "$UNITS/weft-web.service" <<EOF
[Unit]
Description=Weft app on http://localhost:$PORT
After=weft-homeserver.service

[Service]
User=weft
ExecStart=/usr/bin/caddy run --config $ETC/Caddyfile --adapter caddyfile
Restart=on-failure
MemoryMax=200M

[Install]
WantedBy=multi-user.target
EOF
cat > "$UNITS/weft-update.service" <<EOF
[Unit]
Description=Update Weft from its repository
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$SRC/install.sh --update
EOF
cat > "$UNITS/weft-update.timer" <<EOF
[Unit]
Description=Update Weft every day

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable -q weft-homeserver.service weft-web.service weft-update.timer
systemctl restart weft-homeserver.service weft-web.service
systemctl start weft-update.timer

for _ in $(seq 60); do
  curl -fsS "http://127.0.0.1:$PORT/_matrix/client/versions" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/_matrix/client/versions" >/dev/null || die "Weft did not start; see journalctl -u weft-homeserver -u weft-web"

say "Weft runs on http://localhost:$PORT and updates itself every day"
# The address with the token that creates accounts goes only to the person installing, never into the daily
# update's journal.
[ "${1:-}" = --installed ] || echo "WEFT_URL=http://localhost:$PORT/#weft-setup=$(cat "$ETC/registration-token")"
