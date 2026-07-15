// ─── Path Containment ───────────────────────────────────────────────────────
// Confines all agent-controlled file writes (screenshots, recordings, DVR
// dumps, session history) to a single output base directory so a crafted or
// prompt-injected path cannot write outside it.
//
// This replaces the former `resolveSafePath`, which returned absolute paths
// verbatim and let `../` escape the working directory — i.e. a write-anywhere
// primitive with a reassuring name.

import os from 'os';
import path from 'path';

/**
 * The directory all agent-controlled file writes are confined to. Defaults to
 * the working directory (or a tmpdir when launched from filesystem root);
 * override with BROWSER_MCP_OUTPUT_DIR for an explicit sandbox.
 */
export function outputBaseDir(): string {
  const override = process.env.BROWSER_MCP_OUTPUT_DIR;
  if (override && path.isAbsolute(override)) {
    return path.resolve(override);
  }
  let baseDir = process.cwd();
  if (baseDir === '/' || baseDir === '\\') {
    baseDir = path.join(os.tmpdir(), 'best-browser-mcp');
  }
  return path.resolve(baseDir);
}

/**
 * Resolve an agent-supplied output path and confine it to `outputBaseDir()`.
 * Both relative paths (`recordings/x`) and absolute paths inside the base are
 * accepted; anything that escapes the base via `..` or an absolute path outside
 * it throws.
 *
 * Note: containment is lexical. A pre-existing symlink inside the base that
 * points outside it is not resolved here; the base is expected not to contain
 * attacker-controlled symlinks.
 */
export function resolveSafePath(userPath: string): string {
  const base = outputBaseDir();
  const resolved = path.resolve(base, userPath);
  const rel = path.relative(base, resolved);
  if (rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))) {
    throw new Error(
      `Refusing to write outside the allowed output directory (${base}): "${userPath}". ` +
        `Set BROWSER_MCP_OUTPUT_DIR to change the sandbox.`,
    );
  }
  return resolved;
}
