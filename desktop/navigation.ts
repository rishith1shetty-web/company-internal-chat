/**
 * What the desktop window is allowed to load, and what happens to everything else.
 *
 * TWO SEPARATE JOBS, and it is worth being clear which is which, because conflating them is how
 * client-side "security" gets overstated:
 *
 *   1. A REAL BOUNDARY. The renderer must never navigate to another origin, and never to a
 *      scheme like file:, data: or javascript:. That is a containment property of this process
 *      and it is enforced here because nothing else can enforce it.
 *
 *   2. A UI BOUNDARY. /admin is kept out of the employee client (§6). This is NOT what protects
 *      the admin surface — `/api/admin/*` refuses without a valid admin cookie, and it would
 *      refuse this window exactly as it refuses anybody else's browser (lib/auth/admin.ts). This
 *      is a product decision: the employee application has no administration in it, so an
 *      accidental link or a stray redirect lands somewhere sensible instead of on a sign-in form
 *      the employee cannot use. Removing this file would not grant anybody a single privilege.
 *
 * The decision is a pure function of a URL string and the configured origin. Every branch below
 * is a test in tests/desktop/navigation.test.ts, which is the point of keeping it out of main.ts.
 */

/** Where a navigation may go. */
export type NavigationAction =
  /** Load it in the application window. */
  | 'allow'
  /** Hand it to the Windows default browser. Only ever http(s) to another origin. */
  | 'external'
  /** Refuse it, and stay where we are. */
  | 'block';

export type BlockReason =
  /** An administration path. Employee clients do not show these (§6). */
  | 'admin'
  /** A scheme that is not http(s) — file:, data:, javascript:, or a custom handler. */
  | 'scheme'
  /** Unparseable. */
  | 'malformed';

export interface NavigationDecision {
  action: NavigationAction;
  reason?: BlockReason;
}

const ALLOW: NavigationDecision = { action: 'allow' };
const EXTERNAL: NavigationDecision = { action: 'external' };

/**
 * Paths the employee client will not open.
 *
 * Prefix-matched on a normalised path, so `/admin`, `/admin/`, `/admin/devices` and
 * `/api/admin/devices` are all covered while a legitimate path that merely starts with the same
 * letters — `/administration-policy`, were it ever to exist — is not.
 */
const ADMIN_PREFIXES = ['/admin', '/api/admin'] as const;

export function isAdminPath(pathname: string): boolean {
  /*
   * Percent-encoding is decoded before the comparison. `/%61dmin` is `/admin` to the server, and
   * a check that compared the raw string would wave it through — the classic way a path filter
   * is defeated. A malformed encoding cannot be decoded and is treated as suspicious.
   */
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true;
  }

  // Backslashes are separators on Windows and are normalised by some parsers; fold them so
  // `/admin\devices` cannot read as an ordinary path segment. Repeated slashes collapse too.
  const normalised = path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();

  return ADMIN_PREFIXES.some(
    (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`),
  );
}

/**
 * Decides what to do with a navigation request.
 *
 * @param target       The URL the renderer wants to go to.
 * @param serverOrigin The configured company server origin, e.g. 'https://chat.example.local'.
 * @param localFileUrl The application's own offline page, which is a file: URL and must load.
 */
export function decideNavigation(
  target: string,
  serverOrigin: string,
  localFileUrl?: string | undefined,
): NavigationDecision {
  /*
   * The offline screen is a file: URL this process loaded itself, compared in full rather than
   * by scheme. Allowing file: as a class would mean any file on the employee's disk could be
   * rendered inside the application, which is the exact hole the scheme rule exists to close.
   */
  if (localFileUrl && target === localFileUrl) return ALLOW;

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { action: 'block', reason: 'malformed' };
  }

  // Anything that is not the web. javascript:, data:, file:, blob:, ms-settings:, and every
  // custom protocol handler an installed application might have registered.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'block', reason: 'scheme' };
  }

  if (url.origin !== serverOrigin) {
    // Another web site. Not loaded here — handed to the default browser, where the employee has
    // their bookmarks, their extensions and a visible address bar (§19).
    return EXTERNAL;
  }

  if (isAdminPath(url.pathname)) {
    return { action: 'block', reason: 'admin' };
  }

  return ALLOW;
}

/**
 * Whether a URL may be handed to the Windows shell to open.
 *
 * Separate from `decideNavigation` because it answers a different question with a different cost
 * of being wrong: this hands a string to the operating system, so it is an allow-list of exactly
 * two protocols and nothing else. `shell.openExternal` will happily launch a registered handler
 * for a custom scheme, which is a way to start a program from a link.
 */
export function isSafeExternalUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The path the window should return to when an administration URL is refused.
 *
 * Chat, not /setup: a client that has reached /admin is one that already has an identity, and
 * bouncing it to enrollment would be alarming and wrong.
 */
export function fallbackPathFor(reason: BlockReason | undefined): string {
  void reason;
  return '/';
}
