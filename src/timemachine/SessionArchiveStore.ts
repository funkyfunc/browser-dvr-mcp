// ─── Session Archive Store ──────────────────────────────────────────────────
// Durability capstone: persists a SessionArchive to disk so an agent can re-open
// and scrub a session hours or days later. Layout, contained to the sandbox via
// resolveSafePath:
//
//   .bbmcp/sessions/<id>/archive.json     meta + events + non-visual keyframes
//   .bbmcp/sessions/<id>/frames/*.jpg     visual keyframes (binary)
//
// archive.json goes through redactText (secrets scrubbed as a backstop). Visual
// frames are written as raw bytes and NEVER through the text redactor, which
// would corrupt image data; the archive references them by relative path.

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import path from 'path';
import { resolveSafePath } from '../security/resolvePath.js';
import { redactText } from '../security/redaction.js';
import type { SessionArchive, SessionMeta } from './SessionArchive.js';

const ROOT = '.bbmcp';
const NS = 'sessions';

function slugId(id: string): string {
  const s = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || 'session';
}

export class SessionArchiveStore {
  private sessionDir(id: string): string {
    return resolveSafePath(path.join(ROOT, NS, slugId(id)));
  }

  private archiveFile(id: string): string {
    return path.join(this.sessionDir(id), 'archive.json');
  }

  /** Absolute path to this session's frames directory (created on demand). */
  framesDir(id: string): string {
    return path.join(this.sessionDir(id), 'frames');
  }

  /**
   * Write a visual frame as raw bytes and return its path RELATIVE to the session
   * dir (what a VisualKeyframe stores). `base64` is the JPEG payload.
   */
  async writeFrame(id: string, seq: number, base64: string): Promise<string> {
    const dir = this.framesDir(id);
    await mkdir(dir, { recursive: true }).catch(() => {});
    const rel = path.join('frames', `frame_${String(seq).padStart(5, '0')}.jpg`);
    const abs = path.join(this.sessionDir(id), rel);
    await writeFile(abs, Buffer.from(base64, 'base64'));
    return rel;
  }

  /** Absolute path for a frame's session-relative path (for reads by the agent). */
  frameAbsolutePath(id: string, relPath: string): string {
    return resolveSafePath(path.join(ROOT, NS, slugId(id), relPath));
  }

  /** Persist the archive.json (meta + events + non-visual keyframes), redacted. */
  async save(archive: SessionArchive): Promise<void> {
    const dir = this.sessionDir(archive.meta.id);
    await mkdir(dir, { recursive: true }).catch(() => {});
    await writeFile(
      this.archiveFile(archive.meta.id),
      redactText(JSON.stringify(archive, null, 2)),
    );
  }

  /** Re-open a saved archive, or undefined if absent/unreadable. */
  async load(id: string): Promise<SessionArchive | undefined> {
    try {
      const raw = await readFile(this.archiveFile(id), 'utf8');
      return JSON.parse(raw) as SessionArchive;
    } catch {
      return undefined;
    }
  }

  /** List saved sessions' metadata, newest first (best-effort). */
  async list(): Promise<SessionMeta[]> {
    try {
      const base = resolveSafePath(path.join(ROOT, NS));
      const ids = await readdir(base);
      const metas: SessionMeta[] = [];
      for (const id of ids) {
        const archive = await this.load(id);
        if (archive?.meta) metas.push(archive.meta);
      }
      return metas.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    } catch {
      return [];
    }
  }
}
