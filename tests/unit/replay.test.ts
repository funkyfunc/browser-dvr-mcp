// Mock-free unit tests for causal explain + the ReplayEngine.
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventKind, Trust } from '../../src/core/EventBus.js';
import { causalExplain } from '../../src/replay/causalExplain.js';
import { ReplayEngine } from '../../src/replay/ReplayEngine.js';

let seq = 0;
function ev(kind: EventKind, trust: Trust, data: unknown, timestamp: number): BusEvent {
  return { seq: ++seq, timestamp, kind, trust, data };
}
function reset() {
  seq = 0;
}

describe('causalExplain', () => {
  it('explains a click blocked by an occluder', () => {
    reset();
    const t = 1000;
    const events = [
      ev('mutation', 'page-controlled', { type: 'childList' }, t - 50),
      ev(
        'action',
        'tool-output',
        {
          action: 'click',
          success: false,
          feedback:
            'Spatial validation failed. Interaction hit element div.modal-backdrop instead.',
          target: { backendNodeId: 42 },
        },
        t,
      ),
    ];
    const report = causalExplain(events);
    expect(report.action?.success).toBe(false);
    expect(report.hypotheses[0].toLowerCase()).toContain('blocked');
    expect(report.summary.toLowerCase()).toContain('failed');
  });

  it('links a successful action to network failures in its window', () => {
    reset();
    const t = 5000;
    const events = [
      ev('action', 'tool-output', { action: 'click', success: true, feedback: 'Clicked.' }, t),
      ev('network', 'page-controlled', { method: 'POST', url: '/api/save', status: 500 }, t + 300),
      ev('network', 'page-controlled', { method: 'GET', url: '/api/me', status: 200 }, t + 400),
      ev('network', 'page-controlled', { method: 'GET', url: '/late', status: 500 }, t + 9000), // outside window
    ];
    const report = causalExplain(events, { windowMs: 1500 });
    expect(report.network.failures.length).toBe(1);
    expect(report.hypotheses.some((h) => h.includes('network request(s) failed'))).toBe(true);
    expect(report.hypotheses[0]).toContain('/api/save');
  });

  it('flags console errors and navigation', () => {
    reset();
    const t = 2000;
    const events = [
      ev(
        'action',
        'tool-output',
        { action: 'click', success: true, feedback: 'Clicked.', navOccurred: true },
        t,
      ),
      ev(
        'console',
        'page-controlled',
        { level: 'error', text: 'Uncaught TypeError: x is undefined' },
        t + 100,
      ),
    ];
    const report = causalExplain(events);
    expect(report.console.errors.length).toBe(1);
    expect(report.hypotheses.some((h) => h.includes('console error'))).toBe(true);
    expect(report.hypotheses.some((h) => h.toLowerCase().includes('navigation'))).toBe(true);
  });

  it('reports a clean run when nothing notable happens', () => {
    reset();
    const t = 3000;
    const events = [
      ev('action', 'tool-output', { action: 'hover', success: true, feedback: 'Hovered.' }, t),
    ];
    const report = causalExplain(events);
    expect(report.hypotheses).toEqual([]);
    expect(report.summary).toContain('nothing notable');
  });

  it('returns a graceful message when no action exists', () => {
    reset();
    const report = causalExplain([
      ev('console', 'page-controlled', { level: 'log', text: 'hi' }, 1),
    ]);
    expect(report.action).toBeNull();
    expect(report.summary).toContain('nothing to explain');
  });

  it('can anchor on a specific action seq', () => {
    reset();
    const events = [
      ev('action', 'tool-output', { action: 'click', success: false, feedback: 'failed A' }, 1000),
      ev('action', 'tool-output', { action: 'type', success: true, feedback: 'typed B' }, 2000),
    ];
    const first = events[0];
    const report = causalExplain(events, { anchorSeq: first.seq });
    expect(report.action?.action).toBe('click');
  });
});

describe('causalExplain — prescriptive remediation', () => {
  it('suggests dismissing the occluder and parses its id', () => {
    reset();
    const report = causalExplain([
      ev(
        'action',
        'tool-output',
        {
          action: 'click',
          success: false,
          feedback: 'Spatial validation failed. Interaction hit element (id: 77) instead.',
        },
        1000,
      ),
    ]);
    expect(report.remediation?.suggestion.toLowerCase()).toContain('dismiss');
    expect(report.remediation?.occluderId).toBe(77);
    expect(report.remediation?.retrySafe).toBe(true);
  });

  it('flags auth failures as not retry-safe', () => {
    reset();
    const t = 2000;
    const report = causalExplain([
      ev('action', 'tool-output', { action: 'click', success: true, feedback: 'Clicked.' }, t),
      ev('network', 'page-controlled', { method: 'POST', url: '/api/x', status: 403 }, t + 100),
    ]);
    expect(report.remediation?.retrySafe).toBe(false);
    expect(report.remediation?.suggestion.toLowerCase()).toContain('auth');
  });

  it('tells the agent to re-perceive after a navigation', () => {
    reset();
    const report = causalExplain([
      ev(
        'action',
        'tool-output',
        { action: 'click', success: true, feedback: 'Clicked.', navOccurred: true },
        3000,
      ),
    ]);
    expect(report.remediation?.nextTool).toBe('get_semantic_surface');
  });

  it('folds in a known gotcha from site memory', () => {
    reset();
    const report = causalExplain(
      [ev('action', 'tool-output', { action: 'click', success: false, feedback: 'nope' }, 1)],
      { knownGotchas: [{ action: 'click', reason: 'modal blocks this region' }] },
    );
    expect(report.remediation?.suggestion).toContain('modal blocks this region');
  });

  it('leaves remediation undefined for a clean successful action', () => {
    reset();
    const report = causalExplain([
      ev('action', 'tool-output', { action: 'hover', success: true, feedback: 'Hovered.' }, 1),
    ]);
    expect(report.remediation).toBeUndefined();
  });
});

describe('ReplayEngine', () => {
  it('records actions, navigations, and network failures into a bundle', () => {
    reset();
    const events = [
      ev(
        'navigation',
        'page-controlled',
        { url: 'http://localhost:5173/app', statusCode: 200 },
        100,
      ),
      ev(
        'action',
        'tool-output',
        { action: 'click', success: true, target: { backendNodeId: 7 } },
        200,
      ),
      ev('network', 'page-controlled', { method: 'POST', url: '/api/x', status: 503 }, 250),
      ev(
        'action',
        'tool-output',
        { action: 'type', success: false, target: { backendNodeId: 9 } },
        300,
      ),
    ];
    const bundle = ReplayEngine.record(events);
    expect(bundle.actions.length).toBe(2);
    expect(bundle.navigations.length).toBe(1);
    expect(bundle.networkFailures.length).toBe(1);
    expect(bundle.actions[1].success).toBe(false);
  });

  it('renders an ordered, human-readable repro script marking the failure', () => {
    reset();
    const events = [
      ev('navigation', 'page-controlled', { url: 'http://localhost:5173/app' }, 100),
      ev(
        'action',
        'tool-output',
        { action: 'click', success: true, target: { backendNodeId: 7 } },
        200,
      ),
      ev(
        'action',
        'tool-output',
        { action: 'type', success: false, target: { backendNodeId: 9 } },
        300,
      ),
    ];
    const script = ReplayEngine.toScript(ReplayEngine.record(events));
    expect(script).toContain('Navigate to http://localhost:5173/app');
    expect(script).toContain('click');
    expect(script).toContain('← FAILED here');
  });

  it('re-drives a bundle by resolved coordinates and skips uncoordinated actions', async () => {
    reset();
    const events = [
      ev('navigation', 'page-controlled', { url: 'http://localhost:5173/app' }, 100),
      ev(
        'action',
        'tool-output',
        { action: 'click', success: true, coordinates: { x: 10, y: 20 } },
        200,
      ),
      ev(
        'action',
        'tool-output',
        { action: 'type', success: true, coordinates: { x: 30, y: 40 }, text: 'hello' },
        300,
      ),
      ev('action', 'tool-output', { action: 'scroll', success: true }, 400), // no coords -> skipped
    ];
    const bundle = ReplayEngine.record(events);

    const calls: string[] = [];
    const driver = {
      navigate: async (url: string) => calls.push(`navigate:${url}`),
      clickAt: async (x: number, y: number) => calls.push(`click:${x},${y}`),
      typeAt: async (x: number, y: number, text: string) => calls.push(`type:${x},${y}:${text}`),
    };

    const report = await ReplayEngine.replay(bundle, driver);

    expect(calls).toEqual([
      'navigate:http://localhost:5173/app',
      'click:10,20',
      'type:30,40:hello',
    ]);
    expect(report.replayed).toBe(3); // navigate + click + type
    expect(report.skipped).toBe(1); // scroll had no coordinates
    expect(report.steps.find((s) => s.action === 'scroll')?.reason).toMatch(
      /no resolved coordinates/,
    );
  });
});
