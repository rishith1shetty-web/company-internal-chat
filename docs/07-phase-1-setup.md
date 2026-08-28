# Phase 1 — Development Environment

**Status:** Complete
**Date:** 2026-08-28

Phase 1 built the project foundation only: toolchain, custom server, styling, configuration
structure and version control. No chat, identity, file transfer, database or network-restriction
functionality was implemented — those are Phases 2–8.

---

## 1. Project location (changed during Phase 1)

The project now lives at:

```text
C:\dev\company-internal-chat
```

It was moved from `C:\Users\DELL\OneDrive\Desktop\Company Internal Chat & File Transfer System`
during Phase 1, because that path made the toolchain unusable.

**Why the move was necessary.** npm generates launcher shims in `node_modules/.bin` whose final
line is:

```bat
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\..\tsx\dist\cli.mjs" %*
```

`cmd.exe` expands `%dp0%` *before* parsing the line, so an `&` anywhere in the project path is
treated as a command separator and the path is torn in half. Every shim — `next`, `tsc`,
`eslint`, `tsx`, and `prisma` from Phase 3 — failed identically in cmd, PowerShell and bash. It
was verified by running the same tool from a path without `&`, where it worked. No configuration
can work around it; the path had to change.

Moving out of OneDrive additionally stops `node_modules/` and `.next/` from being synced —
thousands of files whose sync churn and file locks are a common cause of intermittent `EPERM`
failures during installs and builds. Source-code backup is GitHub's job.

**Rule going forward:** keep the project path free of `&`, and ideally free of spaces.

---

## 2. Toolchain

| Component | Version | Notes |
|---|---|---|
| Node.js | 24.18.0 | Already installed |
| npm | 11.16.0 | Package manager (D-01) |
| Next.js | 16.3.3 | App Router, Turbopack |
| React | 19.2.8 | |
| TypeScript | 6.0.3 | `strict`, plus `noUncheckedIndexedAccess` and `forceConsistentCasingInFileNames` |
| Tailwind CSS | 4.3.3 | Via `@tailwindcss/postcss`; CSS-first config, no `tailwind.config.js` |
| ESLint | 9.39.5 | Flat config with `eslint-config-next` |
| tsx | 4.23.12 | Runs `server.ts` in development |

`forceConsistentCasingInFileNames` is deliberate: development is on case-insensitive Windows and
production will be case-sensitive Linux, which is a well-known source of imports that build
locally and fail on the server.

---

## 3. Custom server architecture (D-09)

`server.ts` creates the Node `http.Server`, hands requests to Next.js, and is where Socket.IO
will attach in Phase 4 — so both share one process, one port and one origin.

```text
         Browser
            |  http://127.0.0.1:3000
            v
   +--------------------------+
   |  server.ts               |
   |   - loadConfig()         |  lib/config/env.ts
   |   - createLogger()       |  lib/logging/logger.ts
   |   - http.createServer()  |
   |        |            \    |
   |        |             \   |
   |   Next.js handler   [Phase 4: Socket.IO attaches here]
   |   (app/)                 |
   |   - graceful shutdown    |
   +--------------------------+
```

Phase 1 implements the process lifecycle only: configuration loading, request handling, error
handling, structured logging and graceful shutdown on `SIGINT`/`SIGTERM`. The Socket.IO attach
point is a marked comment in `server.ts` — `socket.io` is **not** installed, because Phase 1 does
not use it and the dependency rule says packages are added by the phase that needs them. Nothing
about the foundation has to change to add it: Socket.IO attaches to an existing `http.Server`.

**Consequence to remember:** production runs `node dist/server.js`, not `next start`. `npm run
build` therefore does two things — `next build` for the application, and `tsc -p
tsconfig.server.json` to compile the server to `dist/`.

---

## 4. Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Development server on `http://localhost:3000` via `tsx watch` |
| `npm run build` | `next build` + compile `server.ts` to `dist/` |
| `npm start` | Production server (`node dist/server.js`); requires `npm run build` first |
| `npm run typecheck` | TypeScript check for both the app and the server configs |
| `npm run lint` | ESLint |

`npm run dev` watches `server.ts` and `lib/` only. Changes under `app/` and `components/` are
handled by Next's hot reload, so they are excluded from the watcher to avoid restarting the whole
server on every UI edit.

---

## 5. Configuration

`lib/config/env.ts` is the only place environment variables are read. It validates on startup and
throws a `ConfigError` listing every problem, so a misconfigured deployment fails immediately and
legibly rather than misbehaving later.

Phase 1 parses only what is used today: `NODE_ENV`, `PORT`, `BIND_HOST`, `APP_URL`, `LOG_LEVEL`.
All have safe defaults, so **the application runs with no `.env` file at all**.

`DATABASE_URL` is deliberately *not* read yet. Nothing in the codebase can open a database
connection before Phase 3 adds it. The remaining variables (sessions, uploads, network
restriction) are documented in `.env.example` with the phase that will introduce each.

`.env.example` is the tracked template and contains **placeholders only**. `.env` is git-ignored
and must never be committed.

---

## 6. Structure created

Only directories with real contents were created; the fuller layout in `01-architecture.md` §4 is
the target, filled in as each phase needs it.

```text
company-internal-chat/
├── app/                     Next.js App Router
│   ├── api/health/route.ts  liveness endpoint (infrastructure, no DB check)
│   ├── globals.css          Tailwind entry + base styles
│   ├── layout.tsx           root layout
│   └── page.tsx             Phase 1 placeholder page
├── lib/
│   ├── config/env.ts        environment parsing and validation
│   └── logging/logger.ts    level-filtered structured logger
├── docs/                    Phase 0 architecture + this document
├── server.ts                custom HTTP server (D-09)
├── next.config.ts           Next config (poweredByHeader disabled)
├── tsconfig.json            app TypeScript config
├── tsconfig.server.json     server build config -> dist/
├── eslint.config.mjs        flat ESLint config
├── postcss.config.mjs       Tailwind via PostCSS
├── .env.example             configuration template, placeholders only
└── .gitignore
```

---

## 7. Verification performed

| Check | Result |
|---|---|
| `npm install` | 363 packages, no errors |
| `npm run build` | Success — 3 routes (`/`, `/_not-found`, `/api/health`), server compiled to `dist/` |
| `npm run typecheck` | Clean, both configs |
| `npm run lint` | Clean, 0 problems |
| Dev server | Starts via `server.ts`; `GET /` 200, `GET /api/health` 200 `{"status":"ok"}` |
| Production server | `node dist/server.js` starts; both routes 200; JSON logs confirmed |
| Config validation | Invalid `PORT` and `LOG_LEVEL` rejected at startup with a readable message |
| `X-Powered-By` | Absent, as configured |
| Database access | None. No database package installed, no connection attempted |

---

## 8. Known items for later phases

- **`socket.io` is not installed.** Added in Phase 4 at the marked attach point in `server.ts`.
- **Prisma is not installed.** Added in Phase 3, along with `DATABASE_URL` parsing. Phase 1 ran no
  database or Prisma command of any kind.
- **The logger is dependency-free.** `pino` replaces it when there is real request and socket
  logging to do; the call signature already matches, so it is a one-file change.
- **No test runner yet.** Vitest arrives with the first logic worth testing (Phase 3 onwards);
  installing it now would mean a dependency with nothing to run.
- **`npm` reports two packages with unapproved install scripts** (`esbuild`, `unrs-resolver`).
  They were not run, and everything works without them. Leave them unapproved unless something
  actually breaks.
