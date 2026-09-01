# Decisions, Open Questions & Assumptions

`CLAUDE.md` §18: "When requirements are ambiguous, identify the ambiguity rather than inventing a
business requirement."

**Part A** is the technology stack. **Part B** records decisions finalized at the Phase 0 review
(2026-08-28) — D-01…D-15, settled and not to be revisited without cause. **Part C** lists what is
still open; **no item in Part C blocks Phase 1.** **Part D** lists standing assumptions.

Nothing in this document has been installed, created, or executed.

---

## Part A — Technology stack (recommended; nothing installed)

| Concern | Choice | Reasoning |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript, `strict: true` | Named in `CLAUDE.md` §3 |
| Runtime | Node.js 24 (installed: v24.18.0) | Already present; matches Next 15 requirements |
| Process model | **Custom `server.ts`** hosting Next + Socket.IO on one port | FINALIZED — see D-09 |
| Styling | Tailwind CSS | Named in §3 |
| Components | shadcn/ui, added per component as needed | Copy-in components, not a runtime dependency |
| Database | PostgreSQL 16 (already installed), dedicated `company_chat_db` | §2.1 + the isolation constraint |
| ORM | Prisma | Named in §3 |
| Real-time | Socket.IO v4 | Named in §3; provides rooms, acks, and reconnect handling that raw `ws` would require writing |
| Validation | Zod | One schema shared by HTTP handlers, socket handlers, and TypeScript types |
| Multipart upload | `busboy` | Streaming, no in-memory buffering — necessary at a 500 MB limit; hand-rolled multipart parsing is exactly where security bugs appear |
| File type detection | `file-type` | Magic-byte sniffing; hand-written signature tables are avoidable risk |
| Logging | `pino` (+ `pino-pretty` in development only) | Structured, low overhead, level-configurable |
| Testing | Vitest, plus an integration test database | Native TypeScript/ESM support, no extra transform layer |
| Package manager | **npm** (installed: 11.16.0) | FINALIZED — see D-01 |
| Linting | ESLint (Next config) + Prettier | Standard |

Deliberately **not** adopted: any state-management library, any UI kit beyond shadcn/ui
primitives, Redis (single process — see Q-09), Docker (PostgreSQL is already installed), any
authentication library (D-11), and **any AI, LLM, embedding, or vector dependency — prohibited
through Phase 10 (D-12)**.

---

## Part B — Finalized decisions

| ID | Decision | Applied in |
|---|---|---|
| **D-01** | **Package manager: npm.** The lockfile (`package-lock.json`) is committed. | Part A; `06-phase-1-prerequisites.md` |
| **D-02** | **Display names are not unique.** Multiple users may share a display name. Identity is the server-issued opaque session and its `User.id`; names are labels only, and no query resolves a user by name. The UI disambiguates same-named users. | `01-architecture.md` §5; `02-database.md` User |
| **D-03** | **Group history is join-bounded.** A member added to a group sees only messages sent at or after they joined. Enforced on message queries, **file downloads**, and list previews/unread counts alike. | `01-architecture.md` §7; `02-database.md` ConversationMember; `04-security.md` R-14 |
| **D-04** | **Session lifetime: 24 hours idle, renewed while the user is active**, configurable via `SESSION_TTL_HOURS`. Expiry affects only the user's temporary identity — the application service runs continuously regardless. | `01-architecture.md` §5; `02-database.md` Session; `03-network.md` §1 |
| **D-05** | **Maximum file size: 500 MB**, configurable via `MAX_FILE_SIZE` so it can be tuned later against storage, bandwidth, backup capacity, and company policy. | `01-architecture.md` §8; `03-network.md` §1 |
| **D-06** | **A dedicated PostgreSQL role** is used, with access limited to `company_chat_db` and no privileges on any other database. | `02-database.md` §0 |
| **D-07** | **Every pre-existing database on the PostgreSQL server is off-limits** — never modified, migrated, reset, dropped, renamed, or otherwise affected. This project touches exactly one database: its own. | `02-database.md` §0; `04-security.md` R-12 |
| **D-08** | **GitHub: a new private repository named `company-internal-chat`.** | `06-phase-1-prerequisites.md` |
| **D-09** | **Custom `server.ts` for Next.js + Socket.IO** — an intentional, settled architectural decision. Production starts with `node dist/server.js`, not `next start`. | `01-architecture.md` §3 |
| **D-10** | **File handling is download-only in v1.** No inline file or image previews. | `01-architecture.md` §8; `04-security.md` R-07 |
| **D-11** | **No authentication in v1.** The server-issued opaque session remains the identity mechanism, behind a single swap point (`lib/auth/session.ts`) for later replacement. | `01-architecture.md` §5; `04-security.md` §5 |
| **D-12** | **No AI in Phases 0–10.** No AI dependencies, API keys, embeddings, vector stores, or LLM infrastructure before Phase 11. | Part A; `00-phase-0-overview.md` §1.5 |
| **D-13** | **Two-cookie identity (resolves Q-16).** A long-lived device identity cookie, separate from the 24-hour session, reattaches a browser to the same `User.id` after session expiry. Backed by a `Device` table storing only a token hash. Users are never identified by display name. A **"Switch User / Clear Device Identity"** control revokes both session and device server-side for shared computers. The device identity is **not** authentication, grants no privilege, and its security limitations are documented. | `01-architecture.md` §5; `02-database.md` Device; `04-security.md` R-16 |
| **D-14** | **Session expiry never deletes data.** Sessions and devices are temporary auth state and own nothing. Users, conversations, groups, memberships, messages, file metadata and uploaded files persist in PostgreSQL independently of any session, and survive expiry, browser close, refresh, restart, inactivity, reconnection, and new sessions for the same `User.id`. Enforced by FK direction, `SET NULL` on authorship, and sweeps scoped to `Session`/`Device` only. | `01-architecture.md` §5; `02-database.md` §2.1 |
| **D-15** | **The owner provisions the database.** `company_chat_db` **already exists** and must never be created, dropped, renamed, recreated, or reset. Claude Code creates neither the database nor the role, and **never uses superuser/admin credentials**. The owner supplies the dedicated application role; `DATABASE_URL` is verified to target only `company_chat_db` before any migration. Uncertainty about the target means **stop and ask**. | `02-database.md` §0 |

### How D-13 and D-14 fit together

D-13 keeps a browser attached to the same `User.id`; D-14 keeps that user's data in the database
regardless of session state. Both are needed: continuity of identity without persistence of data
would still show an empty chat list, and persistence without continuity would leave the data
stranded under an identity the browser can no longer reach.

The cost is R-16 — a long-lived bearer cookie on the browser — which is why "Switch User" is a
required feature rather than a nicety, and why the device identity is documented as convenience,
not authentication.

---

## Part C — Remaining open questions

**Q-16 is closed** — resolved as D-13 (option (a), the long-lived device identity cookie).

### Q-19 — Device identity lifetime · minor, Phase 1
`DEVICE_ID_TTL_DAYS` **ASSUMED: 90 days**, renewed on use, configurable. Shorter means employees
re-enter their name more often but a stale device cookie stops working sooner; longer favours
convenience over containment (R-16). Adjustable at any time — it is one environment variable, and
not a blocker.

### Q-17 — Re-added members and their earlier history · DECISION REQUIRED (Phase 6)
Under D-03, re-adding a removed member resets `joinedAt`, so messages they could previously read
become inaccessible. **ASSUMED: that is correct and intended. Implemented that way in Phase 6**,
which also clears the returning member's read marker — one pointing at a message from before the
new join would sit outside their window and suppress the unread count. The alternative — restoring their
earlier visible window — requires modelling membership as multiple dated periods rather than one
row, which is a schema change best made before Phase 3 if it is wanted at all.

### Q-18 — Resumable uploads · DECISION REQUIRED (Phase 7)
At 500 MB a failed upload restarts from zero, because a single POST cannot resume. **ASSUMED:
acceptable for v1** on a LAN. If it proves disruptive, chunked/resumable upload is the fix and is
a materially larger Phase 7.

### Q-04 — User directory scope · DECISION REQUIRED (Phase 5)
Can any user see every registered name in order to start a chat? **ASSUMED: yes.** Note that under
D-02 this list will contain duplicate names and must show a discriminator.

### Q-05b — Group management permissions · ANSWERED (Phase 6)
D-03 settled history visibility, but not who may perform management actions. Who may rename a
group, add members, and remove members?

- **(a) (recommended)** Owner/creator renames and removes; any member may add; any member may leave.
- **(b)** Any member may do anything.
- **(c)** Owner-only for all management actions.

**ANSWERED: (a).** Implemented in Phase 6 — any active member may add, only an `OWNER` may remove
somebody else, and anybody may leave. Leaving needs no permission because it takes access away
rather than granting it; adding is open to any member because the alternative makes an owner on
holiday a bottleneck for a team that needs somebody in the conversation. Renaming a group is not
implemented and keeps the question open for whenever it is (docs/13-phase-6-group-chat.md §7-8).
Reversible: it is four lines in `lib/conversations/service.ts`, and the tests state the rule.

One rule was added that the options did not cover: if the **last owner leaves**, ownership passes
to the longest-standing remaining member. Without it a group is left with nobody able to manage
it and no way back short of direct SQL.

### Q-06b — File type allowlist · DECISION REQUIRED (Phase 7)
`CLAUDE.md` lists PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG/JPEG, PNG, TXT, ZIP. Should CSV be added?
It is a common business format and is absent. Should any format be removed?

### Q-07 — Antivirus scanning of uploads · DECISION REQUIRED (Phase 7 or later)
Not in scope as written. At a 500 MB limit with ZIP allowed, this deserves a conscious answer. If
required, the hook belongs between upload completion and `status=READY`, so an infected file never
becomes downloadable (R-08).

### Q-09 — Expected concurrent users · DECISION REQUIRED (affects Phases 4 and 10)
The single-process design with in-memory presence is comfortable to roughly a few hundred
concurrent connections. **ASSUMED: under 200 employees.** A materially larger figure means
multi-process operation, and presence plus broadcast must move to a shared adapter — better
decided before Phase 4.

### Q-10 — Message and file retention · DECISION REQUIRED (before production)
**ASSUMED: indefinite retention, no deletion feature.** With a 500 MB file ceiling this is now
also a capacity question, not only a policy one. Deletion would touch the schema, the storage
sweep, and the UI.

### Q-11 — Client IP logging · DECISION REQUIRED (Phase 1)
**ASSUMED: log IPs only for authorization failures and errors, not normal traffic**, and not
stored on the `Session` row. Adjust to company policy.

### Q-13 — Production server OS · DECISION REQUIRED (Phase 10)
Linux or Windows Server? Determines the service manager, path conventions, and reverse-proxy
setup.

### Q-14 — TLS and hostname in production · DECISION REQUIRED (Phase 10)
Certificate source and hostname. Without TLS the `Secure` cookie flag cannot be used and R-03
(token theft on the LAN) becomes real. **Strongly recommended: HTTPS even internally.**

---

## Part D — Standing assumptions

| ID | Assumption |
|---|---|
| A-01 | One company, one deployment, one shared tenant — no multi-tenancy |
| A-02 | Employees use modern evergreen browsers on company desktops/laptops |
| A-03 | English-only UI; no localization requirement in v1 |
| A-04 | No accessibility conformance target stated; sensible semantic HTML and keyboard operation are still built in |
| A-05 | Timestamps stored UTC, rendered in the browser's local timezone |
| A-06 | Message bodies are plain text; no rich text, markdown, or emoji picker in v1 |
| A-07 | One attachment per message |
| A-08 | No message editing or deletion in v1 |
| A-09 | No email or desktop notifications; unread badges only |
| A-10 | No pre-existing database on the PostgreSQL server is ever accessed by this project (D-07) |
| A-11 | `company_chat_db` already exists; this project migrates it forward and never creates or resets it (D-15) |
| A-12 | One `Device` row per browser profile; a `User` may accumulate several across their own machines |
