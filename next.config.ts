import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Do not advertise the framework in response headers (docs/04-security.md,
  // "Secrets & information disclosure").
  poweredByHeader: false,
};

export default nextConfig;
