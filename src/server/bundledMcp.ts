/**
 * MCP servers that ship INSIDE cloudchat, as opposed to the ones a user or
 * agent defines at runtime.
 *
 * They are ordinary rows in the MCP registry (transport `bundled`, seeded on
 * first read — see mcpRegistry.ts), which is the whole point: the same
 * per-folder attach/detach switch, the same `mcp list` / `attach` tools, the
 * same management modal. A bundled server is simply one whose "how to reach
 * it" is code in this repo instead of a command or a URL. It is OFF everywhere
 * until a folder attaches it.
 *
 * The factory is async and `import()`s lazily so that listing the registry
 * never loads a server's dependencies — the WhatsApp one pulls in a ~90 MB
 * client library that nothing should pay for until it is attached and used.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type BundledMcpServer = {
  /** Registry name, and therefore the tool namespace (`mcp__whatsapp__…`). */
  name: string;
  /** One line for the management UI and for `mcp list`. */
  description: string;
  /**
   * A FRESH server instance every call — an `McpServer` binds to a single
   * transport, so one shared instance would refuse its second connection.
   */
  create: () => Promise<{ instance: { connect(transport: Transport): Promise<void> } }>;
};

export const BUNDLED_MCP_SERVERS: Record<string, BundledMcpServer> = {
  whatsapp: {
    name: 'whatsapp',
    description:
      "Send WhatsApp messages from the user's own account. Needs a one-time link (WhatsApp button in the top bar).",
    create: async () => (await import('./whatsappTools')).createWhatsAppMcpServer(),
  },
};

export function getBundledMcpServer(key: string | null): BundledMcpServer | null {
  if (!key || !Object.hasOwn(BUNDLED_MCP_SERVERS, key)) return null;
  return BUNDLED_MCP_SERVERS[key];
}
