// End-to-end: the fused perception spine attaches DOMSnapshot geometry onto the
// AX node model and exposes it via the structured-JSON output.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Fused perception spine (Wave 1 full)', () => {
  beforeAll(async () => {
    await handler('browser_launch')({ headless: true, url: PAGE });
  });
  afterAll(async () => {
    try {
      await handler('browser_close')({});
    } catch {
      // ignore
    }
  });

  it('markdown output still carries roles, names, and ids (spine intact)', async () => {
    const res = await handler('get_semantic_surface')({});
    const md = res.content[0].text as string;
    expect(md).toMatch(/\[.*\]/); // has role tags
    expect(md).toContain('id:'); // has backendNodeId tags
  });

  it('json output fuses geometry (boundingBox/visible/clickable) onto nodes', async () => {
    const res = await handler('get_semantic_surface')({ format: 'json' });
    const parsed = JSON.parse(res.content[0].text);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(parsed.nodes.length).toBeGreaterThan(0);

    // At least some nodes should have real geometry fused from the snapshot.
    const withBox = parsed.nodes.filter(
      (n: any) => n.boundingBox && n.boundingBox.width > 0 && n.boundingBox.height > 0,
    );
    expect(withBox.length).toBeGreaterThan(0);
    // Fused fields are present on geometry-bearing nodes.
    expect(withBox[0]).toHaveProperty('visible');
    expect(withBox.some((n: any) => typeof n.clickable === 'boolean')).toBe(true);
  });
});
