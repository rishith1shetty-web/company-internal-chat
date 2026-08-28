# Phase 3 — PostgreSQL & Prisma

**Status:** Complete. The schema is applied to `company_chat_db` and verified against the live
database.

**Migration:** `20260828202511_init_chat_schema` — 4 enums, 7 tables, 19 indexes, 10 foreign
keys. Purely additive: it contains no `DROP`, `TRUNCATE`, `DELETE` or database-level statement.

**Scope:** The data layer only. No API, no real-time layer, no session handling, no file storage,
no AI. The Phase 2 interface is unchanged and still runs on its local sample data.

---

## 1. What was implemented

| Piece | File |
|---|---|
| Database schema (7 models, 4 enums) | `prisma/schema.prisma` |
| Prisma CLI configuration | `prisma.config.ts` |
| Single-database safety guard | `lib/db/target.ts` |
| Prisma client access layer | `lib/db/prisma.ts` |
| Pre-migration target & connectivity check | `scripts/db-check.ts` |
| Environment configuration (`DATABASE_URL`) | `lib/config/env.ts` |
| Test runner configuration | `vitest.config.mts`, `tests/setup-env.ts` |
| Database tests | `tests/db/` |
| Initial migration | `prisma/migrations/20260828202511_init_chat_schema/migration.sql` |

The schema implements `02-database.md` §2 as written. No entity, column, constraint, index or
referential action was invented, dropped or simplified, and no Phase 0 decision was changed.

---

## 2. Versions

| Package | Version | Why |
|---|---|---|
| `prisma` (dev) | 7.10.0 | Current **stable**. npm's `latest` tag is 8.0.0-rc.12, a release candidate; CLAUDE.md §3 requires stable, well-supported packages |
| `@prisma/client` | 7.10.0 | Must match the CLI |
| `@prisma/adapter-pg` | 7.10.0 | **Required** by Prisma 7 — see §7 |
| `vitest` (dev) | 4.1.11 | The test runner named in `05-open-questions.md` Part A |

Exact versions are pinned (`--save-exact`) so every machine and the company server resolve the
same database layer.

---

## 3. The data model

Seven tables, exactly as designed in `02-database.md`:

```text
User 1 ────< Session               temporary auth state; owns nothing
User 1 ────< Device                long-lived browser identity; owns nothing
User 1 ────< ConversationMember >──── 1 Conversation
User 1 ────< Message              >──── 1 Conversation
User 1 ────< Attachment           >──── 1 Conversation
Message 1 ──── 0..1 Attachment
```

Enums: `ConversationType` (DIRECT | GROUP) · `MemberRole` (OWNER | MEMBER) ·
`MessageType` (TEXT | FILE | SYSTEM) · `AttachmentStatus` (PENDING | READY | FAILED).

### Constraints that carry a rule, not just a shape

| Constraint | Enforces |
|---|---|
| `User.normalizedName` indexed but **NOT unique** | D-02: display names are not unique. Two people may share a name; only `id` identifies anyone |
| `Conversation.directKey` unique | At most one direct conversation per pair. The sorted-pair key exists because this cannot be expressed over the membership table, so the database enforces it instead of application code racing itself into duplicates |
| `ConversationMember (conversationId, userId)` unique | A user joins a conversation once |
| `ConversationMember.leftAt` nullable, row retained on removal | Preserves who was present when. **Authorization must test `leftAt IS NULL`**, not row existence |
| `ConversationMember.joinedAt` | D-03: the join-bounded history window. A security column, not a timestamp — it bounds what history is readable, in message queries, file downloads and previews alike |
| `Message (senderId, clientMessageId)` unique | The duplicate-send guard for Phase 4. A retry after a dropped acknowledgement collides instead of inserting twice. `SYSTEM` messages have a null sender, and PostgreSQL treats NULLs as distinct, so server-written messages never collide with each other |
| `Attachment.messageId` unique | One attachment per message (A-07) |
| `Attachment.storageKey` unique | One row per stored file |
| `Attachment.byteSize` is `bigint` | 500 MB uploads (D-05), configurable upward, without a 32-bit ceiling |

### Referential actions

Containers cascade; authorship does not (`02-database.md` §4):

- `CASCADE`: Session→User, Device→User, ConversationMember→(Conversation, User),
  Message→Conversation, Attachment→Conversation
- `SET NULL`: Message→User (sender), Attachment→User (uploader), Attachment→Message,
  Conversation→User (createdBy)

This is what makes D-14 structural rather than procedural: no foreign key runs from `User` to
`Session` or `Device`, so expiring a session can only ever delete that one row, and deleting a
user — not an operation the application offers — still preserves their messages.

### Indexes

`User(normalizedName)`, `User(lastSeenAt)`, `Session(userId)`, `Session(expiresAt)`,
`Device(userId)`, `Device(expiresAt)`, `Conversation(lastMessageAt DESC)`,
`ConversationMember(userId, conversationId)`, `Message(conversationId, createdAt DESC, id DESC)`,
`Attachment(conversationId)`, `Attachment(status, createdAt)`, plus the unique indexes above.

`ConversationMember(userId, conversationId)` is the index every authorization check uses, and
`Message(conversationId, createdAt DESC, id DESC)` is what makes keyset pagination cheap. A test
asserts both exist, and that `normalizedName` is **not** unique.

---

## 4. Database connection

`DATABASE_URL` is the only source of connection details. Nothing — not the host, port, role,
password or database name — is hard-coded in tracked source.

- **Runtime:** `lib/db/prisma.ts` creates one `PrismaClient` per process, lazily, cached on
  `globalThis` in development so Next.js hot reloads cannot leak a connection pool per edit.
- **CLI:** `prisma.config.ts` supplies the URL to migration commands. It loads `.env` with Node's
  built-in `process.loadEnvFile()` because the Prisma 7 CLI no longer reads `.env` itself, and
  because a `dotenv` dependency is avoidable (CLAUDE.md §3).
- **Startup:** `lib/config/env.ts` validates the URL when present and exposes only a **redacted**
  description (`role@host:port/database`). `server.ts` logs that, never the URL.

`DATABASE_URL` is **optional**: the application still starts without it — the Phase 2 interface
needs no database — and only code that actually needs a connection fails, with a clear message.

`server.ts` now also loads `.env` before reading configuration. It previously did not: Next.js
loads env files during `app.prepare()`, which happens *after* the custom server has already read
its own settings, so `.env` had no effect on `PORT`, `APP_URL` or anything else. That was a
latent Phase 1 gap; Phase 3 is the point at which it would have caused real confusion.

### The single-database guard

`lib/db/target.ts` parses `DATABASE_URL` and **refuses any database other than
`company_chat_db`**. Nothing in the application, the check script or the tests can obtain a client
without passing it.

This turns `02-database.md` §0 rule 4 — "confirm the target database before any database
command" — from a discipline into a mechanism. A mistyped or pasted connection string aimed at
another database on the same server fails immediately with an explanatory error instead of
quietly connecting. Its messages never echo the connection string, because it contains a
password.

---

## 5. PostgreSQL role and permissions

The application connects as **`company_chat_app`**, a dedicated role created by the owner:
`LOGIN`, and explicitly **not** `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or
`BYPASSRLS`. That is exactly right, and Phase 3 neither created a role nor asked for more
privilege than the minimum.

The role is a **database connection identity and nothing else**. It is not an application user:
employees are rows in `User`, and the two are never conflated.

| Privilege | Status | Needed for |
|---|---|---|
| `CONNECT` on `company_chat_db` | Already granted | Connecting |
| `TEMPORARY` on `company_chat_db` | Already granted | Sorting and temporary objects |
| `USAGE, CREATE` on `SCHEMA public` | **Still required** | Creating the seven tables and `_prisma_migrations` |

PostgreSQL 15 and later no longer grant `CREATE` on schema `public` to `PUBLIC`, so this must be
granted explicitly. It is the **minimum** needed to apply the migration: it permits creating
objects in one schema of one database and nothing else. `npm run db:check` reports whether the
role has it and prints the exact statement if not.

No broader privilege is required, and none should be granted. `db-check` refuses to proceed if
the connected role turns out to be a superuser.

---

## 6. Migration strategy — and a documented deviation

`02-database.md` §7 specifies `prisma migrate dev` in development and `prisma migrate deploy` in
production. **`migrate dev` cannot be used on this project**, and this is a deliberate, permanent
deviation rather than a workaround:

> `prisma migrate dev` creates and drops a temporary **shadow database** to detect drift. That
> requires the `CREATEDB` privilege. The application role intentionally does not have it, this
> project may not create databases at all (`02-database.md` §0 rule 5), and granting `CREATEDB`
> to get around it would weaken the very constraint that makes the isolation rule enforceable by
> PostgreSQL rather than by discipline.

The supported alternative, which needs no shadow database and no extra privilege:

```bash
# 1. Confirm the target before touching anything (prints a redacted target, read-only).
npm run db:check

# 2. Generate the migration SQL from the current database state to the schema.
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema=prisma/schema.prisma \
  --script -o prisma/migrations/<timestamp>_init_chat_schema/migration.sql

# 3. Apply it, forward only, recording it in _prisma_migrations.
npm run db:migrate        # prisma migrate deploy

# 4. Confirm.
npm run db:status
npm run db:check          # now lists the seven tables
npm test                  # the database suite stops skipping
```

Every schema change from here follows the same shape: diff into a new, reviewed migration file,
then `migrate deploy`. Migrations are forward-only and committed alongside the documentation
change that describes them.

**Never** `prisma migrate reset`, `db push --force-reset`, `DROP DATABASE`, `DROP SCHEMA`, or any
other destructive reset — against any database, this project's own included.

> Note: `prisma migrate diff --from-empty` produces an empty script on Prisma 7.10.0 because the
> schema engine needs datasource information to know the connector. Use
> `--from-config-datasource`, which also produces the more correct diff: from what the database
> actually contains to what the schema describes.

---

## 7. Prisma 7 notes

Three Prisma 7 behaviours shaped this phase, all handled and none of them worth reverting to
Prisma 6 for:

1. **The connection URL is no longer allowed in `schema.prisma`.** It lives in `prisma.config.ts`
   for the CLI, and reaches the running client through the driver adapter.
2. **A driver adapter is required for a direct database connection.** `@prisma/adapter-pg`
   (node-postgres) owns the connection pool and is handed to `PrismaClient`. This is a
   requirement of the chosen ORM, not an added dependency of convenience.
3. **The generated client is TypeScript emitted into the project**, not a package inside
   `node_modules`. It is written to `prisma/generated/`, **git-ignored** as a build artifact, and
   reproduced by `prisma generate` — which now runs from both `postinstall` and `npm run build`.
   The generator is set to `moduleFormat = "cjs"`: the default ESM output emits
   `import.meta.url`, which cannot exist in a CommonJS file, and the custom server (D-09) is
   compiled to CommonJS by plain `tsc`. Without this the built server fails to start.

---

## 8. Types: the UI boundary is unchanged

`lib/chat/types.ts` remains the UI's own view-model layer and imports nothing from Prisma. No
component imports a database type, and no Prisma type crosses into `components/`.

That separation is the point of the seam described in `01-architecture.md` §4: Phase 5 maps
database rows to these view models in the service layer, and the Phase 2 interface continues to
render exactly what it renders today. The names line up deliberately (`ConversationType`,
`MessageKind` ↔ `MessageType`, `MemberRole`), which makes the mapping obvious without coupling
the two.

---

## 9. Tests

`npm test` (Vitest). Two files, deliberately scoped to the Phase 3 data layer:

**`tests/db/target.test.ts` — 10 tests, no database required.** The safety guard: that it accepts
`company_chat_db`, refuses every other database name, never leaks the password into a message or
a redacted description, and rejects missing, malformed and non-PostgreSQL URLs.

**`tests/db/schema.test.ts` — 19 tests against `company_chat_db`.** Skipped automatically when
`DATABASE_URL` is not set, so `npm test` works on a machine with no database. They cover:

- two users sharing a display name, and ids being the only identifier (D-02)
- stable uuid ids and defaulted timestamps
- one direct conversation per pair, in either argument order
- membership uniqueness, owner/member roles, and `leftAt` retention on removal
- message↔conversation↔sender relationships
- the duplicate-send guard, including that the same key from a different sender is allowed and
  that null-sender `SYSTEM` messages do not collide
- the join-bounded history window (D-03) returning only post-join messages
- conversation deletion cascading messages while leaving the user intact
- **user deletion preserving messages** with `senderId` set to null
- attachment metadata: unique `storageKey`, one attachment per message, 500 MB `byteSize`
- session deletion removing only the session, leaving user, messages and membership intact (D-14)
- revoked vs resolvable devices, and duplicate token hashes being rejected
- the presence of the indexes authorization and pagination depend on, and the **absence** of a
  unique index on `normalizedName`

**Test safety.** The suite runs against `company_chat_db` — the project's own and only database.
It creates only its own rows, registers every id, and deletes them afterwards. It never truncates
a table, never empties one, and never reads or modifies a row it did not create. Test users carry
a `zz-test-` display-name prefix so anything left by an interrupted run is identifiable by a
human. No separate test database was created, because creating databases is prohibited.

---

## 10. Verification

Run against the live `company_chat_db`, PostgreSQL 16.14, connected as `company_chat_app`:

| Check | Result |
|---|---|
| `npm run db:check` before migrating | Target confirmed `company_chat_db`; role is not a superuser; `CREATE` on schema `public` present; no project tables |
| `prisma migrate diff` → migration SQL | 192 lines, reviewed before applying; no destructive statement |
| `npm run db:migrate` (`migrate deploy`) | `20260828202511_init_chat_schema` applied |
| `npm run db:status` | "Database schema is up to date!" |
| `npm run db:check` after migrating | All 8 tables present (7 models + `_prisma_migrations`) |
| `npm test` | **29 passed** (10 guard + 19 schema), 0 skipped, 0 failed |
| Row audit after the test run | All seven tables back to 0 rows; 0 leftover `zz-test-` users |
| `npx prisma validate` | Schema valid |
| `npm run typecheck` (app + server) | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Pass |
| Production server start | Starts; logs `database: company_chat_app@localhost:5432/company_chat_db` — redacted, no password in the log |
| Phase 2 interface, headless browser, 30 checks | 30/30 pass, no console errors — unchanged by Phase 3 |
| Databases contacted | `company_chat_db` only |
| Destructive commands run | None. No reset, no drop, no truncate, no superuser connection |

A note on one test that failed first time and what it showed: the index assertion expected
PostgreSQL to render `"id" DESC` in `pg_indexes.indexdef`, but PostgreSQL quotes identifiers only
when it must, so it renders `id DESC`. The index itself was correct; the assertion was comparing
against a rendering rule rather than against the index, and now strips quotes before matching.

## 11. Manual setup (completed here; required again on the company server)

Both steps below were performed by the project owner on the development machine. **They must be
repeated on the company server in Phase 10**, because neither `.env` nor a database grant travels
with the repository.

**1. `.env`** (git-ignored, never committed):

```bash
DATABASE_URL=postgresql://company_chat_app:<password>@localhost:5432/company_chat_db
```

Percent-encode reserved characters in the password (`@` → `%40`, `:` → `%3A`, `%` → `%25`).

**2. The schema privilege**, connected to `company_chat_db` as an administrator:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO company_chat_app;
```

This is the minimum needed to create the tables and `_prisma_migrations`. The role remains a
non-superuser without `CREATEDB`; `npm run db:check` refuses to proceed if it ever becomes one.

On the company server the sequence is: create `.env`, apply the grant, `npm run db:check`,
`npm run db:migrate`. The migration files are committed, so nothing needs to be regenerated
there.

## 12. Deviations from Phase 0

| Deviation | Reason |
|---|---|
| `prisma migrate diff` + `migrate deploy` instead of `migrate dev` | `migrate dev` requires `CREATEDB` for a shadow database. The role must not have it, and this project may not create databases (§6) |
| `@prisma/adapter-pg` added beyond the planned dependency list | Prisma 7 requires a driver adapter for a direct connection (§7) |
| Generated client emitted into `prisma/generated/` (git-ignored) as CommonJS | Prisma 7 generates TypeScript into the project; CommonJS is required by the custom server's `tsc` build (§7) |
| `DATABASE_URL` optional rather than required at startup | The Phase 2 interface has no database dependency, and the README promises the application starts with no `.env` |
| `server.ts` now loads `.env` | It never did; `.env` was documented but had no effect on the custom server (§4) |

Nothing in the entity design, the identity model, the join-bounded history rule, the persistence
guarantee or the database isolation rules was changed.
