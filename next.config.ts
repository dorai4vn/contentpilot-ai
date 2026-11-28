import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // Every page in this app depends on the signed-in user, so we keep classic
  // request-time rendering instead of Cache Components' static shells.
  cacheComponents: false,
  poweredByHeader: false,
  // FN11-A3: the file tracer follows onnxruntime_binding.node but NOT the libonnxruntime.so it dlopen()s, so the
  // serverless bundle failed with ERR_DLOPEN_FAILED (=> image QC fails closed => no RSS image post). Include the
  // linux/x64 native libs for the worker route only (other platforms are excluded to keep the bundle small).
  outputFileTracingIncludes: {
    "/api/cron/sports-news": ["./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
