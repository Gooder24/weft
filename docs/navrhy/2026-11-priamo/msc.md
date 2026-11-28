# MSCxxxx: Server names on a cryptographically addressed overlay, authenticated by the network

*Draft, not yet submitted to matrix-org/matrix-spec-proposals. Written for Weft Priamo (this folder's README) from a
lab run and a two-node deployment, November 2026.*

## Introduction

A homeserver whose server name is an IP literal must still present a TLS certificate that is valid for that IP
address ([Server-Server API, server names and TLS](https://spec.matrix.org/latest/server-server-api/#tls)). For a
home server behind NAT without a public address or a domain this rules out federation altogether: no public CA issues
certificates for addresses it cannot reach.

Some overlay networks give every node an address derived from its own public key, and encrypt and authenticate every
packet to that address with the same key. [Yggdrasil](https://yggdrasil-network.github.io/implementation.html) is
one: a node's address in `200::/7` comes from its ed25519 key, and only the holder of the key can answer on it. On
such an address the network already does what the certificate is for: it proves that the other end is the owner of
the name. A certificate adds nothing, and its absence blocks the use case.

This proposal lets a server skip the certificate check, and only that check, when it connects to a server whose name
is an IP literal inside such an overlay, over that overlay.

## Proposal

A homeserver MAY treat a server name as *overlay-authenticated* when all of these hold:

1. The server name is an IPv6 literal inside an address range that the server's operator has configured as a
   cryptographically addressed overlay. The only range this proposal names is Yggdrasil's `200::/7`. Implementations
   MUST NOT enable this for any range by default.
2. The name was not reached through delegation. A DNS name, a `.well-known` delegation or an SRV record that points
   at such a literal is not overlay-authenticated, because the delegation itself was not proven by the overlay.
3. The connection goes out over the overlay's own interface. A packet to the range that would leave through any
   other interface (a default route, a LAN, a VPN, an HTTP proxy) MUST NOT be sent. Otherwise anyone who can answer
   for that address on another network could stand in for the server.

For a connection to an overlay-authenticated name, the server MUST still complete a TLS handshake and MUST verify the
handshake's signature against the certificate the peer presents, but it MAY accept any certificate, including a
self-signed one, for the identity check. Everything above TLS is unchanged: request signing with `X-Matrix`, server
key fetching and event signature checks work as for every other server.

Nothing changes on the wire. Two servers that both apply this proposal federate; a server that does not apply it
refuses the certificate exactly as today, so the change is opt-in on each side.

### Recommended practice

Being reachable on a public overlay means being reachable by every node on it. A server that uses this proposal
SHOULD limit both its federation allowlist and the overlay interface's packet filter to the servers it means to talk
to. Weft Priamo derives both from one contact list.

## Potential issues

- **Address strength.** A Yggdrasil address carries a truncated form of the node's key (how many of its first bits
  are alike, and the bits after them), not the whole key. Finding a key for a given address costs far more than any certificate
  forgery that matters today, but less than breaking ed25519; an implementation should treat it like an
  [RFC 3972](https://www.rfc-editor.org/rfc/rfc3972) cryptographically generated address, not like a signature.
- **Subnets.** `300::/8` holds the `/64` subnets that Yggdrasil nodes route to hosts behind them. A name there is
  proven to belong to the node that routes the subnet, and the node's operator decides which host answers. Operators
  who want the node itself only can configure `200::/8`.
- **Overlay down.** When the overlay stops, its routes disappear and a host's ordinary routing table may send the
  packets elsewhere. Rule 3 exists for this; in Weft Priamo a packet filter rejects `200::/7` on every interface but
  the overlay's and loopback.
- **Server names cannot move.** The name is the node's key. Changing the key, or the overlay, is a new server, as
  with any IP literal name.

## Alternatives

- **Tor onion services or I2P.** They offer the same self-authenticating names, with anonymity on top, but much
  higher latency, and an onion name is not an IP literal, so the same rule would need its own wording there.
- **Pinning the certificate to the server's signing key.** A server could publish its TLS key in its server keys and
  peers could check it. This needs a reachable key endpoint first, which is what fails here, and a wire change.
- **A public relay or tunnel (a VPS, Cloudflare Tunnel).** It works without any change but puts a third party with a
  public address in the middle of a server meant to need none.
- **Turning off certificate checks** (`allow_invalid_tls_certificates` in several homeservers). The lab used it as the
  baseline: it accepts any certificate from every server, on every route, which is what this proposal avoids.

## Security considerations

The proposal moves authentication of the transport from a CA to the overlay. It is only as strong as rules 2 and 3:
a server that accepts delegation to an overlay literal, or lets the range leave through another interface, accepts
an impostor. Implementations should make both rules part of the same setting and test them, not leave them to the
operator's firewall alone. Request and event signatures are unaffected, so a compromised overlay can at worst do what
a compromised CA can today: deny service or read traffic it should not, not forge events.

## Unstable prefix

None is needed: the proposal adds no field, endpoint or event. Implementations expose it as a configuration option
(Weft's Tuwunel patch calls it `yggdrasil_trust_overlay`).

## Implementation and evidence

- Tuwunel 1.9.4 patch: [`server/priamo/tuwunel-priamo.patch`](../../../server/priamo/tuwunel-priamo.patch). The
  exception applies only to federation clients and only to IP literals in `200::/7`; with it on, federation never uses
  a proxy.
- Lab (network namespaces, both homes behind NAT): the patched server delivered the first message in 6–10 ms with
  certificate checks on for every other server; a stranger on the same overlay was dropped by the packet filter and,
  with the filter off, refused by the allowlist; an ordinary name with a self-signed certificate was refused
  ([README](README.md#krok-1-čo-je-postavené)).
- Two real nodes over public Yggdrasil peers since 28 November 2026: messages in 0.5 s both ways, end-to-end
  encrypted rooms, and a stranger node that found both servers could open neither the federation port nor SSH
  ([README](README.md#krok-2-priamo-na-asuse-a-delli)).

## Dependencies

None.
