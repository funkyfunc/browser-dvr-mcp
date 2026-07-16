// ─── Local JSON persistence ─────────────────────────────────────────────────
// A tiny store for durable, structural-only data (site memory, saved eval
// scenarios) kept under the sandboxed output directory. Everything written here
// is (a) contained to outputBaseDir() via resolveSafePath and (b) passed through
// redactText as a backstop so no token/secret survives to disk.

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { resolveSafePath } from '../security/resolvePath.js';
import { redactText } from '../security/redaction.js';

const ROOT = '.bbmcp';

/** Slugify an arbitrary key into a safe filename component. */
function slug(key: string): string {
  const s = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || 'default';
}

/**
 * Derive a stable, filesystem-safe key from a URL's origin. Real apps have an
 * http(s) origin; file:// URLs are opaque-origin, so we key them by directory.
 */
export function originKey(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:') return 'about';
    if (u.protocol === 'file:') {
      const dir = u.pathname.replace(/\/[^/]*$/, ''); // strip filename
      return `file_${slug(dir)}`;
    }
    return slug(`${u.protocol}${u.host}`);
  } catch {
    return slug(url);
  }
}

export class JsonStore<T> {
  constructor(private readonly namespace: string) {}

  private file(key: string): string {
    return resolveSafePath(path.join(ROOT, this.namespace, `${slug(key)}.json`));
  }

  /** Read a stored value, or `undefined` if absent/unreadable. */
  async read(key: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.file(key), 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  /** Write a value, redacting the serialized payload as a backstop. */
  async write(key: string, value: T): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true }).catch(() => {});
    await writeFile(file, redactText(JSON.stringify(value, null, 2)));
  }

  /**
   * Read-modify-write under a merge function. Returns the merged value. Note:
   * single-process only (no cross-process locking) — fine for a local dev tool.
   */
  async merge(key: string, merger: (existing: T | undefined) => T): Promise<T> {
    const existing = await this.read(key);
    const merged = merger(existing);
    await this.write(key, merged);
    return merged;
  }

  /** List keys present in this namespace (best-effort; empty on error). */
  async keys(): Promise<string[]> {
    try {
      const { readdir } = await import('fs/promises');
      const dir = resolveSafePath(path.join(ROOT, this.namespace));
      const files = await readdir(dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}
