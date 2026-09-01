# Company Internal Chat & File Transfer System

A privately hosted, browser-based chat and file-transfer application for internal company use.
Runs on the company's own server: no cloud services, no client installation.

**Current status: Phase 7 complete — one-to-one chat, group chat and file transfer.**
An administrator assigns each company computer to a named employee; whoever sits at it opens the
application and is already recognised, with nothing to sign in to and no way to change who they
are. Colleagues find each other, hold private conversations, and create named groups — all
delivered in real time and stored in PostgreSQL. Messages, conversations, membership and read
state survive a refresh, a reconnection, session expiry and a restart.

Somebody added to a group sees it from the moment they join, and not what was said before. Nothing
is deleted to achieve that: the earlier messages stay exactly where they are, readable by the
members who were there for them.

Files go with the conversation. Any file type, up to a configurable 500 MB, stored on the
company's own server and downloaded only through the application after it has checked that the
person asking is in the conversation — and, for a group, that the file was shared after they
joined. Nothing uploaded is ever opened or rendered by the server.

Network restriction follows in Phase 8.

## Scope of version 1

One-to-one chat · group chat · real-time messaging · file upload and download ·
online/offline presence · company-network-restricted access.

No passwords in v1, by design, with the identity layer built so that real company authentication
can replace it without redesign. **Identity is assigned by an administrator to a company computer**
and is not something an employee can create, choose, change or clear
([docs/12-admin-device-identity.md](docs/12-admin-device-identity.md)). A 24-hour idle session plus
a long-lived device identity keeps a browser attached to that computer's assigned employee across
expiry; the device identity is a convenience mechanism, not authentication. AI features are
deferred to Phase 11 and must not appear before then.

### Setting up a computer

1. Set `ADMIN_TOKEN` in `.env` (at least 24 characters) and start the server. Without it the
   administration surface is closed and no computer can be assigned.
2. Open `/admin`, sign in, and register the computer with a name (`PC-001`) and the employee's
   name. A one-time setup code is shown **once**.
3. On that computer, open `/setup` and enter the code. That machine is now that employee's.
4. When the computer changes hands, press **Reassign** in `/admin` and enter the new employee's
   name. The new employee gets their own account and their own history; the previous employee's is
   kept and is not transferred. Nobody needs to visit the machine.

### Sending a file

Use the paperclip in the message box. Any file type is accepted — documents, spreadsheets, video,
archives, images, whatever a colleague needs — up to the configured limit. The name and size are
shown before it sends, so a wrong file can be taken back. Files appear in the conversation and in
**Shared files** in the details panel, and download through the application rather than from a
public folder.

### Using a group

Press **New group**, name it, and choose colleagues. You become its owner. Any member may add
somebody later from **Add people** in the conversation details; only the owner can remove somebody
else, and anybody can leave.

People added later see the group from the moment they join. The conversation that came before
stays with the members who were there for it — it is not shown to them, and it is not deleted. The
interface says so before you add anybody, because it is easier to explain beforehand than
afterwards.

## Documentation

| Document | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Master specification and development rules |
| [docs/00-phase-0-overview.md](docs/00-phase-0-overview.md) | Requirements summary, scope boundaries, phase exit criteria |
| [docs/01-architecture.md](docs/01-architecture.md) | System, component and runtime architecture; message and file flows |
| [docs/02-database.md](docs/02-database.md) | PostgreSQL entity design, relationships, **database isolation rules** |
| [docs/03-network.md](docs/03-network.md) | Network restriction model, local development and production topologies |
| [docs/04-security.md](docs/04-security.md) | Threat model, controls, risk register, path to real authentication |
| [docs/05-open-questions.md](docs/05-open-questions.md) | **Finalized decisions (D-01…D-12)**, remaining open questions, assumptions, technology stack |
| [docs/06-phase-1-prerequisites.md](docs/06-phase-1-prerequisites.md) | What had to be settled before Phase 1 |
| [docs/07-phase-1-setup.md](docs/07-phase-1-setup.md) | **Development environment: toolchain, custom server, commands, verification** |
| [docs/08-phase-2-ui.md](docs/08-phase-2-ui.md) | **Chat interface: screens, components, design tokens, accessibility, how later phases replace the sample data** |
| [docs/09-phase-3-database.md](docs/09-phase-3-database.md) | **Database layer: schema, constraints, migration strategy, role permissions, tests, manual setup steps** |
| [docs/10-phase-4-realtime.md](docs/10-phase-4-realtime.md) | **Real-time layer: Socket.IO architecture, identity, event contract, rooms, message flow, presence, tests** |
| [docs/11-phase-5-direct-chat.md](docs/11-phase-5-direct-chat.md) | **One-to-one chat: REST endpoints, directory, conversation resolution, history pagination, unread counts, reconnection, tests** |
| [docs/12-admin-device-identity.md](docs/12-admin-device-identity.md) | **Admin-assigned identity: the device registry, setup codes, assignment and reassignment flows, admin access and its limits** |
| [docs/13-phase-6-group-chat.md](docs/13-phase-6-group-chat.md) | **Group chat: creation, membership, roles, the join-bounded history window and where its timestamp comes from, real-time membership changes, tests** |
| [docs/14-phase-7-file-transfer.md](docs/14-phase-7-file-transfer.md) | **File transfer: streaming upload, storage design, download authorization, why there is no type allowlist, failure and rollback behaviour, production storage setup, tests** |

## Stack

**Installed (Phases 1–4):** Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · ESLint 9 ·
tsx · Node.js 24, served by a custom `server.ts`; Prisma 7 with `@prisma/adapter-pg` for
PostgreSQL 16; Socket.IO 4 and Zod for the real-time layer; Vitest for tests. Phase 2 added no
dependency at all: the interface, its dialogs and its icons are written against React and
Tailwind directly.

**Planned:** shadcn/ui as needed.
Dependencies are added by the phase that needs them, never in advance — see
[docs/05-open-questions.md](docs/05-open-questions.md) Part A.

## Requirements

- Node.js 20.9+ (developed on 24.18)
- npm 11+
- PostgreSQL 16 — needed from Phase 3 onwards, but the application still starts without it

The project path must not contain `&`, and preferably no spaces: npm's `node_modules/.bin`
launcher shims break on such paths. See [docs/07-phase-1-setup.md](docs/07-phase-1-setup.md) §1.

## Local development setup

```bash
git clone <repository-url> company-internal-chat
cd company-internal-chat
npm install
npm run dev
```

Then open <http://localhost:3000>.

Enter any display name to reach the interface. It opens on a sample workspace so the screens can
be seen in use; **nothing is saved** — refreshing returns to the sample data. See
[docs/08-phase-2-ui.md](docs/08-phase-2-ui.md).

The application starts with **no `.env` file** — every Phase 1 setting has a safe default. To
override defaults, copy the template and edit your copy:

```bash
cp .env.example .env          # macOS/Linux
Copy-Item .env.example .env   # Windows PowerShell
```

`.env` is git-ignored and must never be committed. `.env.example` holds placeholders only.

### Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Development server on http://localhost:3000 |
| `npm run build` | Build the Next.js app **and** compile `server.ts` to `dist/` |
| `npm start` | Run the production server (`node dist/server.js`); build first |
| `npm run typecheck` | TypeScript checks (app + server) |
| `npm run lint` | ESLint |
| `npm test` | Vitest (database tests skip when no `DATABASE_URL` is set) |
| `npm run db:check` | **Read-only.** Print the redacted database target, confirm it is `company_chat_db`, report role privileges and which tables exist |
| `npm run db:audit` | **Read-only.** Print row counts per table and list any leftover test rows, so a test run can be shown to have cleaned up after itself |
| `npm run db:generate` | Regenerate the Prisma client (also runs on install and build) |
| `npm run db:status` | Show which migrations have been applied |
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) — forward only |

### Architecture note

The application runs behind a custom `server.ts` rather than `next start`. This is deliberate
(decision D-09): Next.js and Socket.IO share one process, one port and one origin, so the session
cookie applies to both transports with no CORS handling. Production therefore starts with
`node dist/server.js`. Details in [docs/07-phase-1-setup.md](docs/07-phase-1-setup.md) §3 and
[docs/10-phase-4-realtime.md](docs/10-phase-4-realtime.md) §1.

## Database setup

The schema is already applied on the development machine. On a **new machine or the company
server**, two steps are required first, both performed by whoever administers PostgreSQL:

**1. Create `.env`** (git-ignored — never commit it):

```bash
DATABASE_URL=postgresql://company_chat_app:<password>@localhost:5432/company_chat_db
```

Percent-encode reserved characters in the password (`@` → `%40`, `:` → `%3A`, `%` → `%25`).

**2. Grant the schema privilege**, connected to `company_chat_db` as an administrator:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO company_chat_app;
```

That is the minimum needed to create the tables; the role stays a non-superuser without
`CREATEDB`. Then:

```bash
npm run db:check      # read-only: confirms the target is company_chat_db and reports privileges
npm run db:migrate    # applies committed migrations, forward only
```

`npm run db:migrate` never resets or drops anything; `prisma migrate reset` and `db push
--force-reset` are prohibited in this project. Details, including why `prisma migrate dev` is not
used, are in [docs/09-phase-3-database.md](docs/09-phase-3-database.md) §6.

## Database safety

`company_chat_db` **already exists** — created by the project owner. It is never created, dropped,
renamed, recreated, or reset; it is only migrated forward. **Every other database on the
PostgreSQL 16 server is off-limits** and is never modified in any way. The application connects
through a dedicated, non-superuser role supplied by the owner; this project never creates the
database or the role and never uses admin credentials. `DROP DATABASE`, `prisma migrate reset`,
`db push --force-reset` and equivalent destructive commands are prohibited outright. See
[docs/02-database.md](docs/02-database.md) §0.

## Data persistence

Session expiry is temporary authentication state only. Messages, conversations, groups,
memberships, file metadata and uploaded files persist in PostgreSQL independently of any session
and are never deleted by expiry, browser close, refresh, restart, inactivity, or reconnection. See
[docs/02-database.md](docs/02-database.md) §2.1.

The same holds when a computer changes hands. Reassigning it creates a **new** employee account and
revokes the previous employee's sessions; it never renames, reuses or deletes their account, and
their conversations and messages stay exactly where they are.

Phases 1 and 2 ran **no** database or Prisma command of any kind, and no database package is
installed.
