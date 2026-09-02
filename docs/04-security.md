# Security Requirements, Threat Model & Accepted Risks

Phase 0 analysis. `CLAUDE.md` §20: security is a core requirement because the system carries
company conversations and files, and **network restriction is not a substitute for server-side
validation**.

---

## 1. The central tension

The system holds private company data, and the first version has no passwords by explicit
requirement (`CLAUDE.md` §2.2). Those two facts cannot both be fully satisfied. This section states
plainly what that means, so the residual risk is a decision on the record rather than an oversight.

**What the design does guarantee:**

- A client cannot act as another user by editing a request, a cookie payload, or a socket event.
  Identity comes from a server-issued opaque token that maps to a server-side session row.
- A client cannot read a conversation, message, member list, or file it is not a member of, no
  matter what identifiers it discovers or guesses. Every access is authorized server-side against
  the database on every request.
- Uploaded files cannot be executed, cannot be reached by guessing a URL, and cannot escape the
  storage directory.

**What it cannot guarantee:**

- That the person typing "Sarah Chen" at the name screen is Sarah Chen. Decision 2 permits
  duplicate display names, so there is not even a collision check in the way — the name is a
  label people choose, and the system treats it as exactly that.

Everything below follows from that distinction.

---

## 2. Trust boundaries

| Boundary | Trusted? | Rule |
|---|---|---|
| Browser → application | **No** | All input validated (Zod), all resource access authorized, all ids treated as guesses |
| WebSocket event → application | **No** | Identical treatment to HTTP; the socket is not a privileged channel |
| Uploaded file bytes | **No** | Size counted while streaming, type sniffed for a label only, never executed, never served inline. There is deliberately **no** extension allow-list (Phase 7 §7) |
| Reverse proxy → application | Conditionally | Forwarding headers read **only** when the immediate peer is in `TRUSTED_PROXY_IPS`, which is unset by default. See [16-phase-8-network-restriction.md](16-phase-8-network-restriction.md) §4 |
| Source IP address | **Weakly** | From Phase 8 an address outside `ALLOWED_NETWORKS` is refused before anything else runs — but an allow-list is defeated by anything that can source packets from an allowed address, so it gates access and never establishes identity |
| Application → PostgreSQL | Yes | Parameterized access only; credentials server-side only |
| Application → filesystem | Yes | Paths derived server-side; resolved paths asserted to be inside `UPLOAD_DIR` |
| Company network | **No** | A device on the LAN is not automatically an authorized user |

The last row is the one most often assumed away in internal tools. An internal network contains
contractors, unattended unlocked workstations, personal devices, and, on a bad day, an intruder.
Every server-side check exists because of that row.

---

## 3. Controls by category

### Identity & session
- Two opaque 32-byte random tokens — a 24-hour session and a long-lived device identity (D-13).
  Only their SHA-256 hashes are stored, so a database read yields no usable token of either kind.
- The device identity **is not authentication** and never raises anyone's privileges: it answers
  only "which company computer is this", and every authorization check runs exactly as it would
  without it. Who that computer belongs to is a separate, administrator-controlled fact
  ([12-admin-device-identity.md](12-admin-device-identity.md)).
- **Employees cannot create, change or clear an identity.** The endpoints behind name entry and
  "Switch user" were removed, not hidden, and a test asserts they stay removed. Revocation is an
  administrator operation: retiring a computer, or reassigning it, which deletes every session
  issued for it.
- Every identity lookup re-checks that the session's device is still assigned to that session's
  user, so a reassignment takes effect on the next request rather than at the end of a 24-hour
  window.
- Cookie flags `HttpOnly` (no JavaScript access, so XSS cannot exfiltrate it), `Secure` in
  production, `SameSite=Lax` (`Strict` for the administrator cookie), `Path=/`, explicit expiry.
- Server-side expiry checked on every use; expired rows swept.
- Rate limiting on `POST /api/admin/session` and `POST /api/enroll` is **Phase 9** and is not in
  place yet.
- No identity value is ever accepted from the request body or a socket payload.

### Authorization (N-04)
- One rule: **membership is loaded from the database on every access** — `ConversationMember` for
  the caller and the target conversation, with `leftAt IS NULL`.
- List endpoints filter by membership inside the SQL query rather than fetching and filtering in
  application code, so a forgotten filter cannot leak rows.
- **Membership is necessary but not sufficient**: message reads and file downloads additionally
  enforce the join-time window `createdAt >= member.joinedAt` (D-03). Treat "is a member" as
  half of the check, never the whole of it.
- File downloads authorize against the attachment's conversation *and* its message timestamp,
  never against the URL.
- Socket room joins are server-decided; a client asking to join a room it does not belong to is
  denied and logged.
- Group management actions check the role rule (Q-05) in addition to membership.

### Injection
- **SQL injection:** Prisma parameterizes everything. Any raw query, if one becomes necessary,
  uses parameter binding — never string interpolation. This should be treated as a review gate.
- **XSS:** React escapes by default; `dangerouslySetInnerHTML` is prohibited in this codebase.
  Display names and filenames are escaped at render. If link auto-detection is added later, URL
  schemes must be allow-listed (`http`/`https`/`mailto` only) — `javascript:` links are the classic
  hole. Response security headers: `X-Content-Type-Options: nosniff`, a restrictive
  `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options: DENY`.
- **Path traversal:** storage keys are server-generated UUID paths; no user input reaches a path;
  the resolved absolute path is asserted to be within `UPLOAD_DIR` before any read.
- **Header injection:** filenames in `Content-Disposition` are percent-encoded (RFC 5987) and
  stripped of CR/LF.

### CSRF
Cookie-based identity means state-changing requests need CSRF protection (`CLAUDE.md` §5 Phase 9).
Layered:
- `SameSite=Lax` blocks cross-site form posts and top-level cross-site POSTs.
- State-changing endpoints additionally verify the `Origin` header against `APP_URL` and reject
  mismatches — this also covers the Socket.IO handshake, which `SameSite` alone does not fully
  protect for WebSockets.
- No state-changing operation is ever exposed over `GET`.

### File upload
- Size enforced twice: `client_max_body_size` at the proxy, and a streaming byte counter in the
  application that aborts mid-upload. Neither trusts `Content-Length` alone.
- Extension allow-list **and** magic-byte type detection, with the two required to agree.
- Storage name is a UUID with no meaningful extension; the original filename is data, never a path.
- The storage directory contains no application code and is not served statically
  (`CLAUDE.md` §11).
- Downloads: `Content-Type: application/octet-stream`, `Content-Disposition: attachment`,
  `nosniff`. Nothing user-supplied is rendered inline on the application origin.
- Zip files are stored and forwarded, never extracted or inspected beyond their header.

### Denial of service (internal, non-malicious as well as malicious)
- Request body ceiling at the proxy.
- Rate limits on session creation, message send, and upload.
- Pagination limits capped server-side; a client asking for 10,000 messages gets the cap.
- Socket connection count per session bounded.
- These target accidents — a runaway retry loop, a script — as much as attacks.

### Secrets & information disclosure
- No secrets in the repository; `.env` git-ignored from the first commit; `.env.example` carries
  placeholders only (`CLAUDE.md` §7, §15).
- `DATABASE_URL` and every other server-only value stay out of client bundles — in Next.js this
  means **never** prefixing them with `NEXT_PUBLIC_`.
- Error responses carry a code, a safe message, and a correlation id; no stack traces, SQL, paths,
  or environment values (`CLAUDE.md` §13).
- Server banners and framework version headers disabled where configurable.

---

## 4. Risk register

| ID | Risk | Severity without auth | Mitigation / status |
|---|---|---|---|
| R-01 | **Impersonation at the name screen** — anyone can enter a colleague's name | ~~High~~ **Closed** | Inherent to the no-password requirement, and **not reduced by any name check**: D-02 allows duplicate display names, so there is deliberately no collision refusal. Remaining mitigations are visibility, not prevention — the UI disambiguates same-named users with a short id and last-seen, and staff must be told that names are self-declared and unverified. ~~Accepted risk~~ **Closed by admin-assigned identity**
([12-admin-device-identity.md](12-admin-device-identity.md)): there is no name screen, no endpoint
that turns a typed name into a `User`, and no employee-facing way to change identity. What remains
is R-02/R-16 — being at somebody else's assigned computer — not being able to *claim* to be them. |
| R-02 | Shared/unlocked workstation lets another person use an existing session | High | An explicit "Leave" that revokes the session server-side. The 24-hour **idle** window (D-04) renews while the browser is in use, so a session on a machine someone keeps using does not time out on its own — expiry bounds abandoned sessions, it is not a defence against a person at an unlocked desk. Screen lock remains an organizational control. |
| R-16 | **Persistent device identity is a long-lived bearer token** (D-13) — whoever holds the browser profile is the computer's assigned employee for up to `DEVICE_ID_TTL_DAYS`, with no further check | High | Knowingly accepted as the cost of an identity model with no passwords. It *is* R-02 restated: the person at an assigned desk is that employee. Mitigations are containment, not prevention — a bounded TTL, `HttpOnly`/`Secure`/`SameSite` flags, TLS, **administrator-only retirement and re-enrollment** of a computer whose cookie may have been copied, and the rule that every lookup re-checks the device's current assignment so a reassignment revokes the previous employee at once. Employees can no longer clear or switch identity themselves, which removes the old "Switch User" containment — that control now belongs to the administrator, which is the intent. **The device cookie must never relax any authorization decision.** Resolved properly only by authentication (D-11 defers it). |
| R-17 | **The administrator token is a single shared secret** guarding the device registry, with no rate limiting and no per-administrator attribution | High | The smallest honest mechanism, stated as such rather than dressed up ([12-admin-device-identity.md](12-admin-device-identity.md) §5). Constant-time comparison; exchanged once for a short-lived signed cookie so the token is not replayed; rotating it invalidates every administrator session; **an unconfigured server refuses all administration rather than allowing it**. Admin access governs the registry only and grants no access to any conversation, message or file. **Phase 8 put `/admin` and `/api/admin` behind the network gate**, so the token is no longer the only thing in front of the registry — but it is still the only thing separating one employee on the company network from the registry, which is why rate limiting (**Phase 9**), per-administrator accounts and an audit trail remain open. A stricter operator-only range for `/admin` is possible today by putting it on its own host or narrowing the deployment's policy; a per-path policy is not implemented. |
| R-18 | **A setup code is a bearer capability** — whoever holds an unredeemed code can enrol a browser as that computer's assigned employee | Medium | ~98 bits of entropy, stored only as a SHA-256 hash, expiring after `ENROLLMENT_TTL_HOURS`, and cleared inside the transaction that redeems it so it works exactly once. It carries no name and no choice of employee, so it cannot be used to become somebody else — only to complete an assignment an administrator already made. Not rate-limited yet (**Phase 9**). Codes are shown once, to an administrator, and are never recoverable afterwards. |
| R-03 | Session token theft over the network | High if HTTP | TLS in production; `Secure` cookie. If TLS is not deployed, the whole model degrades — see Q-14. |
| R-04 | Insider reads conversations they are a member of | Medium | Out of technical scope; membership is the intended boundary. Group membership changes are recorded as `SYSTEM` messages so additions are visible. |
| R-05 | Enumeration of conversation/message/file ids | Medium | UUIDv4 ids are not enumerable, and authorization is enforced regardless. Hiding a URL is never the control (`CLAUDE.md` §20). |
| R-06 | Malicious upload used to attack another employee's machine | Medium | Forced download, no server-side execution, no inline rendering. **Note what changed in Phase 7**: there is no type validation, by business requirement — the company transfers arbitrary files, and an extension or MIME allowlist would block ordinary work while stopping nothing, since both are strings the sender chose. The server treats every upload as opaque bytes and never acts on them. The file is still opened on a workstation, so endpoint antivirus remains the company's control, and scanning between upload and `READY` is the recommended hardening (R-08, Q-07). |
| R-07 | Stored XSS via a crafted file rendered inline | High if inline | **Closed for v1**: D-10 makes file handling download-only, with no inline previews. Enforced in Phase 7 by serving every download as `application/octet-stream` with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, *regardless* of the detected type — an SVG or an HTML file is served as opaque bytes like everything else, and the detected type never reaches a response header. Would reopen only if previews were added later without origin isolation. |
| R-14 | **Pre-join history leaked through file downloads** — a newly added group member requests an old attachment by id | High | Decision 3 restricts history to `createdAt >= joinedAt`. That bound must be applied to the download endpoint via the attachment's message, not only to message queries; membership alone is insufficient. Explicitly covered in the Phase 9 test list. **Closed.** Phase 6 covered the message side — history, the reconnect backfill and its cursor lookup, sidebar previews, unread counts and socket rooms. **Phase 7 closed the file side**: `loadAttachmentForDownload` authorizes an attachment *through its message*, checking active membership of the message's conversation and `Message.createdAt >= joinedAt`, so membership alone is never sufficient. The same bound filters the Shared files list, so a pre-join file is not merely undownloadable but not listed. Every refusal is an identical 404. Tested end to end: a member added after a file was shared cannot see it, list it, or fetch it with its id, while the members who were there keep it. |
| R-19 | **A group join time taken from the wrong clock widens the window it is supposed to close** | High | `joinedAt` is compared against message `createdAt`, which PostgreSQL fills from its own clock. Taking the join time from the application clock lets server drift place a new member before existing messages; taking it from `SELECT now()` through Prisma's raw path is worse, because that renders the value in the database session's timezone and returns it as UTC — out by the whole offset, four hours on the machine it was found on, and silent. **Closed in Phase 6**: group operations write their `SYSTEM` event first, let the column default stamp it, and stamp `joinedAt` from the row that comes back. One clock, and the join time equals the timestamp of the message announcing it. `writeSystemMessage` accepts no `createdAt` so the mistake cannot be reintroduced at a call site. |
| R-20 | **Connection-pool exhaustion takes the whole application down** | High | Found in Phase 6 testing, introduced in Phase 3: `getDb()` cached its client outside production only, so a production server built a new `PrismaClient` and a new pool on every call. Measured at 96 connections — PostgreSQL's ceiling — within 75 authenticated requests, after which every route failed. This is a denial of service reachable by ordinary use, not by an attacker. **Closed**: the client is cached unconditionally, with a regression test asserting instance reuse under `NODE_ENV=production` and a production measurement showing the count flat over 450 requests. |
| R-15 | Large uploads (500 MB) exhaust disk or stall the proxy | Medium | Streaming with a hard byte counter; proxy body limit and timeouts matched to `MAX_FILE_SIZE`; abandoned-upload sweep of `UPLOAD_DIR/tmp`; capacity planning in Phase 10. Concurrent 500 MB uploads are a realistic internal DoS even without malice. |
| R-08 | No antivirus scanning of uploads | Medium | Out of v1 scope. Recommended later: a scanning hook between upload and `status=READY`, so an infected file never becomes downloadable. **Flagged for decision (Q-07).** |
| R-09 | Data at rest is unencrypted on the server | Medium | Disk-level encryption and filesystem permissions are the server's responsibility; application-level encryption is out of scope and would break search and previews. |
| R-10 | Backups contain all company messages and files | Medium | Backup storage must be access-controlled and, if it leaves the server, encrypted. Phase 10. |
| R-11 | The application is reachable from an unauthorized network | High | **Closed at the application layer in Phase 8.** Every HTTP request is checked against `ALLOWED_NETWORKS` before Next.js sees it, and every Socket.IO handshake before a socket exists — both from the socket's real peer address, never from a header unless a trusted proxy is explicitly configured. Production **refuses to start** without a policy; outside production the default is loopback only, so no environment defaults to permissive. Verified end to end by inverting the policy so the test machine is an outside client ([16-phase-8-network-restriction.md](16-phase-8-network-restriction.md)). What remains is the perimeter itself: the firewall rules and any reverse proxy are Phase 10, and an IP allow-list cannot help against a compromised machine that is already inside an allowed range (R-21). |
| R-21 | **An allowed source address is not an authorized user** | Medium | New in Phase 8, stated so the allow-list is not mistaken for authentication. Anything able to source packets from a permitted range — a compromised or unattended company machine, a spoofed source on a flat network, a permissive router — passes the network gate. It is the outermost of four layers and the weakest; identity, conversation membership and the `joinedAt` window all still run underneath it, unchanged. Nothing in the application became more permissive because the gate exists. |
| R-12 | Accidental damage to **any** pre-existing PostgreSQL database on the shared server | High | `company_chat_db` already exists and is the sole target; a **dedicated role with no access outside it** (D-06), so the constraint is enforced by PostgreSQL rather than by discipline; mandatory target verification before every database command; destructive commands prohibited outright. See `02-database.md` §0. |
| R-13 | No message retention or deletion policy | Low–Medium | Everything is retained indefinitely in v1. If company policy requires retention limits, that is a requirement to capture now (Q-10). |

---

## 5. Path to real authentication

The design is built so that the following is an additive change, not a rewrite:

1. `lib/auth/session.ts` is reimplemented against the company identity provider (AD/LDAP, SSO, or
   a local password store). Its `getCurrentUser()` signature does not change.
2. `User` gains `externalId` (unique) and, if needed, `email`; existing rows are matched or retired
   via `isActive`.
3. The name-entry screen is replaced by a sign-in flow. No other UI changes.
4. Conversation, message, file, and authorization code is untouched, because none of it ever
   trusted the display name for anything.

Retrofitting authentication into a system that trusted client-supplied identity is expensive;
retrofitting it into this one should not be. That is the single most important architectural
decision in this phase, and it costs nothing to make now.

---

## 6. Phase 9 security test checklist (to be executed later)

- Request another user's conversation, message, member list, and file id → expect 403/404
- Add a user to an existing group, then have them request a message id **and an attachment id**
  from before they joined → both refused (R-14); confirm the sidebar preview and unread count show
  nothing from before the join
- Remove and re-add a member → visible window restarts at the new join time
- Create two users with the identical display name → they remain distinct everywhere: authorship,
  membership, presence, and file access all follow the user id, and the UI distinguishes them
- Let a session pass the idle window without activity → expires; keep a session continuously
  active past 24 hours → does not expire; confirm the application service itself never restarts as
  a result of either
- **Persistence across session expiry (D-14):** after a session expires — and after browser close,
  refresh, machine restart, and reconnection — confirm the browser resolves to the *same*
  `User.id` via its device cookie, and that conversations, group memberships, message history,
  file metadata and downloadable files are all still present. Then confirm at the database level
  that the session sweep deleted rows from `Session`/`Device` only
- "Switch User / Clear Device Identity" → both session and device revoked **server-side**;
  replaying the old device cookie afterwards does not resolve; the next entry creates a new
  `User` rather than resuming the previous one
- An expired or revoked device cookie → refused, no fallback to name matching
- Upload two concurrent files at the configured maximum → both complete or fail cleanly, with no
  partial files left in `UPLOAD_DIR/tmp` (R-15)
- Direct request to a storage path from the browser → expect not routable
- Upload an oversized file, a disallowed extension, and a file whose bytes contradict its
  extension → all rejected, no partial file left behind
- Filename containing `../`, absolute paths, null bytes, and Unicode direction overrides → stored
  and rendered safely
- Forged `X-Forwarded-For` from an untrusted peer → ignored
- WebSocket connection without a session cookie, and a room-join for a non-member conversation →
  both refused
- Cross-origin state-changing request → refused
- Message body containing HTML and script → rendered as inert text
- Kill and restart the application and the database mid-conversation → no lost or duplicated
  messages after reconnect
- Trigger errors deliberately and inspect responses for leaked paths, SQL, or environment values
