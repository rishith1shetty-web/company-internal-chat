/**
 * Where the desktop client connects, and how that value is decided.
 *
 * THE ONE THING THIS FILE MUST NOT DO is bake a company address into the application. The LAN
 * address in use today is a development detail that will be replaced by a hostname over HTTPS,
 * and a build that has it compiled in is a build that has to be reissued when the network
 * changes (CLAUDE.md §7). So the URL is configuration, resolved at startup, and the only
 * compiled-in value is a loopback fallback that is wrong everywhere except a developer's own
 * machine — which is the correct kind of wrong, because it fails visibly rather than silently
 * connecting somewhere unintended.
 *
 * RESOLUTION ORDER, highest first:
 *
 *   1. DESKTOP_SERVER_URL in the environment.
 *        Development, and a machine-wide environment variable set by an administrator.
 *   2. `serverUrl` in server.json, in the Electron user-data directory.
 *        %APPDATA%\Rising Path Recruiters Chat\server.json on a packaged Windows install. This
 *        is the production mechanism: the address is per-installation data, so upgrading the
 *        application does not disturb it and the installer does not have to be rebuilt per site.
 *   3. http://localhost:3000
 *        A developer running the server on the same machine.
 *
 * The resolution is a pure function over values the caller has already read, so every branch —
 * including every way the value can be malformed — is testable without a filesystem or an
 * Electron process.
 */

/** Where a resolved URL came from. Reported at startup so an operator can see which won. */
export type ServerUrlSource = 'environment' | 'config-file' | 'default';

export interface ServerUrlSources {
  /** DESKTOP_SERVER_URL, as read from the environment. */
  env?: string | undefined;
  /** `serverUrl` as read from server.json, or undefined when the file is absent or unreadable. */
  file?: string | undefined;
}

export interface ResolvedServerUrl {
  /** Origin only, no trailing slash: 'http://192.168.1.10:3000'. What the window loads. */
  url: string;
  origin: string;
  source: ServerUrlSource;
  /** True for http: on anything but loopback — allowed, but said out loud (§18). */
  insecure: boolean;
}

export class ServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerUrlError';
  }
}

/** The fallback. Loopback, so it can never accidentally point at somebody else's server. */
export const DEFAULT_SERVER_URL = 'http://localhost:3000';

/** The file an administrator edits on a packaged installation. */
export const SERVER_CONFIG_FILENAME = 'server.json';

/** Only these two. A desktop client that would load file: or data: is a remote-code problem. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/**
 * Validates one candidate URL and reduces it to an origin.
 *
 * Throws `ServerUrlError` with a message written for whoever has to fix it, because this is the
 * text that ends up on the configuration screen when an installation is set up wrongly.
 */
export function parseServerUrl(raw: unknown): { url: string; origin: string; insecure: boolean } {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ServerUrlError('The company server address is empty.');
  }

  const value = raw.trim();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServerUrlError(
      `"${value}" is not a valid address. Use the form http://server:3000 or https://chat.example.local`,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ServerUrlError(
      `"${parsed.protocol}" is not supported. The company server address must start with http:// or https://`,
    );
  }

  if (parsed.hostname.length === 0) {
    throw new ServerUrlError(`"${value}" has no server name in it.`);
  }

  /*
   * Credentials in the URL are refused rather than stripped.
   *
   * A username and password embedded in a server address would be written into a plain-text
   * configuration file and passed through the window's load call — and this application does not
   * authenticate that way at all, so anything of that shape is a mistake worth stopping on
   * (CLAUDE.md §22).
   */
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ServerUrlError('The company server address must not contain a username or password.');
  }

  return {
    url: parsed.origin,
    origin: parsed.origin,
    insecure: parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname),
  };
}

/**
 * Picks the server URL from the available sources, highest priority first.
 *
 * A source that is present but invalid is an error rather than a reason to fall through to the
 * next one: an administrator who mistyped the address in server.json needs to be told, not
 * quietly connected to localhost where nothing will be found.
 */
export function resolveServerUrl(sources: ServerUrlSources = {}): ResolvedServerUrl {
  const candidates: { value: string; source: ServerUrlSource }[] = [];

  if (typeof sources.env === 'string' && sources.env.trim().length > 0) {
    candidates.push({ value: sources.env, source: 'environment' });
  }
  if (typeof sources.file === 'string' && sources.file.trim().length > 0) {
    candidates.push({ value: sources.file, source: 'config-file' });
  }
  candidates.push({ value: DEFAULT_SERVER_URL, source: 'default' });

  const chosen = candidates[0];
  if (!chosen) throw new ServerUrlError('The company server address is empty.');

  const parsed = parseServerUrl(chosen.value);
  return { ...parsed, source: chosen.source };
}

/**
 * Reads `serverUrl` out of the parsed contents of server.json.
 *
 * Deliberately tolerant of a missing or malformed file — an absent file is the normal state on a
 * development machine — but not of a present-and-wrong value, which `resolveServerUrl` will
 * reject above.
 */
export function readServerUrlFromConfig(contents: unknown): string | undefined {
  if (typeof contents !== 'object' || contents === null) return undefined;
  const value = (contents as Record<string, unknown>).serverUrl;
  return typeof value === 'string' ? value : undefined;
}
