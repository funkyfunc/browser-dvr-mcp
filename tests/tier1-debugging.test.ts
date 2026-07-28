// End-to-end: the Tier-1 debugging tools — HAR export, timeline query, backward
// data-breakpoint (when_changed), and verify checkpoints — against a live page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-tier1-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const text = (r: any) => r.content[0].text as string;

describe('Tier-1 debugging tools', () => {
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

  it('browser_verify records a passing checkpoint on the timeline', async () => {
    const res = await handler('browser_verify')({
      type: 'text',
      value: 'Adversarial',
      label: 'page-loaded',
    });
    const out = JSON.parse(text(res));
    expect(out.passed).toBe(true);
    expect(out.label).toBe('page-loaded');
  });

  it('browser_query_timeline finds the recorded verify checkpoint', async () => {
    const res = await handler('browser_query_timeline')({ textContains: 'verify' });
    const out = JSON.parse(text(res));
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.events.some((e: any) => e.data?.type === 'verify')).toBe(true);
  });

  it('browser_when_changed(url) finds the navigation to the page', async () => {
    const res = await handler('browser_when_changed')({ type: 'url' });
    const out = JSON.parse(text(res));
    expect(out.found).toBe(true);
    expect(out.to).toContain('adversarial_testbed');
  });

  it('browser_export_har returns a valid HAR 1.2 archive', async () => {
    const res = await handler('browser_export_har')({});
    const har = JSON.parse(text(res));
    expect(har.log.version).toBe('1.2');
    expect(Array.isArray(har.log.entries)).toBe(true);
  });

  it('browser_verify reports a failing checkpoint clearly', async () => {
    const res = await handler('browser_verify')({
      type: 'text',
      value: 'NoSuchTextOnPageXYZ',
      timeoutMs: 300,
    });
    expect(JSON.parse(text(res)).passed).toBe(false);
  });
});
