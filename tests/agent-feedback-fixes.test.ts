// End-to-end coverage for the agent-feedback fixes: navigate bypassCache,
// timeline kind filters, analyze_run activity summary on a passive session,
// and the browser_help orientation tool.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-feedback-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const text = (r: any) => r.content[0].text as string;

describe('agent-feedback fixes', () => {
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

  it('browser_navigate accepts bypassCache without error (cold reload)', async () => {
    const res = await handler('browser_navigate')({ url: PAGE, bypassCache: true });
    expect(text(res).length).toBeGreaterThan(0);
  });

  it('browser_help returns a grouped orientation', async () => {
    const help = text(await handler('browser_help')({}));
    expect(help).toContain('PERCEIVE');
    expect(help).toContain('predicate');
    expect(help).toContain('TIME-TRAVEL');
  });

  it('records evaluate + wait, and analyze_run summarizes a passive session', async () => {
    await handler('evaluate_in_context')({ expression: '1 + 1' });
    await handler('browser_wait_for')({ type: 'predicate', value: 'true' });

    const report = JSON.parse(text(await handler('browser_analyze_run')({})));
    expect(report.failureCount).toBe(0);
    expect(report.activity.evaluations).toBeGreaterThanOrEqual(1);
    expect(report.activity.waits).toBeGreaterThanOrEqual(1);
    expect(report.activity.navigations).toBeGreaterThanOrEqual(1);
    expect(report.summary).toContain('No failures');
  });

  it('browser_get_timeline filters out high-churn kinds', async () => {
    const filtered = JSON.parse(
      text(await handler('browser_get_timeline')({ excludeKinds: ['mutation'], limit: 200 })),
    );
    expect(filtered.every((e: any) => e.kind !== 'mutation')).toBe(true);

    const onlyInteractions = JSON.parse(
      text(await handler('browser_get_timeline')({ kinds: ['interaction'], limit: 200 })),
    );
    expect(onlyInteractions.every((e: any) => e.kind === 'interaction')).toBe(true);
    // The evaluate/wait we recorded show up as interactions.
    expect(onlyInteractions.some((e: any) => e.data?.type === 'evaluate')).toBe(true);
  });
});
