import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The knowledge base is read from disk at runtime, so it has to be traced
  // into the serverless bundle explicitly. Without this the route works
  // locally and throws ENOENT on Vercel.
  outputFileTracingIncludes: {
    "/api/**/*": ["./knowledge/**"],
  },
};

export default nextConfig;
