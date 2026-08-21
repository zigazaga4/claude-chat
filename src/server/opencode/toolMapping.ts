/**
 * Translates OpenCode's tool vocabulary into the one the UI already speaks.
 *
 * `src/components/tools/` renders each tool with a purpose-built view keyed by
 * the Claude Code tool name — `Edit`, `Bash`, `Grep` — reading specific input
 * fields (`file_path`, `old_string`) to draw diffs, command blocks, and match
 * lists. OpenCode names the same tools `edit` / `bash` / `grep` and passes
 * `filePath` / `oldString`.
 *
 * Rather than fork twenty renderers per backend, the difference is absorbed
 * here: names are mapped, inputs are renamed, and the UI cannot tell which
 * harness produced a turn. Anything unrecognised passes through and lands on
 * `GenericToolView`, so a tool added to OpenCode later degrades to a readable
 * default instead of breaking the transcript.
 *
 * Verified against a live OpenCode 1.18.11 server:
 *   built-ins  invalid, question, bash, read, glob, grep, edit, write, task,
 *              webfetch, todowrite, websearch, skill, apply_patch
 *   MCP tools  `<server>_<tool>` — our `notebook` server surfaces as
 *              `notebook_notebook`, the SSH server as `remote_bash`, etc.
 */

/**
 * OpenCode built-in → the name the UI's renderer registry expects.
 *
 * Absent entries are deliberate: `skill`, `apply_patch`, and `invalid` have no
 * Claude Code counterpart and no dedicated view, so they keep their own names
 * and render generically rather than being forced into a view whose input
 * shape they do not match.
 */
const BUILTIN_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  task: 'Task',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todowrite: 'TodoWrite',
  question: 'AskUserQuestion',
};

/**
 * Input keys whose rename is not mechanical.
 *
 * Everything else is handled by camelCase → snake_case, which already turns
 * `filePath` into `file_path`, `oldString` into `old_string`, and `replaceAll`
 * into `replace_all`. Only genuinely different names need listing.
 */
const FIELD_RENAMES: Record<string, Record<string, string>> = {
  // Claude Code's Grep calls the file filter `glob`; OpenCode calls it
  // `include`. GrepToolView reads `glob`.
  Grep: { include: 'glob' },
};

/** `filePath` → `file_path`; leaves already-snake and single-word keys alone. */
function camelToSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Map an OpenCode tool name to the UI's name.
 *
 * `mcpServerNames` are the servers this app published for the turn. They are
 * matched explicitly rather than by splitting on `_`, because built-ins like
 * `apply_patch` also contain an underscore and would otherwise be mistaken for
 * an MCP tool from a server called `apply`.
 */
export function toUiToolName(
  opencodeName: string,
  mcpServerNames: readonly string[],
): string {
  for (const server of mcpServerNames) {
    const prefix = `${server}_`;
    if (opencodeName.startsWith(prefix)) {
      // Matches the Agent SDK's naming, which the renderer registry already
      // keys on for the remote SSH tools.
      return `mcp__${server}__${opencodeName.slice(prefix.length)}`;
    }
  }
  return BUILTIN_NAMES[opencodeName] ?? opencodeName;
}

/**
 * Rename an OpenCode tool's input fields to what the UI view reads.
 *
 * Unknown keys are kept (snake-cased) rather than dropped: the transcript is
 * persisted from this object, and silently losing an argument would make a
 * stored turn an inaccurate record of what actually ran.
 */
export function toUiToolInput(uiToolName: string, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;

  const renames = FIELD_RENAMES[uiToolName] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[renames[key] ?? camelToSnake(key)] = value;
  }
  return out;
}
