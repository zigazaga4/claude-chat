/**
 * The built-in `whatsapp` MCP server: three tools over the session in
 * whatsapp.ts. Registered as a BUNDLED registry entry (see bundledMcp.ts), so
 * it is off everywhere until a folder attaches it — the same switch every
 * other MCP server uses.
 *
 * The descriptions carry most of the safety design. What goes out is sent
 * under the owner's name and cannot be recalled, so the tools say plainly to
 * send only what the user asked, to whom they asked, and to ask when a name is
 * ambiguous — and the code backs that up by refusing to pick between matches.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { err, ok, type ToolResult } from './fileToolShared';
import {
  findChats,
  getWhatsAppStatus,
  sendWhatsAppText,
  warmWhatsApp,
  WhatsAppSendError,
} from './whatsapp';

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function createWhatsAppMcpServer() {
  return createSdkMcpServer({
    name: 'whatsapp',
    version: '0.1.0',
    tools: [
      tool(
        'status',
        "Is WhatsApp linked, which number it is, how many messages have gone out this hour against the cap, and the last few sends. Call this first if a send fails or you are unsure whether the account is connected.",
        {},
        async (): Promise<ToolResult> => {
          const s = await getWhatsAppStatus();
          if (!s.linked) {
            return ok(
              'WhatsApp is NOT linked. The user has to click the WhatsApp button in the cloudchat top bar and scan the QR code with their phone (WhatsApp → Settings → Linked devices → Link a device). You cannot do this for them.',
            );
          }
          const lines = [
            `Linked as +${s.me?.number}${s.me?.name ? ` (${s.me.name})` : ''}.`,
            `Connection: ${s.socket} (it opens on demand and closes when idle).`,
            `Sent this hour: ${s.sendsLastHour} of ${s.hourlyCap}.`,
            `Known chats for name lookup: ${s.knownChats}.`,
          ];
          if (s.error) lines.push(`Last problem: ${s.error}`);
          if (s.recent.length > 0) {
            lines.push('', 'Recent sends:');
            for (const r of s.recent) {
              const body = r.body.length > 60 ? `${r.body.slice(0, 60)}…` : r.body;
              lines.push(
                `  - ${ago(r.at)} → ${r.to}: "${body.replace(/\n/g, ' ')}"${r.ok ? '' : ` [FAILED: ${r.error}]`}`,
              );
            }
          }
          return ok(lines.join('\n'));
        },
      ),
      tool(
        'find_chat',
        'Look up contacts and groups by name (accents and case ignored) so you can see who a name refers to before sending. Returns each match with its phone number or group JID. Names come from the user\'s address book and the groups the account is in.',
        {
          query: z.string().min(1).describe('Part of a contact or group name.'),
        },
        async (args): Promise<ToolResult> => {
          try {
            await warmWhatsApp();
          } catch (e) {
            // Lookups work from what is already stored; only say so if empty.
            const matches = findChats(args.query);
            if (matches.length === 0) {
              return err(e instanceof Error ? e.message : String(e));
            }
          }
          const matches = findChats(args.query, 15);
          if (matches.length === 0) {
            return ok(
              `No contact or group matching "${args.query}". The contact list fills in after the account has synced, which can take a minute after linking; a phone number with country code always works.`,
            );
          }
          return ok(
            matches
              .map(
                (m) =>
                  `${m.label} — ${m.kind === 'group' ? `group, JID ${m.jid}` : `+${m.number}`}`,
              )
              .join('\n'),
          );
        },
      ),
      tool(
        'send_message',
        'Send a WhatsApp text message FROM THE USER\'S OWN ACCOUNT. It goes out under their name and cannot be recalled, so send only what the user asked you to send, to the person they named, and ask when anything is unclear. ' +
          '`to` is a phone number with country code (+40722123456 — never a national number starting with 0), a contact or group name that matches exactly ONE chat, a JID, or "me" for the user\'s own chat. ' +
          'If a name matches several chats nothing is sent and the candidates are returned: ask the user which one. ' +
          'Messages are paced (a few seconds apart) and capped per hour; one message at a time, no broadcasting to lists.',
        {
          to: z
            .string()
            .min(1)
            .describe('Phone number with country code, a contact/group name, a JID, or "me".'),
          text: z.string().min(1).describe('The message text, exactly as it should arrive.'),
        },
        async (args): Promise<ToolResult> => {
          try {
            const sent = await sendWhatsAppText({ to: args.to, text: args.text });
            return ok(
              `Sent to ${sent.label}${sent.label === sent.jid ? '' : ` (${sent.jid})`}.` +
                (sent.messageId ? ` Message id ${sent.messageId}.` : ''),
            );
          } catch (e) {
            // WhatsAppSendError messages are written for the model to act on
            // (ask which Maria, add the country code); anything else is an
            // unexpected failure and is passed through verbatim.
            const msg = e instanceof Error ? e.message : String(e);
            return err(e instanceof WhatsAppSendError ? msg : `WhatsApp error: ${msg}`);
          }
        },
      ),
    ],
  });
}
