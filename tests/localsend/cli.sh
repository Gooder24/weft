#!/usr/bin/env bash
# The board against the official LocalSend CLI (github.com/localsend/localsend releases), pinned by version and hash.
# Everything runs in a new user and network namespace with one dummy interface: no port opens on this machine's
# networks. Usage: tests/localsend/cli.sh; NODE=<electron> runs it on Electron's own TLS (BoringSSL), as the app does.
set -eu
VERSION=1.19.0
SHA256=9076909a259288ae6458a04a4e032f4b6b0c9073cb446a106448aa393fe5f5a2
HERE=$(cd "$(dirname "$0")" && pwd)
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
curl -sSL -m 120 -o "$D/cli.tgz" "https://github.com/localsend/localsend/releases/download/v$VERSION/LocalSend-CLI-$VERSION-linux-x86-64.tar.gz"
echo "$SHA256  $D/cli.tgz" | sha256sum -c --quiet
mkdir "$D/x" && tar -xzf "$D/cli.tgz" -C "$D/x" localsend-cli
D="$D" timeout 170 unshare -rn sh -c '
  ip link set lo up && ip link add d0 type dummy && ip addr add 10.77.0.1/24 dev d0 &&
  ip link set d0 multicast on && ip link set d0 up && ip route add 224.0.0.0/4 dev d0 &&
  ELECTRON_RUN_AS_NODE=1 "${NODE:-node}" "$0"' "$HERE/cli.cjs"
