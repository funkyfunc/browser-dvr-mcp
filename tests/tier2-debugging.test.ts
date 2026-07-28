// End-to-end: Tier-2 debugging tools — anchors, state_diff, and first-point-of-
// failure trajectory analysis — against a live page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-tier2-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const text = (r: any) => r.content[0].text as string;

describe('Tier-2 debugging tools', () => {
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

  it('browser_timetravel returns a composable anchor token', async () => {
    const moment = JSON.parse(text(await handler('browser_timetravel')({})));
    expect(typeof moment.anchor).toBe('string');
    expect(moment.anchor.startsWith('anc_')).toBe(true);
  });

  it('browser_state_diff diffs two anchored moments and returns valid structure', async () => {
    const a1 = JSON.parse(text(await handler('browser_timetravel')({}))).anchor;
    const a2 = JSON.parse(text(await handler('browser_timetravel')({}))).anchor;
    const diff = JSON.parse(text(await handler('browser_state_diff')({ from: a1, to: a2 })));
    expect(diff.source).toMatch(/^sess_/);
    expect(diff.localStorage).toHaveProperty('added');
    expect(diff.url).toHaveProperty('changed');
    expect(diff.between).toHaveProperty('networkFailures');
  });

  it('browser_analyze_run finds a failed verify as the first point of failure', async () => {
    // Plant a failing checkpoint, which analyze_run should surface.
    await handler('browser_verify')({
      type: 'text',
      value: 'DefinitelyNotOnPageXYZ',
      timeoutMs: 200,
    });
    const report = JSON.parse(text(await handler('browser_analyze_run')({})));
    expect(report.failureCount).toBeGreaterThanOrEqual(1);
    expect(report.firstFailure).not.toBeNull();
    expect(report.firstFailure.category).toBe('assertion-failed');
    // The first failure carries a causal explanation.
    expect(report).toHaveProperty('firstFailureDetail');
  });
});
