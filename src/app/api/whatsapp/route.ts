/**
 * The UI's door to the WhatsApp link — the "Connect WhatsApp" button.
 *
 * The agent never goes through here: it uses the built-in `whatsapp` MCP
 * server (src/server/whatsappTools.ts) over the same session. This route only
 * covers what a person has to do with their hands — scan a QR code, unlink,
 * press a test button.
 *
 * Behind the auth gate like every non-MCP route (src/proxy.ts), and
 * deliberately NOT under `/api/mcp/`, which is exempt from it.
 */

import type { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import {
  beginPairing,
  cancelPairing,
  getWhatsAppStatus,
  sendWhatsAppText,
  unlinkWhatsApp,
} from '@/server/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Status for the modal. The raw QR payload becomes an image here, so the client needs no QR library. */
async function wireStatus() {
  const { qr, ...status } = await getWhatsAppStatus();
  let qrImage: string | null = null;
  if (qr) {
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
    qrImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
  return { ...status, qrImage };
}

export async function GET() {
  return Response.json(await wireStatus());
}

/** POST { action: 'connect' | 'cancel' | 'test' | 'unlink' } */
export async function POST(req: NextRequest) {
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  switch (body.action) {
    case 'connect':
      await beginPairing();
      break;
    case 'cancel':
      cancelPairing();
      break;
    case 'unlink':
      await unlinkWhatsApp();
      break;
    case 'test': {
      // A message to the account's own chat: proves the link works without
      // putting anything in front of another person.
      try {
        await sendWhatsAppText({
          to: 'me',
          text: 'CloudChat test message. WhatsApp is connected.',
        });
      } catch (e) {
        return Response.json(
          { ...(await wireStatus()), error: e instanceof Error ? e.message : String(e) },
          { status: 502 },
        );
      }
      break;
    }
    default:
      return Response.json(
        { error: 'action must be one of: connect, cancel, test, unlink' },
        { status: 400 },
      );
  }
  return Response.json(await wireStatus());
}
