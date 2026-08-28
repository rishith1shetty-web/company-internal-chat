# Company Internal Chat & File Transfer System

A privately hosted, browser-based chat and file-transfer application for internal company use.
Runs on the company's own server: no cloud services, no client installation.

**Current status: Phase 1 complete — development environment and project foundation.**
The application currently serves a placeholder page. No chat, identity, file transfer, database
or network-restriction functionality exists yet; those are Phases 2–8.

## Scope of version 1

One-to-one chat · group chat · real-time messaging · file upload and download ·
online/offline presence · company-network-restricted access.

Display-name identity only — no passwords in v1, by design, with the identity layer built so
that real company authentication can replace it without redesign. A 24-hour idle session plus a
long-lived device identity keeps a browser attached to the same user across expiry, with a
"Switch User" control for shared computers; the device identity is a convenience mechanism, not
authentication. AI features are deferred to Phase 11 and must not appear before then.

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

## Stack

**Installed (Phase 1):** Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · ESLint 9 ·
tsx · Node.js 24, served by a custom `server.ts`.

**Planned:** Socket.IO (Phase 4) · Prisma + PostgreSQL 16 (Phase 3) · shadcn/ui as needed.
Dependencies are added by the phase that needs them, never in advance — see
[docs/05-open-questions.md](docs/05-open-questions.md) Part A.

## Requirements

- Node.js 20.9+ (developed on 24.18)
- npm 11+
- PostgreSQL 16 — **not needed until Phase 3**

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

### Architecture note

The application runs behind a custom `server.ts` rather than `next start`. This is deliberate
(decision D-09): Next.js and, from Phase 4, Socket.IO share one process, one port and one origin.
Production therefore starts with `node dist/server.js`. Details in
[docs/07-phase-1-setup.md](docs/07-phase-1-setup.md) §3.

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

Phase 1 ran **no** database or Prisma command of any kind, and no database package is installed.
