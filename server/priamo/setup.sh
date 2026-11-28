#!/bin/sh
# Sets up or updates Weft Priamo on this machine (docs/navrhy/2026-11-priamo/), with passwordless sudo:
#   setup.sh <dir> <unit>        asus: ~/matrix-spike/priamo matrix-spike-priamo
# - the contacts-only firewall as the system unit weft-priamo-firewall, loaded before Yggdrasil can start;
# - Yggdrasil (Debian package) on ygg0, dialling out to PRIAMO_PEERS only: no listener, no multicast;
# - tuwunel-priamo named by this node's Yggdrasil address, on that address and 127.0.0.1 port 8448, as the user
#   unit <unit>, with its database, certificate and registration token in <dir>.
# <dir> must hold priamo.nft and allowlist.toml rendered from its priamo.json (`bun priamo.ts render`, on a machine
# with Bun; the first run may use an empty contact list) and the binary in <dir>/bin/tuwunel-priamo. Run it again
# after a new render: it applies the firewall and restarts Tuwunel with the new allowlist. It prints the address.
# Way out: systemctl --user disable --now <unit>; sudo systemctl disable --now yggdrasil weft-priamo-firewall;
# sudo nft delete table inet weft_priamo; sudo apt-get purge yggdrasil.
set -eu
DIR=$(realpath "$1") UNIT=$2
PEERS=${PRIAMO_PEERS:-tls://ygg-ke.8px.sk:4321 tls://37.205.14.171:993?key=0009e16b9e3afe7b13c3612560410434d3dfc70c8a8a0a63e51e0470cb8124f6}
for f in priamo.nft allowlist.toml bin/tuwunel-priamo; do
  [ -e "$DIR/$f" ] || { echo "setup.sh: chýba $DIR/$f" >&2; exit 1; }
done
grep -q 'iifname "ygg0" drop' "$DIR/priamo.nft" || { echo "setup.sh: priamo.nft nie je pre ygg0" >&2; exit 1; }

# The firewall first: ygg0 must never be up without it, as every service listening on :: would answer there.
# A file nft refuses never replaces the one the next boot loads.
sudo nft -c -f "$DIR/priamo.nft"
sudo install -D -m 644 "$DIR/priamo.nft" /etc/weft-priamo/priamo.nft
sudo tee /etc/systemd/system/weft-priamo-firewall.service >/dev/null <<'EOF'
[Unit]
Description=Weft Priamo firewall: only contacts reach Priamo over Yggdrasil
Before=yggdrasil.service network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/weft-priamo/priamo.nft
ExecReload=/usr/sbin/nft -f /etc/weft-priamo/priamo.nft
ExecStop=/usr/sbin/nft delete table inet weft_priamo

[Install]
WantedBy=multi-user.target
EOF
sudo install -d /etc/systemd/system/yggdrasil.service.d
sudo tee /etc/systemd/system/yggdrasil.service.d/weft-priamo.conf >/dev/null <<'EOF'
[Unit]
Requires=weft-priamo-firewall.service
After=weft-priamo-firewall.service
EOF
sudo systemctl daemon-reload
sudo systemctl enable -q weft-priamo-firewall
if systemctl is-active -q weft-priamo-firewall; then sudo systemctl reload weft-priamo-firewall
else sudo systemctl start weft-priamo-firewall; fi

command -v yggdrasil >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q yggdrasil >/dev/null
CONF=/etc/yggdrasil/yggdrasil.conf
sudo test -s "$CONF" || sudo sh -c "umask 077; yggdrasil -genconf > $CONF"
peers=$(printf '%s\n' $PEERS | jq -R . | jq -sc .)
# The file holds the node's private key, which is its address: a new file is written only when it kept the key.
sudo grep -q PrivateKey "$CONF" || { echo "setup.sh: $CONF nemá PrivateKey, nič nemením" >&2; exit 1; }
trap 'rm -f "$DIR/yggdrasil.conf.old" "$DIR/yggdrasil.conf.new"' EXIT
umask 077
sudo yggdrasil -useconffile "$CONF" -normaliseconf -json > "$DIR/yggdrasil.conf.old"
jq --argjson peers "$peers" '.Peers = $peers | .Listen = [] | .MulticastInterfaces = [] | .IfName = "ygg0"
  | .NodeInfoPrivacy = true | .NodeInfo = {}' "$DIR/yggdrasil.conf.old" > "$DIR/yggdrasil.conf.new"
umask 022
key=$(jq -r .PrivateKey "$DIR/yggdrasil.conf.old")
[ ${#key} -ge 64 ] && [ "$(jq -r .PrivateKey "$DIR/yggdrasil.conf.new")" = "$key" ] ||
  { echo "setup.sh: nový yggdrasil.conf by stratil kľúč uzla, nechávam starý" >&2; exit 1; }
# The service runs as the user yggdrasil.
sudo install -m 640 -o root -g yggdrasil "$DIR/yggdrasil.conf.new" "$CONF"
sudo systemctl enable -q yggdrasil
sudo systemctl restart yggdrasil
ADDR=$(sudo yggdrasil -useconffile "$CONF" -address)

cd "$DIR"
[ -s key.pem ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=$ADDR" \
  -addext "subjectAltName=IP:$ADDR" -keyout key.pem -out cert.pem 2>/dev/null
[ -s registration-token ] || (umask 077 && openssl rand -hex 24 > registration-token)
chmod 600 key.pem registration-token
cat > tuwunel.toml <<EOF
# Written by server/priamo/setup.sh; the contacts are in allowlist.toml, made from priamo.json.
[global]
server_name = "[$ADDR]"
database_path = "$DIR/db"
address = ["$ADDR", "127.0.0.1"]
port = 8448
allow_registration = true
registration_token_file = "$DIR/registration-token"
allow_federation = true
yggdrasil_trust_overlay = true
startup_hello = true
trusted_servers = []
query_trusted_key_servers_first = false
query_trusted_key_servers_first_on_join = false
rocksdb_allow_fallocate = false
log = "info"
log_colors = false

[global.tls]
certs = "$DIR/cert.pem"
key = "$DIR/key.pem"
EOF
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/$UNIT.service" <<EOF
[Unit]
Description=Weft Priamo homeserver (tuwunel-priamo over Yggdrasil)
# ygg0 comes from the system's yggdrasil.service; until its address exists the bind fails and the unit retries.
StartLimitIntervalSec=0

[Service]
ExecStart=$DIR/bin/tuwunel-priamo -c $DIR/tuwunel.toml -c $DIR/allowlist.toml
Restart=always
RestartSec=10
MemoryMax=512M

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable -q "$UNIT"
systemctl --user restart "$UNIT"
echo "$ADDR"
