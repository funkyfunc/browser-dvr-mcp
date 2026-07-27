// Mock-free unit tests for SessionRecorder: real store (temp-sandboxed), injected
// capture deps + a real EventBus. No Chrome.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { EventBus } from '../../src/core/EventBus.js';
import { SessionArchiveStore } from '../../src/timemachine/SessionArchiveStore.js';
import { SessionRecorder, type CaptureDeps } from '../../src/timemachine/SessionRecorder.js';
import { TimeMachine } from '../../src/timemachine/SessionArchive.js';

const SANDBOX = path.join(os.tmpdir(), `bbmcp-recorder-test-${process.pid}`);
let savedEnv: string | undefined;
let savedNoVisual: string | undefined;

beforeEach(() => {
  savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
  savedNoVisual = process.env.BROWSER_MCP_NO_VISUAL;
  process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
  delete process.env.BROWSER_MCP_NO_VISUAL;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
  else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
  if (savedNoVisual === undefined) delete process.env.BROWSER_MCP_NO_VISUAL;
  else process.env.BROWSER_MCP_NO_VISUAL = savedNoVisual;
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwA//9k=';

function deps(clock: { t: number }): CaptureDeps {
  return {
    grabFrame: async () => ({ base64: TINY_JPEG_B64, width: 1, height: 1 }),
    grabStorage: async () => ({
      localStorage: { theme: 'dark' },
      sessionStorage: {},
      cookies: [{ name: 'sid', value: 'abc' }],
    }),
    grabState: async () => ({ url: 'https://app/x', title: 'X' }),
    now: () => clock.t,
  };
}

describe('SessionRecorder', () => {
  it('buffers bus events and captures keyframes, then builds a reconstructable archive', async () => {
    const store = new SessionArchiveStore();
    const rec = new SessionRecorder(store);
    const bus = new EventBus();
    const clock = { t: 1000 };

    rec.attach(bus, 'sess-rec-1', 'https://app/x');
    bus.emit('navigation', 'page-controlled', { url: 'https://app/x' }, 1000);

    await rec.captureKeyframe(deps(clock)); // t=1000
    clock.t = 2000;
    bus.emit('action', 'tool-output', { action: 'click', success: true }, 2000);
    await rec.captureKeyframe(deps(clock)); // t=2000

    const archive = await rec.save(2500, 'my-session');
    expect(archive).not.toBeNull();
    expect(archive!.meta.name).toBe('my-session');
    expect(archive!.events.length).toBe(2);
    // One of each modality per capture, twice.
    expect(archive!.keyframes.filter((k) => k.kind === 'visual').length).toBe(2);
    expect(archive!.keyframes.filter((k) => k.kind === 'storage').length).toBe(2);

    // Reconstruct at t=2000: screen/storage/state all present, action anchored.
    const m = TimeMachine.reconstructAt(archive!, { at: 2000 });
    expect(m.screen).not.toBeNull();
    expect(m.storage?.localStorage).toEqual({ theme: 'dark' });
    expect((m.action?.data as any).action).toBe('click');

    // The frame really is on disk as JPEG bytes.
    const abs = store.frameAbsolutePath('sess-rec-1', m.screen!.path);
    const bytes = readFileSync(abs);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('honors BROWSER_MCP_NO_VISUAL: keeps storage/state, skips frames', async () => {
    process.env.BROWSER_MCP_NO_VISUAL = '1';
    const store = new SessionArchiveStore();
    const rec = new SessionRecorder(store);
    const bus = new EventBus();
    rec.attach(bus, 'sess-rec-2', 'https://app/x');
    await rec.captureKeyframe(deps({ t: 1000 }));
    const archive = rec.buildArchive(1000);
    expect(archive.keyframes.some((k) => k.kind === 'visual')).toBe(false);
    expect(archive.keyframes.some((k) => k.kind === 'storage')).toBe(true);
  });

  it('is a no-op when BROWSER_MCP_NO_MEMORY=1', async () => {
    const prev = process.env.BROWSER_MCP_NO_MEMORY;
    process.env.BROWSER_MCP_NO_MEMORY = '1';
    try {
      const store = new SessionArchiveStore();
      const rec = new SessionRecorder(store);
      const bus = new EventBus();
      rec.attach(bus, 'sess-rec-3', 'https://app/x');
      bus.emit('action', 'tool-output', { action: 'click', success: true }, 1000);
      await rec.captureKeyframe(deps({ t: 1000 }));
      expect(await rec.save(1000)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.BROWSER_MCP_NO_MEMORY;
      else process.env.BROWSER_MCP_NO_MEMORY = prev;
    }
  });

  it('never throws when a capture grab fails', async () => {
    const store = new SessionArchiveStore();
    const rec = new SessionRecorder(store);
    const bus = new EventBus();
    rec.attach(bus, 'sess-rec-4', 'https://app/x');
    const brokenDeps: CaptureDeps = {
      grabFrame: async () => {
        throw new Error('screencast down');
      },
      grabStorage: async () => {
        throw new Error('storage blocked');
      },
      grabState: async () => ({ url: 'https://app/x' }),
      now: () => 1000,
    };
    await expect(rec.captureKeyframe(brokenDeps)).resolves.toBeUndefined();
    const archive = rec.buildArchive(1000);
    // Only the state grab succeeded.
    expect(archive.keyframes.map((k) => k.kind)).toEqual(['state']);
  });
});
