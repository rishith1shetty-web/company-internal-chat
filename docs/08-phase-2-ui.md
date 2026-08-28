# Phase 2 — Chat UI

**Status:** Complete
**Scope:** Interface only. No database, no Prisma, no Socket.IO, no session, no file backend, no AI.

Phase 2 builds the interface the later phases connect to. Every screen, control and empty state
that Phases 4–7 need is in place and driven by local component state, so that adding the real
API and the real-time layer is a matter of replacing where the data comes from — not redrawing
the application.

---

## 1. What was built

| Area | Delivered |
|---|---|
| Entry | Display-name screen with validation, and the plain statement that a name is not proof of identity |
| Application header | Product identity, current-user area, account menu, Settings, **Switch user / clear device identity** |
| Sidebar | Search, New chat, New group, conversation list with avatars, presence, previews, timestamps, unread badges |
| Conversation | Header with presence or member count, message history with date separators and sender grouping, system messages, composer |
| Composer | Auto-growing field, Enter to send, Shift+Enter for a newline, length validation, attachment control |
| Details panel | Conversation/group information, member list with roles and presence, shared-files placeholder |
| Dialogs | New chat, New group, attachment placeholder, switch-user confirmation, settings |
| Empty states | No conversation selected, no conversations at all, empty conversation, no search results |

### Deliberately not built in Phase 2

Persistence, sessions, real presence, message delivery, file upload/download, group management
(rename, add or remove members — Phase 6, and it needs server-side authorization behind it), and
anything AI. Where a later phase owns a feature, Phase 2 either shows a placeholder that says so
or shows nothing at all — it never simulates a control that appears to work.

---

## 2. Screen structure

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ AppHeader        identity · current user · account menu                      │
├───────────────┬──────────────────────────────────┬───────────────────────────┤
│ Sidebar       │ ChatHeader                       │ DetailsPanel              │
│  search       ├──────────────────────────────────┤  conversation info        │
│  new chat     │ MessageList                      │  members + presence       │
│  new group    │   date separators                │  shared files (Phase 7)   │
│  conversation │   grouped bubbles                │                           │
│  list         │   system messages                │                           │
│               ├──────────────────────────────────┤                           │
│  phase notice │ MessageComposer                  │                           │
└───────────────┴──────────────────────────────────┴───────────────────────────┘
```

Breakpoints:

| Width | Sidebar | Details panel |
|---|---|---|
| `< 768px` | Overlay, opened from the header menu button | Overlay, opened from the header info button |
| `768–1279px` | Fixed column | Overlay on request |
| `≥ 1280px` | Fixed column | Fixed column, open by default |

The default state of the details panel follows the screen width until the user decides for
themselves; after that their choice wins.

---

## 3. Files

```text
app/
  page.tsx                      server component; renders the client shell and nothing else
  layout.tsx                    document shell
  globals.css                   design tokens + base styles

components/
  layout/
    AppHeader.tsx               product identity, current-user area
    UserMenu.tsx                account menu: settings, switch user
  chat/
    ChatWorkspace.tsx           the ONLY stateful component; composes everything below
    NameEntryScreen.tsx         display-name entry
    Sidebar.tsx                 search, creation actions, conversation list
    ConversationList.tsx        list + row
    ChatHeader.tsx              conversation header
    MessageList.tsx             history, date separators, grouping, bubbles
    MessageComposer.tsx         message entry and send
    DetailsPanel.tsx            conversation/group details (read-only)
    EmptyChatState.tsx          no conversation selected / none exist
    UserPicker.tsx              colleague picker shared by both creation dialogs
    NewConversationDialogs.tsx  new chat, new group
    SystemDialogs.tsx           attachment placeholder, switch user, settings
  ui/
    Button.tsx  Field.tsx  Modal.tsx  Avatar.tsx  icons.tsx

lib/
  chat/
    types.ts                    view models mirroring the Phase 3 entities
    state.ts                    reducer + selectors (pure, no React)
    format.ts                   timestamps, initials, presence text, discriminators
  ui/
    cn.ts                       class-name joiner
    useMediaQuery.ts            media query subscription
  mock/
    chat-seed.ts                TEMPORARY sample workspace — deleted in Phase 5
```

No dependency was added in this phase.

---

## 4. How the later phases replace this

The layering follows `01-architecture.md` §4: `ChatWorkspace` holds all state, everything below
it receives data and callbacks and touches nothing else.

| Phase 2 today | Becomes |
|---|---|
| `lib/chat/types.ts` view models | The response shapes of the Phase 5 API |
| `chatReducer` action `enter` | `POST /api/session`, then the state applies the server's answer |
| `switch-user` | `POST /api/session/switch-user` — revokes `Session` **and** `Device` server-side |
| `select-conversation` | `GET /api/conversations/:id/messages` + `POST /api/conversations/:id/read` |
| `send-message` | `message:send` over Socket.IO, reconciled by `clientMessageId`, or the REST fallback |
| `start-direct-conversation`, `create-group` | `POST /api/conversations` |
| Fixed `presence` on each user | Live presence from the socket layer (Phase 4) |
| `lib/mock/chat-seed.ts` | Deleted; the data comes from PostgreSQL |
| Attachment placeholder dialog | The Phase 7 upload flow |

Two things are already shaped for what comes later rather than for what works now:

- **`clientMessageId`** is minted per message. It is the idempotency key that lets Phase 4 retry
  a send after a dropped acknowledgement without producing a duplicate message.
- **`ConversationMember.joinedAt`** is carried on every membership, because group history is
  join-bounded (D-03) and the visible window is derived from it.

---

## 5. Identity in the interface

The interface reflects the identity model rather than glossing over it:

- **Display names are labels, not identifiers (D-02).** Where two known users share a name, the
  interface shows a short discriminator derived from the server-issued id — in the conversation
  list, the conversation header, the member list and both creation dialogs. The sample data
  deliberately contains two different people called "Sarah Chen" so this is exercised rather
  than assumed.
- **"Switch user / clear device identity" (F-19)** is reachable from the account menu and from
  Settings, and it is explicit about what it is for: a shared computer. Confirming it returns to
  the name screen, and the next identity starts with no conversations — a new identity never
  inherits the previous person's data.
- **The name screen states the limitation.** There is no password in v1, and a display name is
  not proof of who someone is. Employees are told that, rather than being left to assume
  otherwise.

Phase 2 has no session and no device cookie: the switch-user control clears local state only.
The finished control must revoke both rows server-side (`01-architecture.md` §5), because a
cookie deleted in the browser still works if it was copied.

---

## 6. Design system

Defined once in `app/globals.css` as Tailwind theme tokens; no component contains a raw colour.

| Token | Value | Use |
|---|---|---|
| `canvas` | `#f1f5f9` | Application background |
| `surface` / `surface-muted` | `#ffffff` / `#f8fafc` | Panels, rows, hover |
| `line` / `line-strong` | `#e2e8f0` / `#cbd5e1` | Separators, control borders |
| `ink` / `ink-muted` / `ink-subtle` | `#0f172a` / `#475569` / `#64748b` | Primary, secondary, tertiary text |
| `accent` / `accent-hover` | `#0369a1` / `#075985` | Primary actions, own messages, selection |
| `accent-soft` / `accent-tint` | `#e0f2fe` / `#f0f9ff` | Selected row, quiet emphasis |
| `danger`, `notice`, `online` | `#b91c1c`, `#92400e`, `#059669` | Destructive, warning, presence |

Corporate navy/slate neutrals with a single blue accent, reserved for primary actions and the
current user's own messages so that "the important thing on this screen" stays unambiguous.

**Contrast** (WCAG AA is 4.5:1 for body text): `ink` 17.0:1, `ink-muted` 7.4:1, `ink-subtle`
4.8:1, `accent` 5.9:1, white on `accent` 5.9:1, `danger` 6.2:1. `ink-subtle` is the lightest
text used anywhere, and only for secondary labels.

**Typography.** The system font stack, at 16px/1.5 for body text, 15px for message bodies and
14px for dense interface text; nothing is below 12px. A distinct typeface was considered and
deliberately not adopted: the production system runs on the company network with no assumed
internet access (N-01), and a web-font dependency at build or run time works against that. If a
brand typeface is wanted later, it must be self-hosted in the repository rather than fetched
from a font CDN.

**Motion.** Colour transitions of 150ms on hover and focus, and nothing else. The whole
interface honours `prefers-reduced-motion`.

---

## 7. Accessibility

Built in from the start, per assumption A-04 — semantic HTML and full keyboard operation:

- Every control is reachable and operable by keyboard, with a visible 2px focus ring at 3:1
  against its background. Focus is never removed, only styled.
- Every icon-only button carries an accessible name; decorative icons are hidden from assistive
  technology.
- Every input has a real `<label>`; placeholders are never used as labels. Errors are announced
  next to the field they belong to, not collected at the top.
- Dialogs are `role="dialog" aria-modal="true"`, labelled by their title, close on Escape,
  return focus to whatever opened them, keep Tab inside while open, and open on their first
  field rather than on the close button.
- A skip link jumps straight to the conversation.
- Presence is never signalled by colour alone — the dot is always accompanied by text
  ("Online", "Last seen …").
- Unread counts have accessible labels ("3 unread messages"), not a bare number.

---

## 8. Sample data

`lib/mock/chat-seed.ts` is the single source of the sample workspace, marked temporary at the
top of the file. It is a plain builder — deliberately **not** a fake repository and not shaped
like a database layer — and it is deleted in Phase 5.

Nothing is stored. Refreshing the page returns to the sample workspace and discards anything
typed, which is the honest behaviour for a phase with no persistence. The interface says so, in
the sidebar and on the name screen, rather than letting anyone believe messages are being kept.

---

## 9. Verification

| Check | Result |
|---|---|
| `npm run typecheck` (app + server) | Pass |
| `npm run lint` | Pass, no warnings |
| `npm run build` | Pass — 3 routes, no build warnings |
| Production server (`node dist/server.js`), `/api/health` and `/` | 200, page renders |
| Interface behaviour, headless browser, 30 checks | 30/30 pass |
| Browser console errors / uncaught exceptions | None |
| Horizontal overflow at 375, 768, 1024, 1440px | None |

The behaviour run covers: name entry and its validation, entering the workspace, conversation
selection, sending a message and the resulting list reordering and preview update, search
filtering and its empty state, group history including system messages, the attachment
placeholder, dialog validation and Escape handling, group creation, starting a direct
conversation, and switch-user — including that the second identity starts empty and that the
first identity remains a separate known user.

No test framework is installed yet. Vitest arrives in Phase 3 with the database tests
(`05-open-questions.md` Part A); the reducer and selectors in `lib/chat/state.ts` are pure
functions written to be tested there without a database.

No PostgreSQL, Prisma or Socket.IO command was run in this phase, and no dependency was added.
