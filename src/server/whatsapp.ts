/**
 * The WhatsApp session behind the built-in `whatsapp` MCP server and the
 * "Connect WhatsApp" button.
 *
 * ## What this is, and what it is not
 *
 * cloudchat links to the user's own WhatsApp account as a *linked device*
 * (Settings → Linked devices → scan a QR code), exactly the way WhatsApp Web
 * does, using Baileys — a Node client for that same protocol. It is NOT the
 * official WhatsApp Business API. Meta does not endorse unofficial clients and
 * can ban an account that behaves like a bot; the limits below (one message at
 * a time, a pause between them, an hourly cap, no guessing at recipients, an
 * audit log) exist to keep this looking and acting like one person typing, not
 * to make it safe against a determined misuse.
 *
 * ## Shape
 *
 * One account, one process-wide session on `globalThis` (like every other
 * long-lived store here, so route bundles share it). It is deliberately LAZY:
 *
 *   - Baileys is `import()`ed on first use. Measured: loading it and opening a
 *     socket costs ~90 MB RSS, and this box has 5.6 GB with a Brave tab or two
 *     on it. Nothing is paid until WhatsApp is actually used.
 *   - "Linked" means credentials exist in the DB — it does not need a socket.
 *     The socket opens on demand (a tool call, the Test button) and closes
 *     again after IDLE_MS, so an idle cloudchat holds no WhatsApp connection.
 *   - Credentials and Signal keys live in `whatsapp_auth`, each value
 *     encrypted with secrets.ts. They are enough to impersonate the account.
 *
 * Nothing here receives or stores message content: only the contact/group
 * names needed to turn "Mom" into a JID, and the messages WE send.
 */

import { getDb } from './db';
import { decryptSecret, encryptSecret } from './secrets';
import type {
  AuthenticationCreds,
  Contact,
  SignalKeyStore,
  WASocket,
} from '@whiskeysockets/baileys';

type Baileys = typeof import('@whiskeysockets/baileys');
type BaileysLogger = NonNullable<
  Parameters<Baileys['makeCacheableSignalKeyStore']>[1]
>;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Close the socket after this long without a send. */
const IDLE_MS = 10 * 60_000;
/** A socket that has not opened by now is dead; give up instead of hanging a tool call. */
const OPEN_TIMEOUT_MS = 30_000;
/** Minimum spacing between two sends. */
const MIN_GAP_MS = 2_500;
/** Hard cap on sends per rolling hour. Override with CLOUDCHAT_WHATSAPP_HOURLY_CAP. */
export const HOURLY_CAP = Math.max(
  1,
  Number(process.env.CLOUDCHAT_WHATSAPP_HOURLY_CAP) || 30,
);
const MAX_TEXT_CHARS = 4000;
/** Re-list the account's groups at most this often per process. */
const GROUP_REFRESH_MS = 6 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Process-wide state
// ---------------------------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Pairing opens a socket nobody awaits; a rejection there is reported via
  // `error`, not as an unhandled rejection that would take the server down.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type SocketState = 'closed' | 'connecting' | 'open';

type Session = {
  sock: WASocket | null;
  socketState: SocketState;
  /** Resolves when the current connect attempt reaches `open`. */
  opening: Deferred<WASocket> | null;
  /** True from "user pressed Connect" until the QR is scanned or gives up. */
  pairing: boolean;
  /** The raw QR payload, rotated by WhatsApp every ~20 s. */
  qr: string | null;
  /** Last user-facing problem; cleared by the next successful open. */
  error: string | null;
  me: { jid: string; name: string | null } | null;
  meLoaded: boolean;
  idleTimer: NodeJS.Timeout | null;
  lastSendAt: number;
  sendChain: Promise<unknown>;
  groupsRefreshedAt: number;
  waVersion: [number, number, number] | null;
};

const KEY = '__cc_whatsapp__';
const g = globalThis as unknown as Record<string, unknown>;
if (!g[KEY]) {
  g[KEY] = {
    sock: null,
    socketState: 'closed',
    opening: null,
    pairing: false,
    qr: null,
    error: null,
    me: null,
    meLoaded: false,
    idleTimer: null,
    lastSendAt: 0,
    sendChain: Promise.resolve(),
    groupsRefreshedAt: 0,
    waVersion: null,
  } satisfies Session;
}
const sess = g[KEY] as Session;

const loadBaileys = (): Promise<Baileys> => import('@whiskeysockets/baileys');

/** Baileys logs a lot of expected noise (session churn, retries). Errors surface via `error` instead. */
const silentLogger = {
  level: 'silent',
  child() {
    return silentLogger;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as BaileysLogger;

// ---------------------------------------------------------------------------
// Credentials in SQLite (encrypted)
// ---------------------------------------------------------------------------

function readRow(b: Baileys, k: string): unknown {
  const row = getDb()
    .prepare<[string], { v: string }>(`SELECT v FROM whatsapp_auth WHERE k = ?`)
    .get(k);
  if (!row) return null;
  const raw = decryptSecret(row.v);
  if (raw === null) return null;
  try {
    return JSON.parse(raw, b.BufferJSON.reviver);
  } catch {
    return null;
  }
}

function writeRow(b: Baileys, k: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO whatsapp_auth (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    )
    .run(k, encryptSecret(JSON.stringify(value, b.BufferJSON.replacer)));
}

function wipeAuth(): void {
  getDb().prepare(`DELETE FROM whatsapp_auth`).run();
  sess.me = null;
  sess.meLoaded = true;
}

/**
 * Baileys' multi-file auth state, but backed by the encrypted table instead of
 * a folder of plaintext JSON. Same contract: `creds` is mutated in place by the
 * library and `saveCreds` persists it; keys are written per (type, id).
 */
function loadAuthState(b: Baileys) {
  const creds =
    (readRow(b, 'creds') as AuthenticationCreds | null) ?? b.initAuthCreds();

  const store = {
    get: async (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        let value = readRow(b, `${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = b.proto.Message.AppStateSyncKeyData.fromObject(
            value as Record<string, unknown>,
          );
        }
        out[id] = value;
      }
      return out;
    },
    set: async (data: Record<string, Record<string, unknown>>) => {
      const db = getDb();
      db.transaction(() => {
        for (const type of Object.keys(data)) {
          for (const [id, value] of Object.entries(data[type] ?? {})) {
            const k = `${type}-${id}`;
            if (value) writeRow(b, k, value);
            else db.prepare(`DELETE FROM whatsapp_auth WHERE k = ?`).run(k);
          }
        }
      })();
    },
  } as unknown as SignalKeyStore;

  return {
    creds,
    state: {
      creds,
      keys: b.makeCacheableSignalKeyStore(store, silentLogger),
    },
    saveCreds: async () => writeRow(b, 'creds', creds),
  };
}

function jidNumber(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

function setMeFromCreds(creds: AuthenticationCreds): void {
  if (!creds.me?.id) return;
  sess.me = {
    jid: creds.me.id.replace(/:\d+@/, '@'),
    name: creds.me.name ?? creds.me.notify ?? null,
  };
  sess.meLoaded = true;
}

/**
 * Linked identity, read from the stored credentials the first time it is asked
 * for. Parsed with plain JSON on purpose: `me` holds no binary fields, and
 * going through Baileys' reviver would `import()` the whole library just to
 * answer "is anyone linked?" — which the status poll asks every second.
 */
async function loadMe(): Promise<Session['me']> {
  if (sess.meLoaded) return sess.me;
  const row = getDb()
    .prepare<[], { v: string }>(`SELECT v FROM whatsapp_auth WHERE k = 'creds'`)
    .get();
  const raw = row ? decryptSecret(row.v) : null;
  if (raw) {
    try {
      setMeFromCreds(JSON.parse(raw) as AuthenticationCreds);
    } catch {
      // Unreadable credentials count as not linked.
    }
  }
  sess.meLoaded = true;
  return sess.me;
}

// ---------------------------------------------------------------------------
// Contact / group names
// ---------------------------------------------------------------------------

function upsertContacts(contacts: Partial<Contact>[]): void {
  if (contacts.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO whatsapp_contacts (jid, name, push, kind, updated_at)
     VALUES (?, ?, ?, 'contact', ?)
     ON CONFLICT(jid) DO UPDATE SET
       name = COALESCE(excluded.name, name),
       push = COALESCE(excluded.push, push),
       updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  db.transaction(() => {
    for (const c of contacts) {
      // The phone-number JID is the stable, sendable one; a bare LID is only
      // used when WhatsApp gave us nothing better.
      const jid = c.phoneNumber ?? c.id;
      if (!jid || jid.endsWith('@g.us') || jid.includes('broadcast')) continue;
      const name = c.name ?? c.verifiedName ?? null;
      const push = c.notify ?? null;
      if (!name && !push) continue;
      stmt.run(jid, name, push, now);
    }
  })();
}

async function refreshGroups(sock: WASocket): Promise<void> {
  if (Date.now() - sess.groupsRefreshedAt < GROUP_REFRESH_MS) return;
  sess.groupsRefreshedAt = Date.now();
  try {
    const groups = await sock.groupFetchAllParticipating();
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO whatsapp_contacts (jid, name, push, kind, updated_at)
       VALUES (?, ?, NULL, 'group', ?)
       ON CONFLICT(jid) DO UPDATE SET name = excluded.name, kind = 'group',
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    db.transaction(() => {
      for (const grp of Object.values(groups)) {
        if (grp.id && grp.subject) stmt.run(grp.id, grp.subject, now);
      }
    })();
  } catch {
    // Group names are a convenience; a failed listing must not fail a send.
    sess.groupsRefreshedAt = 0;
  }
}

/** Lowercase, accent-free, for matching "Ștefan" against "stefan". */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

export type ChatMatch = {
  jid: string;
  label: string;
  kind: 'contact' | 'group';
  /** Phone number for contacts; empty for groups. */
  number: string;
};

type ContactRow = {
  jid: string;
  name: string | null;
  push: string | null;
  kind: string;
};

/** Contacts and groups whose saved name or chosen name matches `query`, best first. */
export function findChats(query: string, limit = 10): ChatMatch[] {
  const q = fold(query);
  if (!q) return [];
  const rows = getDb()
    .prepare<[], ContactRow>(`SELECT jid, name, push, kind FROM whatsapp_contacts`)
    .all();

  const scored: { match: ChatMatch; score: number }[] = [];
  for (const r of rows) {
    const names = [r.name, r.push].filter((n): n is string => !!n);
    let best = 0;
    for (const n of names) {
      const f = fold(n);
      if (f === q) best = Math.max(best, 3);
      else if (f.startsWith(q)) best = Math.max(best, 2);
      else if (f.includes(q)) best = Math.max(best, 1);
    }
    if (best === 0) continue;
    const kind = r.kind === 'group' ? 'group' : 'contact';
    scored.push({
      score: best,
      match: {
        jid: r.jid,
        label: r.name ?? r.push ?? r.jid,
        kind,
        number: kind === 'group' ? '' : jidNumber(r.jid),
      },
    });
  }
  scored.sort((a, b) => b.score - a.score || a.match.label.localeCompare(b.match.label));

  // The same person can arrive twice (once as a LID, once as a phone JID).
  // Collapse identical labels, keeping the sendable phone-number form.
  const seen = new Map<string, ChatMatch>();
  for (const { match } of scored) {
    const key = `${match.kind}:${fold(match.label)}`;
    const prev = seen.get(key);
    if (!prev || (match.jid.endsWith('@s.whatsapp.net') && !prev.jid.endsWith('@s.whatsapp.net'))) {
      seen.set(key, match);
    }
  }
  return [...seen.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------

function clearIdleTimer(): void {
  if (sess.idleTimer) clearTimeout(sess.idleTimer);
  sess.idleTimer = null;
}

/** Push the idle deadline out. The socket stays up while the account is in use. */
function touch(): void {
  clearIdleTimer();
  sess.idleTimer = setTimeout(() => {
    if (!sess.pairing) closeSocket();
  }, IDLE_MS);
  sess.idleTimer.unref?.();
}

/**
 * What a waiter sees when WE closed the socket on purpose (cancel, idle, unlink).
 * Distinct from a failure so callers that merely started the connect — pairing —
 * do not report their own cancellation as an error.
 */
class SocketClosedError extends Error {
  constructor() {
    super('The WhatsApp connection was closed.');
  }
}

/** Drop the socket without it counting as a failure. Credentials stay. */
function closeSocket(): void {
  clearIdleTimer();
  const sock = sess.sock;
  // Detach FIRST: the close event Baileys fires for our own end() must look
  // like it belongs to a socket we no longer care about.
  sess.sock = null;
  sess.socketState = 'closed';
  if (sess.opening) {
    sess.opening.reject(new SocketClosedError());
    sess.opening = null;
  }
  try {
    sock?.end(undefined);
  } catch {
    // Already gone.
  }
}

async function onConnectionUpdate(
  sock: WASocket,
  b: Baileys,
  u: Partial<import('@whiskeysockets/baileys').ConnectionState>,
): Promise<void> {
  if (sess.sock !== sock) return; // an older socket's late event

  if (u.qr) sess.qr = u.qr;
  if (u.connection === 'connecting') sess.socketState = 'connecting';

  if (u.connection === 'open') {
    sess.socketState = 'open';
    sess.pairing = false;
    sess.qr = null;
    sess.error = null;
    sess.opening?.resolve(sock);
    sess.opening = null;
    touch();
    void refreshGroups(sock);
    return;
  }

  if (u.connection === 'close') {
    const code = (
      u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
    )?.output?.statusCode;
    sess.sock = null;
    sess.socketState = 'closed';
    clearIdleTimer();

    // Right after a successful scan WhatsApp drops the connection on purpose
    // and expects the client to come back with the new credentials.
    if (code === b.DisconnectReason.restartRequired) {
      const opening = sess.opening ?? deferred<WASocket>();
      sess.opening = opening;
      try {
        await startSocket();
      } catch (e) {
        failOpen(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    if (code === b.DisconnectReason.loggedOut) {
      wipeAuth();
      sess.pairing = false;
      sess.qr = null;
      failOpen('WhatsApp removed this device (it was unlinked from the phone). Connect again to re-link.');
      return;
    }

    if (sess.pairing) {
      sess.pairing = false;
      sess.qr = null;
      failOpen('The QR code expired before it was scanned. Press Connect to get a new one.');
      return;
    }

    // An established connection that simply dropped (idle timeout on
    // WhatsApp's side, a network blip) is not worth showing as an error: the
    // next use reconnects. Only a connect attempt that failed is.
    if (code === b.DisconnectReason.connectionReplaced) {
      failOpen('Another session took over this WhatsApp link.');
    } else if (sess.opening) {
      failOpen(`The WhatsApp connection closed (${code ?? 'unknown reason'}).`);
    }
  }
}

/** Record a problem and fail whoever is waiting for the socket. */
function failOpen(message: string): void {
  sess.error = message;
  if (sess.opening) {
    sess.opening.reject(new Error(message));
    sess.opening = null;
  }
}

/** Create the socket and wire its events. Does not wait for `open`. */
async function startSocket(): Promise<void> {
  const b = await loadBaileys();
  const { creds, state, saveCreds } = loadAuthState(b);

  if (!sess.waVersion) {
    // Tries WhatsApp's current web version and falls back to the one bundled
    // with the library, so it never throws.
    const { version } = await b.fetchLatestBaileysVersion();
    sess.waVersion = version as [number, number, number];
  }

  const sock = b.default({
    auth: state,
    version: sess.waVersion,
    logger: silentLogger,
    browser: b.Browsers.ubuntu('CloudChat'),
    // We only ever send. Skipping the history sync keeps the first connection
    // small, and not announcing "online" leaves the phone's own notifications alone.
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });
  sess.sock = sock;
  sess.socketState = 'connecting';

  sock.ev.on('creds.update', () => {
    void saveCreds();
    setMeFromCreds(creds);
  });
  sock.ev.on('connection.update', (u) => void onConnectionUpdate(sock, b, u));
  sock.ev.on('contacts.upsert', (cs) => upsertContacts(cs));
  sock.ev.on('contacts.update', (cs) => upsertContacts(cs));
  sock.ev.on('messaging-history.set', ({ contacts }) => upsertContacts(contacts));
}

/** Connect (or join the connect already in flight). Resolves once the socket is open. */
function openSocket(): Promise<WASocket> {
  if (sess.sock && sess.socketState === 'open') return Promise.resolve(sess.sock);
  if (sess.opening) return sess.opening.promise;

  const opening = deferred<WASocket>();
  sess.opening = opening;
  startSocket().catch((e) => failOpen(e instanceof Error ? e.message : String(e)));

  // A normal connect takes 1-3 s. While pairing the QR can legitimately sit
  // for a minute, and Baileys ends that itself — so only watch the others.
  if (!sess.pairing) {
    const watchdog = setTimeout(() => {
      if (sess.opening === opening && sess.socketState !== 'open') {
        closeSocket();
        failOpen('Timed out connecting to WhatsApp.');
      }
    }, OPEN_TIMEOUT_MS);
    watchdog.unref?.();
    opening.promise.finally(() => clearTimeout(watchdog)).catch(() => {});
  }
  return opening.promise;
}

async function ensureOpen(): Promise<WASocket> {
  if (!(await loadMe())) {
    throw new Error(
      'WhatsApp is not linked. Ask the user to click the WhatsApp button in cloudchat and scan the QR code with their phone (WhatsApp → Settings → Linked devices).',
    );
  }
  const sock = await openSocket();
  touch();
  return sock;
}

// ---------------------------------------------------------------------------
// Pairing and unlinking (the UI's side)
// ---------------------------------------------------------------------------

/** Start linking: opens a socket with fresh credentials and begins emitting QR codes. */
export async function beginPairing(): Promise<void> {
  if (await loadMe()) return; // already linked
  if (sess.pairing && sess.sock) return; // a QR is already on screen
  closeSocket();
  wipeAuth(); // a half-finished earlier attempt must not seed this one
  sess.error = null;
  sess.qr = null;
  sess.pairing = true;
  void openSocket().catch((e) => {
    // Cancelling closes the socket under us; that is not a problem to report.
    if (e instanceof SocketClosedError) return;
    sess.pairing = false;
    sess.error = e instanceof Error ? e.message : String(e);
  });
}

export function cancelPairing(): void {
  if (!sess.pairing) return;
  closeSocket();
  wipeAuth();
  sess.pairing = false;
  sess.qr = null;
}

/** Remove the linked device on WhatsApp's side (if reachable) and forget the credentials here. */
export async function unlinkWhatsApp(): Promise<void> {
  if (await loadMe()) {
    try {
      const sock = await ensureOpen();
      await sock.logout();
    } catch {
      // Offline or already revoked — still forget the credentials below. The
      // device may linger in the phone's list; it can be removed there.
    }
  }
  closeSocket();
  wipeAuth();
  sess.pairing = false;
  sess.qr = null;
  sess.error = null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type WhatsAppSend = {
  at: number;
  to: string;
  body: string;
  ok: boolean;
  error: string | null;
};

export type WhatsAppStatus = {
  linked: boolean;
  me: { jid: string; number: string; name: string | null } | null;
  socket: SocketState;
  pairing: boolean;
  /** Raw QR payload while pairing, else null. */
  qr: string | null;
  error: string | null;
  sendsLastHour: number;
  hourlyCap: number;
  knownChats: number;
  recent: WhatsAppSend[];
};

function sendsSince(ms: number): number {
  return (
    getDb()
      .prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM whatsapp_sends WHERE ok = 1 AND at >= ?`,
      )
      .get(ms)?.n ?? 0
  );
}

export function recentSends(limit = 5): WhatsAppSend[] {
  return getDb()
    .prepare<
      [number],
      { at: number; label: string | null; jid: string; body: string; ok: number; error: string | null }
    >(`SELECT at, label, jid, body, ok, error FROM whatsapp_sends ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({
      at: r.at,
      to: r.label ?? r.jid,
      body: r.body,
      ok: r.ok !== 0,
      error: r.error,
    }));
}

export async function getWhatsAppStatus(): Promise<WhatsAppStatus> {
  const me = await loadMe();
  return {
    linked: !!me,
    me: me ? { jid: me.jid, number: jidNumber(me.jid), name: me.name } : null,
    socket: sess.socketState,
    pairing: sess.pairing,
    qr: sess.pairing ? sess.qr : null,
    error: sess.error,
    sendsLastHour: sendsSince(Date.now() - 3_600_000),
    hourlyCap: HOURLY_CAP,
    knownChats:
      getDb()
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM whatsapp_contacts`)
        .get()?.n ?? 0,
    recent: recentSends(5),
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const JID_PATTERN = /^[\w.+-]+(:\d+)?@(s\.whatsapp\.net|g\.us|lid)$/;

export class WhatsAppSendError extends Error {}

type Recipient = { jid: string; label: string };

async function resolveRecipient(sock: WASocket, to: string): Promise<Recipient> {
  const raw = to.trim();
  if (!raw) throw new WhatsAppSendError('`to` is empty.');

  if (/^(me|self|myself)$/i.test(raw)) {
    const me = await loadMe();
    if (!me) throw new WhatsAppSendError('WhatsApp is not linked.');
    return { jid: me.jid, label: 'yourself' };
  }

  if (JID_PATTERN.test(raw)) {
    const jid = raw.replace(/:\d+@/, '@');
    return { jid, label: jid };
  }

  // Looks like a phone number: digits with the usual punctuation.
  if (/^\+?[\d\s().-]{7,20}$/.test(raw)) {
    const digits = raw.replace(/[^\d]/g, '').replace(/^00/, '');
    if (raw.replace(/\s/g, '').startsWith('0') && !raw.replace(/\s/g, '').startsWith('00')) {
      throw new WhatsAppSendError(
        `"${raw}" has no country code. Use the international form without a leading 0, e.g. 40722123456 for a Romanian number.`,
      );
    }
    if (digits.length < 8 || digits.length > 15) {
      throw new WhatsAppSendError(`"${raw}" is not a valid international phone number.`);
    }
    const found = await sock.onWhatsApp(`${digits}@s.whatsapp.net`);
    const hit = found?.[0];
    if (!hit?.exists) {
      throw new WhatsAppSendError(`${digits} is not registered on WhatsApp.`);
    }
    return { jid: hit.jid, label: `+${digits}` };
  }

  // Otherwise it is a name. Never guess between two people.
  const matches = findChats(raw, 8);
  const exact = matches.filter((m) => fold(m.label) === fold(raw));
  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (pick) return { jid: pick.jid, label: pick.label };

  if (matches.length === 0) {
    throw new WhatsAppSendError(
      `No contact or group named "${raw}". Use find_chat to look, or pass the phone number with country code.`,
    );
  }
  throw new WhatsAppSendError(
    `"${raw}" matches more than one chat — nothing was sent. Ask the user which one, then send to its number or JID:\n` +
      matches
        .map((m) => `  - ${m.label} (${m.kind}) → ${m.kind === 'group' ? m.jid : m.number}`)
        .join('\n'),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function logSend(r: Recipient | null, to: string, text: string, ok: boolean, error?: string): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO whatsapp_sends (at, jid, label, body, ok, error) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), r?.jid ?? to, r?.label ?? null, text.slice(0, 2000), ok ? 1 : 0, error ?? null);
  } catch {
    // The audit log must never be the reason a send fails.
  }
}

async function doSend(input: { to: string; text: string }): Promise<{
  jid: string;
  label: string;
  messageId: string | null;
}> {
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new WhatsAppSendError('`text` is empty.');
  if (text.length > MAX_TEXT_CHARS) {
    throw new WhatsAppSendError(
      `Message is ${text.length} characters; the limit here is ${MAX_TEXT_CHARS}. Shorten it or split it.`,
    );
  }

  const sock = await ensureOpen();
  const recipient = await resolveRecipient(sock, input.to);

  if (sendsSince(Date.now() - 3_600_000) >= HOURLY_CAP) {
    throw new WhatsAppSendError(
      `Hourly send limit reached (${HOURLY_CAP}). This guard keeps the account from looking automated; try again later.`,
    );
  }

  const wait = sess.lastSendAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);

  try {
    // A person types before they send. Best effort: presence can fail on a
    // chat the account has never opened, and that must not block the message.
    await sock.sendPresenceUpdate('composing', recipient.jid).catch(() => {});
    await sleep(Math.min(2_500, 400 + text.length * 25));
    const sent = await sock.sendMessage(recipient.jid, { text });
    await sock.sendPresenceUpdate('paused', recipient.jid).catch(() => {});
    sess.lastSendAt = Date.now();
    logSend(recipient, input.to, text, true);
    touch();
    return { ...recipient, messageId: sent?.key?.id ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logSend(recipient, input.to, text, false, msg);
    throw new WhatsAppSendError(`WhatsApp refused the message: ${msg}`);
  }
}

/**
 * Send a text message. Sends are serialized so two agents answering at once
 * cannot burst; the second waits for the first plus MIN_GAP_MS.
 */
export function sendWhatsAppText(input: { to: string; text: string }) {
  const run = sess.sendChain.then(
    () => doSend(input),
    () => doSend(input),
  );
  sess.sendChain = run.catch(() => {});
  return run;
}

/** Make sure the socket is up and groups are listed, so name lookups see them. */
export async function warmWhatsApp(): Promise<void> {
  const sock = await ensureOpen();
  await refreshGroups(sock);
}
