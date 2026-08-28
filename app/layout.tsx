import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Company Internal Chat',
  description: 'Internal chat and file transfer system.',
  // The application is private and company-hosted; it should never be indexed if it is ever
  // reachable from a network that has a crawler on it.
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
