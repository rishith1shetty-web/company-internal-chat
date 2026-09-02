# Message notifications

Sound, an in-app toast, and a desktop popup when the tab is in the background.

- **Status:** implemented
- **Phase:** between Phase 8 and Phase 9. Not part of either.
- **Adds no dependency, no endpoint, no table and no column.**

---

## 1. The requirement

A message arriving must reach the employee whether or not they are looking at the application.
The chat page only has to be *open* in a tab; it does not have to be the tab in front.

| Where they are | Sound | In-app toast | Desktop popup |
|---|---|---|---|
| Reading that very conversation | ✓ | — | — |
| In the app, a different conversation | ✓ | ✓ | — |
| Another tab, or another application | ✓ | — | ✓ |
| Another tab, desktop not permitted | ✓ | ✓ (waits for their return) | — |
| Their own message, or a `SYSTEM` line | — | — | — |

**Visibility chooses the surface, never whether there is one.** `document.hidden` selects the
desktop popup over the toast and does nothing else — it is never a reason to stay quiet. That is
the property `tests/notifications/policy.test.ts` is largely written to protect.

Two rows are judgement calls, so they are recorded rather than left implicit:

- **Reading that conversation already** — the message is arriving on screen as they watch. A toast
  would cover it with a copy of itself and a desktop popup would be worse. The chime alone is the
  least intrusive thing that still says "that arrived".
- **Background with no desktop permission** — the toast is queued rather than dropped, so somebody
  who never granted permission still finds out what happened when they come back to the tab.

## 2. Architecture

```
socket 'message:new'
   │
   ▼
useChatSession.onMessage ─────────────► describeIncomingMessage()      pure: the two lines
   │  (the ONLY live path — history                                     a person reads
   │   and reconnect backfill are REST                │
   │   reads that never reach here)                   ▼
   │                                    planNotification()              pure: the table above
   ▼                                                  │
NotificationCenter.handle() ◄──────────────────────────┘
   │  duplicate guard → chime → toast stack → desktop popup
   ▼
useNotifications (React: preferences, permission, a subscription to the stack)
   │
   ▼
NotificationToasts
```

**Four modules, split along one line: whether it needs a browser.**

| Module | What it is |
|---|---|
| `lib/notifications/policy.ts` | The decision. Pure. |
| `lib/notifications/describe.ts` | The wording. Pure. |
| `lib/notifications/center.ts` | Duplicates, the toast stack, its timers, the surfaces. Plain object, everything injected. |
| `lib/notifications/useNotifications.ts` | Only what React must own. |

**Why the centre is not a hook.** The interesting behaviour is stateful and sequential — a
duplicate arriving second, a fourth toast pushing the first out, a timer firing after a manual
dismiss — and none of it is about rendering. Inside a hook it would need a DOM, a React renderer
and a testing library to exercise at all: three dependencies bought to test logic that never
needed them. As a plain object it is driven directly, and `tests/notifications/center.test.ts`
runs in Node with a hand-cranked clock.

**No polling.** The existing `message:new` event is the only trigger. Nothing was added to the
socket contract, and the server was not touched.

## 3. Why old messages cannot be announced

Structurally, not by filtering:

- **History and the reconnect backfill are REST reads.** `loadHistory` and `backfill` dispatch
  `history-loaded` straight into the reducer. They do not pass through `onMessage`, so there is no
  path by which a backfilled message could reach the notifier.
- **The socket is the only live path**, and it carries only messages that arrived after this
  browser connected.
- **A duplicate guard covers what remains**: the same `message:new` delivered twice, which a
  reconnect racing an in-flight broadcast can produce. Message ids are remembered, bounded at 300,
  oldest evicted first.

The guard runs **after** the decision, not before. A message that was never going to notify — your
own, or a system line — must not consume a slot in that record and mark an id as announced when
nothing was announced.

## 4. The sound

`public/sounds/notification.wav` — 15.9 KB, 0.36 s, generated from arithmetic: two sine tones
(C6 then F6, a rising perfect fourth) with a fast attack, an exponential decay and a quiet second
harmonic for body. Peak amplitude 0.28 of full scale, and both the first and last samples are
zero, so it cannot click.

**It is original and local.** Nothing is copied from Microsoft Teams or any other product, and
nothing is fetched from a CDN. The generator is kept out of the repository; the asset is the
deliverable.

One `Audio` element is created and rewound (`currentTime = 0`) on each use — creating one per
message would leak an element per message and let a burst play a dozen overlapping copies. A
minimum 400 ms interval keeps a busy group sounding like a notification rather than an alarm; it
limits the **sound** only, never the notification.

**Autoplay.** Browsers refuse `play()` until the page has been interacted with, and refuse by
rejecting a promise rather than throwing. That is caught and recorded, and surfaced in Settings so
"no sound" has an explanation instead of looking broken. The restriction is about *interaction*,
not visibility — once the page has been clicked, the chime keeps working with the tab in the
background, which is the case that matters here.

## 5. The toast

Bottom-right, at most three, newest at the bottom, each dismissing itself after five seconds.

**It never covers the composer.** The stack is lifted well clear of it, and the browser regression
asserts the two elements' actual bounding rectangles do not intersect rather than trusting the CSS
that was meant to arrange them. The sidebar and header occupy the other edges, so navigation is
never blocked either.

Each card is a button: the whole surface is clickable for a mouse and one tab stop for a keyboard,
with dismiss as the only separately focusable control inside. The region is `role="status"` with
`aria-live="polite"` — a message arriving is worth announcing at the next natural pause, never
worth interrupting what a screen reader is already saying.

Clicking one calls **the same `selectConversation` the sidebar calls**. There is deliberately no
second navigation path, so whatever selecting a conversation does — re-read history, clear the
unread badge, close the mobile sidebar — a notification click does too, without anybody having to
keep two routes in step.

Styling reuses the existing brand system: the `brand-rule` hairline, `shadow-overlay`, the warm
neutrals, and the existing `Avatar`. The entry animation is a short slide from the right edge, and
the base layer's `prefers-reduced-motion` rule flattens it like every other animation here.

## 6. What each kind of message says

```
direct, text     Rishith             ·  Can you review the report?
direct, file     Rishith             ·  Sent report.pdf
group,  text     Engineering Team    ·  Sumit: Can you review the report?
group,  file     Project Team        ·  Rishith sent report.pdf
```

The sender is prefixed only in a group, where the title is the group's name. In a direct
conversation the title *is* the sender, and "Rishith · Rishith: hello" is the kind of detail that
makes an interface feel unconsidered. A caption sent with a file does not displace the filename:
what arrived is the useful fact at notification time.

## 7. Desktop notifications

**Permission is requested once, from a button in Settings, and never on page load.** Browsers
require a gesture in any case, but the real reason is that an unexplained prompt on first visit is
dismissed reflexively — and a denial is permanent from the page's point of view. After a denial
the application never asks again: Settings says it is blocked and points at the browser's own site
settings, which is the only place that can be undone.

Four states are shown distinctly, because collapsing them into on/off leaves somebody staring at a
switch that will not move: `unsupported`, `default` (a "Turn on" button), `granted` (a real
switch), `denied` (blocked, with the explanation).

A popup is tagged with the conversation id, so a busy group replaces its own rather than stacking.
It is `silent: true` whenever the application is playing its own chime, or the employee hears two
sounds per message. Clicking it focuses the window, closes the popup and opens the conversation;
where a browser refuses to focus, the navigation still happens, so returning by hand lands in the
right place.

## 8. Settings and storage

Three switches: **Message sounds** (on), **In-app notifications** (on), **Desktop notifications**
(off until explicitly enabled).

Stored in `localStorage` under `cic.notifications`, **not in PostgreSQL**. Identity is scoped to a
browser profile, so a server-side preference would be shared by every browser on a computer while
the thing it controls — whether *this* browser makes a noise — is per-browser by nature. It is
also not company data: nobody needs it backed up, audited or readable by an administrator, and
putting it in the database would mean a migration, an endpoint and an authorization check for a
value that changes nothing outside the tab it was set in.

Every access is wrapped in `try/catch`. `localStorage` does not merely come back empty in a private
window or with site data blocked — reading it *throws*, and a mute switch must never be able to
take the chat interface down with it. Stored values are validated field by field: what is there is
a string a user could have edited by hand.

**Identity is untouched.** No device, session, cookie or Phase 8 network behaviour was changed, and
nothing here reintroduces the rolled-back workstation-IP experiment.

## 9. Security and privacy

**Nothing new is exposed.** A notification is built from a `message:new` payload the server already
emitted into a room whose membership it verified — the same authorization that decides what the
transcript shows. A member who has left stops receiving the event, so they stop being notified;
the socket's membership check remains the only authority.

**What reaches the operating system** is a title, a one-line body and the company mark. No message
id, no conversation id, no user id, no storage key, no filesystem path, no MIME type. The ids on
the internal event exist so a click can route and a duplicate can be spotted, and
`tests/notifications/describe.test.ts` asserts none of them appears in a rendered string.

**A file is never downloaded or opened by a notification.** Clicking one opens the conversation and
nothing else; the attachment is still fetched through the authorized download route only when the
employee asks for it.

## 10. Branding

The desktop popup uses `/brand/rising-path-mark.png` — the exact asset already in the project. No
logo was generated, redrawn or substituted. The toast uses the existing brand tokens and
components rather than introducing a second visual language.

## 11. Tests

103 tests across six files, all in Node with no DOM:

| File | Covers |
|---|---|
| `tests/notifications/policy.test.ts` | The whole decision table, including every background case |
| `tests/notifications/describe.test.ts` | Direct/group/file wording; what must never appear in it |
| `tests/notifications/center.test.ts` | Duplicates, replay, the stack, its timers, the surfaces, live preference changes |
| `tests/notifications/preferences.test.ts` | Defaults, round trip, corrupt values, a throwing store |
| `tests/notifications/sound.test.ts` | One element, rewind, rate limit, autoplay refusal, no audio at all |
| `tests/notifications/desktop.test.ts` | Every permission state, never re-asking, the click path |

Plus a browser regression (`notify-ui`, 27 checks) against a real production server: a real socket
message producing a real toast, its wording, **its rectangle not intersecting the composer's**,
the click, the self-dismiss, the settings switches, persistence, and — the one that matters for
trust — that `Notification.permission` is still `default` after a page load, proving nothing
prompted on its own.

## 12. Files

| File | |
|---|---|
| `public/sounds/notification.wav` | **new** — the chime |
| `lib/notifications/policy.ts` | **new** |
| `lib/notifications/describe.ts` | **new** |
| `lib/notifications/center.ts` | **new** |
| `lib/notifications/preferences.ts` | **new** |
| `lib/notifications/sound.ts` | **new** |
| `lib/notifications/desktop.ts` | **new** |
| `lib/notifications/useNotifications.ts` | **new** |
| `components/chat/NotificationToasts.tsx` | **new** |
| `components/chat/SystemDialogs.tsx` | Settings gains the notification section |
| `components/chat/ChatWorkspace.tsx` | Wiring, and the toast stack |
| `components/layout/UserMenu.tsx` | Comment only |
| `lib/chat/useChatSession.ts` | `onIncomingMessage`, fed only by `message:new` |
| `app/globals.css` | The `toast-in` animation |
| `tests/notifications/*` | **new** — six files |
