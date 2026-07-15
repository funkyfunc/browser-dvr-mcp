// End-to-end: an action recorded on the event bus is explainable and exportable
// through the real MCP tool handlers (drives a real headless Chrome).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { server } from '../src/index.js';

const TEST_PAGE_URL = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Causal explain + repro export (Wave 3)', () => {
  beforeAll(async () => {
    await handler('browser_launch')({ headless: true, url: TEST_PAGE_URL });
  });

  afterAll(async () => {
    try {
      await handler('browser_close')({});
    } catch {
      // ignore
    }
  });

  it('explains the most recent action from the recorded timeline', async () => {
    // Find a clickable element and click it via coordinates (guaranteed to
    // register an action event regardless of hit result).
    await handler('atomic_interact')({ action: 'click', coordinate: [100, 100] });

    const res = await handler('browser_explain_last_action')({ windowMs: 1500 });
    const report = JSON.parse(res.content[0].text);

    expect(report.action).not.toBeNull();
    expect(report.action.action).toBe('click');
    expect(report.window.toMs).toBeGreaterThan(report.window.fromMs);
    expect(typeof report.summary).toBe('string');
    expect(report.summary.length).toBeGreaterThan(0);
  });

  it('exports a repro bundle listing the recorded action(s)', async () => {
    const res = await handler('browser_export_repro')({});
    const script = res.content[0].text as string;
    expect(script).toContain('# Repro script');
    expect(script).toContain('click');
  });

  it('re-drives the current session deterministically', async () => {
    const res = await handler('browser_replay')({});
    const report = JSON.parse(res.content[0].text);
    // The earlier coordinate click was recorded with resolved coordinates, so
    // it should replay rather than be skipped.
    expect(report.replayed).toBeGreaterThan(0);
    expect(report.steps.some((s: any) => s.action === 'click' && s.status === 'replayed')).toBe(
      true,
    );
  });
});
