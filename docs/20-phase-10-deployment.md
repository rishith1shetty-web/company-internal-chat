# Phase 10 — Production Deployment

**Status:** 10.2 (HTTPS foundation), 10.3 (production configuration and build) and 10.4 (HTTPS
bring-up, Caddy, Windows services) are complete. 10.5 onwards not started.

This document covers the Stage-A production deployment: this Windows PC acting as the company
chat server, reached by employees over HTTPS at a LAN IP address. It is written for whoever
operates the server, not for whoever wrote it — every command here is meant to be run as printed.

---

## 1. Stage-A architecture

```
Employee PC — Rising Path Recruiters Chat.exe  ─┐
Boss/admin PC — browser at /admin              ─┤   https://192.168.29.244   (TCP 443)
                                                │
                                                ▼
                              ┌──────────────────────────────────┐
                              │  Caddy — Windows service         │  TLS terminates here
                              │  cert: Rising Path Internal CA   │
                              │  Host preserved · WS · no cache  │
                              └───────────────┬──────────────────┘
                                              │  http://127.0.0.1:3000
                                              │  X-Forwarded-For: <real client>
                                              ▼
                              ┌──────────────────────────────────┐
                              │  node dist\server.js             │  BIND_HOST=127.0.0.1
                              │  Windows service, after Postgres │  NODE_ENV=production
                              │  Phase 8 gate + Phase 9 guards   │  TRUSTED_PROXY_IPS=127.0.0.1
                              └────────┬─────────────────┬───────┘
                                       ▼                 ▼
                             PostgreSQL 16          UPLOAD_DIR
                             localhost:5432         (outside the repo)
                             never on the LAN
```

Three properties of this shape are load-bearing, and each is forced by code rather than taste:

- **Port 443, and the proxy must preserve `Host`.** `lib/http/request-guard.ts` refuses a write
  when the `Origin` header's host does not equal the `Host` header. Port 443 makes the two
  identical. A proxy that rewrites `Host` to the upstream address — or that drops a non-default
  port — produces the signature failure where **reads work and every write returns
  `CROSS_ORIGIN_FORBIDDEN`**.
- **`TRUSTED_PROXY_IPS=127.0.0.1` becomes mandatory once Caddy is in front.** Every request then
  arrives from loopback. Without the trust entry the Phase 8 gate sees `127.0.0.1` for *everybody*
  and `ALLOWED_NETWORKS` silently stops filtering. With it, `lib/net/policy.ts` walks
  `X-Forwarded-For` right-to-left, discards trusted hops and recovers the real client address, so
  the allow-list stays authoritative. The list contains the immediate proxy and nothing else.
- **`BIND_HOST=127.0.0.1`.** The application is not on the LAN at all; Caddy is the only thing that
  can reach it.

---

## 2. Why HTTPS is mandatory — not a preference

`lib/http/route-helpers.ts` sets `secure: config.isProduction` on both identity cookies. With
`NODE_ENV=production` the server emits, over plain HTTP:

```
set-cookie: cic_admin=<...>; Path=/; Expires=...; Secure; HttpOnly; SameSite=strict
```

A `Secure` cookie is **discarded by the browser on any non-secure origin**. `http://localhost` is
exempt; `http://192.168.29.244:3000` is not.

So on a LAN address in production mode over plain HTTP: sign-in returns `200 OK`, the cookie is
dropped, and nothing works — with no error anywhere. Enrollment appears to succeed and the computer
stays unassigned.

This is why HTTPS cannot be deferred. The alternatives were considered and rejected:
`NODE_ENV=development` in the office abandons the production build, and a `COOKIE_SECURE=false`
override weakens the security model to paper over a deployment gap.

**HTTPS on an IP address is a fully secure context.** Being an IP rather than a name changes
nothing about cookie behaviour.

---

## 3. Production configuration — and how it stays separate from development

`.env` in the repository is the **development** configuration. It is untouched by the production
deployment and must stay that way.

Production uses its own file, outside the repository, selected by **`ENV_FILE`**:

```
C:\company-chat\
├── production.env      the production configuration (secrets — ACL restricted)
├── uploads\            UPLOAD_DIR
└── logs\               application and proxy logs
```

```powershell
$env:ENV_FILE = "C:\company-chat\production.env"
```

### Why a variable rather than "just set the environment"

Every entry point used to call `process.loadEnvFile('.env')` outright. On the company server the
development `.env` sits in the same working directory, so any variable the service failed to set
would have been quietly filled in from it — including `DEV_ORIGINS`, which must never reach a
production process.

`lib/config/env-file.ts` makes the choice explicit:

| `ENV_FILE` | Behaviour |
|---|---|
| unset | `.env`, relative to the working directory. A missing file is fine. Unchanged from before |
| set | **that file and only that file.** `.env` is not read at all |
| set, file missing | **Startup failure.** Never a fall back |

That last row is the one that matters. A production service pointed at a configuration file that
was renamed or never deployed must stop and say so — the alternative is a server that boots with
loopback-only access, no database and no admin token, and looks broken rather than misconfigured.

Values already present in the real environment still win over the file; `process.loadEnvFile` never
overwrites them. A service wrapper can therefore override one setting without editing the file.

**Verified, not assumed.** Started with a bare environment containing nothing but `ENV_FILE`:

```
Server listening
  nodeEnv=production   mode=production
  envFile=C:\company-chat\production.env
  uploadDir=C:\company-chat\uploads
  appUrl=https://192.168.29.244
  url=http://127.0.0.1:3000
  database=company_chat_app@localhost:5432/company_chat_db
  network=3 allowed range(s) from ALLOWED_NETWORKS   trustedProxies=1

DEV_ORIGINS        : <unset>   (present in the dev .env — so .env was not read)
DESKTOP_SERVER_URL : <unset>   (present in the dev .env — so .env was not read)
```

### What production sets

`NODE_ENV=production`, `PORT=3000`, `BIND_HOST=127.0.0.1`, `APP_URL=https://192.168.29.244`,
`LOG_LEVEL=info`, `ALLOWED_NETWORKS=192.168.29.0/24,127.0.0.1/32,::1/128`,
`TRUSTED_PROXY_IPS=127.0.0.1`, `UPLOAD_DIR=C:\company-chat\uploads`, `MAX_FILE_SIZE=524288000`,
the session/device/enrollment lifetimes, `DATABASE_URL` and `ADMIN_TOKEN`.

**`DEV_ORIGINS` is deliberately absent.** It configures the Next.js *development* server and has no
effect on a production build.

**`DESKTOP_SERVER_URL` is deliberately absent.** It is read by the employee's Electron process and
at packaging time — never by the server.

### Secrets

- `production.env` is ACL-restricted to SYSTEM, Administrators and the server administrator.
- The **production `ADMIN_TOKEN` is a different value from the development one**, generated during
  10.3 and written only into that file. To read it back:
  `Select-String -Path C:\company-chat\production.env -Pattern '^ADMIN_TOKEN='`
- The **PostgreSQL password was rotated manually** in pgAdmin before 10.3. `production.env` carries
  the rotated value; the role remains the non-superuser `company_chat_app`, and no privilege,
  ownership or role change was made. To rotate again: change it in pgAdmin, update the one line in
  `production.env`, restart the service. Never echo it, never put it on a command line, never
  commit it.

---

## 4. The data reset utility is locked out of production

`scripts/db-reset-application-data.ts` erases every user, device, conversation, message and
attachment. It cleared development leftovers once; from the first real enrollment it has no
legitimate use, and the cost of running it by accident is the company's entire history.

It now refuses production outright — **safeguard 0**, before the confirmations are read and before
a database connection is opened:

```
  REFUSING TO RUN — this is a production environment.
    · NODE_ENV is "production"
    · ENV_FILE selects a non-default configuration ("C:\company-chat\production.env")

  ...Nothing was read and nothing was changed.
```

Either signal alone is enough. `ENV_FILE` matters most in practice: an administrator standing at
the server may well not have exported `NODE_ENV` in their shell, but the production configuration
is still what they are pointed at.

Because the check runs **before** the confirmations are evaluated, supplying them cannot buy past
it. A dry run is refused too — there is nothing here to run on a production server, not even to
look. The existing protections are unchanged: `company_chat_db` only, non-superuser only, both
confirmations, no DDL, `_prisma_migrations` untouched.

Proven by `tests/security/reset-production-guard.test.ts`, which runs the real script as a
subprocess. Those tests never pass the arming flag, so even a total failure of the guard leaves the
script in its read-only dry-run mode: a test for a destructive lockout must not itself be one
regression away from performing the destruction.

---

## 5. Upload storage

```
UPLOAD_DIR = C:\company-chat\uploads
```

Absolute, outside the repository, outside `public/`, and containing no application code.

- **Absolute on purpose.** The default `./var/uploads` resolves against the working directory, so a
  service started from the wrong directory would silently use a different — empty — storage root.
- **ACL:** SYSTEM, Administrators and the server administrator. No general user access.
- **Git cannot track it.** It is outside the working tree, and `.gitignore` also refuses `/var`,
  `/uploads` and `/storage`.
- **The installer never contains it.** electron-builder packages `dist-desktop/**` and
  `package.json` only.
- **Deterministic for backup and migration.** One directory, one variable. Files are written to a
  temporary name inside it and renamed into place, so a reader sees a complete file or no file —
  which is why backups dump the database *first* and copy files second.

Current contents: empty, matching the clean database that is Stage A's starting point.

---

## 6. Building and starting production

```powershell
cd C:\dev\company-internal-chat
npm ci                                       # first time, or after a dependency change
npm run build                                # prisma generate && next build && tsc -p tsconfig.server.json
Remove-Item -Recurse -Force .next\cache      # see the warning below
$env:ENV_FILE = "C:\company-chat\production.env"
npm start                                    # node dist\server.js
```

The working directory must be the repository root: `UPLOAD_DIR` is absolute, but a relative
`ENV_FILE` and the default `.env` are both resolved against it.

### Never copy `.next` to another machine

**`.next/cache` contains environment material.** After a clean rebuild, the Turbopack cache held
the development `ADMIN_TOKEN` and the database password in a `.sst` file — because `next build`
loads `.env` for itself.

The shipped bundles are clean: `.next/static` and `.next/server` contain neither, and neither does
`dist/`, `dist-desktop/`, `release/` or `public/`. The problem is confined to the build cache.

So:

- Delete `.next\cache` after building on the production server. **Verified safe** — the production
  server serves pages, the API and `/sounds/notification.wav` with it removed; Next rebuilds it as
  needed.
- Never copy `.next` between machines, and never include it in a backup archive.
- A build cache is not a deployment artifact. **The Stage-B server rebuilds from source** — clone,
  `npm ci`, `npm run build` — it never receives a copied `.next`, a copied `node_modules` or a
  copied `dist`.

### Rebuild rules

Rebuild after any dependency change, any source change, or any Prisma schema change. Building needs
no production secrets and does not touch the database. `prisma migrate deploy` is a separate,
deliberate step; `migrate dev` and `migrate reset` are never run anywhere.

---

## 7. Running as Windows services

Three services, all **Automatic**:

| Service | Account | Depends on | Purpose |
|---|---|---|---|
| `postgresql-x64-16` | (installer default) | — | Database |
| `RisingPathChat` | `NT SERVICE\RisingPathChat` | `postgresql-x64-16` | The application on 127.0.0.1:3000 |
| `RisingPathCaddy` | `NT SERVICE\RisingPathCaddy` | — | TLS on :443 |

Wrapped by [WinSW](https://github.com/winsw/winsw) 2.12.0. Definitions live in `deploy/`, are
secret-free, and are copied to `C:\company-chat\services\` at install time.

```powershell
# Install or re-install (idempotent). Elevated.
powershell -ExecutionPolicy Bypass -File deploy\install-services.ps1

# Prove they behave. Elevated.
powershell -ExecutionPolicy Bypass -File deploy\verify-services.ps1
```

Failure policy for both: restart after 10s, then 30s, then 60s, with the counter reset after an
hour.

### Two decisions worth knowing

**`RisingPathChat` depends on PostgreSQL; `RisingPathCaddy` depends on nothing.** The database
dependency stops the application failing its first query at every boot. Caddy deliberately has no
dependency on the application: if the application is down, employees then get a **502 from a
working HTTPS endpoint**, which is diagnosable, instead of a refused connection that looks
identical to the server being switched off. Verified — with the application stopped, HTTPS returns
502 and recovers to 200 when it starts.

**The service accounts are set by the installer, not by the XML.** Two traps, both hit during this
phase and both now guarded:

- WinSW 2.x spells the account `<domain>`/`<user>`; the 3.x `<username>` form is **silently
  ignored** and the service falls back to **LocalSystem**. That is total privilege where least
  privilege was intended, with no error to notice.
- A virtual account's SID does not exist until the service does, so it cannot be declared at
  install time at all — WinSW fails with *"No mapping between account names and security IDs was
  done"* (1332).

So the installer creates each service, switches the account, and then **asserts** it with
`sc.exe qc`, refusing to continue if the answer is not the virtual account.

### What each account may touch

| Account | Path | Rights |
|---|---|---|
| `RisingPathChat` | `C:\dev\company-internal-chat` | Read + Execute |
| | `…\.next` | Modify — Next writes its runtime cache |
| | `C:\company-chat\production.env` | Read |
| | `C:\company-chat\uploads` | Modify |
| | `C:\company-chat\logs`, `…\services` | Modify / RX |
| `RisingPathCaddy` | `deploy\Caddyfile` | Read |
| | `C:\company-chat-pki\server\stage-a.{crt,key}` | Read |
| | `C:\company-chat\caddy`, `…\services` | Read + Execute |
| | `C:\company-chat\logs` | Modify |

Neither account is granted anything under `C:\company-chat-pki\ca`. The root CA is not the proxy's
business, and its private key is not on this machine at all.

Logs: `C:\company-chat\logs`, rolled at 10 MB, 10 kept.

---

## 8. Firewall and exposure

| Port | Bound to | Firewall | Reachable from the LAN? |
|---|---|---|---|
| 443 | Caddy, all interfaces | Allow TCP 443 from `192.168.29.0/24` | **Yes — intended** |
| 80 | Caddy, all interfaces | Allow TCP 80 from `192.168.29.0/24` | Yes — redirect only |
| 3000 | **127.0.0.1 only** | Block TCP 3000 (all) | No |
| 5432 | PostgreSQL, `0.0.0.0` | **Block TCP 5432 (all)** | No |

**PostgreSQL listens on `0.0.0.0:5432`.** The application reaches it over loopback, so nothing on
the network needs it, and an explicit inbound block rule is in place. A firewall rule is a
perimeter control, not a fix: the tidier change is `listen_addresses = 'localhost'` in
`postgresql.conf`, which requires a PostgreSQL restart and is **not** done here.

The 3000 block should never match anything, since the process binds loopback. It exists so that a
future `BIND_HOST` mistake cannot quietly publish the application.

**Windows Firewall does not replace `ALLOWED_NETWORKS`.** The application gate is the authority on
who may use the system; the firewall only narrows who can reach the port.

---

## 9. Power policy

The machine was set to sleep after **30 minutes on AC** (`standby-timeout-ac = 0x708`), which would
have taken the server off the network. Standby on AC is now disabled:

```powershell
powercfg /change standby-timeout-ac 0     # applied
powercfg /change standby-timeout-ac 30    # to revert
```

Hibernate-on-idle was already disabled and was left alone. No other power or OS setting was
changed.

---

## 10. What was verified, and how

All of the following ran against the real stack — TLS terminated by Caddy, the application under
its service account.

| Check | Result |
|---|---|
| TLS chain, no SNI (IP only) | `Verify return code: 0 (ok)`, TLS 1.3 |
| Wrong IP (negative control) | `64 (IP address mismatch)` |
| `/`, `/setup`, `/admin`, `/api/health` | 200 |
| Admin sign-in over real TLS | 200, cookie `Secure; HttpOnly; SameSite=strict` |
| Authenticated admin write | 201 |
| Cross-site write (`Origin: https://evil.example`) | **403 `CROSS_ORIGIN_FORBIDDEN`** |
| Enrollment over HTTPS | 200, both identity cookies `Secure; HttpOnly` |
| Socket.IO | connected, transport **websocket** |
| 12 MB upload → download round trip | 201 / 200, **SHA-256 match** |
| 600 MB streamed through Caddy | **629,145,600 bytes received intact** |
| `notification.wav` | 200, `Cache-Control: public, max-age=0` + ETag, no `Age`/`X-Cache`/`Via` |
| Service stop / start / restart | HTTPS 200 → 502 → 200 as expected |

### Host and X-Forwarded-For — measured, not assumed

A throwaway upstream was put behind Caddy to record exactly what arrives:

```
  Host: 192.168.29.244        <- preserved verbatim; the Phase 9 write guard passes
  X-Forwarded-For: 192.168.29.244
  X-Forwarded-Proto: https
```

With a **forged** `X-Forwarded-For: 203.0.113.9` sent by the client, the upstream still saw only
`192.168.29.244`. Caddy **replaces** the header rather than appending to it, so a caller cannot
inject an address into the Phase 8 gate.

Caddy warns that these `header_up` lines are "unnecessary". They are not: the default *appends*,
and replacement is what makes forgery impossible. Do not remove them on the strength of that
warning.

### The gate still filters through the proxy

`ALLOWED_NETWORKS` was temporarily narrowed to `127.0.0.1/32` in a throwaway copy of the
configuration:

```
  through Caddy from 192.168.29.244   403 NETWORK_FORBIDDEN
  direct on loopback                  200 ok
```

So the gate reads the real client address recovered from `X-Forwarded-For`, not the loopback
address of the proxy. `production.env` was never modified.

### A note on `curl` on Windows

`curl` here is built against **Schannel**, which hard-fails when it cannot fetch revocation
information — and a private CA publishes none. That looks exactly like a trust failure but is not:

```
curl https://192.168.29.244/api/health                        -> 000
curl --ssl-revoke-best-effort https://192.168.29.244/api/...  -> 200
node --use-system-ca ...                                      -> 200
```

Chromium and Electron soft-fail revocation, so they behave like the last two. Use
`--ssl-revoke-best-effort` when testing with curl on this machine. It is **not** a trust bypass —
the certificate must still chain to the trusted root.

---

## 11. The server IP must be reserved — it is currently DHCP

```
IPAddress       InterfaceAlias   PrefixOrigin   SuffixOrigin
192.168.29.244  Ethernet         Dhcp           Dhcp
```

The certificate and the employee installer are both bound to `192.168.29.244`. If the router hands
this PC a different address at a lease renewal, **TLS fails and every employee EXE stops working**
until a new certificate and a new installer are issued.

**Required before rollout:** reserve `192.168.29.244` for this machine in the router (DHCP
reservation against its MAC address), or configure a static address outside the DHCP pool.

Worth asking the router at the same time: **can that reservation later be moved to a different
machine?** If it can, a future server move costs nothing but a database restore and a file copy —
no new certificate, no new installer, no employee re-enrollment (see §19).

---

## 12. The internal CA trust model

There is one private root CA. It signs server certificates for this application and nothing else.

The split that matters:

| | Distributed | Lifetime | Changes when the server moves |
|---|---|---|---|
| **Root CA certificate** | Once, to every employee PC | 10 years | **No** |
| **Server (leaf) certificate** | Only to the chat server | 398 days | Yes — reissued from the same root |

This is why a CA is used rather than a bare self-signed server certificate. With a self-signed
certificate, every change of server means re-trusting a new certificate on every employee PC. With
a CA, employee PCs trust the root once and never touch their trust store again.

Electron uses the **Windows trust store** on Windows, so installing the root there is all that is
required. There is no certificate bypass in the client and none is to be added:
`desktop/main.ts` registers no `certificate-error` handler, sets no `ignore-certificate-errors`
switch and installs no `setCertificateVerifyProc`. A bad certificate must fail the load and show
the offline screen.

---

## 13. What exists, and where

**Nothing below is in the repository.** `C:\company-chat-pki` is outside the working tree, so Git
cannot see it at all. `.gitignore` additionally refuses `*.key`, `*.pem`, `*.crt`, `*.cer`,
`*.pfx`, `*.p12`, `*.csr` and `/deploy/certs`, so a key copied into the working tree for
convenience cannot be committed by accident.

```
C:\company-chat-pki\
├── ca\                                   ACL: SYSTEM + Administrators + server admin only
│   ├── rising-path-root-ca.key           ROOT PRIVATE KEY — see the warning below
│   ├── rising-path-root-ca.crt           root certificate (public)
│   ├── rising-path-root-ca.srl           serial counter
│   └── root-ca.cnf
├── server\                               ACL: SYSTEM + Administrators + server admin only
│   ├── stage-a.key                       leaf private key — Caddy reads this
│   ├── stage-a.crt                       leaf certificate
│   ├── stage-a.csr
│   └── leaf.cnf
└── dist\
    └── rising-path-root-ca.crt           the copy to carry to employee PCs
```

### The root private key must leave this machine

`rising-path-root-ca.key` can issue a certificate for **any** name that every employee PC trusts.
It is far more valuable than the server key, and the chat server never needs it after issuance.

**Do this once, now that issuance is done:** copy `C:\company-chat-pki\ca\` to removable media,
store it somewhere physically secure, and delete the on-disk copy from the server. Keep the
directory intact — the `.srl` and `.cnf` are needed to issue the next certificate.

The key is currently stored **without a passphrase**, so its protection is physical. To add one
before putting it away:

```powershell
openssl rsa -aes256 -in C:\company-chat-pki\ca\rising-path-root-ca.key -out C:\company-chat-pki\ca\rising-path-root-ca.key.enc
# then delete the unencrypted file and rename the .enc back
```

You will be prompted for the passphrase whenever you issue a certificate. Record it in the same
place as the media, not on the server.

### Backup treatment

- `stage-a.key` / `stage-a.crt` — **server deployment material.** Back these up with the server
  configuration. Losing them means reissuing a leaf, which is a five-minute job.
- `rising-path-root-ca.key` — **CA backup material, handled separately.** It does *not* belong in
  the routine database/uploads backup, because that backup is copied to ordinary media and kept in
  ordinary places. Losing it means re-trusting a new root on every employee PC; leaking it means
  someone can impersonate any site to every PC that trusts it.
- Neither key is ever packaged into the employee EXE. The installer carries only `dist-desktop`
  and `package.json` — no certificates, no keys, no `.env`.

---

## 14. Certificate details

### Root CA

```
Subject:  O=Rising Path Recruiters, CN=Rising Path Recruiters Internal Root CA
Validity: 2026-09-09 → 2036-09-06  (10 years)
Key:      RSA 4096
basicConstraints: critical, CA:TRUE, pathlen:0     (may sign leaves only — no sub-CAs)
keyUsage:         critical, Certificate Sign, CRL Sign
SHA-256 fingerprint:
  50:A3:49:52:B6:8F:99:C1:D9:8A:AC:2C:13:00:34:5F:48:59:53:0B:72:B6:36:7C:B5:D8:09:B9:0C:5E:36:AB
```

Check that fingerprint when installing on an employee PC. It is what makes the install verifiable.

### Stage-A leaf

```
Subject:  O=Rising Path Recruiters, CN=192.168.29.244
Issuer:   Rising Path Recruiters Internal Root CA
Validity: 2026-09-09 → 2027-10-12  (398 days)
Key:      RSA 2048
basicConstraints: critical, CA:FALSE
keyUsage:         critical, Digital Signature, Key Encipherment
extendedKeyUsage: TLS Web Server Authentication
```

**Subject Alternative Name — the whole identity of the certificate:**

| SAN | Type | Purpose |
|---|---|---|
| `192.168.29.244` | **IP Address** | The Stage-A production URL. The one that must be right |
| `chat.risingpath.internal` | DNS | Free future-proofing: if router DNS is ever added, this certificate already covers it — no reissue |
| `localhost` | DNS | Health checks and admin access over HTTPS from the server itself |
| `127.0.0.1` | IP Address | Same, by address |

**Chromium ignores CN entirely.** The `CN=192.168.29.244` above is there so a human reading a
certificate list can identify it; it plays no part in validation.

**The mistake to avoid:** writing the address as a DNS-type SAN (`DNS:192.168.29.244`). That does
not validate. It must be the `iPAddress` type, which is what `IP.1 = 192.168.29.244` produces in
the OpenSSL config.

Validity is 398 days because that is the ceiling every client accepts without argument. Renewal
goes in the operations calendar — see §18.

---

## 15. Exact commands used

Reproducible as printed. OpenSSL 3.5.7 ships with Git for Windows; nothing was installed.

**Configuration files** — `C:\company-chat-pki\ca\root-ca.cnf`:

```ini
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = v3_ca

[ dn ]
O  = Rising Path Recruiters
CN = Rising Path Recruiters Internal Root CA

[ v3_ca ]
basicConstraints     = critical, CA:true, pathlen:0
keyUsage             = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
```

`C:\company-chat-pki\server\leaf.cnf`:

```ini
[ req ]
distinguished_name = dn
prompt             = no

[ dn ]
O  = Rising Path Recruiters
CN = 192.168.29.244

[ v3_leaf ]
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName         = @alt

[ alt ]
IP.1  = 192.168.29.244
DNS.1 = chat.risingpath.internal
DNS.2 = localhost
IP.2  = 127.0.0.1
```

**Issuance:**

```bash
cd /c/company-chat-pki

# Root CA — 10 years
openssl genrsa -out ca/rising-path-root-ca.key 4096
openssl req -x509 -new -key ca/rising-path-root-ca.key -sha256 -days 3650 \
  -config ca/root-ca.cnf -out ca/rising-path-root-ca.crt

# Stage-A leaf — 398 days
openssl genrsa -out server/stage-a.key 2048
openssl req -new -key server/stage-a.key -config server/leaf.cnf -out server/stage-a.csr
openssl x509 -req -in server/stage-a.csr \
  -CA ca/rising-path-root-ca.crt -CAkey ca/rising-path-root-ca.key -CAcreateserial \
  -days 398 -sha256 \
  -extfile server/leaf.cnf -extensions v3_leaf \
  -out server/stage-a.crt

cp ca/rising-path-root-ca.crt dist/rising-path-root-ca.crt
```

**Filesystem lockdown:**

```powershell
icacls C:\company-chat-pki\ca     /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "PC1\DELL:(OI)(CI)F"
icacls C:\company-chat-pki\server /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "PC1\DELL:(OI)(CI)F"
```

---

## 16. Installing the root certificate on an employee PC

Do this on the same visit as the EXE install. It is one command, run **as Administrator**:

```powershell
certutil -addstore -f Root \\path\to\rising-path-root-ca.crt
```

Or from a copy on the machine:

```powershell
certutil -addstore -f Root C:\Temp\rising-path-root-ca.crt
```

This writes to **Local Machine → Trusted Root Certification Authorities**, which is what Chromium
and Electron read. A per-user install (`Cert:\CurrentUser\Root`) also works but only for that user.

Carry only `rising-path-root-ca.crt`. **Never carry a private key to an employee PC.**

If Active Directory is ever introduced, this becomes a Group Policy deployment instead.

---

## 17. Verifying trust

**On the employee PC, after installing the root** — confirm the store holds the right certificate:

```powershell
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -like "*Rising Path*" } |
  Select-Object Subject, Thumbprint, NotAfter
```

The thumbprint must match the SHA-1 of the root; the SHA-256 fingerprint in §14 is the stronger
check and can be confirmed with `certutil -dump rising-path-root-ca.crt`.

**The real test is the application:** open the EXE. If it reaches the chat screen, TLS validated.
If it shows the offline screen, it did not — and that is the correct, non-bypassable behaviour.

**On the server**, verifying the certificate itself:

```bash
openssl verify -CAfile C:/company-chat-pki/ca/rising-path-root-ca.crt \
                       C:/company-chat-pki/server/stage-a.crt

openssl x509 -in C:/company-chat-pki/server/stage-a.crt -noout -ext subjectAltName
```

The second must print `IP Address:192.168.29.244` — an `IP Address:` prefix, not `DNS:`.

**End-to-end, without deploying anything** — serve the certificate locally and validate against
the root, including a negative control:

```bash
openssl s_server -accept 127.0.0.1:8443 \
  -cert C:/company-chat-pki/server/stage-a.crt \
  -key  C:/company-chat-pki/server/stage-a.key -www &

echo | openssl s_client -connect 127.0.0.1:8443 \
  -CAfile C:/company-chat-pki/ca/rising-path-root-ca.crt \
  -verify_ip 192.168.29.244        # expect: Verify return code: 0 (ok)

echo | openssl s_client -connect 127.0.0.1:8443 \
  -CAfile C:/company-chat-pki/ca/rising-path-root-ca.crt \
  -verify_ip 192.168.29.99         # expect: Verify return code: 64 (IP address mismatch)
```

A test that only ever passes is not a test. The second command must fail.

---

## 18. Renewal and reissue

**The leaf expires 2027-10-12.** Put a reminder at least a month earlier. Renewal does not touch
employee PCs — the root they trust is unchanged.

```bash
cd /c/company-chat-pki
openssl req -new -key server/stage-a.key -config server/leaf.cnf -out server/stage-a.csr
openssl x509 -req -in server/stage-a.csr \
  -CA ca/rising-path-root-ca.crt -CAkey ca/rising-path-root-ca.key -CAcreateserial \
  -days 398 -sha256 -extfile server/leaf.cnf -extensions v3_leaf -out server/stage-a.crt
```

Then restart Caddy. The root CA key must be brought back from storage for this step, and returned
afterwards.

Reusing the existing key is acceptable for a renewal. Generate a fresh key (`openssl genrsa`) if
the old one may have been exposed.

**The root expires 2036-09-06.** Replacing it does require visiting every PC, which is why it is
long-lived.

---

## 19. If the server IP later changes

Everything below preserves all data. Users, devices, direct chats, groups, messages, attachments,
`joinedAt` boundaries and `_prisma_migrations` all survive — they live in `company_chat_db` and
`UPLOAD_DIR`, neither of which knows anything about the server's address.

**Option A — move the IP with the role (no employee impact).** If the router can reassign
`192.168.29.244` to the new machine, the origin never changes: same certificate, same installer,
no re-enrollment. Restore the database, copy the uploads, move the address. This is the cheapest
path by a wide margin and is worth confirming with the router before choosing B.

**Option B — new server, new IP.** Then:

1. Issue a new leaf from the **same root**, with `IP.1` set to the new address. Employee PCs need
   no trust-store change — this is the property the CA exists for.
2. Migrate `company_chat_db` (`pg_dump -Fc` → `pg_restore` into an empty database on the new
   server, preserving `_prisma_migrations`; then `prisma migrate deploy` must be a no-op).
3. Migrate `UPLOAD_DIR` intact.
4. Rebuild the employee installer with `DESKTOP_SERVER_URL=https://<new-ip>`.
5. Employees install the updated EXE.
6. **Employees re-enroll.** The `cic_device` cookie is scoped to the origin, so a client pointed at
   a new address sends nothing for the old one. This is smaller than it sounds: the existing
   `Device` rows are reused via **re-issue setup code** in `/admin`, so each PC needs one code and
   keeps its identity, its assigned employee and all history. Nothing is recreated.

A single machine can be redirected without a new installer by writing
`%APPDATA%\Rising Path Recruiters Chat\server.json` — `{ "serverUrl": "https://<new-ip>" }` — which
overrides the baked-in address. Useful for testing the new server before the fleet moves.

---

## 20. No stable hostname is required for Stage A

Stage A deliberately uses an IP-based HTTPS URL. Router DNS and
`chat.risingpath.internal` are **optional** and are not a prerequisite for the rollout.

The hostname remains available later at low cost: the Stage-A certificate already carries
`chat.risingpath.internal` as a SAN, so adopting it needs only a DNS entry and an installer
rebuild — no new certificate. Note that switching the EXE from an IP to a name is an origin change
and carries the same re-enrollment consequence described in §19 Option B.

---

## 21. Reverse proxy

The draft lives at [`deploy/Caddyfile`](../deploy/Caddyfile) and is **not yet deployed**. It is
secret-free: it names the certificate and key by path, and the key never enters the repository.

The constraints it satisfies, each for a reason recorded above:

- listens on **443**, with the certificate and key given explicitly (`auto_https off` — no public
  CA can issue for a private IP, and an unattended ACME attempt would only produce confusing
  failures)
- reverse-proxies to `http://127.0.0.1:3000`
- **preserves `Host`** (§1)
- **overwrites** `X-Forwarded-For` with the real peer, so a caller cannot contribute to the header
  the network gate reads
- upgrades WebSockets for `/socket.io` with no configuration
- imposes **no body-size limit**, leaving the application's 500 MB `MAX_FILE_SIZE` as the only
  ceiling
- **caches nothing** — pages carry `Cache-Control: s-maxage=31536000`, which a shared cache would
  honour for a year, and `/sounds/notification.wav` depends on ETag revalidation so the file can be
  replaced server-side without rebuilding every employee EXE
- `admin off` — Caddy's admin API is not used, and an unused listening socket is still a listening
  socket

---

## 22. Not done yet

Phases 10.2, 10.3 and 10.4 are complete: the certificate foundation, the production
configuration and build, and the HTTPS bring-up with Windows services. Still ahead:

| Sub-phase | Work |
|---|---|
| 10.6 | Backup and restore, rehearsed **before** real data exists |
| 10.7 | Final employee installer carrying `https://192.168.29.244` |
| 10.8 | Stage-A deployment and smoke validation |
| 10.9 | Real employee rollout validation |
| 10.10 | Server-move rehearsal and written cutover runbook |
| 10.11 | Final acceptance checklist |
| 10.12 | *Optional, later:* adopt `chat.risingpath.internal` |
