# Phase 0 — Requirements & Architecture

**Status:** Reviewed; decisions D-01…D-12 recorded in `05-open-questions.md` Part B
**Date:** 2026-08-28 (reviewed same day)
**Scope:** Architecture and specification only. No application code, no dependencies installed, no schema created.

This document set is the deliverable of Phase 0 as defined in `CLAUDE.md` §5. It must be
reviewed and the open questions in `05-open-questions.md` answered (or explicitly deferred)
before Phase 1 begins.

## Document map

| File | Contents |
|---|---|
| `00-phase-0-overview.md` | This file — requirements summary, scope boundaries, phase exit criteria |
| `01-architecture.md` | System, component, and runtime architecture; message and file flows |
| `02-database.md` | PostgreSQL entity design proposal, relationships, indexes, cascade rules |
| `03-network.md` | Company-network restriction model, local dev and production topologies |
| `04-security.md` | Threat model, controls, accepted risks, path to real authentication |
| `05-open-questions.md` | **Finalized decisions (Part B)**, remaining open questions, assumptions, stack |
| `06-phase-1-prerequisites.md` | What must be true/decided before Phase 1 starts |

---

## 1. Requirements summary

### 1.1 What the system is

A privately hosted, browser-accessed chat and file-transfer application for employees of a
single company, running on hardware the company controls. It is a **modular monolith**: one
Node.js application process, one PostgreSQL database, one file-storage directory, fronted by
a reverse proxy.

### 1.2 Functional requirements (v1)

| # | Requirement | Source |
|---|---|---|
| F-01 | One-to-one conversations between two employees | §2.3 |
| F-02 | Group conversations with a name and members | §2.3, §5 Phase 6 |
| F-03 | Real-time message delivery without page refresh | §2.3 |
| F-04 | Message persistence in PostgreSQL (source of truth) | §2.3, §5 Phase 4 |
| F-05 | Message history load with pagination | §5 Phase 5 |
| F-06 | Message timestamps, stored UTC, rendered local | §2.3, §8 |
| F-07 | Sender identification on every message | §5 Phase 5 |
| F-08 | Online / offline presence indication | §2.3 |
| F-09 | Unread message indication per conversation | §2.3 ("where practical") |
| F-10 | Display-name identity, no password | §2.2 |
| F-18 | Identity continuity: a browser reattaches to the same `User.id` after session expiry (D-13) | D-13 |
| F-19 | "Switch User / Clear Device Identity" control for shared computers (D-13) | D-13 |
| F-20 | Chat history and all persistent data survive session expiry, browser close, refresh, restart, inactivity and reconnection (D-14) | D-14 |
| F-11 | File upload inside a conversation | §2.4 |
| F-12 | File download through a controlled server route | §2.4 |
| F-13 | File metadata persisted (name, storage id, size, MIME, sender, conversation, time) | §2.4 |
| F-14 | Configurable upload size limit and type allowlist | §2.4 |
| F-15 | Group management: create, rename, add/remove members | §5 Phase 6 |
| F-16 | Conversation list with search | §5 Phase 2 |
| F-17 | Reconnect handling with no message loss or duplication | §5 Phase 4 |

### 1.3 Non-functional requirements

| # | Requirement |
|---|---|
| N-01 | Runs entirely on company-controlled infrastructure; no cloud dependency |
| N-02 | Browser-only for employees; no client install |
| N-03 | Reachable only from the company network per the deployed network configuration |
| N-04 | Every server operation authorizes the requester against the requested resource |
| N-05 | No secrets, credentials, or internal paths reach the browser or the repository |
| N-06 | Deployment is reproducible from documentation, independent of any developer machine |
| N-07 | Errors are handled and logged server-side; users see safe messages |
| N-08 | Identity mechanism is replaceable by real authentication without redesign |
| N-09 | Desktop-first responsive UI, usable by non-technical staff |

### 1.4 Priority order

`CLAUDE.md` §23: **Reliability → Security → Simplicity → Maintainability → Performance → Features.**
Where this specification makes a trade-off, it resolves in that order. Notably: file downloads
are forced as attachments rather than rendered inline (security over convenience), and the
real-time layer is treated as a transport, never as storage (reliability over latency).

### 1.5 Explicitly out of scope for v1

AI of any kind — no dependencies, keys, embeddings, or vector stores through Phase 10 (D-12);
inline file or image previews, files are download-only (D-10); authentication (D-11); voice,
video, screen sharing; calendar; email integration; cloud storage; mobile or desktop apps;
enterprise SSO/LDAP; public registration; message reactions, threads, edit/delete, typing
indicators, read receipts beyond the unread counter; end-to-end encryption; antivirus scanning
of uploads (see risk R-08).

---

## 2. Application boundaries

The system owns:

- Identity records for display names and their sessions
- Conversations, membership, and messages
- File bytes on company storage and their metadata
- Presence state for currently connected sessions

The system explicitly does **not** own and must not assume:

- Employee directory / HR records (no integration in v1)
- Network authentication or device identity
- Firewall, DNS, TLS certificate issuance, or backup infrastructure — these are consumed as
  environment configuration and operated by whoever administers the company server

Every boundary crossing (browser → app, app → database, app → filesystem) is listed with its
trust assumptions in `04-security.md`.

---

## 3. Phase 0 exit criteria

1. ✅ This document set has been read and accepted by the project owner.
2. ✅ All Phase 1 blocking decisions are answered — recorded as **D-01…D-15** in
   `05-open-questions.md` Part B. No remaining open question blocks Phase 1.
3. ✅ Assumptions are recorded and confirmed or corrected (Part D).
4. ✅ No application code, dependency, or database object has been created — that is Phase 1.

**Phase 0 is complete.** Phase 1 awaits explicit instruction and the application database
credentials from the project owner.
