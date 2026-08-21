import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build somewhere other than `.next` when asked. `next start` serves the
  // build that was on disk when it booted, so rebuilding `.next` underneath a
  // running server deletes the chunks it is still serving and breaks the open
  // page. Setting this lets a build be verified without touching the live one.
  distDir: process.env.CC_DIST_DIR || ".next",
  // Native modules — keep them as runtime `require` instead of bundling.
  serverExternalPackages: ["ssh2", "node-pty", "better-sqlite3"],
  images: {
    // This app never imports `next/image` — every image it shows is either a
    // plain <img> or a data URL from the composer. Leaving the optimizer on
    // therefore buys nothing and costs two things:
    //
    //   1. RAM. The first request to /_next/image lazily dlopen's sharp and
    //      libvips into the server and they never leave — measured at 11 sharp
    //      plus 6 libvips mappings and roughly 15-35 MB of RSS, permanently,
    //      on a 5.6 GB box.
    //   2. An unauthenticated route. `_next/image` is exempt from the auth
    //      matcher in src/proxy.ts (see the note there), and this host is
    //      published over a public tailscale funnel, so it answers 200 with no
    //      session cookie while every real route answers 401.
    //
    // The blast radius of that route is small — remotePatterns and domains are
    // both empty, so remote fetches are refused, and localPatterns rejects
    // traversal — but "small" is a worse reason to keep it than "unused" is to
    // drop it. Turning it off removes the route entirely and guarantees sharp
    // is never loaded.
    unoptimized: true,
  },
  // Pin Turbopack to this project — a stray lockfile in $HOME made it
  // climb up to /home/leo and break tailwind/postcss resolution.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
