# Phase 1 Prerequisites

Phase 1 (Development Environment, `CLAUDE.md` §5) begins only on explicit instruction.

**Status after the Phase 0 review (2026-08-28): all Phase 1 blocking decisions are resolved.**
The only outstanding item is the application database credential, which the project owner supplies.

---

## 1. Settled inputs for Phase 1

| Input | Value |
|---|---|
| Package manager | npm (D-01) |
| Process model | Custom `server.ts`: Next.js + Socket.IO, one port (D-09) |
| Repository | New **private** GitHub repository `company-internal-chat` (D-08) |
| Database | `company_chat_db`, **already created by the owner** — connect and migrate forward only (D-15) |
| Database role | Dedicated, non-superuser, limited to `company_chat_db`; **provided by the owner** (D-06, D-15) |
| `SESSION_TTL_HOURS` | 24, idle-based, renewed on activity (D-04) |
| `DEVICE_ID_TTL_DAYS` | 90, renewed on use (D-13) |
| `MAX_FILE_SIZE` | 524288000 (500 MB), configurable (D-05) |
| Identity | Two cookies: 24h session + long-lived device identity; "Switch User" revokes both (D-13) |
| Data persistence | Independent of session state (D-14) |
| Display names | Not unique; identity is the server-issued session and `User.id` (D-02) |
| Authentication | None in v1 (D-11) |
| AI | Excluded through Phase 10 (D-12) |

## 2. Still needed from the project owner

| Item | Note |
|---|---|
| **Application database credentials** | Role name and password for the dedicated role with access to `company_chat_db`. These go into a git-ignored `.env` and are never committed. Nothing in Phase 1 touches PostgreSQL until they are supplied |
| Q-11 — client IP logging policy | Becomes an `.env.example` entry; a default of "failures and errors only" is assumed if unspecified |

Everything else in `05-open-questions.md` Part C belongs to later phases and does not block
Phase 1.

## 3. Environment state on this machine

| Item | Status |
|---|---|
| Node.js | v24.18.0 — present, suitable |
| npm | 11.16.0 — present |
| Git | 2.55.0 — present |
| Git repository | **Not initialised** — this directory is not yet a repo |
| GitHub repository | **Not created** — `company-internal-chat`, private, Phase 1 |
| PostgreSQL 16 | Installed; `psql` is not on the current `PATH` |
| `company_chat_db` | **Already exists** — created by the owner; not to be created or recreated |
| Application role | To be provided by the owner; **not created by this project** |
| Project files | `CLAUDE.md`, `README.md`, `docs/` — no code, no dependencies, no database objects |

`psql` needs to be on `PATH` (or its full path noted) only if command-line database inspection is
wanted; Prisma connects via `DATABASE_URL` regardless. Git should be initialised before any code
lands, so the first commit already contains `.gitignore`.

---

## 4. Database rules — restated, because Phase 1 is where they first apply

```text
PostgreSQL 16 (development machine)
├── Existing Database 1     <- OFF LIMITS
├── Existing Database 2     <- OFF LIMITS
├── Existing Database 3     <- OFF LIMITS
└── company_chat_db         <- ALREADY CREATED; this project's only target
```

1. **Do not create `company_chat_db`** — it exists. Do not drop, rename, reset, or recreate it.
2. **Do not create the PostgreSQL role.** Do not use superuser or administrator credentials. The
   owner provides the dedicated application role.
3. Every pre-existing database is off-limits: never modified, migrated, reset, dropped, renamed, or
   affected in any way.
4. Before any migration, print the target database from the active `DATABASE_URL` and confirm it is
   `company_chat_db`.
5. Never run `prisma migrate reset`, `prisma db push --force-reset`, `DROP DATABASE`, or any other
   destructive reset command — against any database, including this project's own.
6. Forward migrations only: `prisma migrate dev` in development, `prisma migrate deploy` in
   production.
7. **If there is any uncertainty about the database target, stop and ask.**

Full rules in `02-database.md` §0.

---

## 5. Phase 1 scope — COMPLETED 2026-08-28

Built and verified as described in `07-phase-1-setup.md`. Three deviations from the plan below,
all deliberate, all narrowing scope or forced by the environment:

- **Prisma was not installed.** The Phase 1 instruction was to add no database package unless the
  scaffold required one; it did not. Prisma arrives in Phase 3 with the schema, which also removes
  any possibility of a database connection before then.
- **`socket.io` was not installed.** `server.ts` establishes the `http.Server` that Socket.IO
  attaches to in Phase 4; installing the package before anything uses it would break the
  dependency rule for no benefit.
- **The project was moved** out of `…\Company Internal Chat & File Transfer System` to
  `C:\dev\company-internal-chat`, because an `&` in the path breaks every npm binary shim. See
  `07-phase-1-setup.md` §1.

Phase 1 covered:

- `package.json` (npm), TypeScript config, ESLint
- Next.js application skeleton that starts and serves a placeholder page
- Custom `server.ts` — process lifecycle only, with the Socket.IO attach point marked
- Tailwind configured; shadcn/ui not needed yet
- `lib/config` env parsing with validation, and `.env.example` with placeholders only, including
  `SESSION_TTL_HOURS=24`, `DEVICE_ID_TTL_DAYS=90`, `MAX_FILE_SIZE=524288000`
- `.gitignore` covering `.env`, `node_modules`, build output, and the uploads directory
- Git initialised, first commit, private GitHub repository `company-internal-chat`
- Verification that the application starts locally with no build or TypeScript errors

Phase 1 does **not** include: chat UI, database schema, migrations, message logic, uploads,
presence, identity implementation, or network restriction. Those are Phases 2–8.
