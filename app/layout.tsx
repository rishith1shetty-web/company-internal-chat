import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Rising Path Recruiters · Internal Chat',
    template: '%s · Rising Path Recruiters',
  },
  description: 'Internal chat and file transfer system.',
  applicationName: 'Rising Path Recruiters Internal Chat',
  // The application is private and company-hosted; it should never be indexed if it is ever
  // reachable from a network that has a crawler on it.
  robots: { index: false, follow: false },
  /*
   * The tab icon is app/icon.png, which Next discovers by convention and links itself — no
   * <link rel="icon"> is written by hand anywhere. Both it and app/apple-icon.png are the
   * company's own logo: the sun-and-path symbol cropped out of the supplied artwork and resampled,
   * never redrawn (components/brand/Logo.tsx).
   */
};

export const viewport: Viewport = {
  // Matches the header surface, so the browser chrome on mobile does not sit against a colour
  // the application never uses.
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
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
