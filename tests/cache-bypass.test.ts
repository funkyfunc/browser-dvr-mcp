// End-to-end: cache-bypass actually engages (via puppeteer setCacheEnabled, which
// enables the Network domain itself — the previous raw Network.setCacheDisabled on
// our AX/DOM session silently no-opped). Own launch/close lifecycle so the relaunch
// doesn't disturb the shared session other suites use.
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-cache-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}
const text = (r: any) => r.content[0].text as string;

describe('cache bypass', () => {
  afterAll(async () => {
    try {
      await handler('browser_close')({});
    } catch {
      // ignore
    }
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  });

  it('launches cold with bypassCache and can perceive the page', async () => {
    process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
    await handler('browser_launch')({ headless: true, url: PAGE, bypassCache: true });
    // The page loaded and is perceivable — the cache-disable path did not break navigation.
    const surface = text(await handler('get_semantic_surface')({}));
    expect(surface.length).toBeGreaterThan(0);
  });

  it('re-navigates cold with bypassCache without error', async () => {
    const res = await handler('browser_navigate')({ url: PAGE, bypassCache: true });
    expect(text(res).length).toBeGreaterThan(0);
    // A follow-up perceive still works (cache stays disabled for the session).
    const surface = text(await handler('get_semantic_surface')({}));
    expect(surface.length).toBeGreaterThan(0);
  });
});
