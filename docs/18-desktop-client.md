# Windows desktop client

**Rising Path Recruiters Chat** — an Electron client so employees use one application instead of
one browser profile.

- **Status:** implemented
- **Phase:** between Phase 8 and Phase 9. Not part of either.
- **No database migration, no schema change, no server change.**

---

## 1. What it is, and what it is not

A **thin client**. It holds no database, no credentials, no business logic and no copy of the
application. It opens a window onto the real page served by the real company server, and
everything an employee sees comes from that server exactly as it does in a browser.

```
Employee PC
    │
    ▼
Rising Path Recruiters Chat.exe        ← window, tray, navigation rules
    │  HTTP/HTTPS over the company LAN
    ▼
Company server
    ├─ Next.js + custom server (D-09)
    ├─ Socket.IO
    ├─ PostgreSQL
    └─ uploads
```

It contains no `DATABASE_URL`, no `ADMIN_TOKEN`, no Prisma, no uploaded files and no second
backend. The installer carries the compiled `dist-desktop/` and nothing else — `package.json`'s
`build.files` excludes `node_modules` entirely, and the main process imports only Electron and
Node built-ins.

## 2. Why it loads a remote URL instead of bundling the app

The chat client opens its socket with `io({ path })` and **no host** ([socket.ts](../lib/chat/socket.ts)) — same
origin, deliberately, so one process serves both transports and the session cookie applies to each
without CORS (D-09). A bundled `file://` renderer has no origin to share, and would need a second,
weaker authentication path invented for it.

Loading the server's own page means the cookies, the Phase 8 network gate, the upload route and
the download route behave here **precisely as they do in Chrome**, with nothing re-implemented and
nothing to keep in step. That is the single decision the rest of this design follows from.

## 3. What the desktop client actually adds

| | |
|---|---|
| **One profile per computer** | A named persistent partition, so one enrollment per machine — the browser-profile proliferation this application was built to avoid. |
| **Native Windows notifications** | Shown by the main process, because only it can restore a window hidden in the tray. |
| **A tray** | Closing the window keeps the socket open. That is what makes a chat client a chat client rather than a web page. |
| **Navigation rules** | One origin, two protocols, no administration surface. |

It adds **no** relaxation of any server check. The network gate, membership checks, admin token
and download authorization all remain the server's, and this process neither can nor does weaken
any of them.

## 4. Files

```
desktop/
  main.ts          window, tray, single instance, navigation, IPC, notifications
  preload.ts       the contextBridge — six things, and nothing else
  ipc.ts           channel names shared by main and preload
  config.ts        server-URL resolution and validation      (pure)
  navigation.ts    allow / external / block                  (pure)
  notifications.ts payload validation for the native toast   (pure)
  downloads.ts     Windows filename safety                   (pure)
  offline.html     the branded "cannot connect" screen
  tsconfig.json    Node + Electron types, no DOM
```

The four pure modules are where the rules live, which is why they are testable without an Electron
process at all ([tests/desktop/](../tests/desktop/), 71 tests).

## 5. Where the server address is configured

Highest priority first:

| # | Source | Used for |
|---|---|---|
| 1 | `DESKTOP_SERVER_URL` in the environment | Development, and a machine-wide variable set by an administrator |
| 2 | `serverUrl` in `server.json`, in the Electron user-data directory | **Packaged production**: `%APPDATA%\Rising Path Recruiters Chat\server.json` |
| 3 | `http://localhost:3000` | A developer running the server on the same machine |

```jsonc
// %APPDATA%\Rising Path Recruiters Chat\server.json
{
  "serverUrl": "https://chat.risingpath.local",
  "launchAtStartup": false
}
```

**No company address is compiled into the build.** The fallback is loopback — wrong everywhere
except a developer's own machine, so it fails visibly rather than connecting somewhere
unintended. The address lives in per-installation data, so upgrading the client does not disturb
it and the installer does not have to be rebuilt per site.

A source that is present but **invalid is an error**, not a reason to fall through to the next one.
An administrator who mistyped the server name gets told, rather than being quietly connected to
localhost where nothing will be found. `http://` to a non-loopback host is accepted and logged
once as insecure; `https://` is what production should use (§10 below).

## 6. One EXE, one identity

```
PC-001  →  Chat.exe  →  persist:rising-path-chat  →  one Device  →  one assigned employee
```

The partition is `persist:rising-path-chat` — fixed, never generated. `persist:` is what makes it
survive a restart; a partition without that prefix is in-memory, and would hand the employee a
fresh unenrolled browser on every launch.

**Cookies are flushed to disk when the window is hidden and again on quit.** Chromium's cookie
store writes on a timer, and a machine switched off at the wall — which is what actually happens
at the end of a working day — can lose a cookie written minutes earlier. For a web session that
costs a sign-in; here it would cost the computer's **enrollment**, and an administrator would have
to visit the desk again with a new setup code.

Uninstalling does **not** delete the profile (`deleteAppDataOnUninstall: false`), so reinstalling
or upgrading finds the same enrollment.

## 7. First-time setup

1. Administrator opens `/admin` **in a normal browser** on the server/admin PC.
2. Registers the computer and the employee; receives the existing one-time setup code.
3. Goes to the employee PC and launches **Rising Path Recruiters Chat**.
4. The client shows the existing "this computer is not set up yet" screen — no field, no way for
   the employee to name themselves.
5. Administrator opens `/setup`, enters the code.
6. The existing server enrollment creates the Device and sets the two cookies.
7. Chat opens as the assigned employee.

From then on the employee never sees setup again: closing, reopening, and restarting Windows all
restore the same identity. **No new identity mechanism was invented** — this is the existing
device-cookie enrollment, running in a browser profile that happens to belong to one application.

**Administration is never done in the EXE.** The admin console stays in a browser on the admin PC,
and `ADMIN_TOKEN` is never put anywhere near the installer.

## 8. Reassignment

Unchanged, and it works because identity resolution always ends at the same question: *who is this
computer assigned to right now?* ([session.ts](../lib/auth/session.ts))

An administrator reassigns PC-001 from Sumit to Rahul. The server revokes the stale sessions; the
device cookie survives; on the client's next resolve the device's **current** assignment answers
Rahul. Sumit's history is untouched (D-14). The employee needs no logout and no switch-user
control, and there is deliberately none in this client — reopening the app is enough.

## 9. Security settings

| Setting | |
|---|---|
| `contextIsolation: true` | Page and preload run in separate JavaScript worlds |
| `nodeIntegration: false` | No `require`, `process`, `module` or `Buffer` in the page |
| `sandbox: true` | The renderer runs in the OS sandbox, as a browser tab does |
| `webviewTag: false` | No embedded frame with its own preferences |
| `webSecurity: true` | Same-origin policy left on |
| `devTools: !isPackaged` | Off in the packaged client; not a security boundary |
| `backgroundThrottling: false` | The one non-default — see below |
| Permissions | **Every** browser permission denied, by handler |
| Certificates | No override of any kind. See §10 |

`backgroundThrottling: false` is the exception, and the tray is the reason: Chromium throttles
timers in hidden windows to roughly one tick a minute, which would slow the socket's heartbeat
exactly when the client is sitting minimised — the state it is designed for.

**The preload is six things**: `isDesktop`, `notify`, `closeNotification`, `onNotificationClick`,
`reload`, `connectionInfo`. No filesystem, no child process, no shell, no `ipcRenderer` itself, and
no generic "invoke any channel" escape hatch. Nothing exposed there can read or write company data,
and there is deliberately no method that returns a cookie, a token, a path or a setting.

**A sandboxed preload cannot `require` its own files.** Electron's sandbox bundle resolves only a
few built-ins, so a relative import fails at load, the whole preload is dropped, and the page comes
up with no bridge on it. The channel names are therefore written out in `preload.ts` *and* in
`ipc.ts`, with two type-only assignments that fail `npm run typecheck` the moment the two lists
differ in either direction.

### Navigation

Three hooks, because there are three ways to leave: `will-navigate`, `will-redirect`, and
`setWindowOpenHandler`.

| Target | |
|---|---|
| The server origin | **allow** |
| `/admin`, `/api/admin` | **block**, return to chat |
| Another `http(s)` origin | **open in the Windows default browser** |
| `javascript:`, `data:`, `file:`, `blob:`, custom schemes | **block** |
| Unparseable | **block** |

Admin paths are compared after percent-decoding and separator normalisation, so `/%61dmin`,
`/ADMIN/devices` and `//admin` are all caught — while `/administration-policy` is not.
`shell.openExternal` gets its own stricter allow-list of exactly `http:` and `https:`, because that
one hands a string to the operating system, which will happily launch a registered handler.

**Blocking `/admin` is a product boundary, not the protection.** `/api/admin/*` refuses without a
valid admin cookie whatever asks it. What this does is keep a stray link from parking an employee
on a sign-in form they cannot use.

## 10. HTTPS

Development may continue over `http://192.168.29.244:3000`. **Production should use HTTPS** —
`https://chat.risingpath.local` or equivalent.

There is **no certificate bypass of any kind**: no `ignore-certificate-errors`, no
`setCertificateVerifyProc`, and no `certificate-error` handler. Electron's default therefore
applies and a bad certificate fails the load, which shows the employee the offline screen. That is
the correct outcome — a client that accepted any certificate would make the eventual HTTPS
deployment worse than the HTTP one it replaced.

## 11. Notifications

The existing feature ([docs/17](./17-notifications.md)) is unchanged. The desktop client changes
the **surface** and nothing else: `showDesktopNotification` already takes an injectable
`DesktopScope`, so the integration is one object backed by the preload bridge
([electron.ts](../lib/notifications/electron.ts)). The policy, the duplicate guard, the toast stack,
the wording and their tests are untouched and cannot tell the difference.

| Where the employee is | Sound | Toast | Windows notification |
|---|---|---|---|
| Reading that conversation | ✓ | — | — |
| App in front, another conversation | ✓ | ✓ | — |
| Minimised, hidden, or in another app | ✓ | — | ✓ |
| Their own message, or `SYSTEM` | — | — | — |

**Exactly one popup per message.** The web `Notification` path is not used inside the desktop
client — the scope replaces it — so there is no way to get both.

**Why the main process shows them**, in order of how much it matters:

1. **The tray.** A click has to bring back a window that may be *hidden*, and a renderer cannot
   show a hidden BrowserWindow. Only the main process can complete the click.
2. The session denies every browser permission, so the page's own API is refused here by design.
3. The toast carries the application's icon and AppUserModelID, so Windows attributes it to Rising
   Path Recruiters Chat.

> **A correction worth recording.** The obvious guess — that Chromium's secure-context gating hides
> `window.Notification` on a plain-http LAN address — is **false inside Electron**. Measured on
> `http://192.168.29.244:3411`: `isSecureContext: false`, yet `typeof Notification === 'function'`.
> Electron does not apply that gating. It is real for Chrome and Edge, and it is why *browser* users
> on plain http get the toast fallback rather than a desktop popup — but it is not why this client
> uses the native path.

**Desktop notifications default to ON in the EXE**, and only in the EXE. They are off by default in
a browser because turning them on means a permission prompt, and an unexplained prompt is one
people refuse permanently. There is no prompt here, so the caution has nothing left to protect
against. It remains a default: an employee who switches it off stays switched off, stored in
`localStorage` under `cic.notifications` like every other notification preference.

The sound is the existing `public/sounds/notification.wav`, served by the company server. Nothing
was added, and nothing copyrighted was used.

## 12. Tray, close, and single instance

Clicking **X hides the window**. The process stays alive, the socket stays open, and notifications
keep arriving. Tray menu: **Open Rising Path Recruiters Chat**, and **Quit**, which actually exits.
Single click and double click on the tray icon both restore the window.

> **A second finding worth recording**, because it decides which notification an employee gets.
> With `backgroundThrottling: false`, a window hidden to the tray still reports
> `document.visibilityState === 'visible'`. Measured on a real hidden window:
> `{ visibility: "visible", hasFocus: false }`. So `visibilityState` alone would conclude the
> employee is looking at the app and raise an in-app toast **inside a window nobody can see**.
> What saves it is that `documentIsFocused()` in [useNotifications.ts](../lib/notifications/useNotifications.ts)
> checks visibility **and** `hasFocus()` — written for a tab sitting behind a spreadsheet, and it
> turns out to be exactly what the tray needs too. The end-to-end run asserts this directly rather
> than trusting it.
>
> Two gestures that look like clicking X are not: the renderer's `window.close()` destroys the
> webContents without the `close` handler running at all, and `taskkill` without `/F` never reaches
> the window. Only a real `WM_CLOSE` to the window handle exercises this path, which is what the
> test sends.

`window-all-closed` deliberately does **not** quit — that would defeat the tray entirely.

**One instance per Windows user**, via `requestSingleInstanceLock`. Two copies would mean two
sockets, two notifications per message, and two windows an employee could believe were different
accounts. A second launch hands off to the first, which brings its window forward, and then exits.

## 13. Files in and out

**Upload** is unchanged: the employee picks a file from Windows through the ordinary file input,
and it goes to the existing authorized upload route. The 500 MB configured limit remains the
server's. The renderer has no filesystem API of its own.

**Download** goes only through the existing authorized endpoint, which decides both whether this
employee may have the file and what it is called. Chromium's own save dialog is used, so the
employee chooses the folder as they would in a browser. On top of that the filename is sanitised
again in `downloads.ts` before it becomes a Windows path — the last path segment only, illegal
characters replaced, trailing dots stripped, reserved device names (`CON`, `PRN`, `COM1`…) prefixed,
length capped with the extension preserved. **Whatever goes in, what comes out cannot escape the
folder it is saved into.**

Nothing downloaded is opened, executed or handed to the shell.

## 14. Offline screen

A local HTML file, so it needs no network at the one moment there is none — brand mark included,
loaded from disk. It says *"Unable to connect to Company Chat"*, explains in plain language that
the computer may be off the company network or the server may be unavailable, shows the address it
is trying to reach, and offers **Try again**.

It shows **no** stack trace, error code, filesystem path or configuration value beyond that
address, which is a LAN address already visible in the window rather than a secret.

The same screen covers a client that was never configured, and a client outside the permitted
company network — the Phase 8 gate refuses it, the load fails, and this is what the employee sees.

## 15. Launch at Windows sign-in

Off unless an administrator sets `"launchAtStartup": true` in `server.json`. Applied through
`app.setLoginItemSettings`, which is a per-user registry entry and needs no administrator rights.
It is written on **every** launch, so turning the flag off actually removes the entry rather than
leaving one behind that nothing owns. Never enabled silently, and there is no employee-facing
control for it.

## 16. Scripts

| | |
|---|---|
| `npm run desktop:dev` | Build, then launch the unpackaged client |
| `npm run desktop:build` | Compile `desktop/` and generate the icons |
| `npm run desktop:package` | Windows installer + portable EXE |
| `npm run desktop:package:win` | The same, targets named explicitly |

`npm run typecheck` now covers three projects: the app, the server, and the desktop client.
Everything else — `dev`, `build`, `start`, `test`, `lint` — is unchanged.

**The end-to-end run cleans up after itself.** Its `finally` block — so it runs whether the run
passed or threw, since a harness that only tidies on success leaves its worst runs behind — calls
`scripts/db-cleanup-e2e.ts --prefix=zz-desk-`. That script deletes by id in explicit foreign-key
order inside one transaction, refuses any prefix that is not in `scripts/test-prefixes.ts`, and
refuses to delete a conversation containing anyone who is not a test user (keeping the test users
in it too, since the `User → ConversationMember` cascade would otherwise remove them from somebody
else's history). It works by prefix rather than by the run's own ids, so it also clears anything a
previously interrupted run left behind. `npm run db:audit` remains the independent check and still
reports residue — and its totals are now counted rather than inferred from a list capped at 50.

Development:

```bash
npm run dev                                        # the company server
set DESKTOP_SERVER_URL=http://192.168.29.244:3000  # or leave unset for localhost:3000
npm run desktop:dev
```

## 17. Installer

`npm run desktop:package:win` produces, in `release/`:

- `Rising Path Recruiters Chat Setup <version>.exe` — the primary deliverable
- `Rising Path Recruiters Chat <version> Portable.exe` — for testing

Per-user by default, so **no administrator rights and no UAC prompt**; a machine-wide install is
still offered by the installer. Start Menu entry and desktop shortcut, proper uninstall, and the
application profile deliberately preserved across uninstall and reinstall.

> **The installer is unsigned.** Windows SmartScreen will warn on first run — "Windows protected
> your PC" — until a code-signing certificate is bought and configured. This is expected during
> development and testing. Signing is a configuration change to `build.win`, not a code change.

## 18. Icons

Generated by `scripts/desktop-assets.mjs` from `public/brand/rising-path-mark.png` — **the exact
existing asset**. Nothing draws, redraws or recolours the logo: the script decodes that one PNG,
box-filters it down to 16/24/32/48/64/128/256, and repacks the results as PNG-in-ICO. Averaging
rather than sampling, because a logo reduced by picking one pixel in five loses its thin strokes and
comes out ragged at 16px, which is the size seen most often.

It is hand-written rather than a dependency: the alternative is `sharp`, a native module with a
platform-specific binary, pulled in for a file that changes when the company rebrands. Node's own
`zlib` does the only hard part. `desktop/assets/` is therefore build output and git-ignored.

## 19. Updates

**No auto-updater.** For V1 an administrator installs a new build over the old one; the profile,
and therefore the enrollment, survives. Future options, when they are wanted: `electron-updater`
against a file share or an internal HTTP endpoint — neither needs cloud hosting, and both need code
signing to be worth having.

## 20. What was deliberately not added

No employee logout. No switch-user. No name editing. No admin controls in the EXE. No auto-updater.
No second database. No change to Device, Session or User. No IP-based workstation identity — the
rolled-back Phase 8.5 experiment stays rolled back.
