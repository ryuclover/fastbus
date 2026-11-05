/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    const production = process.env.NODE_ENV === "production";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${production ? "" : " ws: wss:"}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`,
          },
          ...(production
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
            : []),
        ],
      },
    ];
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  serverExternalPackages: [
    "puppeteer",
    "playwright-core",
    "@sparticuz/chromium",
  ],
  // Runtime data is mounted on the server, never distributed with application code.
  outputFileTracingExcludes: {
    "/*": [
      "./data/**/*",
      "./scratch/**/*",
      "./test-results/**/*",
      "./.env*",
      "./.wwebjs_auth/**/*",
      "./.wwebjs_cache/**/*",
      "./RemoteAuth-*.zip",
    ],
  },
  outputFileTracingIncludes: {
    "/api/search": ["./.fastbus-cloud/*"],
    "/api/cron/monitor": ["./.fastbus-cloud/*"],
    "/api/admin/whatsapp": ["./.fastbus-cloud/*"],
    "/api/admin/diagnostics": ["./.fastbus-cloud/*"],
    "/api/whatsapp": ["./.fastbus-cloud/*"],
    "/api/account/recovery": ["./.fastbus-cloud/*"],
  },
  images: {
    unoptimized: false,
  },
};

export default nextConfig;
