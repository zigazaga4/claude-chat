/**
 * Mints a short-lived Soniox key so the browser can stream audio straight to
 * their WebSocket without ever seeing the real one.
 *
 * WHY NOT PROXY THE AUDIO
 *
 * The obvious alternative is to relay the microphone through this server. That
 * would need a WebSocket endpoint, which Next route handlers do not provide,
 * and it would put every audio frame through the Node process for no benefit —
 * on a machine where memory is already the binding constraint.
 *
 * Soniox sells the answer to this exact problem: a temporary key, scoped to one
 * usage type, valid only long enough to open a stream. The long-lived key stays
 * on the server, and the worst a leaked temporary key buys an attacker is a
 * single transcription session that expires in a minute.
 *
 * This route sits under /api/, so the auth gate in proxy.ts already covers it —
 * only a signed-in session can mint one. That matters: minting is a billable
 * action, and an unauthenticated endpoint here would be an open tab on the
 * account.
 */

import { readConfiguredSecret } from '@/server/secretSource';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';

/**
 * Real-time multilingual model. Sent to the client rather than hardcoded there
 * so the model is chosen in exactly one place; Soniox keeps several live at
 * once (stt-rt-v3 through v5, plus previews) and they do not all behave alike.
 */
const MODEL = 'stt-rt-v5';

/**
 * How long the key may be used to *open* a stream. Deliberately short: the
 * client requests one and connects immediately, so a minute is generous, and
 * this is the window during which a leaked key is worth anything.
 */
const EXPIRES_IN_SECONDS = 60;

/**
 * How long a stream, once open, may run. This is the real dictation limit —
 * expiry above does not terminate a stream already in progress.
 */
const MAX_SESSION_SECONDS = 1800;

export async function POST() {
  const key = readConfiguredSecret({
    envVar: 'SONIOX_API_KEY',
    fileName: 'soniox-api-key',
  });
  if (!key) {
    return Response.json(
      {
        error:
          'Voice input is not configured. Set SONIOX_API_KEY, or write the key to soniox-api-key in the cloudchat data directory.',
      },
      { status: 503 },
    );
  }

  let res: Response;
  try {
    res = await fetch(TEMP_KEY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: EXPIRES_IN_SECONDS,
        // One key, one stream. Pressing the mic again mints a fresh one, which
        // costs a single cheap round trip and means a key cannot be replayed.
        single_use: true,
        max_session_duration_seconds: MAX_SESSION_SECONDS,
      }),
    });
  } catch (e) {
    return Response.json(
      {
        error: `Could not reach Soniox: ${e instanceof Error ? e.message : 'network error'}`,
      },
      { status: 502 },
    );
  }

  if (!res.ok) {
    // Surface their message rather than a generic failure — a 401 here means
    // the configured key is wrong or revoked, and that is worth saying plainly
    // instead of letting it look like a microphone problem.
    const detail = await res.text().catch(() => '');
    return Response.json(
      {
        error: `Soniox refused to issue a key (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      },
      { status: 502 },
    );
  }

  const data = (await res.json()) as { api_key?: string; expires_at?: string };
  if (!data.api_key) {
    return Response.json(
      { error: 'Soniox returned no key' },
      { status: 502 },
    );
  }

  return Response.json({
    apiKey: data.api_key,
    expiresAt: data.expires_at ?? null,
    model: MODEL,
  });
}
