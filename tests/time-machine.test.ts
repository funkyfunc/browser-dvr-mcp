// End-to-end: the Time Machine flight recorder against a live page. Launch,
// interact, then scrub the session — reconstruct a moment (screen/storage/state/
// events), save it durably, list it, re-open it, and scrub the loaded archive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync, readFileSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-timemachine-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Time Machine', () => {
  let savedEnv: string | undefined;
  beforeAll(async () => {
    savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
    process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
    await handler('browser_launch')({ headless: true, url: PAGE });
    // Give the screencast a beat to produce at least one frame, and let a
    // keyframe interval fire.
    await sleep(1200);
    await handler('atomic_interact')({ action: 'click', coordinate: [100, 100] });
  });
  afterAll(async () => {
    try {
      await handler('browser_close')({});
    } catch {
      // ignore
    }
    if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
    else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  });

  it('reconstructs a synchronized moment from the live session', async () => {
    const res = await handler('browser_timetravel')({});
    const moment = JSON.parse(res.content[0].text);
    expect(moment.source).toMatch(/^sess_/);
    // Storage + state keyframes are captured reliably (no screencast dependency).
    expect(moment.storage).not.toBeNull();
    expect(typeof moment.storage.localStorage).toBe('object');
    expect(moment.state).not.toBeNull();
    expect(moment.state.url).toContain('adversarial_testbed');
    // The event timeline is present (at least the initial navigation).
    expect(Array.isArray(moment.events)).toBe(true);
  });

  it('exposes a readable screen frame path when a visual keyframe exists', async () => {
    const res = await handler('browser_timetravel')({});
    const moment = JSON.parse(res.content[0].text);
    if (moment.screen) {
      // If captured, the frame is real JPEG bytes on disk at the absolute path.
      const bytes = readFileSync(moment.screen.absolutePath);
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    }
  });

  it('saves, lists, loads, and scrubs a durable session archive', async () => {
    const save = await handler('browser_save_session')({ name: 'testbed-run' });
    expect(save.content[0].text).toContain('Saved session');

    const list = JSON.parse((await handler('browser_list_sessions')({})).content[0].text);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const id = list[0].id;

    const load = await handler('browser_load_session')({ id });
    expect(load.content[0].text).toContain('Loaded session');

    // Now timetravel operates on the loaded archive.
    const res = await handler('browser_timetravel')({ beforeLastError: false });
    const moment = JSON.parse(res.content[0].text);
    expect(moment.source).toBe(id);
    expect(moment.state?.url).toContain('adversarial_testbed');
  });

  it('errors clearly for an unknown session id', async () => {
    await expect(handler('browser_load_session')({ id: 'does-not-exist' })).rejects.toThrow(
      /No saved session/,
    );
  });
});
