# 16 — Phase 8: company network / IP restriction

The application answers only clients whose address is inside a configured set of company ranges.
Everything else is refused with a 403 before Next.js, before identity, and before a socket exists.

No schema change. No API contract change. No route added or removed.

---

## 1. Architecture

```text
   employee computer                          outside client
   192.168.1.x                                203.0.113.9
        │                                          │
        ▼                                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Node process (server.ts)                                 │
   │                                                          │
   │  http.Server 'request'  ──►  gate.check(socket peer)      │
   │        │ allowed                    │ denied → 403        │
   │        ▼                            ✗                     │
   │   Next.js handler                                        │
   │     pages · /admin · /setup · REST · upload · download   │
   │                                                          │
   │  engine.io handshake   ──►  gate.check(socket peer)       │
   │        │ allowed                    │ denied → refused    │
   │        ▼                            ✗   (no socket at all)│
   │   Socket.IO identity → membership → rooms                │
   └──────────────────────────────────────────────────────────┘
                              │
                    PostgreSQL · file storage
                    (no inbound network exposure)
```

Access is now four gates deep, and the new one is outermost:

```text
Network allowed?  →  Identity valid?  →  Conversation authorized?  →  joinedAt window?  →  allow
```

### Why there are two enforcement points and not one

This is the single most important implementation fact in the phase, and it is not obvious.

When Socket.IO attaches, **engine.io caches the HTTP server's `request` listeners, removes them,
and calls them only for requests it does not want itself** (`engine.io/build/server.js`,
`attach()`). Socket.IO's polling transport therefore never reaches the check in `server.ts`, and
the WebSocket upgrade arrives on the `upgrade` event, which that listener never sees either.

A gate written only in `server.ts` would look completely correct and would leave the entire
real-time surface — presence, message delivery, room membership — reachable from any network.

So the socket path is gated with engine.io's own `allowRequest` hook, which `verify()` calls for
the initial handshake of **both** transports. The two points share one `NetworkGate` object, so
they cannot drift apart about who is allowed in.

### Files

| File | Role |
| --- | --- |
| `lib/net/ip.ts` | IPv4/IPv6 parsing and CIDR matching. Pure, no config, no I/O. |
| `lib/net/policy.ts` | The allow-list decision and client-address resolution, including proxy trust. |
| `lib/net/gate.ts` | The enforcement object: decide, log (throttled), and write the refusal. |
| `lib/config/env.ts` | Parses `ALLOWED_NETWORKS` / `TRUSTED_PROXY_IPS`; `assertNetworkPolicyConfigured` is the fail-closed rule (§6). |
| `server.ts` | Enforcement point 1 — every HTTP request. |
| `lib/realtime/gateway.ts` | Enforcement point 2 — every Socket.IO handshake. |

No dependency was added. `ipaddr.js` and `cidr-matcher` do this well, but the whole job is two
parsers and a bitmask compare, and a dependency at the centre of an access-control decision is one
whose next version silently changes who can reach the application (CLAUDE.md §3). The behaviour is
pinned by 71 tests instead.

---

## 2. Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_NETWORKS` | loopback outside production; **required** in production | Addresses and ranges permitted to reach the application |
| `TRUSTED_PROXY_IPS` | unset — headers ignored | Peers whose `X-Forwarded-For` is believed |
| `BIND_HOST` | `127.0.0.1` | Interface the server binds |

### CIDR examples

```bash
ALLOWED_NETWORKS=192.168.1.0/24                      # one office subnet
ALLOWED_NETWORKS=192.168.1.0/24,192.168.2.0/24       # two
ALLOWED_NETWORKS=10.0.0.0/8,127.0.0.1/32             # a whole private range, plus local health checks
ALLOWED_NETWORKS=10.0.0.5                            # a single machine (same as /32)
ALLOWED_NETWORKS=fd00::/8                            # an IPv6 range
```

**Host bits must be zero.** `192.168.1.5/24` is refused at startup rather than quietly widened to
`192.168.1.0/24` — the two readings differ by 255 machines, and an operator who wrote the first
meaning the second should be told at startup, not discover it from who got in.

**Leading zeros are refused.** `010.0.0.1` is 8 to anything reading it as octal and 10 to anything
that is not; a rule that reads differently to a person than it behaves is worse than one rejected.

**A malformed entry is a startup failure, not a skipped rule.** Dropping an unparsable range would
produce a silently narrower allow-list than the operator wrote — the failure that presents as an
outage on a Monday morning instead of as a configuration error.

---

## 3. IPv6

Fully supported, not stubbed: parsing (including `::` compression and embedded IPv4), matching,
and CIDR ranges, in the same code path as IPv4.

The case that matters most is **IPv4-mapped IPv6**. A server bound to `::` reports every IPv4 peer
as `::ffff:192.168.1.5`. Those are normalised back to IPv4 *once*, in `parseIp`, before any
comparison — so an operator who configures `192.168.1.0/24` gets the range they wrote whether the
listener is IPv4-only or dual-stack. Without that normalisation the allow-list would match nobody
at all on a dual-stack bind, which is a silent, total failure.

Families never match across: an IPv6 address is not inside an IPv4 range, and `0.0.0.0/0` does not
match `::1`.

---

## 4. Client IP resolution

**The socket's peer address is the only thing the network guarantees, and with no trusted proxy
configured it is the only thing consulted.** This is the default and the V1 deployment shape.

`X-Forwarded-For` is a string the sender typed. It is read only when:

1. `TRUSTED_PROXY_IPS` is set at all, **and**
2. the immediate peer is itself one of those configured proxies.

Even then, entries are walked **right to left**, discarding addresses that are trusted proxies,
and the first address that is not one of ours is the client. Reading left to right instead is the
classic form of this bug: a client sending `X-Forwarded-For: 192.168.1.10` would pick its own
company address and bypass the allow-list with one header.

An unparsable hop stops the walk and falls back to the peer, rather than being skipped — skipping
would let a client insert junk to push the scan further left, into a value it wrote itself.

`Forwarded` (RFC 7239) and `X-Real-IP` are **not** parsed. Supporting three spellings of the same
claim is three chances to disagree about which wins; an unread header cannot be trusted.

A request whose address cannot be established at all is **denied**, never passed.

---

## 5. Development

`npm run dev` works with no configuration. With `ALLOWED_NETWORKS` unset the policy defaults to
loopback only (`127.0.0.0/8`, `::1/128`), so `http://localhost:3000` behaves exactly as before.

**The direction of that default is deliberate.** The development fallback is the *tightest*
policy available, not a relaxation. There is no branch anywhere in the configuration that widens
access because the environment is not production. That is what makes `NODE_ENV` safe to get
wrong: mislabelling a production server as development can only lock people out — never let
outsiders in.

To test the restriction locally, flip the policy rather than trying to fake a source address:

```bash
ALLOWED_NETWORKS=10.99.0.0/24 npm start   # now this machine is an outside client
```

---

## 6. Production: fail closed

With `NODE_ENV=production` and no `ALLOWED_NETWORKS`, **the process refuses to start**:

```text
Invalid environment configuration:
  - ALLOWED_NETWORKS must be set in production — list the company ranges permitted to reach
    this application, e.g. "192.168.1.0/24"
```

The alternative — defaulting to something permissive — would make the most important setting in
this phase the one an operator can forget, and forgetting it would publish the company's
conversations to whatever network the server is plugged into.

**Where the check lives, and why not in `loadConfig`.** The first implementation enforced this
inside the configuration parser, and it broke `npm run build`: route handlers read the
configuration at module scope, and `next build` evaluates those modules with
`NODE_ENV=production` while collecting page data. The build therefore demanded the company's
address ranges in order to compile — and a build machine has no business knowing them; requiring
it would push a production network detail into every environment that ever builds the app.

So `loadConfig` parses and validates the *syntax* everywhere (a malformed range is still an error
in every environment), and `assertNetworkPolicyConfigured` enforces the *presence* rule. `server.ts`
calls it immediately before `listen()` — the moment a process is actually about to accept traffic,
which is the only moment failing closed protects anything. Builds, tests and type-checks are
unaffected.

`server.ts` also warns at startup when it binds a non-loopback interface with no policy
configured, because that combination is reachable from the LAN and will refuse every employee on
it — a symptom that otherwise reads as "the app is broken" rather than "the app is not
configured".

### Binding

| | `BIND_HOST` | Who can reach the port | Who the app answers |
| --- | --- | --- | --- |
| Development | `127.0.0.1` | this machine only | loopback |
| Production, direct on the LAN | `0.0.0.0` | anyone who can route to the server | `ALLOWED_NETWORKS` only |
| Production behind a proxy (Phase 10) | `127.0.0.1` | the proxy only | `ALLOWED_NETWORKS`, resolved through `TRUSTED_PROXY_IPS` |

Setting `BIND_HOST=0.0.0.0` is what exposes the application; `ALLOWED_NETWORKS` is then the thing
deciding who may use it. They are set together or the server is either useless or open.

---

## 7. The refusal

`403`, and nothing else. Identical for `/`, `/admin`, a real attachment id and a made-up one, so
an outside client learns only that it is not allowed to be here.

- **API and socket paths** get JSON: `{"error":{"code":"NETWORK_FORBIDDEN", …}}`.
- **Page requests** get a minimal branded HTML page.
- **Never a redirect.** Sending a denied client to `/setup` or a sign-in page would advertise
  those routes and invite a second attempt.

The denied page is self-contained — inline CSS, no images, no links. The company logo is served
from the same origin behind the same gate, so an `<img>` would be refused and render broken.

It discloses no ranges, no configuration, no server details and no paths (CLAUDE.md §13).

### Logging

The first denial from an address is logged at `warn`; further ones are summarised at most once a
minute per address, with a suppressed count. A port scanner would otherwise turn a refusal into a
disk-space problem (CLAUDE.md §14).

**This throttles log lines, not requests.** Every request is still evaluated and refused. Nothing
here rate-limits traffic — that is Phase 9's subject and is deliberately not started. The
configured ranges are never written to the log.

---

## 8. What this does and does not protect

**It covers** every page, `/admin`, `/setup`, every REST route, the health endpoint, attachment
upload, attachment download, and the entire Socket.IO surface, because all of them are behind the
two enforcement points.

An attachment URL copied outside the company network fails **even with the session cookie**: the
gate runs before identity is resolved, so what the request is carrying never comes up. Conversation
membership and the `joinedAt` window remain in place underneath as the second and third layers.

**It is not a substitute for the perimeter.** An IP allow-list is defeated by anything that can
source packets from an allowed address — a compromised company machine, a spoofed source on a flat
network, or a permissive router. It is one layer:

| Layer | Where | Status |
| --- | --- | --- |
| 1 — Perimeter | Company router / firewall | The company's; Phase 10 documents what to ask for |
| 2 — Reverse proxy | Optional; not assumed | Deferred to Phase 10 |
| 3 — Application | This phase | **Done** |
| 4 — Identity, membership, `joinedAt` | Phases 4–7 | Already in place |

**`next start` bypasses this.** The gate lives in `server.ts`; running Next's own server would
skip it entirely. `npm start` runs `node dist/server.js` and is the only supported way to run this
application — which is also required for Socket.IO (D-09), so this is not a new constraint.

A Next.js `middleware.ts` was considered as a second HTTP layer and rejected: middleware receives
a `Request`, which has headers but no socket, so it cannot see the peer address at all. Anything
enforced there would necessarily be trusting a header — the exact mistake §4 exists to prevent.

---

## 9. Deferred

**To Phase 9 (security hardening):** rate limiting, brute-force protection on the admin token,
request size limits beyond the upload path, and audit logging of access decisions.

**To Phase 10 (deployment):** firewall rules on the real company server, whether a reverse proxy
is introduced at all, TLS and certificates, DNS and hostname, the Windows service wrapper, and the
`BIND_HOST` / `ALLOWED_NETWORKS` values for the real network — none of which can be chosen before
the company's actual network details are known (CLAUDE.md §5 Phase 8: "do not assume a specific IP
address, subnet, firewall, port, or router configuration").

**Not planned:** per-user or per-device network rules, geo restriction, and VPN integration. None
is in scope, and each would need a requirement before a design.
