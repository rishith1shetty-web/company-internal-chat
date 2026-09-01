/**
 * /setup — the one-time enrollment page, opened on the company computer being set up.
 *
 * `?code=` is accepted so an administrator can paste a whole link rather than reading twenty
 * characters aloud, but it only pre-fills the field: nothing is redeemed until the form is
 * submitted. That matters, because a code redeemed by merely visiting a URL could be spent by a
 * link preview, a prefetch or a mistyped tab.
 */

import { EnrollmentScreen } from '@/components/admin/EnrollmentScreen';

export const metadata = {
  // The root layout's title template appends the company name.
  title: 'Computer setup',
  robots: { index: false, follow: false },
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  // A repeated query parameter arrives as an array; only a single value is meaningful here.
  const initialCode = typeof code === 'string' ? code.slice(0, 64) : '';

  return <EnrollmentScreen initialCode={initialCode} />;
}
