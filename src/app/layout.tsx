import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import AuthGuard from '@/components/AuthGuard';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  applicationName: 'claude chat',
  title: 'claude chat',
  description: 'Claude Agent SDK chat interface',
  // Standalone / installed-app behaviour on iOS Safari, where the manifest's
  // `display` isn't honoured — these meta tags are what make it run chromeless.
  appleWebApp: {
    capable: true,
    title: 'claude chat',
    statusBarStyle: 'black-translucent',
  },
};

export const viewport: Viewport = {
  // Colors the browser/OS chrome (address bar, status bar) to match the app's
  // near-black background so the installed window looks seamless.
  themeColor: '#0a0a0a',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  // Let the background reach the physical edges of the screen. Required for
  // `env(safe-area-inset-*)` to report anything but 0 — and mandatory here,
  // because `appleWebApp.statusBarStyle` above is black-translucent, which
  // already draws content under the status bar.
  viewportFit: 'cover',
  // The software keyboard shrinks the layout viewport instead of sliding over
  // it, so a bottom-pinned composer stays visible while typing.
  interactiveWidget: 'resizes-content',
  // Deliberately not locked to 1: pinch-zoom is an accessibility affordance,
  // and the 16px input rule below is what actually stops iOS auto-zooming.
  maximumScale: 5,
  userScalable: true,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="h-full overflow-hidden bg-background text-foreground">
        <AuthGuard />
        {children}
      </body>
    </html>
  );
}
