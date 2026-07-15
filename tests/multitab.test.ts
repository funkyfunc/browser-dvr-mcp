// End-to-end multi-tab support through the real MCP tool handlers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Multi-tab (Wave 4)', () => {
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

  it('opens, lists, switches, and closes tabs', async () => {
    // One tab after launch.
    let tabs = JSON.parse((await handler('browser_list_tabs')({})).content[0].text);
    expect(tabs.length).toBe(1);
    const firstId = tabs[0].tabId;
    expect(tabs[0].active).toBe(true);

    // Open a second tab -> becomes active.
    const openRes = await handler('browser_new_tab')({ url: 'about:blank' });
    expect(openRes.content[0].text).toMatch(/Opened and switched to tab-/);

    tabs = JSON.parse((await handler('browser_list_tabs')({})).content[0].text);
    expect(tabs.length).toBe(2);
    const active = tabs.find((t: any) => t.active);
    expect(active.tabId).not.toBe(firstId);
    const secondId = active.tabId;

    // Switch back to the first tab and confirm perception targets it.
    await handler('browser_switch_tab')({ tabId: firstId });
    tabs = JSON.parse((await handler('browser_list_tabs')({})).content[0].text);
    expect(tabs.find((t: any) => t.active).tabId).toBe(firstId);

    const surface = await handler('get_semantic_surface')({});
    expect(surface.content[0].text.length).toBeGreaterThan(0);

    // Close the second tab.
    await handler('browser_close_tab')({ tabId: secondId });
    tabs = JSON.parse((await handler('browser_list_tabs')({})).content[0].text);
    expect(tabs.length).toBe(1);
    expect(tabs[0].tabId).toBe(firstId);
  });

  it('refuses to close the last remaining tab', async () => {
    const tabs = JSON.parse((await handler('browser_list_tabs')({})).content[0].text);
    expect(tabs.length).toBe(1);
    await expect(handler('browser_close_tab')({ tabId: tabs[0].tabId })).rejects.toThrow(
      /last tab/,
    );
  });
});
