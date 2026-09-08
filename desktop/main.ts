/**
 * Rising Path Recruiters Chat — the Windows desktop client.
 *
 * WHAT THIS PROCESS IS. A window, a tray icon, and a set of rules about where that window is
 * allowed to go. It is a thin client in the strict sense: it holds no database, no credentials,
 * no business logic and no copy of the application. It loads the real page from the real company
 * server, and everything an employee sees is served by that server exactly as it is to a browser.
 *
 * WHY IT LOADS A REMOTE URL RATHER THAN BUNDLING THE APP. The chat client opens its socket with
 * `io({ path })` and no host (lib/chat/socket.ts) — same origin, deliberately, so that one
 * process serves both transports and the session cookie applies to each without CORS (D-09). A
 * bundled `file://` renderer would have no origin to share and would need a second, weaker
 * authentication path invented for it. Loading the server's own page means the cookies, the
 * Phase 8 network gate, the upload route and the download route all behave here precisely as
 * they do in Chrome, with nothing re-implemented and nothing to keep in step.
 *
 * WHAT THE DESKTOP CLIENT ADDS, and it is a short list:
 *
 *   1. ONE PROFILE PER COMPUTER. A named persistent partition, so the enrollment an administrator
 *      performs once is the enrollment the machine keeps — the browser-profile proliferation this
 *      application was built to avoid (§9).
 *   2. NATIVE WINDOWS NOTIFICATIONS, shown by this process rather than by the page. The decisive
 *      reason is the tray: a notification click has to bring back a window that may be hidden,
 *      and a renderer cannot show a hidden BrowserWindow — only this side can. The session's
 *      deny-all permission handler also refuses the renderer's own Notification API, and the
 *      application icon and identity on the toast come from here (desktop/notifications.ts).
 *   3. A TRAY. Closing the window keeps the socket open, which is what makes a chat client behave
 *      like a chat client rather than a web page.
 *   4. NAVIGATION RULES. One origin, two protocols, no administration surface (§6, §19).
 *
 * WHAT IT DOES NOT ADD, and must not: any relaxation of the server's checks. The network gate,
 * the membership checks, the admin token and the download authorization are all still the
 * server's, and this process cannot and does not weaken any of them (§17).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  ipcMain,
  nativeImage,
  session,
  shell,
  type Session,
} from 'electron';

import {
  DEFAULT_SERVER_URL,
  DEVICE_COOKIE_NAME,
  PACKAGED_CONFIG_FILENAME,
  SERVER_CONFIG_FILENAME,
  ServerUrlError,
  readServerUrlFromConfig,
  resolveServerUrl,
  startPathFor,
  type ResolvedServerUrl,
} from './config';
import { safeDownloadName } from './downloads';
import { decideNavigation, isSafeExternalUrl } from './navigation';
import { CHANNELS } from './ipc';
import { sanitizeNotificationRequest } from './notifications';

/** Shown in the title bar, the taskbar, the tray tooltip and the installer. */
const APP_NAME = 'Rising Path Recruiters Chat';

/**
 * The single persistent profile (§9).
 *
 * `persist:` is what makes it survive a restart — a partition without that prefix is in-memory
 * and would hand the employee a fresh, unenrolled browser on every launch, which is the exact
 * failure this application exists to prevent. The name is fixed and never generated, so
 * reinstalling the client finds the same enrollment (§24).
 */
const PARTITION = 'persist:rising-path-chat';

/** Windows needs this to attribute toasts to the application rather than to "Electron". */
const APP_USER_MODEL_ID = 'com.risingpathrecruiters.chat';

const MIN_WIDTH = 940;
const MIN_HEIGHT = 600;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;

const isPackaged = app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ResolvedServerUrl | null = null;
let startupError: string | null = null;
/** Set by the tray's Quit item, so `close` can tell "hide me" from "actually exit". */
let quitting = false;
/** The last load failure, in words an employee can read. Never a code, a path or a stack. */
let lastFailure = '';

/** Live native notifications, so a click can be routed and a replacement can close the old one. */
const liveNotifications = new Map<string, Notification>();

/** Assets and the offline page sit beside the compiled output. */
const resourcePath = (...parts: string[]): string => join(__dirname, ...parts);

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

/**
 * Reads `serverUrl` from server.json in the Electron user-data directory.
 *
 * Absent is the normal state on a development machine, so it is not an error. Unreadable or
 * malformed JSON is reported and then ignored, which leaves the environment variable and the
 * default to answer — an operator who mistyped the JSON gets a line in the log rather than an
 * application that will not start.
 */
function readConfigFile(): string | undefined {
  const path = join(app.getPath('userData'), SERVER_CONFIG_FILENAME);
  if (!existsSync(path)) return undefined;

  try {
    return readServerUrlFromConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    console.warn(`[desktop] ${SERVER_CONFIG_FILENAME} could not be read; ignoring it.`);
    return undefined;
  }
}

/** Optional per-installation flags that live alongside `serverUrl`. */
/**
 * The address baked in when this package was built, if any.
 *
 * Sits beside `main.js` — inside the asar on a packaged install, in `dist-desktop/` when running
 * from source — and is written by `scripts/desktop-assets.mjs` from DESKTOP_SERVER_URL at build
 * time. Absent is the normal state for a build made without one, and simply means the client falls
 * through to the loopback default.
 */
function readPackagedServerUrl(): string | undefined {
  const path = resourcePath(PACKAGED_CONFIG_FILENAME);
  if (!existsSync(path)) return undefined;

  try {
    return readServerUrlFromConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    // Build output this application wrote itself; if it is unreadable something is wrong with the
    // package, and falling through is better than refusing to start.
    console.warn(`[desktop] ${PACKAGED_CONFIG_FILENAME} could not be read; ignoring it.`);
    return undefined;
  }
}

function readConfigFlag(name: string): boolean {
  const path = join(app.getPath('userData'), SERVER_CONFIG_FILENAME);
  if (!existsSync(path)) return false;

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    return (parsed as Record<string, unknown>)[name] === true;
  } catch {
    return false;
  }
}

/**
 * Works out where to connect, and records the reason if it cannot.
 *
 * A configuration error does not prevent the window from opening: the employee gets the branded
 * screen explaining that the client is not configured, which is far more useful than a process
 * that exits before anything is drawn (§16).
 */
function loadServerConfiguration(): void {
  try {
    server = resolveServerUrl({
      env: process.env.DESKTOP_SERVER_URL,
      file: readConfigFile(),
      packaged: readPackagedServerUrl(),
    });

    console.log(`[desktop] Company server: ${server.url} (from ${server.source})`);

    if (server.insecure) {
      // Said once, at startup, because it is a deployment fact rather than a running problem.
      // TLS is the Phase 10 answer; nothing here disables or works around certificate checks.
      console.warn(
        '[desktop] Connecting over plain HTTP. Use HTTPS for production (docs/18-desktop-client.md).',
      );
    }
  } catch (error) {
    server = null;
    startupError =
      error instanceof ServerUrlError
        ? error.message
        : 'The company server address is not configured correctly.';
    console.error(`[desktop] ${startupError}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------------

function appIcon(): Electron.NativeImage | undefined {
  const icoPath = resourcePath('assets', 'icon.ico');
  if (!existsSync(icoPath)) return undefined;

  const image = nativeImage.createFromPath(icoPath);
  return image.isEmpty() ? undefined : image;
}

function createWindow(): BrowserWindow {
  const icon = appIcon();

  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: APP_NAME,
    // A normal Windows title bar: minimise, maximise, restore and close behave as every other
    // application on the machine does. A custom frame would be a cosmetic choice paid for in
    // accessibility and in snap/dock behaviour that people rely on without noticing (§5).
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    // Draw nothing until there is something to draw, rather than flashing an empty frame.
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: resourcePath('preload.js'),
      /*
       * The three that matter, and they are not defaults worth relying on implicitly (§3):
       *   contextIsolation  — the page and the preload run in separate worlds.
       *   nodeIntegration   — the page has no `require`, no `process`, no `Buffer`.
       *   sandbox           — the renderer runs in the OS sandbox, as a browser tab does.
       * Together these mean a compromise of the page is a compromise of a web page, not of the
       * employee's computer.
       */
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No <webview>: an embedded frame with its own preferences is a way around all of the above.
      webviewTag: false,
      // Same-origin policy and the rest of Chromium's protections, left on.
      webSecurity: true,
      /*
       * The one non-default here, and the reason for it is the whole point of the tray.
       *
       * Chromium throttles timers in hidden windows to about one tick a minute. With the window
       * minimised to the tray — the state this client is designed to sit in — that would slow the
       * socket's heartbeat and delay exactly the notifications that were the reason for the
       * desktop application (§11, §13).
       */
      backgroundThrottling: false,
      partition: PARTITION,
      // DevTools are a development affordance; a packaged employee client has no use for them.
      devTools: !isPackaged,
      spellcheck: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  applyNavigationRules(window);
  applyWindowChrome(window);

  /*
   * Closing the window hides it (§11).
   *
   * The socket stays open and notifications keep arriving, which is what an employee expects
   * from a chat application — the X means "get this off my screen", not "sign out". Quitting is
   * the tray's Quit item, and that sets `quitting` so this handler stands aside.
   */
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();

    /*
     * Commit cookies to disk at the moment the employee puts the window away.
     *
     * Chromium's cookie store writes on a timer, so a machine that loses power — or is switched
     * off at the wall at the end of the day, which is what actually happens — can lose a cookie
     * written minutes earlier. For an ordinary web session that costs a sign-in; here it would
     * cost the computer's ENROLLMENT, and an administrator would have to visit the desk again
     * with a new setup code. Flushing here and on quit makes that window as small as it can be.
     */
    void window.webContents.session.flushStorageData();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

/** Menu bar, zoom and the accidental-DevTools shortcuts (§23). */
function applyWindowChrome(window: BrowserWindow): void {
  /*
   * No application menu in the packaged client.
   *
   * Electron's default menu carries Reload, Force Reload and Toggle Developer Tools, which are
   * browser controls rather than chat controls (§5). Removing it is a tidiness measure and is
   * explicitly NOT a security boundary — the sandbox and the navigation rules are.
   */
  if (isPackaged) {
    Menu.setApplicationMenu(null);
  }

  window.webContents.on('before-input-event', (event, input) => {
    if (!isPackaged) return;

    const key = input.key.toLowerCase();
    const opensDevTools =
      key === 'f12' || (input.control && input.shift && (key === 'i' || key === 'j' || key === 'c'));

    if (opensDevTools) event.preventDefault();
  });

  // The page is a fixed layout served by the company server; pinch-zoom leaves it looking broken
  // and there is no address bar to reset it from.
  void window.webContents.setVisualZoomLevelLimits(1, 1);
}

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

function offlineFileUrl(): string {
  return `file:///${resourcePath('offline.html').replace(/\\/g, '/')}`;
}

/**
 * Applies the navigation policy to a window.
 *
 * Three hooks, because there are three ways a renderer can try to leave: following a link
 * (`will-navigate`), being redirected mid-flight (`will-redirect`), and opening a new window
 * (`setWindowOpenHandler`). Missing any one of them leaves the rule half-enforced.
 */
function applyNavigationRules(window: BrowserWindow): void {
  const origin = server?.origin ?? '';
  const localFile = offlineFileUrl();

  const handle = (event: { preventDefault(): void }, target: string): void => {
    const decision = decideNavigation(target, origin, localFile);

    if (decision.action === 'allow') return;

    event.preventDefault();

    if (decision.action === 'external') {
      openExternally(target);
      return;
    }

    if (decision.reason === 'admin') {
      /*
       * The employee client has no administration in it (§6).
       *
       * This is a product boundary, not the protection: `/api/admin/*` refuses without a valid
       * admin cookie and would refuse this window as readily as anybody's browser. What this
       * does is keep a stray link or redirect from parking an employee on a sign-in form they
       * cannot use — so it returns them to chat instead.
       */
      console.warn('[desktop] Administration is not available in the employee client.');
      returnToChat();
      return;
    }

    console.warn('[desktop] Blocked navigation to an unsupported address.');
  };

  window.webContents.on('will-navigate', (event, url) => handle(event, url));
  window.webContents.on('will-redirect', (event, url) => handle(event, url));

  /*
   * No popups, ever. `target="_blank"` and `window.open` are answered by handing the URL to the
   * default browser when it is an ordinary web address, and by refusal otherwise. A new
   * BrowserWindow would inherit this window's session and open without any of the chrome that
   * tells somebody where they are (§19).
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation(url, origin, localFile);

    if (decision.action === 'external') openExternally(url);
    else if (decision.action === 'allow') void window.loadURL(url);

    return { action: 'deny' };
  });

  window.webContents.on('did-fail-load', (_event, errorCode, _description, failingUrl, isMainFrame) => {
    // Only a failure of the page itself is worth a screen. A sub-resource that did not load, or
    // a navigation the renderer cancelled itself (-3), is not.
    if (!isMainFrame || errorCode === -3) return;
    if (failingUrl.startsWith('file://')) return;

    showOfflineScreen('The company chat server did not respond.');
  });
}

/** Hands a URL to the Windows default browser, after checking it is a web address (§19). */
function openExternally(target: string): void {
  if (!isSafeExternalUrl(target)) {
    console.warn('[desktop] Refused to open a link that is not a web address.');
    return;
  }

  void shell.openExternal(target).catch(() => {
    console.warn('[desktop] Windows could not open that link.');
  });
}

/** Loads the company server. The one place the window is pointed anywhere. */
/**
 * Is this profile holding a device cookie — i.e. has this computer ever been enrolled?
 *
 * Read from the persistent partition rather than asked of the server, so the answer is available
 * before the network is, and a slow or unreachable server cannot turn an enrolled machine into an
 * unenrolled-looking one.
 */
async function hasDeviceCookie(origin: string): Promise<boolean> {
  try {
    const cookies = await session
      .fromPartition(PARTITION)
      .cookies.get({ url: origin, name: DEVICE_COOKIE_NAME });
    return cookies.length > 0;
  } catch {
    // Unreadable cookie store: assume enrolled, so a transient failure sends nobody to a setup
    // screen they do not need. A genuinely unenrolled machine still shows the "not set up yet"
    // screen, which now carries the button that gets an administrator to setup by hand.
    return true;
  }
}

/**
 * Loads the company server, opening on setup when this computer has never been enrolled.
 *
 * WHY THE DECISION IS HERE and not in the web application: `/setup` is deliberately unreachable
 * from the employee interface (docs/12-admin-device-identity.md — nothing links to it, so that a
 * setup mechanism does not become something employees ask each other for). In a browser that is
 * right and stays right; an administrator simply types the URL. The desktop client has no address
 * bar, so without this there is no route to enrollment at all — which is the bug this fixes.
 *
 * Deciding it in the main process keeps the browser's behaviour exactly as designed: the web
 * application is unchanged and still links nowhere near setup.
 */
function loadServer(): void {
  if (!mainWindow) return;

  if (!server) {
    showOfflineScreen(startupError ?? 'The company server address is not configured.');
    return;
  }

  const target = server;

  void (async () => {
    const path = startPathFor(await hasDeviceCookie(target.origin));

    if (path === '/setup') {
      console.log('[desktop] This computer is not enrolled yet; opening setup.');
    }

    // `mainWindow` is re-read after the await: the window can be gone by the time this resolves.
    await mainWindow?.loadURL(`${target.url}${path === '/' ? '' : path}`).catch(() => {
      // `did-fail-load` has already drawn the offline screen; this only stops an unhandled
      // rejection reaching the process.
    });
  })();
}

function returnToChat(): void {
  loadServer();
}

/** Replaces the window contents with the branded offline screen (§16). */
function showOfflineScreen(message: string): void {
  if (!mainWindow) return;

  lastFailure = message;
  void mainWindow.loadFile(resourcePath('offline.html')).catch(() => {
    // If even the local file will not load there is nothing further to try; the window stays
    // where it is rather than the process exiting under the employee.
  });
}

// ---------------------------------------------------------------------------------------------
// Session hardening
// ---------------------------------------------------------------------------------------------

/**
 * Locks down the persistent session (§3, §21).
 *
 * Applied to the partition rather than to a window, so it holds for anything that ever uses it.
 */
function hardenSession(target: Session): void {
  /*
   * Refuse every browser permission.
   *
   * The chat application asks for none of them: notifications go through the main process
   * (desktop/notifications.ts), and there is no camera, microphone, location, MIDI or USB
   * feature anywhere in it. Denying by default means a future page — or a compromised one —
   * cannot prompt an employee for hardware access inside a window that looks like a company
   * application.
   */
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);

  /*
   * Downloads (§21).
   *
   * The server has already decided that this employee may have this file and what it is called;
   * the filename is sanitised again here because it is about to become a Windows path, and a
   * separator or a reserved device name in it is this process's problem to catch.
   *
   * The save dialog is left to Chromium, so the employee chooses the folder as they would in a
   * browser. Nothing is opened afterwards: a downloaded file is never executed, launched or
   * handed to the shell by this application.
   */
  target.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ title: 'Save attachment', defaultPath: safeDownloadName(item.getFilename()) });

    item.once('done', (_doneEvent, state) => {
      if (state !== 'completed') {
        console.warn('[desktop] A download did not complete.');
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

/**
 * Shows a native Windows notification on behalf of the page.
 *
 * The page decided *whether* to notify — that is lib/notifications/policy.ts, and it is the same
 * decision in a browser and here. This end only renders it, and re-validates the text first
 * because a renderer's word is not something the main process can take (desktop/notifications.ts).
 */
function showNativeNotification(payload: unknown): void {
  if (!Notification.isSupported()) return;

  if (typeof payload !== 'object' || payload === null) return;
  const id = (payload as Record<string, unknown>).id;
  if (typeof id !== 'string' || id.length === 0) return;

  const request = sanitizeNotificationRequest(payload);
  if (!request) return;

  /*
   * One popup per conversation. The page tags by conversation id, so a second message replaces
   * the first rather than stacking a pile of toasts for one busy group — and Windows has no
   * `tag` of its own, so the replacement is done here by closing the previous one.
   */
  if (request.tag) {
    for (const [existingId, existing] of liveNotifications) {
      if (existingId.startsWith(`${request.tag}:`)) {
        existing.close();
        liveNotifications.delete(existingId);
      }
    }
  }

  const key = `${request.tag}:${id}`;
  const notification = new Notification({
    title: request.title,
    body: request.body,
    // The page plays its own chime, and letting Windows add a second one is two sounds a message.
    silent: request.silent,
    ...(existsSync(resourcePath('assets', 'icon.ico'))
      ? { icon: resourcePath('assets', 'icon.ico') }
      : {}),
  });

  notification.on('click', () => {
    // Bring the application back first — it may be hidden in the tray — then tell the page which
    // popup was clicked so it can open that conversation (§13).
    revealWindow();
    mainWindow?.webContents.send(CHANNELS.notificationClicked, id);
    liveNotifications.delete(key);
  });

  notification.on('close', () => liveNotifications.delete(key));

  liveNotifications.set(key, notification);
  notification.show();
}

// ---------------------------------------------------------------------------------------------
// Tray, window restoration and single instance
// ---------------------------------------------------------------------------------------------

/** Shows, restores and focuses the window, whatever state it was in. */
function revealWindow(): void {
  if (!mainWindow) {
    mainWindow = createWindow();
    loadServer();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  const icon = appIcon();
  if (!icon) {
    // Without an icon there is nothing to click, so the window simply stays a normal window and
    // closing it quits. Said out loud rather than failing silently.
    console.warn('[desktop] Tray icon asset missing; the tray will not be created.');
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: () => revealWindow() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );

  // Double-click is what people try first on Windows; single click is what they try second.
  tray.on('click', () => revealWindow());
  tray.on('double-click', () => revealWindow());
}

// ---------------------------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------------------------

/**
 * One instance per Windows user (§12).
 *
 * Two copies would mean two sockets, two sets of notifications for one message, and — worse —
 * two windows an employee could believe were different accounts. The second launch hands its
 * arguments to the first and exits; the first brings its window forward.
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => revealWindow());

  // Must be set before any window exists, or Windows attributes toasts to "Electron".
  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.setName(APP_NAME);

  void app.whenReady().then(() => {
    loadServerConfiguration();
    hardenSession(session.fromPartition(PARTITION));
    registerIpc();
    applyStartupPreference();

    mainWindow = createWindow();
    loadServer();
    createTray();
  });

  /*
   * Windows only, and deliberately empty of the usual macOS `activate` handling: the window is
   * hidden rather than closed, so there is nothing to recreate. Quitting happens through the
   * tray, and `window-all-closed` must therefore NOT quit — that would defeat the tray entirely.
   */
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    // The enrollment must survive the quit. See the note on the window's `close` handler.
    try {
      session.fromPartition(PARTITION).flushStorageData();
    } catch {
      // Nothing useful to do while exiting, and an error here must not prevent the exit.
    }
  });

  /*
   * Certificate errors are never overridden (§18).
   *
   * There is no `ignore-certificate-errors` switch, no `setCertificateVerifyProc` that returns 0,
   * and no handler for `certificate-error` — which means Electron's default applies and a bad
   * certificate fails the load. An employee then sees the offline screen. That is the correct
   * outcome: a client that accepted any certificate would make the eventual HTTPS deployment
   * worse than the HTTP one it replaced.
   */
}

/** Optional launch at sign-in (§15). Off unless an administrator turns it on in server.json. */
function applyStartupPreference(): void {
  const openAtLogin = readConfigFlag('launchAtStartup');

  // Written on every launch so that turning the flag off in the file actually removes the entry,
  // rather than leaving one behind that nothing owns any more.
  app.setLoginItemSettings({ openAtLogin, name: APP_NAME });

  if (openAtLogin) console.log('[desktop] Launch at Windows sign-in is enabled.');
}

/**
 * Is this IPC message from the window we created?
 *
 * The navigation rules already stop this window loading anything but the company server and the
 * bundled offline page, `webviewTag` is off, and `setWindowOpenHandler` denies every request — so
 * there is no second renderer for a message to come from. This is the check that keeps that true
 * rather than assumed: a channel that acts on whatever arrives is a channel that quietly becomes a
 * hole the first time a future edit introduces another `webContents`.
 */
function isTrustedSender(event: { sender: Electron.WebContents }): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
}

function registerIpc(): void {
  ipcMain.on(CHANNELS.notify, (event, payload: unknown) => {
    if (!isTrustedSender(event)) return;
    showNativeNotification(payload);
  });

  ipcMain.on(CHANNELS.closeNotification, (event, id: unknown) => {
    if (!isTrustedSender(event)) return;
    if (typeof id !== 'string') return;
    for (const [key, notification] of liveNotifications) {
      if (key.endsWith(`:${id}`)) {
        notification.close();
        liveNotifications.delete(key);
      }
    }
  });

  ipcMain.on(CHANNELS.reload, (event) => {
    if (!isTrustedSender(event)) return;
    loadServer();
  });

  ipcMain.handle(CHANNELS.connectionInfo, (event) => {
    if (!isTrustedSender(event)) return null;

    return {
      // The address the employee is trying to reach. Shown so somebody can tell IT which server the
      // client is pointed at — it is a LAN address, not a secret, and it is already in the window.
      serverUrl: server?.url ?? DEFAULT_SERVER_URL,
      insecure: server?.insecure ?? false,
      // Deliberately plain language. No error code, no stack, no filesystem path (CLAUDE.md §13).
      message: lastFailure || startupError || '',
    };
  });
}
