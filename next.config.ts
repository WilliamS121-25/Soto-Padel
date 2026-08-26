import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Both database drivers must stay out of the bundle: pg opens real TCP
  // sockets, and PGlite ships a WebAssembly build that the bundler would
  // mangle.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
