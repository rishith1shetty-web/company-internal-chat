/**
 * /admin — the device-assignment console.
 *
 * A server component whose only job is to render the client boundary below it. Nothing is
 * rendered here that depends on being an administrator: the page itself is public, and every
 * piece of information on it comes from `/api/admin/*`, which refuses without a valid admin
 * cookie. An unauthenticated visitor gets a sign-in prompt and nothing else — not a device list
 * that is hidden with CSS, and not a redirect that could be read as one.
 *
 * NOT YET RESTRICTED BY NETWORK. Confining this path to an operator network belongs at the
 * reverse proxy in Phase 8, and it is listed there rather than being half-done here
 * (docs/12-admin-device-identity.md, "What must be hardened").
 */

import { AdminConsole } from '@/components/admin/AdminConsole';

export const metadata = {
  title: 'Administration · Company Internal Chat',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminConsole />;
}
