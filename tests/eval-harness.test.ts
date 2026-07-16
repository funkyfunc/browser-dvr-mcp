// End-to-end: save a scenario from a live session, then re-run it and assert.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-eval-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Eval / regression harness', () => {
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

  it('saves a scenario and re-runs it with a passing assertion', async () => {
    await handler('atomic_interact')({ action: 'click', coordinate: [100, 100] });

    // The testbed's <title> text is stably present on the page.
    const save = await handler('browser_save_scenario')({
      name: 'testbed-loads',
      assertions: [{ type: 'text', value: 'Adversarial' }],
    });
    expect(save.content[0].text).toContain('Saved scenario');

    const run = await handler('browser_run_scenario')({ name: 'testbed-loads' });
    const result = JSON.parse(run.content[0].text);
    expect(result.passed).toBe(true);
    expect(result.assertions[0].met).toBe(true);
  });

  it('reports failure when an assertion does not hold', async () => {
    await handler('browser_save_scenario')({
      name: 'bad-assert',
      assertions: [{ type: 'text', value: 'ThisTextIsNotOnThePageXYZ' }],
    });
    const run = await handler('browser_run_scenario')({ name: 'bad-assert' });
    const result = JSON.parse(run.content[0].text);
    expect(result.passed).toBe(false);
    expect(result.assertions[0].met).toBe(false);
  });

  it('errors clearly for an unknown scenario', async () => {
    await expect(handler('browser_run_scenario')({ name: 'does-not-exist' })).rejects.toThrow(
      /No scenario named/,
    );
  });
});
