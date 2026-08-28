# Database Design Proposal

Phase 0 proposal. **No database, schema, migration, or Prisma command has been executed, and none
will be executed during Phase 0.**

---

## 0. Database isolation & safety constraint (MANDATORY)

PostgreSQL 16 is already installed on the development machine and hosts **existing databases
belonging to other projects**. **Every pre-existing database on that server is off-limits,
whatever it is called and however many there are.** None of them may be read from, written to,
migrated, reset, dropped, renamed, or affected in any other way by this project (D-07).

The rule is not a list of named databases to avoid — it is the inverse: this project touches
**exactly one** database — `company_chat_db`, which already exists — and nothing else on the server.

Binding rules for every later phase:

1. **`company_chat_db` ALREADY EXISTS.** It was created by the project owner on the existing
   PostgreSQL 16 installation. It must **not** be created, dropped, renamed, recreated, or reset by
   this project — only connected to and migrated forward.
2. **Provisioning is the owner's job, not this project's.** Claude Code does not create the
   database, does not create the PostgreSQL role, and **never uses superuser or administrator
   credentials**. The owner supplies a dedicated application role and its connection details; the
   application uses only that role (D-06, D-15).
3. `DATABASE_URL` lives only in `.env` (git-ignored). `.env.example` carries a placeholder such as
   `postgresql://USER:PASSWORD@localhost:5432/company_chat_db?schema=public` with no real
   credentials.
4. **Before any migration or database command**, the target database name in the active
   `DATABASE_URL` must be printed and confirmed to be `company_chat_db`. A command runs only after
   that check passes. If the target is ambiguous for any reason — **stop and ask**.
5. The following are **prohibited** in this project, in every phase, against **every** database
   including `company_chat_db` itself:
   `DROP DATABASE`, `CREATE DATABASE`, `DROP SCHEMA`, `ALTER DATABASE ... RENAME`,
   `prisma migrate reset`, `prisma db push --force-reset`, any other destructive reset command,
   `TRUNCATE` outside this project's database, and any command run against a connection string
   other than this project's.
6. Schema changes are applied only with **forward migrations** — `prisma migrate dev` in
   development, `prisma migrate deploy` in production.
7. The application connects as a **dedicated PostgreSQL role** limited to `company_chat_db`, with
   no privileges on any other database (D-06). The owner creates and configures that role. Because
   the role is not a superuser, rule 5 is enforced by PostgreSQL rather than by discipline.

### Current PostgreSQL state

```text
PostgreSQL 16 (development machine)
├── Existing Database 1     <- OFF LIMITS, never touched
├── Existing Database 2     <- OFF LIMITS, never touched
├── Existing Database 3     <- OFF LIMITS, never touched
└── company_chat_db         <- ALREADY CREATED by the owner; this project's only target
```

Off-limits means exactly that: never read, written, migrated, reset, dropped, renamed, or affected
in any other way. This project connects to one database and no other.

These rules are repeated in `06-phase-1-prerequisites.md` because Phase 1 is where the first
opportunity to violate them appears.

---

## 1. Design principles

- PostgreSQL is the source of truth for identity, conversations, messages, and file metadata
  (`CLAUDE.md` §8, §10). The real-time layer stores nothing durable.
- UUID primary keys (`uuid v4`, generated application-side or by `gen_random_uuid()`), so ids can
  be minted before a write and are not enumerable.
- All timestamps `timestamptz`, stored UTC, formatted for display in the browser.
- No soft-delete framework and no audit table in v1 — neither is required by the current scope.
- Foreign keys chosen so that history is never silently destroyed: content cascades with its
  container, but authorship is never cascaded away.

---

## 2. Entities

### User
Identity record for a display name.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `displayName` | varchar(64) | as entered, trimmed |
| `normalizedName` | varchar(64) | lower-cased, whitespace-collapsed; **search and sort only — not an identifier** |
| `createdAt` | timestamptz | default now |
| `lastSeenAt` | timestamptz | updated on disconnect and periodically while connected |
| `isActive` | boolean | default true; lets a name be retired without deleting message history |

**DECIDED (D-02): display names are NOT unique.** `normalizedName` carries a **plain,
non-unique** index for directory search and ordering. Two rows may hold the same name and are two
different people; the only identifier is `id`. No query anywhere in the application may resolve a
user by name — a name lookup that returns one row today can return three tomorrow.

Index on `lastSeenAt` for directory ordering.

Forward-compatibility: real authentication later adds `externalId varchar UNIQUE NULL` (and
possibly `email`) to this table. Nothing else in the schema needs to change — that is the point of
keeping identity in its own entity rather than denormalising names onto messages.

### Session
One row per browser that entered a display name.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `userId` | uuid FK → User | `ON DELETE CASCADE` |
| `tokenHash` | char(64) UNIQUE | SHA-256 of the opaque cookie token; **the raw token is never stored** |
| `createdAt` | timestamptz | |
| `expiresAt` | timestamptz | explicit expiry, enforced on every lookup; **slid forward on activity** |
| `lastSeenAt` | timestamptz | |
| `userAgent` | varchar(255) NULL | diagnostics only; see Q-11 before adding client IP |

Indexes: unique `tokenHash`; index `(userId)`; index `(expiresAt)` for the cleanup sweep.

**Session lifetime (D-04):** `expiresAt = now + SESSION_TTL_HOURS`, initially **24 hours**,
renewed while the user is active. The renewal write is throttled (extended at most once per few
minutes per session) so that a sliding window does not turn every request into a database write.
Expiry affects only the user's temporary identity — the application service keeps running, and
**no application data is deleted** (see §2.1).

### Device (D-13)

The long-lived browser identity that survives session expiry. One row per browser profile.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `userId` | uuid FK → User | `ON DELETE CASCADE` |
| `tokenHash` | char(64) UNIQUE | SHA-256 of the opaque device cookie token; **the raw token is never stored** |
| `createdAt` | timestamptz | |
| `expiresAt` | timestamptz | `now + DEVICE_ID_TTL_DAYS` (default 90), renewed on use |
| `lastSeenAt` | timestamptz | |
| `revokedAt` | timestamptz NULL | set by "Switch User"; a revoked device never resolves again |
| `userAgent` | varchar(255) NULL | diagnostics only |

Indexes: unique `tokenHash`; index `(userId)`; index `(expiresAt)` for the sweep.

Deliberately a **separate table from `Session`**, not a longer-lived session: the two answer
different questions ("is this browser active?" versus "whose browser is this?"), have different
lifetimes, and are revoked by different user actions. Collapsing them would mean either sessions
that never expire or an identity that vanishes daily.

A `User` may have several `Device` rows — one per browser profile they have used. A `Device` maps
to exactly one `User` and is never transferred: "Switch User" revokes the row and the next entry
creates a new `User`, rather than repointing an existing device at someone else.

**Resolution rule:** a device resolves only when `revokedAt IS NULL AND expiresAt > now()`. As with
`ConversationMember.leftAt`, checking the row's mere existence is the bug to avoid.

### Conversation

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `type` | enum `DIRECT` \| `GROUP` | |
| `name` | varchar(120) NULL | groups only; null for direct |
| `directKey` | varchar(73) NULL UNIQUE | for `DIRECT` only: the two member ids sorted and joined |
| `createdById` | uuid FK → User NULL | `ON DELETE SET NULL` |
| `createdAt` | timestamptz | |
| `lastMessageAt` | timestamptz NULL | denormalised for list ordering — justified below |

`directKey` exists because "at most one direct conversation per pair" cannot be expressed as a
constraint over the membership table. A generated, sorted key with a unique index makes the
database enforce it, instead of application code racing itself into duplicate pair conversations.

`lastMessageAt` is the one deliberate denormalisation. Ordering the conversation list otherwise
requires a correlated max-per-conversation subquery on the largest table on every sidebar load. It
is written inside the same transaction as the message insert, so it cannot drift.

Indexes: unique `directKey`; index `(lastMessageAt DESC)`.

### ConversationMember

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `conversationId` | uuid FK → Conversation | `ON DELETE CASCADE` |
| `userId` | uuid FK → User | `ON DELETE CASCADE` |
| `role` | enum `OWNER` \| `MEMBER` | direct conversations: both `MEMBER` |
| `joinedAt` | timestamptz | |
| `leftAt` | timestamptz NULL | non-null means removed/left; the row is kept |
| `lastReadMessageId` | uuid NULL | drives the unread count |
| `lastReadAt` | timestamptz NULL | |

Indexes: unique `(conversationId, userId)`; index `(userId, conversationId)` — this is the index
that every authorization check uses, so it is not optional.

Removal sets `leftAt` rather than deleting the row: it preserves who was present when, and it
keeps `lastReadMessageId` meaningful if the person is re-added. **Authorization checks must test
`leftAt IS NULL`**, not merely the row's existence — the most likely place for an access-control
bug in this schema.

**`joinedAt` is a security column, not a timestamp (D-03).** A member sees only messages
with `createdAt >= joinedAt`, so this value bounds what history is readable. Consequences for the
schema and every query built on it:

- Message queries filter on it. File downloads filter on it too, via the attachment's message —
  otherwise history is retrievable by file id. Conversation previews and unread counts are
  computed inside the same window.
- Re-adding a removed member sets `joinedAt` to the new join time and clears `leftAt`, restarting
  the visible window from that moment (Q-17 covers the alternative).
- Because visibility depends on it, `joinedAt` is written by the server only, never accepted from
  a request, and is never editable through the API.

### Message

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `conversationId` | uuid FK → Conversation | `ON DELETE CASCADE` |
| `senderId` | uuid FK → User NULL | `ON DELETE SET NULL` — never cascade a person's messages away |
| `type` | enum `TEXT` \| `FILE` \| `SYSTEM` | |
| `body` | text NULL | required for `TEXT`; optional caption for `FILE`; rendered text for `SYSTEM` |
| `clientMessageId` | uuid | browser-generated idempotency key |
| `createdAt` | timestamptz | default now |

Indexes:
- `(conversationId, createdAt DESC, id DESC)` — history pagination and the "latest message" read.
- unique `(senderId, clientMessageId)` — the duplicate-send guard described in `01-architecture.md`.

Keyset pagination on `(createdAt, id)` rather than `OFFSET`: correct under concurrent inserts and
does not degrade as history grows.

`SYSTEM` messages record group events ("X added Y", "group renamed") in the same stream as the
conversation, so the timeline needs no second source. Structured detail can go in a `metadata jsonb`
column if the UI needs to render them richly — deferred until Phase 6 shows whether it is needed.

### Attachment

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `conversationId` | uuid FK → Conversation | `ON DELETE CASCADE`; the download authorization anchor |
| `messageId` | uuid FK → Message NULL UNIQUE | null between upload and message creation |
| `uploaderId` | uuid FK → User NULL | `ON DELETE SET NULL` |
| `originalFilename` | varchar(255) | as supplied; sanitized at render and at download |
| `storageKey` | varchar(255) UNIQUE | server-generated relative path, e.g. `2026/08/<uuid>.bin` |
| `byteSize` | bigint | measured server-side, not taken from the client |
| `mimeType` | varchar(127) | detected server-side, not taken from the client |
| `extension` | varchar(16) | validated against the allowlist |
| `checksumSha256` | char(64) NULL | integrity verification |
| `status` | enum `PENDING` \| `READY` \| `FAILED` | |
| `createdAt` | timestamptz | |

Indexes: unique `storageKey`; unique `messageId`; index `(conversationId)`; index
`(status, createdAt)` for the abandoned-upload sweep.

`conversationId` on this table is not duplicated data: an attachment exists before its message
does, so its conversation cannot be derived through `messageId` at the moment the upload is
authorized.

Download authorization, however, cannot stop at `conversationId`. Under D-03 it must also
load the linked message and confirm `Message.createdAt >= member.joinedAt`; membership alone
would let a newly added member pull every file ever shared in the group. Any future caching of
file permissions must preserve that second condition.

`byteSize` is `bigint` deliberately — with `MAX_FILE_SIZE` now at 500 MB and configurable upward,
a 32-bit column would be an avoidable ceiling.

### Not modelled

- **Presence** — derived from live socket connections plus `User.lastSeenAt`. A presence table
  would be stale from the instant it is written.
- **Unread counts** — computed from `ConversationMember.lastReadMessageId` against the message
  index. A stored counter is a cache-invalidation problem for no benefit at this scale.

## 2.1 Data persistence guarantee (D-14)

**Session and device rows are temporary authentication state. They own no application data.**
`Session` and `Device` sit at the leaf of every relationship they participate in: rows point *from*
them *to* `User`, never the other way. Removing one therefore deletes one row and nothing else.

The following persist in PostgreSQL entirely independently of any session, and are **never**
deleted by session expiry, browser close, page refresh, machine restart, inactivity, reconnection,
or the creation of a new session for the same `User.id`:

`User` · `Conversation` (direct and group) · `ConversationMember` (including `joinedAt` and read
state) · `Message` · `Attachment` metadata · the file bytes in `UPLOAD_DIR`

This is structural rather than procedural:

| Guarantee | How the schema enforces it |
|---|---|
| Expiring a session deletes no user | The FK is `Session.userId → User`. There is no FK from `User` to `Session`, so no cascade can run in that direction |
| Expiring a session deletes no messages | `Message` has no relationship to `Session` at all |
| Revoking a device deletes nothing but the device | Same shape as `Session`; nothing references `Device` |
| Even deleting a `User` preserves content | `Message.senderId` and `Attachment.uploaderId` are `ON DELETE SET NULL` |
| The cleanup sweep cannot over-reach | It issues `DELETE FROM "Session" WHERE "expiresAt" < now()` and the equivalent for `Device`. Those two tables are the only ones any sweep touches |

Reconnecting with a valid device cookie resolves to the **same `User.id`**, so the same
conversations, memberships and history are reachable, subject only to the ordinary membership and
join-window rules.

Two boundaries on this guarantee, stated so it is not read as more than it is:

- **D-03 is a visibility rule, not deletion.** Messages a newly added group member cannot see stay
  permanently in the database; they are filtered out of that member's queries by `joinedAt`.
  Nothing is removed.
- **The guarantee is scoped to session expiry.** It does not make data undeletable forever.
  Administrative deletion, retention policy (Q-10), and recovery from database or storage failure
  are separate concerns handled in Phase 10 with backup and restore procedures.

---

## 3. Relationships

```text
User 1 ────< Session          (temporary; leaf, owns nothing)
User 1 ────< Device           (long-lived browser identity; leaf, owns nothing)
User 1 ────< ConversationMember >──── 1 Conversation
User 1 ────< Message            >──── 1 Conversation
User 1 ────< Attachment         >──── 1 Conversation
Message 1 ──── 0..1 Attachment
```

v1 rule: **one attachment per message** (unique `messageId`). Multi-file messages would be a
one-to-many change with no other schema impact, if it is ever wanted.

## 4. Referential-action summary

| Relationship | On delete | Reasoning |
|---|---|---|
| Session → User | CASCADE | sessions are worthless without their user; **the reverse direction does not exist** |
| Device → User | CASCADE | same shape as Session; deleting a device deletes only that row |
| ConversationMember → Conversation | CASCADE | membership belongs to the conversation |
| ConversationMember → User | CASCADE | membership belongs to the user |
| Message → Conversation | CASCADE | deleting a conversation deletes its messages, deliberately |
| Message → User (sender) | SET NULL | history survives; the UI renders "Unknown user" |
| Attachment → Conversation | CASCADE | matches messages |
| Attachment → Message | SET NULL | an orphaned blob row remains sweepable |
| Attachment → User (uploader) | SET NULL | as with sender |

Note the asymmetry, which is intentional per `CLAUDE.md` §8: containers cascade, authorship does
not. Deleting a `User` row is not an operation the v1 UI offers; `isActive = false` is the intended
retirement path.

## 5. Transactions

Multi-statement operations that must be atomic (`CLAUDE.md` §8):

- message insert + `Conversation.lastMessageAt` update
- conversation creation + initial member rows
- attachment link + `Message(type=FILE)` insert + `lastMessageAt` update
- group creation + owner member row + the `SYSTEM` message

## 6. Blob/metadata consistency

Two stores can always disagree. The chosen ordering: **write the file first, then the row.** A file
with no row is invisible and is collected by the sweep; a row with no file would be a broken
download shown to a user. Deletion, if ever implemented, reverses the order for the same reason.

## 7. Migration policy

- Prisma Migrate; every schema change is a committed, reviewed migration file.
- Migrations are forward-only. Production uses `prisma migrate deploy`.
- No `migrate reset`, no `db push --force-reset`, no destructive reset of any kind, against any
  database, ever (see §0).
- `company_chat_db` already exists and is only ever migrated forward — never created, dropped,
  renamed, or recreated.
- The target database name is printed and confirmed before every migration run.
- The schema documentation in this file is updated in the same commit as the migration that
  changes it.
