# Admin-controlled device identity

**Status:** implemented, on top of Phase 5. Supersedes the employee-facing identity flow described
in [docs/10-phase-4-realtime.md](10-phase-4-realtime.md) §"Identity" and
[docs/11-phase-5-direct-chat.md](11-phase-5-direct-chat.md) §"Entering".

---

## 1. What changed, and why

**Before.** An employee opened the application, typed a display name, and the server created a
`User` for them. They could sign out ("Switch user / clear device identity") and enter a different
name, becoming a different user.

**Now.** An administrator assigns a company computer to a named employee. The computer is set up
once. From then on, whoever sits at it opens the application and is already recognised. There is
no name entry, no sign-in, no sign-out, no switch-user and no clear-identity anywhere in the
employee interface — and no server endpoint behind those actions either.

The requirement this satisfies: **the employee using an assigned company computer must not be able
to control identity.** Self-declared identity is not merely hidden in the interface; the endpoints
that implemented it were removed, and a test asserts they stay removed.

What did **not** change: authorization. Every request and every socket event still resolves through
`resolveIdentity()` to a server-derived `User.id`, and every membership check still reads the
database. The client still cannot claim a sender, a membership or a conversation.

---

## 2. The model

A `Device` row is **a company computer, and the employee currently assigned to it**. It answers two
questions at once:

| Question | Column |
| --- | --- |
| Which physical machine is this? | `label` — the administrator's name for it, e.g. `PC-001` |
| Whose is it right now? | `userId` — repointed by a reassignment, never renamed |
| Is this browser that machine? | `tokenHash` — SHA-256 of the device cookie |

That indirection is the whole design. The browser proves **which computer** it is; the computer's
current assignment decides **who that is**. A reassignment changes the second without touching the
first, which is why a staff change needs nobody to visit the desk.

### Lifecycle

```
  register        userId set, tokenHash NULL, enrollment code issued   → awaiting setup
  enroll          tokenHash set, enrollment code cleared               → in use
  reassign        userId → a NEW User; tokenHash UNCHANGED             → in use, new employee
  re-enroll       tokenHash cleared, a fresh code issued               → awaiting setup
  out of service  revokedAt set, both hashes cleared                   → resolves no more
  back in service revokedAt cleared, a fresh code issued               → awaiting setup
```

The four operations, kept distinct on purpose:

| | Means |
| --- | --- |
| **Reassign** | Same computer, still in service, a different employee |
| **Take out of service** | This computer stops working — lost, stolen, in a cupboard, or being repaired |
| **Return to service** | That same computer comes back, same employee, set up once more |
| **New setup code** | A computer that never left service whose browser identity was lost |
| **Rename** | Only what the computer is called here. Available in service and out of it |

**Taking a computer out of service asks for confirmation first.** It is the one action that stops a
working machine, and the consequence an administrator cannot otherwise see is the third one: it
needs a new setup code entered *on that computer*, so somebody has to walk to it. Cancel writes
nothing.

A device resolves **only** when `tokenHash IS NOT NULL AND revokedAt IS NULL AND expiresAt > now()`.
Checking that the row merely exists is the bug this rule exists to prevent.

### Sessions are anchored to a device

`Session.deviceId` was added for one reason: identity is now device-anchored, so a session must be
traceable back to the computer that produced it. Without it, reassigning a computer could not
revoke the previous employee's still-valid session cookie.

`resolveIdentity()` therefore checks, on **every** lookup, that the session's device still exists,
is not revoked, has not expired, and is **still assigned to that session's user**. A session whose
device has moved on is refused even if the explicit revocation somehow had not run. A session with
no device at all cannot be checked this way and is not honoured.

---

## 3. The flows, exactly

### New employee, new computer

1. Administrator opens `/admin`, signs in with `ADMIN_TOKEN`.
2. Enters a computer name (`PC-001`) and the employee's name (`Rishith`).
3. The server creates a **new** `User`, a `Device` bound to it, and a one-time setup code. The code
   is displayed **once** — only its SHA-256 hash is stored, so nothing can produce it again.
4. On that computer, somebody from IT opens `/setup` and enters the code (or opens
   `/setup?code=…`, which pre-fills the field but redeems nothing until submitted).
5. The server verifies the code, clears it, and sets the `HttpOnly` device and session cookies.
6. The employee opens the application. They are Rishith. There is nothing to sign in to.

### Reassignment — the same computer, a different employee

`PC-001: Rishith → Rahul`

1. Administrator opens `/admin`, presses **Reassign** on `PC-001`, enters `Rahul`.
2. In one transaction the server:
   - creates a **new** `User` for Rahul — Rishith's row is not renamed, reused or deactivated;
   - repoints `Device.userId` at Rahul and refreshes `assignedAt`;
   - **deletes every `Session` issued for that device**, so Rishith's session cookie stops
     resolving immediately.
3. `Device.tokenHash` is deliberately **left alone**. The computer stays enrolled; the very next
   request from that browser is Rahul. Nobody visits the machine, and no code is handed out.
4. Rishith's `User`, conversations, memberships and messages are exactly where they were. Rahul
   inherits none of them and starts with an empty conversation list.

### Re-enrollment — a computer whose browser identity was lost

For a reimaged PC, cleared site data, a replaced browser profile, or a device cookie that may have
been copied. **Not** part of a staff change.

Issuing a fresh code clears `tokenHash` and deletes that device's sessions, so the old cookie is
worthless, and enrolls the **same** employee again.

### Out of service, and back again

The counterpart of there being no employee-facing sign-out. A lost, stolen or decommissioned
machine is taken out of service from `/admin`: both hashes are cleared and every session for it is
deleted. It stops the computer, not the person — the employee's `User` and history are untouched,
and the `Device` row stays in the register, still labelled and still assigned.

**Returning it to service** clears `revokedAt`, refreshes `expiresAt`, and issues a fresh setup
code. The same row throughout: same `Device.id`, same `label`, same assigned employee. No second
device is created and no new `User` is invented — handing the machine to somebody else is Reassign,
and stays a separate, deliberate act.

It deliberately does **not** restore the old device cookie, because taking a computer out of
service destroyed `tokenHash` on purpose — that may have been a response to the machine going
missing, and resurrecting its token would quietly undo the very thing the control was for. So the
computer is enrolled once more, back onto the same row.

That asymmetry is the design: taking a computer out of service is safe to reach for precisely
because it cannot be silently walked back, and the way back is explicit, logged, and visible in the
register. Without it, a mis-click was repairable only with direct SQL — and because `label` is
unique, the stopped row kept the computer's real name, so it could not even be registered again
under it.

---

## 4. Setup codes

- 20 characters from a 30-character alphabet with the ambiguous glyphs removed (no `O`/`0`,
  `I`/`L`/`1`, `U`) — about **98 bits**, generated with rejection sampling so no character is more
  likely than another.
- Grouped `XXXXX-XXXXX-XXXXX-XXXXX` for reading aloud; case and punctuation are ignored on entry.
- Stored **only** as a SHA-256 hash, and hashed over the canonical form at both ends.
- **Expire** after `ENROLLMENT_TTL_HOURS` (default 24).
- Cleared inside the same transaction that redeems them, so a code works exactly **once**. A second
  attempt is refused with the same message as a made-up one — telling somebody their code was "the
  right shape" narrows a guess for them.

A code carries **no name, no user id and no choice**. It names one computer whose employee an
administrator already decided. It is not, and cannot be used as, a login or an account switcher.

---

## 5. Administrator access

`ADMIN_TOKEN` is a single shared secret, presented once at `POST /api/admin/session` and exchanged
for a short-lived signed cookie (`cic_admin`, `HttpOnly`, `SameSite=Strict`, 8 hours). The cookie
carries an expiry and an HMAC over it keyed by the token itself, so:

- it needs no server-side table;
- **rotating `ADMIN_TOKEN` invalidates every administrator session immediately**;
- editing the expiry breaks the signature.

Both the token check and the cookie check are constant-time over hashed values.

**With no `ADMIN_TOKEN` configured the admin surface is closed, not open**: every admin request is
refused with 503, and no computer can be assigned at all.

Admin access governs the device registry and nothing else. It confers no ability to read a
conversation, a message or a file, and an employee session can never act as an administrator.

### What must be hardened, stated plainly

This is the smallest honest mechanism, not a finished one. It is **not** faked security, and it is
not represented as more than it is:

| Limitation | Where it belongs |
| --- | --- |
| One shared token — actions cannot be attributed to an individual administrator | A real admin account model, post-Phase 10 |
| No rate limiting or lockout on `/api/admin/session` or `/api/enroll` | **Phase 9** |
| `/admin` and `/api/admin` reachable from anywhere the application is | **Phase 8** — restrict at the reverse proxy / firewall |
| No audit log of who assigned or reassigned what, beyond application logs | Phase 9/10 |
| The device cookie remains a bearer token (R-16) | Unchanged; real authentication replaces `resolveIdentity()` |

The `Secure` cookie flag is set in production, where TLS terminates at the reverse proxy
([docs/03-network.md](03-network.md)).

---

## 6. API surface

### Employee — read-only

| Endpoint | Purpose |
| --- | --- |
| `GET /api/session` | Who is this computer assigned to. `204` when it is not assigned. |

There is deliberately no `POST` and no `DELETE`. `tests/chat/identity.test.ts` asserts their
absence, so adding one back fails the suite rather than passing unnoticed.

### Setup — on the computer being set up

| Endpoint | Purpose |
| --- | --- |
| `POST /api/enroll` | Redeem a one-time setup code; sets the identity cookies. |

Guarded by the code rather than the admin cookie — deliberately. The alternative is typing the
administrator's token into an employee's browser, which is a far worse exposure than a single-use,
expiring value that grants one device cookie.

### Administrator — all behind `withAdmin`

| Endpoint | Purpose |
| --- | --- |
| `GET/POST/DELETE /api/admin/session` | Probe (204 when signed out), sign in, sign out |
| `GET /api/admin/devices` | List every computer and its current assignment |
| `POST /api/admin/devices` | Register a computer, create its employee, issue a code |
| `POST /api/admin/devices/:id/reassign` | Hand the computer to a new employee |
| `POST /api/admin/devices/:id/enrollment` | Issue a fresh setup code (lost identity only) |
| `POST /api/admin/devices/:id/revoke` | Take the computer out of service |
| `POST /api/admin/devices/:id/reactivate` | Return that same computer to service, with a fresh setup code |
| `POST /api/admin/devices/:id/rename` | Change `Device.label`, and nothing else |

`withAdmin` is a separate preamble from `withIdentity` and never produces a `CurrentUser`: an
administrator acts on the registry, never as somebody.

No response from any of these carries a token or a hash. `enrollmentCode` appears only on the
response that creates it.

---

## 7. What the employee sees

| Situation | Screen |
| --- | --- |
| Computer not assigned, or out of service | "This computer is not set up yet" — no field, no button, and a pointer to IT |
| Computer assigned | The workspace, already signed in as the assigned employee |
| Account menu | Name, id discriminator, computer label, and **Settings** — nothing else |
| Settings | Display name, id, assigned computer, "Assigned to this computer by IT" — read-only |

The setup code is never mentioned to employees. Enrollment is an IT operation, and putting the word
in front of every employee would turn a setup mechanism into something people ask each other for.

---

## 8. Schema changes

Migration `20260831120000_admin_device_assignment`, forward-only and additive. No table dropped,
renamed, truncated or recreated; no column dropped or narrowed; no row deleted.

| Table | Change | Why |
| --- | --- | --- |
| `Device` | `label varchar(64) NOT NULL UNIQUE` | A computer must be identifiable to an administrator before any browser on it holds a cookie |
| `Device` | `tokenHash` → nullable | An assignment exists before the computer is enrolled |
| `Device` | `enrollmentTokenHash char(64) UNIQUE`, `enrollmentExpiresAt` | One-time code, stored hashed, expiring |
| `Device` | `assignedAt NOT NULL DEFAULT now()`, `enrolledAt` | Operational facts an administrator cannot otherwise recover |
| `Session` | `deviceId uuid NULL` + index + FK `ON DELETE SET NULL` | Ties a session to the computer it was issued for, so reassignment can revoke it |

`label` was added nullable, backfilled from the row's own id, and only then made `NOT NULL`, so the
migration is correct whether the table is empty or already holds rows.

**Pre-existing rows survive.** An identity created through the old name-entry flow keeps working:
its device was given a placeholder label (`Unlabelled device <id-prefix>`) and still resolves. Its
old sessions carry no `deviceId` and are therefore not honoured, so the browser falls through to the
device cookie and is issued a new, properly anchored session on its next request.

---

## 9. Tests

`tests/chat/devices.test.ts` (27) and `tests/chat/identity.test.ts` (12) cover, against the real
database and the real route handlers:

- the employee identity endpoints do not exist;
- admin routes refuse anonymous callers, wrong tokens, expired and edited cookies, and a perfectly
  valid **employee** session;
- an unconfigured server is closed, not open;
- registration creates a new user, stores the code hashed, and never discloses it again;
- duplicate computer names are refused; two computers assigned the same name get two employees;
- a code redeems once, expires, ignores any name or id in the request, and tolerates any typing;
- reassignment creates a new user, leaves the previous row and history intact, revokes the session,
  keeps the computer enrolled, and grants the new employee nothing of the old one's;
- a stale session cannot survive by racing the revocation;
- re-enrollment invalidates the old cookie and re-enrols the **same** employee;
- taking a computer out of service stops resolution, keeps the row, the label, the assignment, the
  employee and their messages, and stops it operating over both REST and the socket;
- returning it to service reuses the **same** `Device.id`, creates no second device and no new
  `User`, preserves the label and the assignment, refreshes the lifetime so a long-stopped machine
  is usable again, does **not** resurrect the old cookie, re-enrols onto the same row, works again
  afterwards, and can still be reassigned;
- returning a computer that never left service is refused, as is one that does not exist, and one
  requested without an administrator cookie — none of which writes anything;
- renaming writes `label` alone — `id`, `userId`, `tokenHash`, `enrolledAt`, `assignedAt`,
  `revokedAt`, sessions, memberships and messages are unchanged, and the same cookies still
  resolve to the same employee — works out of service, refuses a name another computer holds with
  a message an administrator can act on, accepts a computer's own current name, rejects an empty
  or over-long one, and refuses without an administrator cookie.

Verified end-to-end against `node dist/server.js` (61 checks) and in a real headless browser across
three pages (60 checks), including that the employee interface contains no sign-out, switch-user or
clear-identity control anywhere, and no console errors.
