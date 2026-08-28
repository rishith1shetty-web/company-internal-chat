# Phase 4 — Real-Time Messaging

**Status:** Complete. Socket.IO is attached to the custom server, every handshake is authenticated
server-side, conversation rooms are membership-checked, messages persist to PostgreSQL before
delivery, and presence is derived from live connections.

**Scope:** The real-time infrastructure and the identity resolution it depends on. No chat feature
is wired into the interface — the Phase 2 UI is untouched and still runs on its sample data. See
§12 for what is deliberately left to Phase 5.

---

## 1. Architecture

Unchanged from D-09: one process, one port, one origin.

```text
Browser
  │  HTTP  ──────────────►  Next.js (pages, /api/session, /api/health)
  │  WSS   ──────────────►  Socket.IO gateway            ┐
  │                                                       ├── same http.Server, same port
  └── cookie applies to both, so no CORS and no second origin
                                   │
                       resolveIdentity(cookie) → User.id
                                   │
                    findActiveMembership() → rooms, messages
                                   │
                              Prisma → PostgreSQL
```

`server.ts` creates the `http.Server` and passes it to `createRealtimeGateway()`. Socket.IO
attaches to that instance rather than creating its own listener, which is the entire reason the
custom server exists. No second server, no second port, no separate service.

The gateway is created **only when a database is configured**. Without `DATABASE_URL` there is no
identity to resolve and no message to persist, so the socket server would have nothing to do —
and the Phase 2 interface must keep working on a machine with no `.env`.

---

## 2. Files

| File | Purpose |
|---|---|
| `lib/realtime/gateway.ts` | The gateway: handshake authentication, rooms, message flow, presence announcements |
| `lib/realtime/events.ts` | The event contract: payload schemas, error codes, wire types |
| `lib/realtime/presence.ts` | In-memory presence tracker with multi-connection counting and a grace period |
| `lib/auth/session.ts` | Identity: issue, resolve, revoke. The single swap point for real authentication |
| `lib/auth/tokens.ts` | Opaque token generation and SHA-256 hashing |
| `lib/authz/membership.ts` | Membership authorization, including `leftAt` and `joinedAt` handling |
| `lib/messages/service.ts` | Send/validate/persist, duplicate-send handling, `SYSTEM` messages |
| `app/api/session/route.ts` | POST enter · GET who-am-I · DELETE switch-user |
| `server.ts` | Gateway attachment and socket-aware graceful shutdown |
| `lib/config/env.ts` | `SESSION_TTL_HOURS`, `DEVICE_ID_TTL_DAYS` |
| `tests/realtime/` | 33 integration tests against real sockets and the real database |

---

## 3. Identity — and a scope note

**The Socket.IO handshake authenticates from the session cookie, and nothing was issuing that
cookie.** Phase 3 created the `Session` and `Device` tables; nothing wrote to them. Phase 4
therefore had to implement the identity mechanism designed in D-11/D-13, because a socket layer
that cannot identify its caller is not a socket layer worth having.

What was implemented is the minimum the handshake needs, no more: issue an identity, resolve one,
revoke one. This is not authentication and no password exists anywhere in it.

```text
POST   /api/session          enter a display name → new User + Device + Session, two cookies
GET    /api/session          who am I (204 when nobody)
DELETE /api/session          Switch User: revokes Session AND Device server-side
```

Both cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production. Only the
SHA-256 hash of each token is stored, so a database backup yields no working cookie.

**Resolution order** (`lib/auth/session.ts`):

1. A valid, unexpired session → that user. Expiry slides forward, throttled to at most one write
   per five minutes so an active user does not cause a write per event (D-04).
2. Otherwise a valid, unrevoked, unexpired **device** cookie → a **new session for the same
   `User.id`** (D-13), so conversations and history stay reachable across expiry (D-14).
3. Otherwise: no identity. The socket handshake is refused.

A device cookie belonging to a different user than the resolved session is ignored, not honoured:
it must never be able to re-point an active session at someone else.

**What identity does not do.** It grants nothing. Every membership check runs identically whether
the identity came from a fresh session or a 90-day-old device cookie (R-16).

---

## 4. Event contract

Small on purpose. Every event added is an authorization rule to maintain.

### Client → server (all acknowledged)

| Event | Payload | Authorization |
|---|---|---|
| `conversation:join` | `{ conversationId: uuid }` | Active membership, read from the database |
| `conversation:leave` | `{ conversationId: uuid }` | None needed — leaving grants nothing |
| `message:send` | `{ conversationId: uuid, body: string, clientMessageId: uuid }` | Active membership; `senderId` comes from the socket |

### Server → client

| Event | Payload | When |
|---|---|---|
| `session:ready` | `{ userId, displayName, conversationIds }` | Once, after a successful handshake |
| `message:new` | the stored message | A message in a room this socket is in |
| `presence:update` | `{ userId, online, lastSeenAt }` | A user sharing a conversation connects or disconnects |
| `server:error` | `{ code, message }` | A failure not tied to a specific request |

Acknowledgements are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Payloads
are parsed with Zod at the boundary before anything reads them: a socket payload is arbitrary
attacker-controlled JSON, exactly like an HTTP body.

**There is no `clientMessageId` equivalent for identity.** No event accepts a `userId`,
`senderId`, `role` or membership claim. The schemas have no such fields, so an extra property in
the payload is dropped before the handler sees it — a test asserts exactly this.

---

## 5. Rooms

- `user:{userId}` — every socket a user has open. Used for presence and cross-tab updates.
- `conversation:{conversationId}` — joined **only** after `findActiveMembership()` returns a row.

`socket.join()` is never called on a client's say-so. On connection the server loads the user's
active memberships from the database and joins those rooms; on request it re-checks. A
reconnecting socket is a new socket with no memory — it inherits nothing from its predecessor,
and a membership removed while it was away is not restored (there is a test for that).

Refusing a room and refusing a non-existent conversation return the **same** `FORBIDDEN`, because
distinguishing them would confirm to an outsider which conversation ids are real.

---

## 6. Message flow

```text
message:send  →  Zod validation (shape, length)
              →  findActiveMembership()            ← authorization, from the database
              →  transaction: INSERT Message + UPDATE Conversation.lastMessageAt
              →  COMMIT
              →  ack { id, createdAt, … }          ← only now is it "sent"
              →  broadcast message:new to the room, excluding the sender
```

The acknowledgement **follows** the commit. Nothing is broadcast before PostgreSQL has the row,
and a message never exists only in memory: restart the server and the message is still there,
because the database is the source of truth and the socket layer is a delivery accelerator.

`senderId` is taken from `socket.data.userId`, which was set at handshake from the cookie. The
client cannot influence it.

Validation performed server-side, regardless of what the UI did: conversation id shape, body
present, body ≤ `MAX_MESSAGE_LENGTH` (4000), membership, and message type (Phase 4 sends `TEXT`;
`SYSTEM` is server-written only, and `FILE` waits for Phase 7).

---

## 7. Duplicate-send handling

The database constraint `unique (senderId, clientMessageId)` is the mechanism; the service is
built around it rather than duplicating the check in application code:

1. Insert optimistically.
2. On a `P2002` violation, load the existing row and return it with `duplicate: true`.
3. The caller acknowledges with the **existing** message and does **not** broadcast again.

So a client that retries after a lost acknowledgement gets the same message id and timestamp, the
room sees one message, and the history contains one row. The same `clientMessageId` from a
*different* sender is a different message and is allowed — the constraint is on the pair.

---

## 8. Presence

Derived from connections the server actually holds, never from a client announcing itself.

- `Map<userId, Set<socketId>>` — one entry per live socket.
- A user is online while **any** socket remains. Closing one of three tabs changes nothing.
- When the last socket goes, a **10-second grace period** runs before offline is announced. A page
  reload disconnects and reconnects within a second; without the delay the presence dot would
  flicker for every refresh, which teaches people to distrust it.
- A reconnect inside the grace window cancels the pending offline entirely.
- `User.lastSeenAt` is persisted on connect and on going offline, so "last seen" survives a
  restart.

Presence is announced **only to users who share at least one active conversation**, plus the
user's own other tabs. Someone with no conversation in common is not told — there is a test for
that, because presence is otherwise a directory of who is at their desk.

In-memory state is correct for the single process this application runs (D-09). Multi-process
operation would require a shared adapter — the known constraint Q-09, not a defect.

---

## 9. Errors

| Code | Meaning |
|---|---|
| `UNAUTHENTICATED` | Handshake refused: no valid session or device |
| `FORBIDDEN` | Not an active member — or the conversation does not exist |
| `INVALID_PAYLOAD` | Failed schema validation |
| `MESSAGE_TOO_LONG` / `MESSAGE_EMPTY` | Body bounds |
| `RATE_LIMITED` | Reserved; not enforced in Phase 4 |
| `INTERNAL_ERROR` | Anything else, including database failures |

The browser receives a code and a short, safe sentence. Stack traces, SQL, Prisma detail,
filesystem paths, the connection string and configuration values never cross the boundary; they
go to the server log (CLAUDE.md §13, §14). A test sends a payload PostgreSQL rejects and asserts
the client sees `INTERNAL_ERROR` with none of that detail, and that the socket survives.

Message bodies are never logged.

---

## 10. Shutdown

Sockets are closed **before** the HTTP server. An open WebSocket is a live connection and
`server.close()` waits for those to end, so closing them second would make every shutdown sit
until the 10-second force-exit timer fired. Order: gateway → HTTP server → Next.js → database
pool.

---

## 11. Tests

`npm test` — **62 tests, all passing**: 10 database-target guard, 19 schema (Phase 3), 33
real-time (Phase 4). The real-time suite starts a real HTTP server with a real gateway, connects
real `socket.io-client` sockets, and uses the real `company_chat_db`. Nothing is mocked — a test
that stubs the authorization it is checking proves nothing.

| Area | Covered |
|---|---|
| Handshake | valid cookie accepted · no cookie refused · forged token refused · expired session refused · device cookie reattaches to the same user · revoked device refused |
| Impersonation | a client-supplied user id in the handshake is ignored · a `senderId` in a message payload is ignored and the stored sender is the socket's user |
| Rooms | member auto-joined on connect · member may join on request · non-member refused (and genuinely not in the room) · removed member refused · unknown conversation gives the same refusal · malformed payload rejected · rooms are re-derived on reconnect, not restored |
| Messages | persisted before acknowledgement · `lastMessageAt` updated in the same transaction · non-member's message not stored · length enforced · empty rejected · delivered live to the other member · not delivered to an outsider |
| Duplicates | retry returns the same stored message · no second broadcast · different senders may share a `clientMessageId` |
| Presence | online announced to a conversation peer · not announced to a stranger · user stays online while another tab is open · offline only after the last connection closes · `lastSeenAt` recorded |
| Reconnect | identity re-resolved and rooms re-authorized · revoked identity cannot reconnect |
| Errors | unknown event does not break the connection · database failure returns a safe error with no internals |

**Test safety.** Every row is created by the tests, registered by id and deleted afterwards.
Nothing is truncated, no table is emptied, and no row created by anything else is read or
modified. Test users carry `zz-rt-` / `zz-test-` display-name prefixes. Verified after the run:
all seven tables back to zero rows.

### End-to-end verification through the real server

Ten checks against `node dist/server.js` on port 3000: the Phase 2 page still loads; an
unauthenticated socket is refused; `POST /api/session` issues `HttpOnly`/`SameSite=Lax` cookies; a
socket authenticates **on the same port as Next.js**; both members join a room; a message is
acknowledged with a stored id, delivered live to the second browser, and attributed to the
server-derived sender; and a revoked identity cannot reconnect with the same cookie. All ten pass.

| Check | Result |
|---|---|
| `npm test` | 62/62 pass |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Pass |
| `npm run dev` | Starts; gateway attached; `/socket.io` responds 200 |
| Production server | Starts; gateway attached; no unhandled errors |
| Phase 2 UI, headless browser | 30/30 pass, no console errors |
| Database rows after all runs | All tables 0 |

---

## 12. Deferred to Phase 5 and later

Phase 4 built the infrastructure, not the feature. Deliberately **not** done:

- **The UI is not wired to the socket.** `ChatWorkspace` still runs on `lib/mock/chat-seed.ts` and
  stores nothing. Connecting it needs conversation and message endpoints, history loading and
  optimistic rendering — that is the Phase 5 one-to-one chat feature, and doing it here would have
  been Phase 5 in all but name.
- **No conversation or message REST endpoints.** `GET /api/conversations`, message history with
  keyset pagination, `POST /api/conversations/:id/read` — Phase 5.
- **No user directory.** `GET /api/users` — Phase 5.
- **No backfill-on-reconnect client.** The design is settled (fetch `?after=<lastKnownMessageId>`
  from the database rather than replaying socket events, which is why Socket.IO's
  `connectionStateRecovery` is switched off), but the client half belongs with the UI in Phase 5.
- **No group management.** Creating groups, adding and removing members, `SYSTEM` message
  emission — Phase 6. `recordSystemMessage()` exists in the service; nothing calls it yet.
- **No unread counts.** `lastReadMessageId` is in the schema and unused.
- **No file transfer** (Phase 7), **no network restriction** (Phase 8), **no rate limiting** —
  `RATE_LIMITED` is reserved in the error contract but nothing enforces it yet (Phase 9).
- **No AI** (Phase 11).

---

## 13. Dependencies added

| Package | Version | Why |
|---|---|---|
| `socket.io` | 4.8.3 | The real-time layer named in CLAUDE.md §3 and Part A |
| `zod` | 4.5.1 | Payload validation at the socket boundary — the validation library chosen in Part A |
| `socket.io-client` (dev) | 4.8.3 | Test clients. Moves to a runtime dependency in Phase 5, when the browser needs it |

No schema change was required. No database permission changed. No destructive command was run.
