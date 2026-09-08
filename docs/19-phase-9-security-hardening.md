# Phase 9 — Security hardening and production readiness

Phase 9 did not redesign anything. The authorization model, the identity seam, the network gate and
the file layer were audited and found sound; what was missing was a set of ceilings and headers that
earlier phases had explicitly deferred to this one, and one concurrency bug in the enrollment path.
This document records the threat model those changes answer, what they do **not** cover, and what
must be true before Phase 10 deployment.

The sentence the rest of this document depends on:

> **Network restriction is a perimeter control, not a replacement for application authorization.**

Every server-side operation validates what the requester may access, on every request, from the
database — and it would still do so if the firewall were switched off tomorrow. Phase 8 decides who
may knock. It has never decided what they may read.

---

## 1. Threat model

### 1.1 Who is being defended against

| Adversary | Can they reach the application? | What Phase 9 changes |
|---|---|---|
| **Someone outside the company network** | No — refused by the Phase 8 gate at both HTTP and socket handshake | Unchanged. The gate is the perimeter and it fails closed. |
| **An employee on the company LAN, curious** | Yes, as themselves | Cannot read another conversation, another file, or another employee's history — all pre-existing, all tested. Now also cannot frame the application, exhaust its memory with a large body, or guess at the two secrets without a ceiling. |
| **An employee on the LAN, deliberate** | Yes | The realistic attacker for this system. See §1.2. |
| **Someone who has stolen a company laptop** | Yes, as the enrolled employee | **Not defended against by the application.** The device cookie is a bearer token (D-11 / R-16). The control is administrative: retire the device from `/admin`, which destroys its token and every session immediately. |
| **A malicious page in an employee's browser** | Only through that browser | `SameSite=Lax`, the Origin check on writes, and `frame-ancestors 'none'` all target this. |
| **Someone with the database backup** | — | Only SHA-256 hashes of tokens and codes are stored, so a backup yields no working cookie. Message and file **content** is in the clear; the backup itself is the thing to protect. |

### 1.2 The realistic attacker

A person who already has a company computer, an assigned identity, and time. Concretely, they may:

- guess at conversation, message, attachment and user ids — every endpoint re-derives authorization
  from the database and answers identically for "does not exist" and "not yours";
- read the JavaScript bundle and call the API directly — the API is the only enforcement point that
  matters and it assumes exactly this;
- open a socket and send whatever they like — every event is validated and re-authorized server-side,
  and `senderId` comes from the socket's own resolved identity, never from a payload;
- try to reach `/admin` — refused without the administrator cookie, and blocked outright inside the
  desktop client;
- try to guess the administrator token or a setup code — **this is what Phase 9 closed.**

### 1.3 What is deliberately out of scope for V1

Employee-to-employee impersonation on an **unlocked, already-enrolled** machine. Anyone sitting at a
signed-in company computer is that employee, exactly as they would be in their signed-in email. The
answer is Windows screen locking, not application code, and pretending otherwise would be theatre.

---

## 2. What changed

### 2.1 Rate limiting on the two secret-guessing endpoints

`POST /api/admin/session` and `POST /api/enroll` are the only endpoints in this application that
answer a guess at a secret. Both previously had no ceiling; both said so in their own source
comments and deferred it here.

- **Where**: `lib/http/rate-limit.ts` (the counter) and `server.ts` (the wiring).
- **Why in the custom server**: a Next.js route handler receives a `Request`, which has headers but
  no socket. Anything counted inside a handler would be counted per header value the caller chose.
  `server.ts` is the only layer that can see the peer address — the same reason the network gate
  lives there.
- **Limits**: admin sign-in 10 attempts / 15 minutes; enrollment 20 / 15 minutes. Exhausting the
  window starts a 15-minute penalty, which is what stops "exhaust, wait for the window to roll,
  exhaust again" being a steady drip of guesses.
- **Set by what a person does.** An administrator who mistypes a long random token twice must not be
  locked out; a control that causes outages is a control people switch off.
- **The signed-in probe (`GET /api/admin/session`) is not counted.** It runs on every visit to the
  admin page, and counting it would lock an administrator out of their own console.

**Limitations, stated plainly.** The counter is in this process's memory. It does not survive a
restart (someone who can restart the server already has the machine), it is not distributed (running
more than one process would multiply the effective limit and would have to revisit this module), and
it raises the cost of guessing from one source but cannot raise it from a thousand.

### 2.2 Request body limits

`request.json()` reads whatever it is sent, and **Next.js applies no limit of its own to route
handlers** — its `bodySizeLimit` setting covers Server Actions only. One connection could make the
server buffer an arbitrary amount of memory by posting to any endpoint.

Two layers, because either alone is incomplete:

| Layer | Catches | Limit |
|---|---|---|
| `server.ts`, from `Content-Length` | The honest oversized request, before Next.js allocates anything | 256 KB, answered 413 |
| `readJsonBody`, counting the stream | A chunked body with no declared length, or one that lies | 256 KB, answered 400 |

The **file upload route is deliberately excluded**. Its body *is* a file, up to `MAX_FILE_SIZE`, and
it is counted as the bytes arrive by `lib/files/storage.ts` — the only measurement that does not
depend on believing the sender. Bounding it from a header would mean either refusing legitimate files
or trusting a number the client chose.

### 2.3 Cross-site writes

The identity cookies were already `HttpOnly; SameSite=Lax` (and `Secure` in production), which stops
a cross-site form post from carrying them. Phase 9 adds the second lock: a write whose `Origin`
header names another host is refused with 403 before it reaches Next.js.

Compared against the request's own `Host`, **not** against a configured `APP_URL`. The two are
equivalent when the configuration is right, and this one cannot be *wrong* — an operator who mistypes
`APP_URL` would otherwise lock every employee out of every write.

A request carrying **no** `Origin` is allowed. This looks like a hole and is not: browsers attach
`Origin` to exactly the cross-site requests this catches, and a client that sends none is not a
browser being used against its user, which is the whole of what CSRF describes.

> **Deployment note — this is the one way to break every write.** Because the comparison is against
> `Host`, a reverse proxy in front of the application **must forward the original host**. In nginx
> that is `proxy_set_header Host $host;`, which is the usual configuration. A proxy that rewrites
> `Host` to `127.0.0.1:3000` while the browser still sends `Origin: https://chat.company.com` would
> make every message send, group change and upload fail with `CROSS_ORIGIN_FORBIDDEN` — reads would
> keep working, so the symptom would look like "sending is broken", not "the proxy is misconfigured".
> Checked as part of §8.

### 2.4 Security response headers

| Header | Value | What it actually buys |
|---|---|---|
| `X-Frame-Options` | `DENY` | The chat interface can no longer be framed behind a transparent overlay. This is the one that closed a real gap. |
| `Content-Security-Policy` | see below | `frame-ancestors`, `object-src`, `base-uri`, `form-action` |
| `X-Content-Type-Options` | `nosniff` | No content sniffing anywhere |
| `Referrer-Policy` | `no-referrer` | A conversation or attachment id never leaves in a `Referer` |
| `Permissions-Policy` | camera, microphone, geolocation, payment, usb all `()` | The application asks for none of them |

**The CSP is not an anti-XSS control, and saying so would be false.** `script-src` includes
`'unsafe-inline'` because Next.js injects inline bootstrap scripts into every page; allowing those
specifically needs a per-request nonce, which needs middleware this application does not have. The
actual protection against XSS is structural: React escapes every message body, there is no
`dangerouslySetInnerHTML` anywhere in the codebase, and uploaded files are only ever served as
`application/octet-stream` attachments with `nosniff`. Nonce-based CSP is residual work (§4).

`/api/*` is excluded from the page CSP so that the attachment download's deliberately tighter
`default-src 'none'; sandbox` remains the only policy applied to it — a second CSP header does not
replace the first, it is enforced alongside it.

### 2.5 Atomic enrollment-code redemption

`enrollDevice` read the device by code hash, then wrote it by id. Two requests arriving together
would both find the code unspent and both write, and the pair would resolve to whichever committed
last — leaving the other holding a device cookie that had already stopped working, with nothing to
say why.

The claim is now one conditional statement (`enrollmentTokenHash: codeHash` in the `where`), so
PostgreSQL settles it: the second transaction re-evaluates the condition after the first commits,
finds the column already `NULL`, and matches nothing. The loser is refused with the same message a
made-up code gets.

### 2.6 No hard-coded company address

`next.config.ts` carried a literal LAN address in `allowedDevOrigins`, against CLAUDE.md §7. It now
reads `DEV_ORIGINS` from the environment. Development only — it has no effect on a production build.

### 2.7 Electron IPC sender validation

Every IPC handler in the desktop main process now checks that the message came from the window it
created. The navigation rules already made a second renderer impossible; this keeps that true rather
than assumed, so a future edit that introduces another `webContents` cannot quietly inherit the
channels.

---

## 3. What was audited and found sound

Recorded so that a later reader knows these were examined, not overlooked.

- **Identity** flows through one function, `resolveIdentity()`. Both cookies are opaque 256-bit random
  tokens, stored only as SHA-256. Every request re-checks the device's *current* assignment, so a
  reassignment takes effect immediately and cannot be outlived by a cookie.
- **The admin surface** is a separate preamble (`withAdmin`) that produces no `CurrentUser`. There is
  no path by which an administrator becomes an employee, or an employee an administrator. All six
  device routes are wrapped; the four unwrapped routes (`session` sign-in, `enroll`, `session` probe,
  `health`) are unauthenticated by design.
- **Conversation authorization** is one module, `findActiveMembership`, which returns `joinedAt` with
  every success so a caller cannot forget to bound history by it. `leftAt IS NULL` is checked, not
  mere row existence.
- **The `joinedAt` boundary (D-03)** is applied to history, pagination cursors, previews, unread
  counts, the shared-files list, file downloads and reconnect backfill. The download path authorizes
  through the attachment's *message*, which is what stops a newly added member fetching older files
  by id.
- **Socket.IO** authenticates at the handshake from the cookie only, re-authorizes every room join
  from the database, takes `senderId` from the socket's own identity, caps frames at 128 KB, sets
  `cors: { origin: false }`, and inherits no rooms across a reconnect.
- **File storage** never derives a path from client input, generates UUID keys with a uniform `.bin`
  suffix, resolves-then-checks containment, streams uploads through a counter, and serves every
  download as `application/octet-stream; attachment` with `nosniff`.
- **The network gate** ignores `X-Forwarded-For` entirely unless `TRUSTED_PROXY_IPS` is configured,
  and when it is, walks the header right-to-left so a client-supplied prefix cannot win. Enforced at
  both the HTTP listener and `allowRequest`, because engine.io's polling transport never reaches the
  former.
- **Errors** return a fixed set of codes with no stack, path, SQL or configuration. Detail goes to
  the server log only.
- **Logs** never contain a token, a setup code, a submitted password-equivalent, or the configured
  allow-list.

---

## 4. Residual V1 risks

Ordered by how much they should worry an operator.

1. **The device cookie is a bearer token.** Whoever holds it is that employee until it expires or is
   revoked. There is no second factor and no proof of a human. This is D-11 / R-16 and is the
   fundamental limitation of V1 identity — it is why `resolveIdentity()` is written as a single
   replaceable seam.
2. **Plain HTTP on the LAN.** Until TLS terminates in front of this application, cookies and message
   content cross the network in the clear and anyone who can see the traffic can replay a session
   cookie. See §6.
3. **One shared administrator token.** Actions cannot be attributed to a person, and rotating it
   means telling everyone who administers the system. Rotation does invalidate every admin cookie
   ever issued, which is the correct behaviour.
4. **CSP allows inline script.** Not an XSS defence (§2.4). The structural protections are what stand.
5. **The rate limiter is per-process and in-memory.** §2.1.
6. **No malware scanning of uploads.** Files are stored as opaque bytes and never executed or served
   inline, so the server is not at risk — but a file downloaded by a colleague is whatever was
   uploaded. Antivirus on the endpoints is the control.
7. **No audit trail of administrator actions.** Assignments, reassignments and retirements are logged
   to stdout but there is no queryable history.
8. **Browser E2E fixtures do not self-clean.** The desktop suite does; `zz-gui-`, `zz-ui-` and
   `zz-fui-` rows are left behind and are removed with
   `npx tsx scripts/db-cleanup-e2e.ts --prefix=<prefix>`.

---

## 5. The company-LAN trust assumption

The application assumes that **being on the company network is not a permission**. It is stated here
because it is the assumption most likely to be misread in the other direction:

- Reaching the application does not grant an identity. Without an enrolled device cookie a visitor
  gets the "not set up" screen and no data.
- The gate is not consulted by any authorization decision. Removing it would expose the login-less
  surface to a wider audience; it would not grant anybody access to anything.
- `TRUSTED_PROXY_IPS` must stay empty unless a reverse proxy really is in front of the application.
  Setting it without one turns the allow-list into a value the client supplies.

---

## 6. HTTPS / TLS

**Required before the application carries real company conversations outside a single trusted
segment; strongly recommended in every case.**

Today, on plain HTTP:

- session and device cookies cross the network in the clear and can be replayed by anyone who can
  see the traffic;
- message bodies and file contents are readable in transit;
- `Secure` is set on cookies only when `NODE_ENV=production`, so a production server on plain HTTP
  will set `Secure` cookies that the browser then refuses to send — TLS is effectively a prerequisite
  for a correct production deployment, not an optional extra.

The intended arrangement is a reverse proxy terminating TLS in front of the Node process, with the
process bound to an interface the proxy can reach, and `TRUSTED_PROXY_IPS` set to that proxy so
`X-Forwarded-For` is believed from it and nothing else. A private CA or an internal certificate is
sufficient for a LAN-only deployment.

The desktop client refuses no certificate errors and disables no TLS validation — pointing it at an
`https://` URL is a configuration change, not a code change.

---

## 7. Uptime and backup expectations

**Uptime.** The application is one Node process plus PostgreSQL. It must be run as a service that
restarts on failure and starts at boot, on a machine that stays on — not from a developer's terminal.
A restart costs connected clients a reconnect and nothing else: history is in PostgreSQL, the socket
layer holds no durable state, and the rate limiter's counters resetting is the only loss.

**Backup.** Two things must be backed up together, or a restore produces rows pointing at files that
are not there:

1. the PostgreSQL database (`pg_dump` of `company_chat_db`);
2. the `UPLOAD_DIR` tree.

A restore that misses the second is visible: `GET /api/attachments/:id/download` answers 404 and logs
"Attachment row has no file behind it". Restores must be rehearsed, not assumed. Backups contain
company conversations and files in the clear and must be protected accordingly.

---

## 8. Phase 10 prerequisites

Before deployment to the company server:

- [ ] `ALLOWED_NETWORKS` set to the real company ranges. The process refuses to start in production
      without it.
- [ ] `ADMIN_TOKEN` set to a long random value, never the `.env.example` placeholder.
- [ ] `DATABASE_URL` pointing at `company_chat_db` with a role that owns only that database.
- [ ] `UPLOAD_DIR` on a volume with room to grow, outside `public/`, excluded from anything that
      executes files.
- [ ] TLS terminating in front of the application (§6), with `TRUSTED_PROXY_IPS` set to the proxy and
      nothing else.
- [ ] The proxy forwards the original `Host` header (nginx: `proxy_set_header Host $host;`).
      Verify by sending one message through the proxy after deployment — if writes fail with
      `CROSS_ORIGIN_FORBIDDEN` while reads succeed, this is why (§2.3).
- [ ] The service configured to start at boot and restart on failure.
- [ ] Backup of database **and** upload directory scheduled, and a restore rehearsed once.
- [ ] `npm run db:migrate` run against the production database, and `npm run db:status` clean.
- [ ] The desktop client's `DESKTOP_SERVER_URL` (or `server.json`) pointing at the production URL —
      the installer must be rebuilt only if that default is baked in rather than configured.

---

## 9. What Phase 9 deliberately did not add

Per the phase's own scope: no passwords, no SSO, no OAuth, no Active Directory, no Redis, no Docker
or Kubernetes, no auto-updater, no workstation-IP identity, no AI, and no UI redesign. No database
schema change and no migration were required — every change in this phase is code.
