import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native modules — keep them as runtime `require` instead of bundling.
  serverExternalPackages: ["ssh2", "node-pty", "better-sqlite3"],
  // Pin Turbopack to this project — a stray lockfile in $HOME made it
  // climb up to /home/leo and break tailwind/postcss resolution.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
