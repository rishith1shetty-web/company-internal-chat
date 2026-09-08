import type { NextConfig } from "next";

/**
 * Origins permitted to reach the Next.js DEVELOPMENT server cross-origin.
 *
 * Development only — Next uses this for its dev-server asset requests, and it has no effect on a
 * production build. It is read from the environment rather than written here because CLAUDE.md §7
 * says the company's addresses are not to be hard-coded, and a LAN address baked into a tracked
 * file follows the repository onto every other machine that clones it.
 *
 * `DEV_ORIGINS=192.168.1.50` in `.env` (comma-separated for more than one).
 */
const devOrigins = (process.env.DEV_ORIGINS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Content-Security-Policy for application pages (Phase 9).
 *
 * WHAT IT STOPS, and it is worth being precise rather than reassuring:
 *
 *   frame-ancestors 'none'   this application cannot be framed, so its interface cannot be put
 *                            behind a transparent overlay on somebody else's page. This is the
 *                            directive that actually earns its place — until now the chat window
 *                            could be embedded by any page an employee's browser could reach.
 *   object-src 'none'        no plugin content, whatever a future edit puts on a page.
 *   base-uri 'self'          an injected <base> cannot re-point every relative URL on the page.
 *   form-action 'self'       a form cannot be made to post company data to another origin.
 *   default-src 'self'       nothing loads from anywhere but this server.
 *
 * WHAT IT DOES NOT STOP. `script-src` includes `'unsafe-inline'`, so this is NOT an anti-XSS
 * control. Next.js injects inline bootstrap scripts into every page, and the way to allow those
 * specifically is a per-request nonce, which requires middleware this application does not have.
 * Claiming XSS protection here would be false: the actual protection against XSS is that nothing
 * in this codebase renders user content as HTML — React escapes every message body, there is no
 * `dangerouslySetInnerHTML` anywhere, and uploaded files are only ever served as
 * `application/octet-stream` attachments. Nonce-based CSP is recorded as residual work in
 * docs/19-phase-9-security-hardening.md rather than pretended to be done.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  // 'unsafe-eval' is React Fast Refresh in development only; it is not present in a build.
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The notification chime, served from public/sounds by this same server.
  "media-src 'self'",
  // Same-origin only, which covers the Socket.IO websocket to this host.
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),

  // Do not advertise the framework in response headers (docs/04-security.md,
  // "Secrets & information disclosure").
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Everything, including the API. These four are cheap and none of them can break a
        // response that was already correct.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Clickjacking, for anything that ignores `frame-ancestors`.
          { key: 'X-Frame-Options', value: 'DENY' },
          // A conversation id or an attachment id must not travel to another site in a Referer.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // The application asks for none of these, and the Electron client denies them outright.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
          },
        ],
      },
      {
        /*
         * Pages only.
         *
         * `/api/*` is excluded because two responses there set a deliberately tighter policy of
         * their own — the attachment download sends `default-src 'none'; sandbox` — and a second
         * CSP header does not replace the first, it is enforced alongside it. Keeping this one off
         * the API surface means the strict policy on a download stays the only one applied to it.
         */
        source: '/((?!api/).*)',
        headers: [{ key: 'Content-Security-Policy', value: contentSecurityPolicy }],
      },
    ];
  },
};

export default nextConfig;
