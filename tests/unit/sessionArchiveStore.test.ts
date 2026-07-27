// Mock-free unit tests for SessionArchiveStore: real disk (temp-sandboxed).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { SessionArchiveStore } from '../../src/timemachine/SessionArchiveStore.js';
import type { SessionArchive } from '../../src/timemachine/SessionArchive.js';

const SANDBOX = path.join(os.tmpdir(), `bbmcp-sessions-test-${process.pid}`);
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
  process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
  else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

function archive(id: string, startedAt: number): SessionArchive {
  return {
    version: 1,
    meta: { id, startedAt, endedAt: startedAt + 1000, eventCount: 1, origin: 'https_app' },
    events: [
      {
        seq: 1,
        timestamp: startedAt,
        kind: 'navigation',
        trust: 'page-controlled',
        data: { url: '/x' },
      },
    ],
    keyframes: [{ kind: 'state', timestamp: startedAt, url: 'https://app/x' }],
  };
}

// A 1x1 red JPEG.
const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=';

describe('SessionArchiveStore', () => {
  it('round-trips an archive and returns undefined for missing ids', async () => {
    const store = new SessionArchiveStore();
    expect(await store.load('nope')).toBeUndefined();
    await store.save(archive('sess-a', 1000));
    const loaded = await store.load('sess-a');
    expect(loaded?.meta.id).toBe('sess-a');
    expect(loaded?.events.length).toBe(1);
    expect(loaded?.keyframes[0].kind).toBe('state');
  });

  it('writes frames as binary and references them by relative path', async () => {
    const store = new SessionArchiveStore();
    const rel = await store.writeFrame('sess-b', 3, TINY_JPEG_B64);
    expect(rel).toBe(path.join('frames', 'frame_00003.jpg'));
    const abs = store.frameAbsolutePath('sess-b', rel);
    // Real JPEG bytes on disk, NOT the redacted text payload.
    const bytes = readFileSync(abs);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8); // JPEG SOI marker
  });

  it('lists saved sessions newest-first', async () => {
    const store = new SessionArchiveStore();
    await store.save(archive('old', 1000));
    await store.save(archive('new', 5000));
    const list = await store.list();
    expect(list.map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('redacts secret-shaped text in the persisted archive.json', async () => {
    const store = new SessionArchiveStore();
    const a = archive('sess-c', 1000);
    (a.events[0].data as any).url = 'https://app/cb?token=sk-ABCDEF1234567890ABCDEF1234567890';
    await store.save(a);
    const raw = readFileSync(
      path.join(SANDBOX, '.bbmcp', 'sessions', 'sess-c', 'archive.json'),
      'utf8',
    );
    expect(raw).not.toContain('sk-ABCDEF1234567890ABCDEF1234567890');
  });
});
