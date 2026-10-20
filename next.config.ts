import type { NextConfig } from "next";
import { isCheckinApp } from "./src/lib/app-mode";

// Confidential routes: never cached, indexed, framed or leaked via Referer.
const privateHeaders = [
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  // Lets the marketing build and the check-in build live side by side locally.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  async redirects() {
    return [
      {
        source: "/",
        destination: "/registration",
        permanent: false,
      },
    ];
  },

  async headers() {
    const rules = [
      { source: "/registration", headers: privateHeaders },
      { source: "/registration/:path*", headers: privateHeaders },
      { source: "/thank-you", headers: privateHeaders },
      { source: "/staff", headers: privateHeaders },
      { source: "/staff/:path*", headers: privateHeaders },
      { source: "/api/registrations", headers: privateHeaders },
      { source: "/api/queue/:path*", headers: privateHeaders },
      { source: "/api/staff/:path*", headers: privateHeaders },
    ];

    // The whole check-in deployment is private, apart from static assets.
    if (isCheckinApp()) {
      rules.push({
        source: "/((?!_next/static|_next/image|brand/|images/|icon.png|favicon.ico).*)",
        headers: privateHeaders,
      });
    }
    return rules;
  },
};

export default nextConfig;
