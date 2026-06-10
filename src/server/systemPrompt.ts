import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Optional operator-defined system prompt prefix.
 *
 * The app ships with NO built-in system prompt: out of the box, sessions run
 * with only the runtime environment block the chat route assembles. To add
 * your own standing instructions, create one of these files — the first one
 * that exists and is non-empty wins:
 *
 *   1. The file pointed at by $CLAUDE_CHAT_SYSTEM_PROMPT_PATH
 *   2. <project root>/system-prompt.local.md   (gitignored)
 *   3. ~/.claude-chat/system-prompt.md
 *
 * The file's full contents are prepended to the system prompt of every new
 * chat session. Loaded once per server process — restart the server after
 * editing the file.
 */
function loadCorePrefix(): string {
  const candidates = [
    process.env.CLAUDE_CHAT_SYSTEM_PROMPT_PATH,
    path.join(process.cwd(), 'system-prompt.local.md'),
    path.join(os.homedir(), '.claude-chat', 'system-prompt.md'),
  ].filter((p): p is string => !!p);
  for (const candidate of candidates) {
    try {
      const text = fs.readFileSync(candidate, 'utf8').trim();
      if (text) return text;
    } catch {
      // Missing or unreadable file — fall through to the next candidate.
    }
  }
  return '';
}

/**
 * The operator prompt prefix prepended to every session's system prompt.
 * Empty string when no local prompt file is configured.
 */
export const CORE_PREFIX = loadCorePrefix();
