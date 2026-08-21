'use client';

/**
 * Push-to-talk dictation via Soniox real-time transcription.
 *
 * The browser streams microphone audio straight to Soniox over a WebSocket,
 * authenticated with a single-use key minted by /api/voice/token. Words arrive
 * as they are spoken rather than after you stop, which is the whole point: a
 * record-then-upload design makes you wait twice, once for yourself and once
 * for the upload.
 *
 * MULTILINGUAL BY DESIGN
 *
 * `language_hints: ['ro', 'en']` with `enable_language_identification` lets a
 * single stream switch between Romanian and English mid-sentence, which is how
 * people actually talk when one of the two is a technical vocabulary. Hints are
 * not a restriction — the model covers 60 languages either way — they only
 * weight the decision, so a stray third language still transcribes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

/**
 * How often MediaRecorder hands us a chunk. Small enough that transcription
 * feels live, large enough that we are not paying WebSocket framing overhead on
 * near-empty buffers.
 */
const CHUNK_MS = 120;

const LANGUAGE_HINTS = ['ro', 'en'];

export type VoiceStatus = 'idle' | 'starting' | 'listening' | 'stopping';

type SonioxToken = {
  text: string;
  is_final: boolean;
  language?: string;
};

type SonioxMessage = {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: string | number | null;
  error_message?: string | null;
};

/**
 * First supported container. Chrome and Firefox give webm/opus; Safari only
 * offers mp4. Soniox's `audio_format: 'auto'` demuxes either, so the right move
 * is to take whatever the browser is willing to produce rather than insisting
 * on one and failing on iOS.
 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}

function describeStartFailure(e: unknown): string {
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices) {
    // getUserMedia is gated on a secure context. Over plain http on a tailnet
    // address the API is simply absent, which otherwise surfaces as an
    // inscrutable TypeError.
    return 'Microphone access needs HTTPS (or localhost).';
  }
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError') {
      return 'Microphone permission was denied.';
    }
    if (e.name === 'NotFoundError') return 'No microphone was found.';
    return `Microphone error: ${e.name}`;
  }
  return e instanceof Error ? e.message : 'Could not start the microphone.';
}

export function useVoiceInput({
  onFinalText,
}: {
  /** Called with each confirmed fragment, in order, as it is recognised. */
  onFinalText: (text: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  /** Words heard but not yet confirmed. Shown greyed, never inserted. */
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Kept in a ref so `start` does not need the callback in its dependency list;
  // a caller that rebuilds the handler each render would otherwise tear down
  // and restart the microphone mid-sentence.
  const onFinalRef = useRef(onFinalText);
  useEffect(() => {
    onFinalRef.current = onFinalText;
  }, [onFinalText]);

  /** Release the microphone and socket. Safe to call from any state. */
  const release = useCallback(() => {
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
    }
    recRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }

    setInterim('');
    setStatus('idle');
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setInterim('');
    setStatus('starting');

    let stream: MediaStream;
    let token: { apiKey: string; model: string };

    try {
      const res = await fetch('/api/voice/token', { method: 'POST' });
      const body = (await res.json()) as {
        apiKey?: string;
        model?: string;
        error?: string;
      };
      if (!res.ok || !body.apiKey) {
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      token = { apiKey: body.apiKey, model: body.model ?? 'stt-rt-v5' };
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start voice input.');
      setStatus('idle');
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      setError(describeStartFailure(e));
      setStatus('idle');
      return;
    }
    streamRef.current = stream;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Config must be the first frame; audio sent before it is discarded.
      // sample_rate and num_channels are deliberately omitted — they apply only
      // to raw PCM, and 'auto' reads them out of the container instead.
      ws.send(
        JSON.stringify({
          api_key: token.apiKey,
          model: token.model,
          audio_format: 'auto',
          language_hints: LANGUAGE_HINTS,
          enable_language_identification: true,
          enable_endpoint_detection: true,
        }),
      );

      const mimeType = pickMimeType();
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (e) {
        setError(describeStartFailure(e));
        release();
        return;
      }
      recRef.current = rec;

      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(ev.data);
        }
      };
      // Fires after the final ondataavailable, so the empty-string terminator
      // lands strictly after the last audio rather than racing it.
      rec.onstop = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send('');
      };

      rec.start(CHUNK_MS);
      setStatus('listening');
    };

    ws.onmessage = (ev) => {
      let msg: SonioxMessage;
      try {
        msg = JSON.parse(String(ev.data)) as SonioxMessage;
      } catch {
        return;
      }

      if (msg.error_code) {
        setError(msg.error_message || `Transcription error ${msg.error_code}`);
        release();
        return;
      }

      let confirmed = '';
      let pending = '';
      for (const t of msg.tokens ?? []) {
        if (t.is_final) confirmed += t.text;
        else pending += t.text;
      }
      if (confirmed) onFinalRef.current(confirmed);
      setInterim(pending);

      if (msg.finished) release();
    };

    ws.onerror = () => {
      // The event carries no detail by design, so say the useful part: this is
      // the leg between browser and Soniox, not the app's own server.
      setError('Lost the connection to the transcription service.');
      release();
    };

    ws.onclose = () => {
      if (wsRef.current === ws) release();
    };
  }, [release]);

  /** Stop recording but let the socket drain, so the last words still land. */
  const stop = useCallback(() => {
    setStatus('stopping');
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop(); // onstop sends the terminator; Soniox replies finished:true
        return;
      } catch {
        /* fall through to a hard release */
      }
    }
    release();
  }, [release]);

  const toggle = useCallback(() => {
    if (status === 'idle') void start();
    else if (status === 'listening') stop();
    // 'starting' and 'stopping' are transient; ignoring taps during them keeps
    // a double-press from opening a second stream against a single-use key.
  }, [status, start, stop]);

  // Never leave the microphone live on unmount — the browser keeps the
  // recording indicator up and the tab holds the device.
  useEffect(() => release, [release]);

  return {
    status,
    interim,
    error,
    clearError: useCallback(() => setError(null), []),
    toggle,
    stop,
    isActive: status === 'listening' || status === 'starting',
  };
}
