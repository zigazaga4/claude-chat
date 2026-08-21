import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — makes claude chat installable as a standalone PWA.
 *
 * This file convention is served at `/manifest.webmanifest` and Next.js
 * auto-injects the matching `<link rel="manifest">` into every page, so no
 * manual <head> wiring is needed. The window it produces is a thin frame over
 * the same app that runs in the browser — the Node server (started separately,
 * e.g. under pm2) is what backs it, exactly as when opened in a tab.
 *
 * Icons are pre-rendered PNGs in /public (see scripts/generate-pwa-icons.mjs).
 * We ship both a "maskable" icon (full-bleed, for OS launchers that apply their
 * own mask) and plain "any" icons (rounded tile, for browser menus).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'claude chat',
    short_name: 'claude chat',
    description:
      'Self-hosted web UI for the Claude Agent SDK — agentic chat over local folders and remote SSH machines.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    categories: ['developer', 'productivity', 'utilities'],
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
