# Network, Local Development & Production Architecture

Phase 0 proposal. Per `CLAUDE.md` §5 Phase 8, **no specific IP address, subnet, port, firewall
product, domain name, or router configuration is assumed anywhere in this document.** Every such
value is a named placeholder resolved from environment configuration at deployment time.

---

## 1. Company-network restriction — conceptual model

The requirement is "reachable from the company network, not from unauthorized external networks"
(`CLAUDE.md` §2.1). That is enforced in **three independent layers**, outermost first. Each layer
is useful on its own; the application layer is the weakest and is never the only one.

```text
        Unauthorized external network
                    X   blocked at Layer 1
                    |
   ============ Layer 1: Perimeter =====================================
   Company router / firewall. Only the HTTPS port is permitted inbound
   to the server, and only from the company's own address ranges.
   No inbound rule exists for the database or the application port.
   ---------------------------------------------------------------------
                    |
   ============ Layer 2: Reverse proxy ================================
   nginx binds the public interface, terminates TLS, and applies an
   allow-list of permitted source ranges (ALLOWED_NETWORKS), denying
   everything else before a request reaches application code.
   ---------------------------------------------------------------------
                    |
   ============ Layer 3: Application ==================================
   Node process binds 127.0.0.1 only. Optional middleware re-checks the
   client address against ALLOWED_NETWORKS as defence in depth, and the
   Socket.IO handshake validates the Origin header.
   ---------------------------------------------------------------------
                    |
          PostgreSQL (127.0.0.1) + file storage (local path)
          No inbound network exposure at all.
```

### Why not do this in the frontend

A browser-side check is decoration: the API is still reachable directly. Restriction belongs at
the firewall and proxy, exactly as `CLAUDE.md` §5 Phase 8 requires. Layer 3 exists to fail closed
if the proxy is ever misconfigured or bypassed — not as the primary control.

### The client-IP trust rule

Behind a proxy, `req.socket.remoteAddress` is the proxy. The real client address comes from
`X-Forwarded-For`, which any client can forge. Therefore:

- `X-Forwarded-For` is trusted **only** when the immediate peer is in `TRUSTED_PROXY_IPS`.
- The proxy must be configured to **overwrite**, not append to, any inbound `X-Forwarded-For`.
- If no trusted proxy is configured, the application ignores the header entirely and uses the
  socket address.

Getting this backwards turns the allow-list into a header the attacker controls. It is called out
here so the Phase 8 implementation cannot get it wrong by default.

### Configuration placeholders

| Variable | Meaning | Example placeholder |
|---|---|---|
| `APP_URL` | Origin the browser uses | `https://chat.internal.example` |
| `PORT` | Loopback port for the Node process | `3000` |
| `BIND_HOST` | Interface the app binds | `127.0.0.1` |
| `ALLOWED_NETWORKS` | Comma-separated CIDRs permitted to reach the app | `10.0.0.0/8,192.168.0.0/16` |
| `TRUSTED_PROXY_IPS` | Peers whose forwarding headers are believed | `127.0.0.1` |
| `DATABASE_URL` | Project database only, dedicated role (see `02-database.md` §0) | `postgresql://USER:PASSWORD@localhost:5432/company_chat_db` |
| `UPLOAD_DIR` | Absolute path to file storage | `/var/lib/company-chat/uploads` |
| `MAX_FILE_SIZE` | Bytes — **initially 500 MB**, configurable | `524288000` |
| `ALLOWED_FILE_EXTENSIONS` | Allowlist | `pdf,doc,docx,xls,xlsx,ppt,pptx,jpg,jpeg,png,txt,zip` |
| `SESSION_TTL_HOURS` | Idle session lifetime, renewed on activity — **initially 24** | `24` |
| `DEVICE_ID_TTL_DAYS` | Long-lived device identity lifetime, renewed on use (D-13) | `90` |
| `LOG_LEVEL` | | `info` |
| `NODE_ENV` | | `production` |

All are validated at process start by `lib/config`. A missing or malformed required variable is a
startup failure, not a runtime surprise (`CLAUDE.md` §7).

---

## 2. Local development architecture

```text
Developer workstation (Windows 10, this machine)
+---------------------------------------------------------------+
|  Browser (localhost)                                          |
|      |                                                        |
|      v  http://localhost:3000                                 |
|  Node dev server (server.ts: Next dev + Socket.IO, one port)  |
|      |                          |                             |
|      v                          v                             |
|  PostgreSQL 16 (already         ./var/uploads/                |
|  installed, localhost:5432)     (git-ignored, outside public/)|
|      |                                                        |
|      +-- company_chat_db      <- ALREADY CREATED by the owner |
|      |                           this project's only target;  |
|      |                           never created or recreated   |
|      +-- every other database <- OFF-LIMITS, never touched    |
+---------------------------------------------------------------+
```

Development specifics:

- No TLS locally; `Secure` on the session cookie is conditional on `NODE_ENV`.
- `ALLOWED_NETWORKS` unset in development means the Layer-3 check is inactive; the firewall and
  proxy layers do not exist locally. This asymmetry must be remembered when testing Phase 8 —
  network restriction is verifiable only in an environment that has a proxy in front.
- Uploads go to a repository-relative, git-ignored directory. `.gitignore` must exclude it from
  the first commit (`CLAUDE.md` §15).
- The PostgreSQL server is shared with other projects. `company_chat_db` **already exists** and is
  the only database this project touches; every other database on the server is off-limits without
  exception. The application connects as a dedicated, non-superuser role supplied by the owner,
  with no access outside its own database. Neither the database nor the role is created by this
  project. See `02-database.md` §0 — binding, not advisory.
- Multi-user behaviour is tested with several browser profiles or private windows, since identity
  lives in a cookie.

Docker for PostgreSQL was considered and is **not** recommended here: a suitable PostgreSQL 16 is
already installed, and adding a container would introduce a second server, port conflicts, and a
real chance of confusion about which instance holds which database.

---

## 3. Production / company-server architecture (target)

```text
              Company network / employee workstations
                              |
                   Router / firewall  (Layer 1)
                    only HTTPS inbound, from
                    company ranges only
                              |
+-----------------------------v-------------------------------+
|  Company server                                             |
|                                                             |
|   nginx  (Layer 2)                                          |
|     - TLS termination                                       |
|     - allow-list of company ranges                          |
|     - client_max_body_size aligned with MAX_FILE_SIZE       |
|       (500 MB), and proxy read/send timeouts long enough    |
|       for a 500 MB upload to complete                       |
|     - WebSocket upgrade headers passed through              |
|     - proxy_pass -> 127.0.0.1:PORT                          |
|              |                                              |
|   Node application service (systemd unit, or a Windows      |
|   service wrapper if the server is Windows)                 |
|     - restart on failure, start on boot                     |
|     - runs as an unprivileged service account               |
|     - environment from a root-owned, 0600 env file          |
|              |                    |                         |
|   PostgreSQL 16                UPLOAD_DIR                   |
|     - listen_addresses =         - outside the app          |
|       localhost only               directory and public/    |
|     - dedicated role,            - writable only by the     |
|       dedicated database           service account          |
|     - nightly logical backup     - no execute permission    |
+-------------------------------------------------------------+
```

Deployment properties required by `CLAUDE.md` §5 Phase 10:

- Reproducible from documented steps; nothing depends on the developer's machine.
- Service starts on boot and restarts on failure.
- Backups cover **both** stores, taken consistently: a database dump without the matching upload
  directory restores to broken downloads. Restore must be rehearsed, not assumed.
- Application logs go to the service manager's journal or a rotated file; the log level is
  configuration, not code.
- Migrations run as an explicit deployment step (`prisma migrate deploy`), never automatically at
  application start-up, so a bad deployment cannot silently alter the schema.

**Unresolved and deliberately unassumed:** the server OS, hostname, certificate source (internal
CA vs. self-signed vs. public), whether nginx is already present, and how DNS resolves the
application name. These become Phase 10 inputs — see Q-13 and Q-14.

---

## 4. Communication flow, employee to server

```text
1.  Employee opens the application URL in a browser on the company network.
2.  Firewall permits the request (company source range); nginx accepts it, terminates TLS.
3.  nginx re-checks the source against the allow-list, then proxies to 127.0.0.1:PORT.
4.  The application resolves the session cookie.
       no session  -> name-entry screen  -> POST /api/session -> cookie issued
       session     -> chat shell rendered
5.  The browser opens a WebSocket to the same origin; nginx upgrades the connection.
6.  The server authenticates the handshake from the cookie, verifies membership from the
    database, and joins the socket to its rooms.
7.  The conversation list and message history load over REST (the durable path).
8.  Messages flow over the socket; every one is persisted before it is acknowledged or broadcast.
9.  File uploads and downloads use REST endpoints and are authorized per request against
    conversation membership; bytes stream to and from UPLOAD_DIR, never through a public path.
10. On disconnect, the client reconnects and backfills missed messages over REST by message id.
```

At no point does the browser address PostgreSQL or the filesystem, and at no point does the server
accept the client's word for who it is or what it belongs to.
