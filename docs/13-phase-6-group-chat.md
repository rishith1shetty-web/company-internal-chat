# Phase 6 — Group Chat

**Status:** Complete. Employees can create groups, talk in them in real time, add colleagues,
remove them, and leave. Everything runs against PostgreSQL through the Phase 4 gateway.

**Scope:** group conversations and their membership. File transfer is Phase 7 and network
restriction is Phase 8; neither was touched. Renaming a group is deliberately not implemented —
see §8.

**What did not change:** the schema, the Phase 2 visual design, and the direct-chat behaviour of
Phase 5. No migration was written for this phase and none was needed.

---

## 1. Why there is no migration

The Phase 3 schema already modelled groups completely, because Phase 0 designed for them:

| What a group needs | Where it already was |
|---|---|
| A group kind of conversation | `ConversationType.GROUP` |
| A name | `Conversation.name varchar(120)`, null for direct conversations |
| Membership | `ConversationMember`, unique on `(conversationId, userId)` |
| An owner | `MemberRole.OWNER` / `MEMBER` |
| A join-bounded history window | `ConversationMember.joinedAt` |
| Removal without losing the record | `ConversationMember.leftAt`, row retained |
| Group events in the timeline | `MessageType.SYSTEM`, sender null |

`Conversation.directKey` stays null for a group: it is the constraint that makes at most one
direct conversation per pair, and two groups containing the same people are two different groups.

Phase 5 also wrote its listing, preview, unread and history queries against the generic membership
model rather than against direct conversations specifically, and applied the `joinedAt` filter
even where it was a no-op. That is why adding groups changed neither `listConversationsForUser`
nor `listMessages`: the clause that did nothing for a direct conversation is the clause that now
hides a group's earlier history from a newcomer.

---

## 2. Shape of the change

```text
Browser
  ├── POST   /api/conversations                          { type: "GROUP", name, memberIds[] }
  ├── POST   /api/conversations/:id/members              { userIds[] }
  ├── DELETE /api/conversations/:id/members/:userId      leave, or remove
  └── Socket  message:send / message:new                 unchanged from Phase 4

Server
  app/api/conversations/…            validate → authorize → service → notify → re-read
  lib/conversations/service.ts       createGroupConversation, addGroupMembers, removeGroupMember
  lib/authz/membership.ts            unchanged — already the single authorization seam
  lib/realtime/notify.ts             the one seam from a route handler to the socket server
  lib/realtime/gateway.ts            + conversation:changed, room join/leave on membership change
```

Every group operation follows the same order, and the order is the design:

1. **Authorize from the database.** A conversation id in a request is a request, never a
   permission. `requireGroupMembership` reads the caller's own active membership first.
2. **Validate.** Name, member ids, count ceilings.
3. **Commit**, in one transaction, with the `SYSTEM` message recording what happened.
4. **Notify** the members — after the commit, never before.
5. **Re-read** through `listConversationsForUser` to build the response, so a reply can never
   describe a conversation differently from the way the sidebar will.

---

## 3. Group creation

`POST /api/conversations` with `type: "GROUP"`. The body carries a name and the other people's
ids, and nothing else. There is no `createdById`, no `role`, no `joinedAt` and no member entry for
the caller: they are taken from the session, made a member, and made the `OWNER`. An API that
accepted any of those would let a caller create a group they are not in, or hand ownership to
somebody else.

Members are named by **id**. Two colleagues may share a display name (D-02), so a name could not
identify which was meant even if the API accepted one — and the picker shows an id-derived
discriminator for exactly that reason.

Duplicate ids collapse rather than failing: `[bob, bob, bob]` is the same request as `[bob]`, and
the caller naming themselves is ignored. A group with no other members, an empty name, a name over
120 characters, or an id that is not an active user is refused, and nothing is created.

---

## 4. The join-bounded window (D-03)

The rule: **a member sees only messages with `createdAt >= joinedAt`.** From the requirement:

```text
10:00  group created
10:05  message A
10:10  message B
10:20  John added        →  John never sees A or B
```

Enforced in five places, each tested separately, because a rule applied in four places out of five
is a disclosure:

| Path | Where |
|---|---|
| Message history | `listMessages` — the window, *and* the cursor lookup, so a member cannot page past their own join by handing in an older message id |
| Reconnect backfill | the same function, `after` branch |
| Sidebar preview | `loadPreviews` — computed inside the caller's window |
| Unread count | `countUnread` — same |
| Socket room | `findActiveMembership` before `socket.join`, and the room is repaired only from the membership table |

**Nothing is deleted to achieve it.** Messages A and B stay exactly where they are and stay
readable by the members who were present for them. The newcomer's window is narrower; the
conversation is not shorter.

Phase 7 must apply the same bound to file downloads through the attachment's message (R-14).
Membership alone is not sufficient there.

### Where the timestamp comes from, and why it matters

`joinedAt` is compared against message `createdAt`, which the schema fills from the **database**
clock (`DEFAULT CURRENT_TIMESTAMP`). So the join time must come from the same clock. Two wrong
ways were tried during this phase:

- **`new Date()`** is the application's clock. On a server running even slightly ahead of the
  database, a member added "now" gets a join time *before* messages that already exist, and sees
  history they are not entitled to.
- **`SELECT now()` through `$queryRaw`** is worse, because it looks right. Prisma's raw path
  renders a `timestamptz` in the database session's zone and returns it as though it were UTC. On
  the development machine, whose PostgreSQL session runs in `America/New_York`, it was out by four
  hours — four hours of a group's history handed to somebody who had just joined. A test caught
  it; nothing about the value looks wrong until it is compared with another one.

What is used instead: every group operation already writes a `SYSTEM` message recording what
happened. That row is written **first**, its `createdAt` filled in by the column default, and read
back through Prisma's ordinary model mapping, which round-trips correctly. The membership rows are
then stamped with exactly that value. Only one clock is consulted, and a new member's `joinedAt`
is precisely the timestamp of the message announcing them — so their window admits the event that
added them and nothing before it.

`writeSystemMessage` therefore takes no `createdAt` parameter, on purpose.

---

## 5. Adding members

`POST /api/conversations/:id/members`. Any active member may add (§7). Everybody added gets
`joinedAt = now`, which is the whole security story of the operation.

- Somebody **already in the group is skipped, not rejected**. Two people adding the same colleague
  at the same moment is an ordinary race, and re-adding a current member would reset their
  `joinedAt` and silently hide history they can currently read — a far worse outcome than doing
  nothing. The picker also omits current members, so it is not normally asked.
- Re-adding somebody who **previously left** resets `joinedAt` to now and clears their read
  marker. Their window restarts from this moment rather than resuming (Q-17, assumed and now
  implemented). The marker is cleared because one pointing at a message from before this join
  would sit outside their new window and suppress the unread count.
- At most 100 people per request. Not a policy about group size — it bounds the work one request
  can ask for.

---

## 6. Removing and leaving

`DELETE /api/conversations/:id/members/:userId`. One endpoint for both, because they are the same
operation with different authorization. Which one it is comes from comparing the path's id with
the **session's** id — never from a flag in the request, which would let a caller choose the rule
they are judged by.

The membership row is **not deleted**; `leftAt` is set. That preserves who was present when, keeps
the person's messages in the conversation and attributed to them, and is why every authorization
check in this application tests `leftAt IS NULL` rather than the row's existence.

The response describes the conversation as the caller can now see it — `null` for somebody who has
just left, produced by the same membership-filtered query as the sidebar, so it cannot accidentally
describe a group the caller is no longer in.

**Ownership succession.** If the last owner leaves, ownership passes to the longest-standing
remaining member. Without it a group would quietly become unmanageable: nobody able to remove
anyone, and no way back short of direct SQL.

---

## 7. Q-05b answered

Q-05b (group management permissions) was open with a recommended option. This phase adopts **option
(a)**, the documented recommendation:

| Action | Who |
|---|---|
| Add a member | any active member |
| Remove somebody else | `OWNER` only |
| Leave | anybody, always |
| Rename the group | **not implemented** (§8) |

Leaving needs no permission because it takes access away rather than granting it. Adding is open to
any member because the alternative makes an owner on holiday a bottleneck for a team that needs
somebody in the conversation. This is reversible: it is four lines in
`lib/conversations/service.ts`, and the tests state the rule explicitly.

The controls in the interface follow the same rules, but they are a courtesy and never the
authorization — the server re-derives the caller and their role on every request, and a hidden
button is not a control.

---

## 8. Deliberately deferred

| Item | Why |
|---|---|
| **Renaming a group** | Listed under F-15, but not in this phase's brief. It needs the same role decision behind it that removal has, and `Conversation.name` is displayed to every member. One endpoint and one role rule when it is wanted. |
| **Restoring a returning member's old window** | Q-17: re-joining starts a fresh window. Preserving the earlier one needs membership modelled as dated periods rather than one row — a schema change, and one best made deliberately. |
| **Group avatars, descriptions, pinned messages, mentions** | Not in scope (`CLAUDE.md` §19). |
| **A group with no members left** | Possible: the last member may leave. The conversation and its messages remain, visible to nobody. Cleanup is a retention question (Q-10), not a Phase 6 one. |
| **Rate limiting on membership changes** | Phase 9, with the rest of the rate limiting. |

---

## 9. Real time

Group messages need no new socket event: `message:send` and `message:new` already authorize from
the database and broadcast to a room whose membership the server decided.

What is new is `conversation:changed`, emitted when a membership change commits over HTTP. It
carries **a conversation id and nothing else**. Every browser that receives one re-reads through
`GET /api/conversations`, which authorizes from that caller's own membership rows — so the event
cannot disclose a name, a member list or a message, and a browser that received one in error would
simply learn nothing.

The gateway also joins the added members' sockets to the room and removes the departed members'
sockets from it, both from the membership table. That is what makes the next message reach a new
member without a reload, and stop reaching somebody who has left.

`lib/realtime/notify.ts` is the only seam from a route handler to the socket server. It is
registered on `globalThis` — like the Prisma client, and for the same reason: Next.js bundles route
modules separately from the code `tsc` compiles for the custom server. When no gateway is attached
every function is a no-op, which is correct rather than lenient: the change is already committed,
and PostgreSQL is the source of truth. A browser that misses the event gets the change on its next
read, and every reconnection performs one.

---

## 10. Unread counts and `SYSTEM` messages

A `SYSTEM` message does not raise the unread badge. `senderId: { not: userId }` compiles to
`senderId <> $1`, which is NULL — and therefore false — for a server-written message.

That is also the behaviour to want: a badge says somebody has said something to you, and "Alice
added Bob" has not. Without it, creating a group would put an unread marker on every member's
sidebar including the creator's. The group still surfaces, because the event moves `lastMessageAt`
and sorts the conversation to the top of the list.

The Phase 5 comment in `countUnread` asserted the opposite, and was wrong. It has been corrected.

---

## 11. A pre-existing defect found here

Not Phase 6 work, and recorded because the phase's verification is what surfaced it.

`lib/db/prisma.ts` cached its `PrismaClient` on `globalThis` **only outside production**, on the
reasoning that the module is evaluated once in production so a cache would be redundant. Nothing
else held the client, so in production every `getDb()` call constructed a new client with a new
connection pool. A production server accumulated connections request by request until PostgreSQL
answered *"remaining connection slots are reserved for roles with the SUPERUSER attribute"* and
every route began failing at once.

Introduced in Phase 3. Invisible in development, invisible in unit tests, and invisible until a
production build has served a few hundred requests — which the Phase 6 browser regression was the
first thing to do.

Measured against the production build, 450 authenticated requests:

| | before | after |
|---|---|---|
| Connections after 75 requests | 96 | 1 |
| Connections after 450 requests | 96 (PostgreSQL's ceiling) | 1 |

The fix is one line: cache unconditionally. `tests/db/client.test.ts` asserts that repeated
`getDb()` calls return the same instance with `NODE_ENV=production`.

---

## 12. Tests

`tests/chat/groups.test.ts` — 28 tests against the real database, the real route handlers and a
real Socket.IO server.

**Creation.** Creator becomes an owner and a member; chosen colleagues become members; two
colleagues sharing a display name are told apart by id; duplicate ids collapse to one membership;
a group with nobody else, an unusable name, a non-existent user and a retired user are all refused
with nothing created; creation over HTTP works and is refused without an identity.

**Authorization.** A member reads and sends; an outsider is refused history, refused a send,
refused the socket room at connection and on request, and refused the members endpoint without
anything being written; any member may add; only an owner may remove somebody else; anybody may
leave; membership cannot be changed on a direct conversation; ownership passes on when the last
owner leaves.

**Join-bounded history.** Pre-join messages hidden from a new member and post-join messages
visible; the hidden messages still in the database and still readable by the members who were
there; a cursor from before the join refused in both directions; the reconnect backfill bounded;
preview and unread count bounded; a re-added member's window restarted and their read marker
cleared; a current member not reset by a redundant add; a leaver's group gone from their list and
nobody else's.

**Real time.** Committed before broadcast; delivered to members; not delivered to an outsider;
`clientMessageId` idempotency intact with no second broadcast; a member added while connected
receives the next message without reconnecting; a removed member stops receiving and cannot rejoin
the room.

**Regression.** Direct conversations still resolve one per pair; an unknown conversation type is
refused; error messages carry nothing about a group the caller cannot see.

Placing the "before" messages is deliberate: the helper adds the latecomer through the real code
path, reads the `joinedAt` that produced, and then writes the two earlier messages into the gap
between the group opening and that join. Sending them and hoping the clock lands the right way
would make a security test a race.

### Verification runs

| | |
|---|---|
| `npm test` | 228 passed, 13 files |
| `npm run typecheck` | pass (app and server) |
| `npm run lint` | pass, no warnings |
| `npm run build` | pass; both new routes present |
| Production end-to-end, group chat | 46/46 |
| Production end-to-end, admin identity (Phase 5.5 regression) | 61/61 |
| Browser regression, group chat | 47/47 |
| Browser regression, admin identity | 60/60 |
| Connection growth under 450 authenticated requests | flat at 1 |
| `npm run db:audit` | clean |
