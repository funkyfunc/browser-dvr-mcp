// End-to-end: in-session human handoff. The agent begins a handoff, a human
// reproduces something (simulated by pushing to the in-page tracker buffer), and
// the human's actions land on the session timeline as `user` provenance and in
// the durable flight-recorder archive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-handoff-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('In-session human handoff', () => {
  let savedEnv: string | undefined;
  beforeAll(async () => {
    savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
    process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
    await handler('browser_launch')({ headless: true, url: PAGE });
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

  it('records simulated human actions as user-provenance events and returns a summary', async () => {
    const begin = await handler('browser_begin_handoff')({ note: 'reproduce the modal bug' });
    expect(begin.content[0].text).toContain('Handoff started');

    // Simulate a human interacting: push events into the in-page tracker buffer
    // exactly as the injected click/input listeners would, then let the poller drain.
    await handler('evaluate_in_context')({
      expression: `(() => {
        window.__bbmcp_human_events = window.__bbmcp_human_events || [];
        window.__bbmcp_human_events.push({ type: 'click', x: 10, y: 20, target: 'button#buy', text: 'Buy', timestamp: Date.now() });
        window.__bbmcp_human_events.push({ type: 'input', target: 'input#qty', value: '3', timestamp: Date.now() });
        return true;
      })()`,
    });
    await sleep(700); // one poll cycle (500ms)

    const end = await handler('browser_end_handoff')({});
    const summary = JSON.parse(end.content[0].text.split('\n\n')[0]);
    expect(summary.active).toBe(false);
    expect(summary.interactionCount).toBeGreaterThanOrEqual(2);

    // The human's actions are on the timeline tagged `user`.
    const timeline = JSON.parse(
      (await handler('browser_get_timeline')({ trust: 'user' })).content[0].text,
    );
    const kinds = timeline.map((e: any) => e.data?.type);
    expect(kinds).toContain('handoff-start');
    expect(kinds).toContain('handoff-end');
    expect(timeline.some((e: any) => e.data?.source === 'human')).toBe(true);
    expect(timeline.every((e: any) => e.trust === 'user')).toBe(true);
  });

  it('surfaces the human reproduction in a timetravel reconstruction', async () => {
    const res = await handler('browser_timetravel')({});
    const moment = JSON.parse(res.content[0].text);
    // The windowed events include the user-provenance handoff markers/actions.
    const hasUser = moment.events.some((e: any) => e.trust === 'user');
    expect(hasUser).toBe(true);
  });

  it('errors when ending a handoff that was never started', async () => {
    await expect(handler('browser_end_handoff')({})).rejects.toThrow(/No active handoff/);
  });
});
