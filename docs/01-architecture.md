# System & Component Architecture

Phase 0 proposal. Nothing here is implemented yet.

---

## 1. Architectural style

A **modular monolith**: one deployable Node.js process serving the Next.js UI, the HTTP API,
and the WebSocket layer, backed by one PostgreSQL instance and one filesystem directory.

Rationale (`CLAUDE.md` §3, §4): the expected user population is a single company's staff, the
network is private, and the feature set is small. Splitting real-time, uploads, or the API into
separate services would multiply deployment and failure modes without solving any current
problem. Internal modularity — enforced by directory boundaries and typed service functions —
gives the separation benefit without the operational cost, and leaves extraction possible later.

---

## 2. High-level system architecture

```text
  Employee workstation (company network)
  +---------------------------------------+
  |  Browser                              |
  |   - Next.js UI (React, client)        |
  |   - fetch() -> REST for state changes |
  |   - Socket.IO client -> live delivery |
  +---------------+-----------------------+
                  | HTTPS + WSS (single origin, single port)
                  v
  +-----------------------------------------------------------+
  |  Company server                                           |
  |                                                           |
  |  +-------------------------------------------------+      |
  |  | Reverse proxy (nginx)                           |      |
  |  |  - TLS termination                              |      |
  |  |  - network allow-list (see 03-network.md)       |      |
  |  |  - WebSocket upgrade pass-through               |      |
  |  |  - request body size ceiling                    |      |
  |  +---------------+---------------------------------+      |
  |                  | 127.0.0.1:PORT                         |
  |  +---------------v---------------------------------+      |
  |  | Chat application (one Node.js process)          |      |
  |  |  +-----------+--------------+----------------+  |      |
  |  |  | Next.js   | HTTP API     | Socket.IO      |  |      |
  |  |  | (UI/SSR)  | (route       | (realtime      |  |      |
  |  |  |           |  handlers)   |  gateway)      |  |      |
  |  |  +-----+-----+------+-------+-------+--------+  |      |
  |  |        +------------+---------------+           |      |
  |  |              +------v------+                    |      |
  |  |              | Domain      |  session, convo,   |      |
  |  |              | services    |  message, file,    |      |
  |  |              | (lib/)      |  presence          |      |
  |  |              +--+-------+--+                    |      |
  |  +-----------------+-------+-----------------------+      |
  |           Prisma   |       |  Node fs streams             |
  |  +-----------------v-+   +-v------------------------+     |
  |  | PostgreSQL        |   | File storage (UPLOAD_DIR)|     |
  |  | localhost only    |   | outside web root         |     |
  |  +-------------------+   +--------------------------+     |
  +-----------------------------------------------------------+
```

Two properties of this picture matter and should not be compromised later:

1. **PostgreSQL and the file directory are never addressable from a browser.** They are reached
   only through the application process.
2. **The Socket.IO gateway shares the application's identity and authorization code.** It is not
   a separate trust domain with its own rules.

---

## 3. Runtime composition — the one non-obvious decision

Next.js route handlers are request/response scoped and cannot host a long-lived Socket.IO
server; `next start` gives no hook to attach one. There are three ways out:

| Option | Description | Assessment |
|---|---|---|
| **A. Custom Node server — ADOPTED** | A small `server.ts` creates a Node `http.Server`, attaches the Socket.IO server to it, and forwards all other requests to the Next.js request handler. One process, one port. | Keeps the monolith intact; single origin means no CORS and cookies work unmodified; costs the loss of `next start` ergonomics. |
| B. Separate Socket.IO service | Second Node process on its own port. | Two processes to supervise, two proxy routes, cross-origin cookie handling, duplicated session code. Not justified at this scale. |
| C. Polling / SSE instead of WebSockets | Server-Sent Events for delivery, POST for sending. | Simpler infrastructure, but no bidirectional channel for presence and acks, and `CLAUDE.md` §3 names Socket.IO. |

**DECIDED — Option A** (confirmed at Phase 0 review, 2026-08-28). This is an intentional,
settled architectural decision for the project and is not to be revisited without cause.
Consequences accepted up front: the production start command becomes `node dist/server.js`
rather than `next start`, and the build must compile both the Next app and the server entry
point. This shapes the Phase 1 scripts and the Phase 10 service definition.

---

## 4. Component architecture

Proposed layout, consistent with `CLAUDE.md` §6:

```text
company-chat/
├── server.ts                   # HTTP + Next handler + Socket.IO attach (Option A)
├── app/
│   ├── (chat)/                 # main application shell + chat routes
│   ├── api/
│   │   ├── session/            # enter, read, leave, switch-user (clear device identity)
│   │   ├── users/              # directory of known users, presence snapshot
│   │   ├── conversations/      # list, create, members, messages (paged)
│   │   └── files/              # upload endpoint, download endpoint
│   └── layout.tsx
├── components/                 # presentational React only; no data access
│   ├── ui/                     # shadcn/ui primitives
│   └── chat/                   # conversation list, message list, composer, file item
├── lib/
│   ├── config/                 # env parsing + validation, single source for settings
│   ├── db/                     # Prisma client singleton, transaction helpers
│   ├── auth/                   # session + device identity issue/verify, getCurrentUser();
│   │                           #   the single swap point for real auth later
│   ├── authz/                  # membership & resource-access checks (pure, testable)
│   ├── conversations/          # conversation + membership services
│   ├── messages/               # message create/list services
│   ├── files/                  # validation, storage-path resolution, streaming
│   ├── realtime/               # socket server, room naming, event handlers, presence
│   ├── validation/             # Zod schemas shared by API and socket layers
│   └── logging/                # logger + request/socket log helpers
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── public/                     # static assets only — never uploads
├── tests/
├── docs/
├── scripts/
├── .env.example
└── package.json
```

### Layer rules

- **Components** never call Prisma and never read `process.env`. They receive data and
  callbacks.
- **Route handlers and socket handlers** are thin: parse → validate (Zod) → authorize → call a
  service → map the result to a response or an emit. They contain no business rules.
- **Services** (`lib/*`) own the business rules and are the only code that touches Prisma or the
  filesystem. They are callable from both the HTTP and socket paths, which is what keeps the two
  entry points from drifting apart.
- **`lib/authz`** is pure functions over already-loaded data where possible, so membership rules
  are unit-testable without a database.

### The identity seam (N-08)

All request-scoped identity flows through one function:

```ts
// lib/auth/session.ts
type CurrentUser = { userId: string; displayName: string; sessionId: string };
getCurrentUser(req): Promise<CurrentUser | null>
```

Every route handler and every socket connection obtains identity only from this function.
Replacing display-name identity with company SSO/LDAP later means reimplementing this one
module and adding an `externalId` column to `User` — no call site changes. This is the concrete
meaning of "designed so it can be replaced" (`CLAUDE.md` §2.2).

---

## 5. Identity & session model (no passwords)

`CLAUDE.md` §2.2 forbids building an authentication system, but the server still needs a stable
handle for "who is this connection" that the client cannot simply assert.

**DECIDED at Phase 0 review:** display-name identity with a server-issued opaque session remains
the identity mechanism for v1. No authentication is added (D-11).

Mechanism:

1. On first visit the user is shown a name-entry screen and submits a display name.
2. The server validates the name, creates a `User` row, and issues two **cryptographically random
   opaque tokens** (32 bytes each) — a 24-hour session token and a long-lived device token. Only
   their SHA-256 hashes are stored, in `Session` and `Device`; the raw values go into
   `HttpOnly; Secure; SameSite=Lax; Path=/` cookies.
3. Every subsequent HTTP request and the Socket.IO handshake resolve identity by hashing the
   session cookie and looking up the session. **The client never sends its user id or display name
   as a claim** — that is the difference between this and trusting the browser.
4. When the session has expired, the device cookie re-establishes a new session for the **same**
   `User.id` (D-13 below). With neither cookie, the user reaches the name screen.

### Display names are not unique (D-02)

Two employees may both enter "Sarah Chen". A display name is a **label, not an identifier**.
Identity is the server-issued `User.id` behind the session cookie, and everything — message
authorship, membership, file access — keys on that id. Nothing in the system ever resolves a
person by name.

Two consequences follow, and both need handling rather than assuming away:

- **The server cannot reuse a `User` row by matching a name.** Doing so would silently merge two
  different people who share a name, which is exactly what D-02 forbids. Therefore each
  entry at the name screen creates a **new** `User` row.
- **The UI must disambiguate.** Where two visible users share a name, the interface shows a
  discriminator alongside it — a short suffix of the user id, plus last-seen — so a person picking
  a chat partner can tell them apart. A name alone is never sufficient in a picker.

### Two-cookie identity model (D-13, resolving Q-16)

**DECIDED.** The browser carries **two independent cookies with different lifetimes and different
jobs**:

| | Session cookie | Device identity cookie |
|---|---|---|
| Answers | "Is this browser currently active?" | "Which `User.id` does this browser belong to?" |
| Lifetime | 24 hours idle, renewed on activity | Long-lived (`DEVICE_ID_TTL_DAYS`, default 90), renewed on use |
| Backing row | `Session` | `Device` |
| On expiry | The user re-enters at the name screen | The browser becomes a new identity |
| Cleared by | "Leave" / session sweep | **"Switch User"** only |

Flow when someone returns after their session expired:

```text
Browser arrives with an expired (or absent) session cookie
        |
        +-- device cookie present and valid?
        |        |
        |        yes -> resolve to its existing User.id
        |               -> issue a NEW Session for that SAME User.id
        |               -> the user's conversations, history and memberships are all there
        |
        +-- no (first visit, cleared cookies, new machine, or "Switch User")
                 -> name screen -> create a NEW User row + Device + Session
```

The device cookie stores an opaque random token; only its SHA-256 hash is kept server-side, the
same as the session token. It carries no name, no user id, and nothing the client can read or
forge. One `Device` maps to exactly one `User`; one `User` may have several `Device` rows (work
laptop, second browser), which is how the same person stays the same person across their own
machines only if they re-enter on each — the device cookie never travels between browsers.

This satisfies every rule at once: identity remains server-issued (never derived from a display
name), names stay non-unique (D-02), and conversation history stays attached to a stable
`User.id` across session expiry.

### "Switch User / Clear Device Identity" (required for shared computers)

A visible, always-available control that:

1. Revokes the current `Session` **server-side** (not merely dropping the cookie).
2. Revokes the current `Device` row server-side (`revokedAt`), so a copy of the cookie is useless.
3. Clears both cookies in the browser.
4. Returns to the name screen, where the next entry creates a **new** `User` — it does not
   silently re-attach to the previous person.

Both revocations are server-side on purpose: a cookie deleted only in the browser still works if
it was copied. This control is the designated mechanism for shared or hot-desk machines and must
be present in the UI from the first release that has identity, not added later.

### Security limitation of persistent device identity (documented, not solved)

The device cookie is **a convenience mechanism, not authentication.** Explicitly:

- **It is a bearer token with a long life.** Anyone who obtains it — by using the unlocked
  machine, copying the browser profile, or capturing it in transit without TLS — becomes that
  user, for up to `DEVICE_ID_TTL_DAYS`, with no further check.
- **It makes the shared-computer problem worse, not better.** Before D-13, an abandoned session
  became useless after a day; now the *next* person at that desk is silently the previous person
  until someone uses "Switch User". This is the direct cost of the continuity requirement, and it
  is accepted knowingly (R-16).
- **It proves nothing about a human.** It identifies a browser profile. It cannot distinguish the
  employee from anyone else using that profile.
- **It does not upgrade the trust level of anything.** No authorization decision may be relaxed
  because a device cookie is present. Every membership and access check is unchanged.

Mitigations in v1: server-side revocation via "Switch User", a bounded `DEVICE_ID_TTL_DAYS`,
`HttpOnly`/`Secure`/`SameSite=Lax` flags, TLS in production, and clear guidance to staff that
shared machines require "Switch User". The real fix is authentication, which is out of scope by
D-11 and remains a single-module change (§4, "The identity seam").

### Session lifetime (D-04)

**24 hours of inactivity, renewed while the user is active**, configurable via
`SESSION_TTL_HOURS`. Each authenticated request or socket activity slides `expiresAt` forward, so
an employee working through the day is never interrupted, while an abandoned browser stops
resolving after a day of silence. To avoid a database write on every request, the sliding renewal
is throttled — the expiry is extended at most once per few minutes per session.

This governs the **user's temporary identity only**. The application process itself runs
continuously as a service (`03-network.md` §3); session expiry never implies restarting,
stopping, or reloading the server.

### Session expiry is not data deletion (D-14)

**A session is temporary authentication state. It is not the user, and it owns none of their
data.** Expiring, revoking, or sweeping a `Session` row deletes exactly one thing: that session
row.

The following are stored in PostgreSQL independently of any session and are **never** removed by
session expiry, browser close, page refresh, machine restart, inactivity, reconnection, or the
creation of a new session for the same `User.id`:

- `User` records
- `Conversation` records, direct and group
- `ConversationMember` rows (memberships, `joinedAt`, read state)
- `Message` rows
- `Attachment` metadata
- The uploaded file bytes in `UPLOAD_DIR`

Enforced structurally, not by convention:

- Foreign keys run **`Session` → `User`**, so deleting a user would remove their sessions — the
  reverse direction does not exist and cannot be written by accident. No table cascades *from*
  `Session` or `Device` to anything.
- Message authorship uses `ON DELETE SET NULL`, so even deleting a `User` (not an operation the v1
  UI offers) preserves the messages and files.
- The session sweep deletes from `Session` only, filtered on `expiresAt`. It touches no other
  table. The same is true of the device sweep.

When a browser reconnects with a valid device cookie, it resolves to the **same `User.id`** and
therefore sees the same conversations and the same history, subject only to the ordinary
membership and join-window rules (D-03).

Two clarifications, so the guarantee is not overstated:

- **D-03 is visibility, not deletion.** Messages a newly added group member cannot see remain
  permanently stored in PostgreSQL; they are filtered out of that member's queries by `joinedAt`.
  Nothing is removed from the database at any point.
- **"Never vanish" scopes to session expiry.** It does not mean data is undeletable forever.
  Administrative deletion, retention policy (Q-10), and backup/recovery for database or storage
  failure are separate concerns, planned for Phase 10.

### What this does and does not achieve

It prevents a user from acting *as another user* by editing a request, and it gives every message
a stable author. It does **not** prevent someone from typing a colleague's name at the name
screen — and with non-unique names there is no collision check to slow that down. That is an
accepted risk (R-01), a direct consequence of the no-password requirement; see `04-security.md`.

Anonymous JWTs were considered and rejected: they cannot be revoked, and there is no scaling
pressure here that would justify avoiding a session table.


---

## 6. Real-time architecture

**Principle (`CLAUDE.md` §10, Phase 4): PostgreSQL is the source of truth; Socket.IO is a
delivery accelerator.** Any state a client can obtain over the socket must also be obtainable
over REST, and the REST answer wins.

### Rooms

- `user:{userId}` — every socket a user has open joins this. Used for conversation-list updates
  and unread badges across their tabs.
- `conversation:{conversationId}` — joined only after the server verifies membership from the
  database. The client asks to join; it never announces that it is a member.

### Connection lifecycle

1. Handshake: resolve the session from the cookie. No valid session → disconnect immediately.
2. Load the user's conversation ids server-side; join `user:{id}` and each `conversation:{id}`.
3. Mark presence online; notify users who share a conversation.
4. On disconnect: drop the socket; if it was the user's last socket, start a short grace timer (a
   page reload should not flap the presence dot), then mark offline and persist `lastSeenAt`.

### Send-message flow

```text
Client                          Server                          PostgreSQL
  |  emit message:send                                              |
  |  {conversationId, body,                                         |
  |   clientMessageId}                                              |
  |------------------------------>|                                 |
  |                               | resolve session (cookie)        |
  |                               | validate payload (Zod)          |
  |                               | verify active membership ------->|
  |                               | INSERT message                  |
  |                               | UPDATE conversation.lastMessageAt|
  |                               |   (one transaction) ------------>|
  |                               |<--------- persisted row         |
  |<---- ack {id, createdAt} -----|                                 |
  |                               | broadcast message:new to        |
  |                               |   conversation:{id}             |
  |                               | unread bump to user:{id} of     |
  |                               |   the other members             |
```

The client renders an optimistic bubble keyed by `clientMessageId` and reconciles on ack.
**A message counts as sent only once the transaction commits** — the ack follows the write, never
precedes it (`CLAUDE.md` §10).

### Duplicates and reconnects

- `clientMessageId` (a UUID minted by the browser) is unique per sender. A retry after a dropped
  ack collides with the existing row and returns it instead of inserting a second message.
- On reconnect the client does **not** rely on replayed socket events. It calls
  `GET /api/conversations/:id/messages?after=<lastKnownMessageId>` and backfills from the
  database, then resumes live delivery. Missed-while-offline and duplicate-delivery therefore
  reduce to the same, already-solved problem.
- Every client-side list dedupes on server message id.

### Presence

Presence is derived, not stored as authoritative state: a user is online when the server holds at
least one socket for them. An in-memory `Map<userId, Set<socketId>>` is correct for a single
process; `User.lastSeenAt` is persisted for the "last seen" display and survives restarts. If the
application is ever run as multiple processes this must move to a shared store — recorded as a
constraint (Q-09), not built now.

---

## 7. HTTP API surface (draft)

Every endpoint validates the method, validates input with Zod, resolves identity via
`getCurrentUser`, authorizes the specific resource, and returns typed JSON errors that leak
nothing.

| Method & path | Purpose | Authorization rule |
|---|---|---|
| `POST /api/session` | Enter with a display name; sets the cookie | none (entry point); rate-limited |
| `GET /api/session` | Who am I | valid session |
| `DELETE /api/session` | Leave — revokes the session server-side, keeps the device identity | own session only |
| `POST /api/session/switch-user` | **Switch User / Clear Device Identity** — revokes the session *and* the `Device` row server-side, clears both cookies | own session and own device only |
| `GET /api/users` | Known users + presence, for starting chats | valid session |
| `GET /api/conversations` | The caller's conversations, ordered by last activity, with unread counts | membership-filtered in the query itself |
| `POST /api/conversations` | Create a direct or group conversation | caller becomes member/owner. **Built (Phases 5-6).** `{type:"DIRECT", userId}` or `{type:"GROUP", name, memberIds[]}`; the creator is taken from the session and is always a member, and always the `OWNER` of a group they create |
| `GET /api/conversations/:id` | Conversation detail + members | caller is an active member |
| `PATCH /api/conversations/:id` | Rename a group | per the Q-05 role rule. **Not built** — deferred from Phase 6 (docs/13-phase-6-group-chat.md §8) |
| `POST /api/conversations/:id/members` | Add members | **Built (Phase 6).** Any active member of the group (Q-05b (a)). Everybody added gets `joinedAt = now` |
| `DELETE /api/conversations/:id/members/:userId` | Remove a member / leave | **Built (Phase 6).** Anybody may remove themselves; only an `OWNER` may remove somebody else. Which it is comes from comparing the path id with the session's, never from the request body. Sets `leftAt`; the row is kept |
| `GET /api/conversations/:id/messages` | Keyset-paginated history (`before`/`after` + `limit`) | active member **and** `Message.createdAt >= member.joinedAt` |
| `POST /api/conversations/:id/messages` | Send a message (REST fallback, and the path used when attaching a file) | caller is an active member |
| `POST /api/conversations/:id/attachments` | Upload a file, returns an attachment id | caller is an active member |
| `GET /api/files/:attachmentId` | Download | active member of the attachment's conversation **and** the attachment's message is at or after `joinedAt` |
| `POST /api/conversations/:id/read` | Mark read up to a message | caller is an active member |

`GET /api/files/:attachmentId` takes an opaque id and re-derives everything else server-side. No
endpoint ever accepts a filesystem path, a storage key, or a sender id from the client
(`CLAUDE.md` §9).

### Join-time history visibility (D-03)

A member added to a group sees **only messages sent at or after they joined**. Prior history is
not delivered and is not retrievable.

Implementation rule — this is one rule applied in three places, and missing any one of them
leaks history:

1. **Message history queries** filter `Message.createdAt >= member.joinedAt`.
2. **File downloads** apply the same bound. Membership alone is not sufficient: an attachment id
   from before the join must be refused, or the history restriction is bypassed by asking for the
   file instead of the message. This is the easiest of the three to forget.
3. **The conversation list preview and unread count** are computed over the visible window only,
   so a snippet of pre-join conversation never appears in the sidebar.

Live delivery needs no special handling: a new member's socket joins the room at the moment of
joining, so it receives only what is sent afterwards.

**Re-adding a removed member** resets `joinedAt` to the new join time, so their visible window
starts again from that point and previously visible messages become inaccessible. This follows
directly from the stated rule. If instead a re-added member should regain their earlier window,
membership needs to be modelled as multiple dated periods rather than one row — noted as Q-17,
deliberately not built now.

Direct (one-to-one) conversations are unaffected: both members join at creation, so their
`joinedAt` covers the whole history.

---

## 8. File transfer flows

Storage layout under `UPLOAD_DIR`, a path outside the repository and outside `public/`:

```text
$UPLOAD_DIR/
  2026/08/9f2c1d7a-....bin       <- UUID name, no original filename, no real extension
  2026/08/b31e0a45-....bin
  tmp/upload-<uuid>.part         <- in flight, removed on failure
```

The original filename is stored **only as a database column**, never as a path component. Stored
files carry no meaningful extension, so nothing on the server can be induced to execute or
content-sniff them by name.

### Upload

```text
1. Browser  POST /api/conversations/:id/attachments   (multipart/form-data, one file)
2. Server   resolve session -> verify active membership of :id
3.          reject early when Content-Length exceeds MAX_FILE_SIZE
4.          stream to $UPLOAD_DIR/tmp/upload-<uuid>.part behind a hard byte counter;
            abort and delete the moment the counter exceeds MAX_FILE_SIZE
            (never buffer a whole upload in memory)
5.          inspect the leading bytes to detect the real type;
            require the declared extension to be in the allowlist AND the detected type to be
            consistent with it (a .pdf whose bytes are not a PDF is rejected)
6.          storageKey = yyyy/mm/<uuid>.bin ; rename tmp -> final
7.          INSERT Attachment {conversationId, uploaderId, originalFilename, storageKey,
                               byteSize, mimeType, checksum, status=READY}
8.          respond { attachmentId, originalFilename, byteSize }
9. Browser  POST /api/conversations/:id/messages  { attachmentId, clientMessageId }
10. Server  verify the attachment belongs to this conversation, was uploaded by this user,
            is READY and not already attached -> create Message(type=FILE) in a transaction
            -> broadcast message:new
```

Splitting upload from message creation is deliberate: it lets the UI show real progress, it keeps
a failed upload from producing a broken message, and it gives a clean place to garbage-collect
abandoned uploads (a sweep of unattached rows older than N hours — a Phase 7 detail).

Upload progress uses `XMLHttpRequest`'s `upload.onprogress`; `fetch` alone reports no upload
progress. Minor, but it decides how the client upload code is written.

### Consequences of the 500 MB limit (D-05)

`MAX_FILE_SIZE` is set to 500 MB initially and is environment-configurable, so the company can
raise or lower it later against real storage, bandwidth, and backup capacity. At that size the
single-request streaming upload above still works — bytes never accumulate in memory — but four
things need explicit attention in Phase 7, none of which change the design above:

- **No resume.** A connection dropped at 90% restarts from zero, because a single POST cannot be
  resumed. On a LAN this costs seconds, so it is an annoyance rather than a defect; if it proves
  disruptive in practice, chunked/resumable upload is the answer and is deliberately deferred
  (Q-18).
- **Timeouts.** The reverse proxy's `client_max_body_size` must match `MAX_FILE_SIZE`, and its
  read/send timeouts must exceed the slowest realistic transfer, or large uploads die at the proxy
  before the application ever sees them.
- **Temporary disk.** Partial uploads occupy `UPLOAD_DIR/tmp` at full size; the abandoned-upload
  sweep matters more at 500 MB than at 50 MB.
- **Storage growth.** With indefinite retention (Q-10 still open) and a 500 MB ceiling, disk
  capacity and backup volume become a real operational planning item for Phase 10, not a
  footnote.

### Download

```text
1. Browser  GET /api/files/:attachmentId
2. Server   resolve session
3.          load the Attachment by id -> conversationId
4.          verify the caller is an active member of that conversation   <- the gate that matters
5.          absolute = path.resolve(UPLOAD_DIR, storageKey)
            assert absolute.startsWith(path.resolve(UPLOAD_DIR) + path.sep)   <- traversal guard
6.          stat the file; if missing -> 404 plus a server-side error log (metadata/blob drift)
7.          stream with:
              Content-Type: application/octet-stream
              Content-Disposition: attachment; filename="<ascii-safe>"; filename*=UTF-8''<pct>
              X-Content-Type-Options: nosniff
              Cache-Control: private, no-store
```

**DECIDED (D-10): v1 is download-only. No inline file or image previews.** Everything is
served as an attachment with a generic content type, images included. That removes a whole class
of stored-XSS and content-sniffing problems: a crafted SVG or HTML file rendered inline on the
application's own origin runs script in the application's security context. If previews are ever
wanted, the safe route is a separate origin or a sandboxed response — out of scope for v1.

The traversal guard in step 5 is defence in depth. `storageKey` is server-generated and never
user-influenced, so the check should be unreachable. It is written anyway, because "should be
unreachable" is exactly how traversal bugs occur.

---

## 9. Error handling & logging model

- Services throw typed domain errors (`NotFoundError`, `ForbiddenError`, `ValidationError`,
  `PayloadTooLargeError`, `ConflictError`). One mapper converts them into HTTP status codes and
  socket error acks, so the two entry points cannot answer the same situation differently.
- The browser receives `{ error: { code, message } }` with a safe, human-readable message and a
  correlation id. Stack traces, SQL text, filesystem paths, and environment values never cross
  the boundary (`CLAUDE.md` §13).
- Server logs are structured, carry the correlation id, and record: unhandled errors, database
  failures, upload rejections with the reason, authorization denials, socket handshake failures,
  and process lifecycle events. Message bodies, file contents, and cookie or token values are
  never logged (`CLAUDE.md` §14).
- The log level is environment-configured; pretty-printing is development only.
