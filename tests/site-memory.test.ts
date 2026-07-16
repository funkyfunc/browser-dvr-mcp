// End-to-end: an action in one session is recalled by origin in the next.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-sitemem-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Site Memory (recall across sessions)', () => {
  let savedEnv: string | undefined;
  beforeAll(() => {
    savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
    process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
  });
  afterAll(() => {
    if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
    else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  });

  it('learns from session 1 and recalls in session 2', async () => {
    // Session 1: perceive, click a real element (records a landmark), then close (flush).
    await handler('browser_launch')({ headless: true, url: PAGE });
    const surface = await handler('get_semantic_surface')({ format: 'json' });
    const nodes = JSON.parse(surface.content[0].text).nodes;
    const clickable = nodes.find((n: any) => n.name && n.backendNodeId && n.role !== 'generic');
    if (clickable) {
      await handler('atomic_interact')({ action: 'click', backendNodeId: clickable.backendNodeId });
    } else {
      await handler('atomic_interact')({ action: 'click', coordinate: [100, 100] });
    }
    await handler('browser_close')({});

    // Session 2: same origin — recall should return a populated model.
    await handler('browser_launch')({ headless: true, url: PAGE });
    const recalled = await handler('browser_recall_site')({});
    const text = recalled.content[0].text as string;
    expect(text).not.toContain('first visit');
    const model = JSON.parse(text);
    expect(model.stats.visitCount).toBeGreaterThanOrEqual(1);
    // A flow (the click) was recorded.
    expect(model.flows.length).toBeGreaterThan(0);
    await handler('browser_close')({});
  });
});
