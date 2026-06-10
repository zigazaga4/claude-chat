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
 * chat session. The file is read fresh each time a session starts, so edits
 * (including ones made through the in-app editor) apply to the next message
 * without a server restart.
 */

/**
 * The single file the system prompt lives in — both reads and the in-app
 * editor's writes resolve through here. An explicit
 * $CLAUDE_CHAT_SYSTEM_PROMPT_PATH always wins; otherwise the project-root
 * file is preferred, falling back to ~/.claude-chat/system-prompt.md when
 * only that one exists.
 */
export function systemPromptPath(): string {
  const envPath = process.env.CLAUDE_CHAT_SYSTEM_PROMPT_PATH;
  if (envPath && envPath.trim()) return envPath.trim();
  const projectFile = path.join(process.cwd(), 'system-prompt.local.md');
  const homeFile = path.join(os.homedir(), '.claude-chat', 'system-prompt.md');
  if (!fs.existsSync(projectFile) && fs.existsSync(homeFile)) return homeFile;
  return projectFile;
}

/**
 * The operator prompt prefix prepended to a session's system prompt.
 * Empty string when no prompt file is configured.
 */
export function readSystemPrompt(): string {
  try {
    return fs.readFileSync(systemPromptPath(), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Persist the operator prompt. An empty/whitespace text clears the prompt. */
export function writeSystemPrompt(text: string): void {
  const target = systemPromptPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const trimmed = text.trimEnd();
  fs.writeFileSync(target, trimmed ? `${trimmed}\n` : '');
}
