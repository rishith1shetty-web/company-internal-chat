/**
 * The bridge between the company chat page and the desktop application.
 *
 * THE SIZE OF THIS FILE IS THE POINT. A preload script runs with access to Node in a context the
 * page can reach, so every function exposed here is permanently part of the attack surface of the
 * renderer. What is exposed is therefore the smallest set that makes native Windows notifications
 * and the offline screen work, and nothing else: no filesystem, no child process, no shell, no
 * `ipcRenderer` itself, no generic "invoke any channel" escape hatch (CLAUDE.md §20, §3 of the
 * desktop brief).
 *
 * Nothing here can read or write company data. Notifications carry text the page already had;
 * `reload` does what `location.reload()` does; `connectionInfo` returns the address this window is
 * already pointed at. There is deliberately no method that returns a cookie, a token, a path or a
 * setting — a bridge that could would be a way to lift the session out of the browser sandbox.
 *
 * `contextBridge` rather than assignment to `window`: with `contextIsolation: true` the page and
 * the preload run in separate JavaScript worlds, and only values passed through the bridge cross.
 * The page therefore receives plain data and functions, never a live reference to anything of
 * ours it could walk back to `require`.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  CHANNELS as MainProcessChannels,
  DesktopConnectionInfo,
  DesktopNotifyPayload,
} from './ipc';

export type { DesktopConnectionInfo, DesktopNotifyPayload };

/**
 * The channel names, written out here rather than imported — and that is a constraint, not a
 * preference.
 *
 * A SANDBOXED PRELOAD CANNOT REQUIRE ITS OWN FILES. With `sandbox: true` the preload runs inside
 * Electron's sandbox bundle, where `require` resolves only a short list of built-ins (`electron`,
 * `events`, `timers`, `url`) and nothing else. A relative import fails at load with "module not
 * found", the whole preload is dropped, and the page silently comes up with no bridge on it —
 * which is precisely what happened before this comment was written. Bundling the preload would be
 * the other way out, at the cost of a build tool for one file.
 *
 * So the constant is duplicated, and the duplication is made safe below rather than left to
 * discipline: the two assignments are type-only, erased at compile time, and fail `npm run
 * typecheck` the moment these names stop matching desktop/ipc.ts in either direction. A channel
 * that drifts is a message sent into nothing, so it is worth catching at build time.
 */
const CHANNELS = {
  notify: 'desktop:notify',
  closeNotification: 'desktop:notification-close',
  notificationClicked: 'desktop:notification-clicked',
  reload: 'desktop:reload',
  connectionInfo: 'desktop:connection-info',
} as const;

/** Every channel this file declares exists in the main process's list, with the same value. */
const _channelsAreDeclared: typeof MainProcessChannels = CHANNELS;
/** And every channel the main process declares exists here. Together: the two lists are equal. */
const _channelsAreComplete: typeof CHANNELS = null as unknown as typeof MainProcessChannels;
void _channelsAreDeclared;
void _channelsAreComplete;

/** The whole of what the page can see. */
export interface RisingPathDesktopBridge {
  readonly isDesktop: true;
  /** Shows a native Windows notification. Fire and forget. */
  notify(payload: DesktopNotifyPayload): void;
  /** Dismisses one previously shown by id. */
  closeNotification(id: string): void;
  /** Subscribes to notification clicks. Returns the unsubscribe. */
  onNotificationClick(handler: (id: string) => void): () => void;
  /** Asks the window to load the company server again. Used by the offline screen. */
  reload(): void;
  /** What the offline screen needs to explain itself. */
  connectionInfo(): Promise<DesktopConnectionInfo>;
}

/**
 * Copies the payload field by field into a fresh object of known shape.
 *
 * Passing the page's object straight to `ipcRenderer` would send whatever else it happens to
 * carry — including things that fail to serialise — and would let the page choose the shape of a
 * message the main process is about to act on. Rebuilding it means only these five fields ever
 * leave the renderer, whatever the caller passed.
 */
function toPayload(value: unknown): DesktopNotifyPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;

  const text = (input: unknown): string => (typeof input === 'string' ? input : '');
  const id = text(source.id);
  if (id.length === 0) return null;

  return {
    id,
    title: text(source.title),
    body: text(source.body),
    tag: text(source.tag),
    silent: source.silent === true,
  };
}

const bridge: RisingPathDesktopBridge = {
  isDesktop: true,

  notify(payload) {
    const safe = toPayload(payload);
    if (safe) ipcRenderer.send(CHANNELS.notify, safe);
  },

  closeNotification(id) {
    if (typeof id === 'string' && id.length > 0) {
      ipcRenderer.send(CHANNELS.closeNotification, id);
    }
  },

  onNotificationClick(handler) {
    if (typeof handler !== 'function') return () => {};

    /*
     * The Electron event object is deliberately not forwarded. It carries `sender` and other
     * live references, and handing those to the page would undo context isolation in one line —
     * the page would hold a real IPC port rather than the narrow function it was given.
     */
    const listener = (_event: unknown, id: unknown): void => {
      if (typeof id === 'string') handler(id);
    };

    ipcRenderer.on(CHANNELS.notificationClicked, listener);
    return () => {
      ipcRenderer.removeListener(CHANNELS.notificationClicked, listener);
    };
  },

  reload() {
    ipcRenderer.send(CHANNELS.reload);
  },

  connectionInfo() {
    return ipcRenderer.invoke(CHANNELS.connectionInfo) as Promise<DesktopConnectionInfo>;
  },
};

contextBridge.exposeInMainWorld('risingPathDesktop', bridge);
