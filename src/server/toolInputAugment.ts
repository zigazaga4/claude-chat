/**
 * Attaches the pre-edit contents of a file to `Write` / `Edit` tool inputs.
 *
 * The UI renders those two tools as a diff, which needs the "before" side — and
 * by the time a tool result arrives the file on disk is already the "after".
 * So the prior contents are read at call time and ride along on the input as
 * `_priorContent`.
 *
 * Shared by both backends: the Agent SDK path calls this from its `canUseTool`
 * hook, the OpenCode path from its tool-part mapper. Keeping it here means the
 * diff behaves identically no matter which harness ran the turn.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Ceiling on what gets snapshotted. Past this the diff view is not useful
 * anyway, and the contents would be held in memory and persisted with the
 * message.
 */
const MAX_PRIOR_BYTES = 256 * 1024;

export function readPriorFileContent(
  cwd: string,
  filePath: string,
): string | null {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_PRIOR_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    // A brand-new file has no prior contents, and an unreadable one must not
    // take the turn down — either way the diff simply renders one-sided.
    return null;
  }
}

/**
 * Return `input` with `_priorContent` added, for the tools that render as a
 * diff. Any other tool is passed through untouched.
 *
 * `name` is the tool name as the UI knows it, so callers on the OpenCode path
 * must normalise (`edit` → `Edit`) before calling.
 */
export function augmentToolInput(
  name: string,
  input: unknown,
  cwd: string,
): unknown {
  if (name !== 'Write' && name !== 'Edit') return input;
  const obj =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : '';
  if (!filePath) return input;
  return { ...obj, _priorContent: readPriorFileContent(cwd, filePath) };
}
