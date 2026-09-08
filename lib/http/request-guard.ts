/**
 * Request-shape guards enforced before Next.js sees a request (Phase 9).
 *
 * Three checks that belong at the server rather than in route handlers, for the same reason the
 * network gate does (server.ts): a check written in a handler is a check the next handler can
 * forget, and two of the three need things a `Request` object does not have.
 *
 *   1. **Body size.** A JSON endpoint that reads an unbounded body is a way to spend the server's
 *      memory from one connection. Next.js applies no default limit to route handlers — its
 *      `bodySizeLimit` covers Server Actions only — so until now `POST /api/conversations` would
 *      buffer whatever it was sent.
 *   2. **Cross-site writes.** The identity cookies are `SameSite=Lax`, which already stops a
 *      cross-site form post carrying them. This is the second lock: a request that announces an
 *      `Origin` from somewhere else is refused outright.
 *   3. **Which endpoints are secret-guessing endpoints**, so the rate limiter knows where to
 *      apply which rule.
 *
 * Pure functions, no I/O, no configuration beyond what is passed in — the matching rules are the
 * whole substance of a control like this, and they need to be testable without a server.
 */

/** Largest JSON body any endpoint in this application legitimately receives. */
export const JSON_BODY_LIMIT = 256 * 1024;

/**
 * Largest body for anything that is not a recognised upload.
 *
 * Deliberately small. Every non-upload endpoint here takes a short JSON object; a request that
 * needs more than this is not one this application has.
 */
export const DEFAULT_BODY_LIMIT = JSON_BODY_LIMIT;

/** The one route whose body is a file, bounded by MAX_FILE_SIZE rather than by this module. */
const ATTACHMENT_UPLOAD = /^\/api\/conversations\/[^/]+\/attachments\/?$/;

/** Methods that carry a body worth bounding and are worth refusing cross-site. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isUnsafeMethod(method: string | undefined): boolean {
  return UNSAFE_METHODS.has((method ?? '').toUpperCase());
}

/**
 * Strips the query string and normalises a request target to a comparable path.
 *
 * Percent-decoded first, because `/api/%61dmin` is `/api/admin` to the router and would otherwise
 * be a way past every rule in this file. A target that will not decode is returned as-is: it
 * matches nothing, and nothing here fails open on it.
 */
export function normalisePath(target: string | undefined): string {
  const raw = target ?? '/';
  const withoutQuery = raw.split('?')[0]?.split('#')[0] ?? '/';

  let decoded = withoutQuery;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    // Malformed percent-encoding is attacker-controlled input, not a server error.
  }

  // Collapse repeated separators, so `//api//admin` is the same path to this module as it is to
  // the router.
  const collapsed = decoded.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}

/**
 * The largest body this path may carry, or `null` for "not bounded here".
 *
 * The upload route is the only `null`, and it is not unbounded: `lib/files/storage.ts` counts the
 * bytes as they arrive and aborts the moment they pass `MAX_FILE_SIZE`. Bounding it a second time
 * from a header would mean trusting `Content-Length`, which is a number the sender chose.
 */
export function bodyLimitFor(method: string | undefined, path: string): number | null {
  if (!isUnsafeMethod(method)) return null;
  if (ATTACHMENT_UPLOAD.test(path)) return null;
  return DEFAULT_BODY_LIMIT;
}

/**
 * Does this request's `Origin` agree with the host it was sent to?
 *
 * Returns true when there is no `Origin` header at all. That is not a hole: browsers attach
 * `Origin` to exactly the cross-site requests this check exists to catch, and a client that sends
 * none — curl, a script, the health check — is not a browser being used against its user, which
 * is the entire threat CSRF describes.
 *
 * Compared against `Host` rather than against a configured `APP_URL`. The two are equivalent when
 * the configuration is right, and this one cannot be *wrong*: an operator who mistypes `APP_URL`
 * would otherwise lock every employee out of every write in the application.
 */
export function isSameOriginWrite(
  origin: string | string[] | undefined,
  host: string | string[] | undefined,
): boolean {
  const originValue = single(origin);
  if (originValue === undefined || originValue.length === 0) return true;

  // Some clients send the literal `null` for a privacy-sensitive origin (a sandboxed frame, a
  // `file://` page). That is not this application's own origin, so it is refused.
  if (originValue === 'null') return false;

  const hostValue = single(host);
  if (hostValue === undefined || hostValue.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(originValue);
  } catch {
    return false;
  }

  // `URL.host` keeps a non-default port, which is exactly how the `Host` header is written too,
  // so the two are directly comparable for the ports this application runs on.
  return parsed.host.toLowerCase() === hostValue.trim().toLowerCase();
}

/**
 * The endpoints that answer a guess about a secret, and how hard they may be guessed at.
 *
 * Only these two exist. Everything else in the application requires an identity that a guess
 * cannot produce, so rate limiting it would spend memory to protect nothing — and would risk
 * throttling ordinary work, which is its own kind of outage.
 */
export type GuardedEndpoint = 'admin-sign-in' | 'device-enrollment';

export function guardedEndpointFor(
  method: string | undefined,
  path: string,
): GuardedEndpoint | null {
  if ((method ?? '').toUpperCase() !== 'POST') return null;
  if (path === '/api/admin/session') return 'admin-sign-in';
  if (path === '/api/enroll') return 'device-enrollment';
  return null;
}

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
