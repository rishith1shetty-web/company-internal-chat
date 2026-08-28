/**
 * Liveness endpoint.
 *
 * Infrastructure, not application functionality: it lets the reverse proxy, the service
 * manager and the Phase 1 verification steps confirm the process is up without a browser.
 *
 * It deliberately reports nothing about the environment, configuration, versions or
 * dependencies — a health endpoint is reachable by anyone who can reach the application, so it
 * must not become an information-disclosure surface (docs/04-security.md).
 *
 * It performs NO database check. There is no database connection in Phase 1, and when one
 * exists a readiness check will be a separate, deliberate addition.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(
    { status: 'ok' },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
