import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Allow this development machine to be accessed through its company-LAN IP.
  allowedDevOrigins: [
  "localhost",
  "127.0.0.1",
  "192.168.29.244",
],

  // Do not advertise the framework in response headers (docs/04-security.md,
  // "Secrets & information disclosure").
  poweredByHeader: false,
};

export default nextConfig;
