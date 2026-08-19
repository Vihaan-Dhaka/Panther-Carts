import type { NextConfig } from "next";

const protectedHeaders = [
  { key: "Cache-Control", value: "private, no-store" },
  { key: "Pragma", value: "no-cache" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return ["/admin/:path*", "/staff/:path*", "/student/:path*"].map(
      (source) => ({ source, headers: protectedHeaders }),
    );
  },
};

export default nextConfig;
