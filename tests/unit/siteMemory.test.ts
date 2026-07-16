// Mock-free unit tests for site-memory distillation.
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventKind, Trust } from '../../src/core/EventBus.js';
import { distill, type SiteModel } from '../../src/memory/SiteMemory.js';

let seq = 0;
function ev(kind: EventKind, data: unknown, timestamp = ++seq): BusEvent {
  const trust: Trust = kind === 'action' ? 'tool-output' : 'page-controlled';
  return { seq: ++seq, timestamp, kind, trust, data };
}

describe('distill', () => {
  it('extracts landmarks + a flow from successful actions', () => {
    const events = [
      ev('navigation', { url: 'http://localhost:5173/app' }),
      ev('action', {
        action: 'click',
        success: true,
        targetRole: 'button',
        targetName: 'Login',
        coordinates: { x: 10, y: 20 },
      }),
      ev('action', {
        action: 'type',
        success: true,
        targetRole: 'textbox',
        targetName: 'Email',
        coordinates: { x: 30, y: 40 },
      }),
    ];
    const model = distill('http_localhost_5173', events, undefined, 1000);

    expect(model.stats.visitCount).toBe(1);
    expect(model.landmarks).toEqual([
      { role: 'button', name: 'Login', action: 'click' },
      { role: 'textbox', name: 'Email', action: 'type' },
    ]);
    expect(model.flows).toHaveLength(1);
    expect(model.flows[0].steps.map((s) => s.action)).toEqual(['click', 'type']);
  });

  it('records failed actions as gotchas', () => {
    const events = [
      ev('action', {
        action: 'click',
        success: false,
        feedback: 'Spatial validation failed. Interaction hit element div.modal-backdrop instead.',
      }),
    ];
    const model = distill('o', events, undefined, 1);
    expect(model.gotchas).toHaveLength(1);
    expect(model.gotchas[0].action).toBe('click');
    expect(model.gotchas[0].reason).toContain('modal-backdrop');
  });

  it('merges idempotently — same landmark twice yields one entry', () => {
    const events = [
      ev('action', { action: 'click', success: true, targetRole: 'button', targetName: 'Login' }),
    ];
    const first = distill('o', events, undefined, 1);
    const second = distill('o', events, first, 2);
    expect(second.landmarks).toHaveLength(1);
    expect(second.stats.visitCount).toBe(2); // visits accumulate
    expect(second.stats.firstSeen).toBe(1); // preserved
    expect(second.stats.lastSeen).toBe(2);
  });

  it('persists NO captured input values (structural-only)', () => {
    const events = [
      ev('action', {
        action: 'type',
        success: true,
        targetRole: 'textbox',
        targetName: 'Password',
        text: 'hunter2-should-never-persist',
        coordinates: { x: 1, y: 2 },
      }),
    ];
    const model = distill('o', events, undefined, 1);
    expect(JSON.stringify(model)).not.toContain('hunter2');
  });

  it('builds a navigation graph and redacts URLs', () => {
    const events = [
      ev('navigation', { url: 'http://localhost:5173/a?token=secret' }),
      ev('navigation', { url: 'http://localhost:5173/b' }),
    ];
    const model = distill('http_localhost_5173', events, undefined, 1);
    expect(model.navGraph.length).toBe(1);
    expect(JSON.stringify(model.navGraph)).not.toContain('secret');
  });

  it('caps unbounded growth', () => {
    const existing: SiteModel = {
      origin: 'o',
      landmarks: Array.from({ length: 250 }, (_, i) => ({
        role: 'button',
        name: `b${i}`,
        action: 'click',
      })),
      flows: [],
      gotchas: [],
      navGraph: [],
      stats: { visitCount: 1, firstSeen: 0, lastSeen: 0 },
    };
    const model = distill('o', [], existing, 2);
    expect(model.landmarks.length).toBeLessThanOrEqual(200);
  });
});
