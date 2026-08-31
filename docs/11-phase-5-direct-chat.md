# Phase 5 — One-to-One Chat

**Status:** Complete. The Phase 2 interface is connected to the real server. Identity, the
colleague directory, conversations, message history, sending, live delivery, unread counts,
presence and reconnection all run against PostgreSQL through the Phase 4 gateway.

**Scope:** Direct (one-to-one) conversations only. Group creation is Phase 6 and file transfer is
Phase 7; both controls exist in the interface and say plainly that they are not built yet rather
than appearing to work. See §12 for the full list of what was deliberately left out.

**What did not change:** the Phase 2 visual design. No layout, no component structure, no styling
decision was revisited. The changes to components are the ones connecting them to real data
required — new props, honest copy where the old copy said "nothing is saved", and a delivery-state
affordance the design already anticipated.

---

## 1. Shape of the change

```text
Browser
  │
  ├── REST  ── /api/session, /api/users, /api/conversations,
  │            /api/conversations/:id/messages, /api/conversations/:id/read
  │              → the source of truth. Everything the interface knows, it read from here.
  │
  └── Socket ── message:send, conversation:join/leave, presence:sync
                message:new, presence:update, session:ready, server:error
                   → delivery only. Nothing arrives here that could not be re-read over REST.

                            both on one port, one origin, one process (D-09)
                                              │
                                    resolveIdentity(cookie) → User.id
                                              │
                                   findActiveMembership() → allowed?
                                              │
                                        Prisma → PostgreSQL
```

The client rule, stated once and applied everywhere: **PostgreSQL is the source of truth; the
socket is a delivery accelerator.** History is read over REST and never replayed from the socket;
every reconnection re-reads rather than assuming; a message is shown as sent only once the server
has acknowledged the committed row.

---

## 2. Files

### Server

| File | Purpose |
|---|---|
| `lib/conversations/service.ts` | Resolve/create a direct conversation, list conversations with previews and unread counts, move the read marker |
| `lib/users/directory.ts` | The minimum colleague directory needed to start a chat |
| `lib/messages/service.ts` | *(extended)* `listMessages` — keyset-paginated history with membership and `joinedAt` bounds |
| `lib/http/route-helpers.ts` | The shared route preamble: authenticate, refuse, renew the session cookie, answer errors in one shape |
| `lib/http/serialize.ts` | Database rows → wire shapes; the one place that decides what a browser sees |
| `lib/chat/wire.ts` | The wire contract shared by browser and server. Imports nothing, so it is safe in both bundles |
| `app/api/users/route.ts` | `GET` the directory |
| `app/api/conversations/route.ts` | `GET` the caller's conversations · `POST` resolve a direct conversation |
| `app/api/conversations/[id]/messages/route.ts` | `GET` history (`before` / `after` / `limit`) |
| `app/api/conversations/[id]/read/route.ts` | `POST` move the read marker |
| `lib/realtime/events.ts` | *(extended)* `presence:sync`; wire types now re-exported from `lib/chat/wire.ts` |
| `lib/realtime/gateway.ts` | *(extended)* `presence:sync` handler; room repair on the send path |

### Browser

| File | Purpose |
|---|---|
| `lib/chat/api.ts` | Every HTTP call the interface makes. Sends no identity — the cookies do that |
| `lib/chat/socket.ts` | The Socket.IO connection, with a promise-shaped API and connection state |
| `lib/chat/useChatSession.ts` | The controller: everything with a side effect, in one place |
| `lib/chat/state.ts` | *(rewritten)* The reducer now applies server answers instead of inventing them |
| `lib/chat/types.ts` | *(extended)* `DeliveryState` gains `FAILED`; `Conversation` gains `lastMessage` |
| `components/chat/ConnectionNotice.tsx` | A one-line status strip: reconnecting, disconnected, or a failure worth showing |
| `components/chat/ChatWorkspace.tsx` | *(rewired)* Holds no chat state; hands the hook's data to the same components as before |
| `components/chat/MessageList.tsx` | *(extended)* Sending/failed states, retry, and "load earlier messages" |
| `components/chat/NameEntryScreen.tsx` | *(extended)* Pending state, server errors, honest copy |
| `components/chat/SystemDialogs.tsx` | *(extended)* `GroupsUnavailableDialog`; corrected switch-user copy |
| `scripts/db-audit.ts` | Read-only row audit, to prove a test run left nothing behind |

**Removed:** `lib/mock/chat-seed.ts`. Mock data is no longer the source of truth for anything, and
leaving a sample workspace in the tree would be an invitation to reintroduce it.

---

## 3. Identity (D-02, D-11, D-13 preserved)

Nothing about identity changed. Phase 5 uses what Phase 4 built:

- The browser calls `GET /api/session` on load. No identity → the name screen. Identity → the
  workspace, with the `User.id` the server named.
- `POST /api/session` always creates a **new** user. Entering a name somebody else already uses
  does not sign you in as them.
- The device cookie reattaches a browser to the same `User.id` after the 24-hour session lapses,
  and the renewed session cookie is handed back on the next request through `withRenewedSession`.
- **Switch User** revokes the session and the device server-side. If that call fails, the
  interface stays signed in and says so — clearing the screen while the cookies still worked would
  be the worst outcome on a shared computer.

**A display name is never an identifier.** `GET /api/users?q=` matches `normalizedName` to *filter*
the list; every row carries its id, and every subsequent call names a user by id. Two colleagues
called "Sarah Chen" are two rows, and the picker shows an id-derived discriminator so they can be
told apart.

---

## 4. Direct conversations

`POST /api/conversations` takes `{ type: "DIRECT", userId }` — the person to talk to, and nothing
else. There is no field for a conversation id, a member list, a role or a creator, so a browser
cannot manufacture membership of anything.

One conversation per pair is enforced by the **database**, not by hopeful application code:
`Conversation.directKey` is the two ids sorted and joined, with a unique index. Two browsers
clicking at the same instant race into the same key; the loser catches the unique violation and
returns the winner's row. A test drives three concurrent requests and asserts one conversation
exists.

`type: "GROUP"` is rejected with a 400 and a message saying groups are not available yet.

---

## 5. Message history

`GET /api/conversations/:id/messages` with keyset pagination on `(createdAt, id)` — the index the
schema declares for exactly this query. `OFFSET` was not used: it silently skips or repeats rows
as messages arrive underneath it, which in a live chat is not a theoretical concern.

- Default 50 messages, ceiling 100. An oversized `limit` is clamped, not honoured.
- `before=<id>` pages backwards; `after=<id>` backfills forwards after a reconnect.
- A cursor is a message id from a browser, so it is verified: it must belong to *this*
  conversation and lie inside the caller's window, or the request is refused.
- **`joinedAt` bounds every query (D-03)** — including the cursor lookup, or a member could page
  past their own join time by handing in an older message's id.

Authorization failure and "no such conversation" are the same 403 with the same body. The body
does not contain the conversation id.

---

## 6. Sending, and what the user sees

```text
type → optimistic bubble (SENDING) → message:send → validate → authorize
                                        → INSERT + lastMessageAt in one transaction
                                        → COMMIT → ack → bubble becomes the stored row (SENT)
                                                       → broadcast to the conversation room
```

The Phase 4 ordering is unchanged and nothing is broadcast before the row exists. What Phase 5
adds is the browser's half:

- `clientMessageId` is minted once per message and **reused verbatim on retry**, so a retry after
  a lost acknowledgement collides with the stored row instead of writing a second message.
- A failed send is shown as failed — outlined, with "Not sent · Try again" — never as delivered.
- The reducer reconciles on the server id first and `clientMessageId` second, so a broadcast that
  races the acknowledgement produces one message, not two, in either arrival order.

---

## 7. Unread counts

Computed, not stored (`docs/02-database.md`, "Not modelled"): the number of messages in the
caller's visible window newer than `ConversationMember.lastReadAt` that they did not send.

- `GET /api/conversations` returns the count with each conversation, in one grouped query.
- `POST /api/conversations/:id/read` moves the marker. The message id is verified against the
  conversation and the window, and the marker only ever moves **forward** — a stale request from a
  second tab cannot bring a cleared badge back.
- The interface clears the badge optimistically on open and then takes the server's recomputed
  count as the answer.

---

## 8. Presence

The Phase 4 mechanism, unchanged: derived from live sockets, scoped to people who share an active
conversation. Phase 5 adds one event, `presence:sync`, because a client that has just connected
has no way to know who was already online, and presence is deliberately not public so it cannot
simply be included in a directory response.

The client calls it on connect, after starting a conversation, and when a message arrives for a
conversation it had not heard of — that last case is a colleague who has only just become a
presence peer, and without it they would show as offline until something else changed.

`GET /api/users` returns `lastSeenAt` and **no** online flag. A colleague who is merely in the
directory is shown with their last-seen time; that is all a REST response is entitled to say.

---

## 9. Reconnection

`session:ready` is emitted on every successful connection, including reconnections. The client
treats it as "re-read everything": reload the conversation list, re-join the open conversation,
backfill with `after=<newest known server message id>`, re-sync presence.

Socket.IO's own connection-state recovery stays off. Replaying an in-memory buffer would not
survive a server restart; the database does.

A conversation created *after* a socket connected has no room for that socket. Rather than have
conversation creation reach into the socket server, the gateway repairs room membership on the
send path — from the database, using the same authorization source `conversation:join` uses. It
adds people who are entitled to the room, never people who asked for it.

---

## 10. What the browser may say

Nothing. Every request derives its user from the cookie:

| A client tries to… | What happens |
|---|---|
| send `senderId` in `message:send` | The schema has no such field; it is dropped before a handler sees it |
| pass `createdById` or `members` to `POST /api/conversations` | Same — Zod strips them; the caller is always the creator and a member |
| read a conversation it is not in | 403, identical to a conversation that does not exist |
| join a room it is not a member of | `FORBIDDEN`; `socket.join` is never reached |
| mark read with another conversation's message id | 403 |
| page past its own `joinedAt` | The cursor is rejected |
| ask for 10,000 messages | Clamped to 100 |

---

## 11. Verification

| Check | Result |
|---|---|
| `npm test` | **152 passed** in 10 files |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Pass; 8 routes |
| `npm run dev` | Starts, gateway attached, `/` and `/socket.io` respond |
| `node dist/server.js` end-to-end | **36/36** — two identities, real cookies, real sockets |
| Browser regression (headless, two profiles) | **24/24** — no console errors, no overflow, desktop and mobile |
| `npm run db:audit` | All seven tables at 0 rows; no verification data left behind |

The Phase 5 suite (`tests/chat/`, 79 tests) covers the directory, conversation resolution and the
duplicate-pair race, unread counts and read markers, history pagination and its authorization, the
REST handlers called as real `Request` objects, one-to-one chat over real sockets, identity and the
D-14 persistence guarantees, and the browser reducer's reconciliation rules.

---

## 12. Deliberately not in Phase 5

- **Group conversations** (Phase 6). `NewGroupDialog` is written and left in place for that phase;
  the control opens `GroupsUnavailableDialog` until the server side exists.
- **File transfer** (Phase 7). The attachment control still opens the Phase 2 placeholder.
- **Rate limiting** (Phase 9). `RATE_LIMITED` remains reserved in the socket contract, unenforced.
- **Cross-tab read synchronisation.** Marking a conversation read in one tab does not clear its
  badge in another until that tab re-reads. Correct within a tab; the fix is a `conversation:read`
  broadcast, which is not worth an event until somebody asks for it.
- **Directory scope.** Q-06 — who should be visible to whom once real authentication exists — is
  still open. The directory lists the users this application created, and nothing more.
- **A colleague's presence in the picker.** Shown as last-seen rather than live, because Phase 4
  scopes presence to shared conversations and this endpoint has no conversation to scope by.

---

## 13. Notes for whoever picks this up

- `NODE_ENV` is not set in `.env`, so a locally built server still reports `development` and the
  Next.js dev indicator appears in the corner. Production deployment (Phase 10) sets it.
- The conversation list runs one indexed query per conversation for its preview. That is a
  deliberate trade against raw SQL `DISTINCT ON`; revisit it if a person ever has hundreds of
  conversations.
- Every server-side rule that matters lives in `lib/authz/membership.ts`,
  `lib/conversations/service.ts` and `lib/messages/service.ts`. Phase 6 should add group
  authorization to those, not to the route handlers.
