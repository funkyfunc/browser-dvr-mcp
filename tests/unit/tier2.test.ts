// Mock-free unit tests for Tier-2 debugging primitives: anchors, stateDiff, trajectory.
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventKind, Trust } from '../../src/core/EventBus.js';
import type { SessionArchive, Keyframe } from '../../src/timemachine/SessionArchive.js';
import { encodeAnchor, decodeAnchor, isAnchor } from '../../src/timemachine/anchor.js';
import { stateDiff } from '../../src/timemachine/queries.js';
import { analyzeTrajectory } from '../../src/replay/trajectory.js';

let seq = 0;
function ev(
  kind: EventKind,
  data: unknown,
  timestamp: number,
  trust: Trust = 'page-controlled',
): BusEvent {
  return { seq: ++seq, timestamp, kind, trust, data };
}

describe('anchors', () => {
  it('round-trips an opaque anchor token', () => {
    const token = encodeAnchor({ session: 'sess_1', ts: 12345, seq: 7 });
    expect(token.startsWith('anc_')).toBe(true);
    expect(decodeAnchor(token)).toEqual({ session: 'sess_1', ts: 12345, seq: 7 });
    expect(isAnchor(token)).toBe(true);
  });
  it('rejects malformed tokens', () => {
    expect(decodeAnchor('not-an-anchor')).toBeNull();
    expect(decodeAnchor('anc_%%%')).toBeNull();
    expect(isAnchor('last_error')).toBe(false);
  });
});

function archive(events: BusEvent[], keyframes: Keyframe[]): SessionArchive {
  return {
    version: 1,
    meta: {
      id: 's',
      startedAt: events[0]?.timestamp ?? null,
      endedAt: events.at(-1)?.timestamp ?? null,
      eventCount: events.length,
    },
    events,
    keyframes,
  };
}

describe('stateDiff', () => {
  it('diffs storage, url, and buckets the events between two moments', () => {
    seq = 0;
    const store = (t: number, ls: Record<string, string>, url: string): Keyframe[] => [
      { kind: 'storage', timestamp: t, localStorage: ls, sessionStorage: {}, cookies: [] },
      { kind: 'state', timestamp: t, url },
    ];
    const a = archive(
      [
        ev('action', { action: 'click', success: true }, 1000, 'tool-output'),
        ev('network', { url: '/save', status: 500 }, 1500),
        ev('navigation', { url: 'https://app/done' }, 1800),
      ],
      [
        ...store(900, { cart: '1' }, 'https://app/cart'),
        ...store(2000, { cart: '2', coupon: 'X' }, 'https://app/done'),
      ],
    );
    const d = stateDiff(a, 900, 2000);
    expect(d.url.changed).toBe(true);
    expect(d.url.to).toBe('https://app/done');
    expect(d.localStorage.added).toEqual([{ key: 'coupon', value: 'X' }]);
    expect(d.localStorage.changed).toEqual([{ key: 'cart', from: '1', to: '2' }]);
    expect(d.between.networkFailures.length).toBe(1);
    expect(d.between.navigations.length).toBe(1);
  });
});

describe('analyzeTrajectory', () => {
  it('finds every failure, labels each, and surfaces the earliest', () => {
    seq = 0;
    const events = [
      ev('action', { action: 'click', success: true }, 1000, 'tool-output'),
      // earliest failure: occluded
      ev(
        'action',
        { action: 'click', success: false, feedback: 'hit element div.modal-backdrop' },
        2000,
        'tool-output',
      ),
      // later failure: server error
      ev(
        'action',
        { action: 'type', success: false, feedback: 'submit failed' },
        4000,
        'tool-output',
      ),
      ev('network', { url: '/api', status: 503 }, 4100),
      // assertion failure
      ev(
        'interaction',
        { type: 'verify', label: 'banner', passed: false, details: 'not found' },
        5000,
        'tool-output',
      ),
    ];
    const r = analyzeTrajectory(events);
    expect(r.totalActions).toBe(3);
    expect(r.failureCount).toBe(3);
    expect(r.firstFailure?.timestamp).toBe(2000);
    expect(r.firstFailure?.category).toBe('occluded-target');
    const cats = r.failures.map((f) => f.category);
    expect(cats).toContain('server-error');
    expect(cats).toContain('assertion-failed');
  });

  it('reports a clean run with no failures', () => {
    seq = 0;
    const r = analyzeTrajectory([
      ev('action', { action: 'click', success: true }, 1000, 'tool-output'),
    ]);
    expect(r.failureCount).toBe(0);
    expect(r.firstFailure).toBeNull();
  });

  it('classifies auth failure from surrounding network', () => {
    seq = 0;
    const r = analyzeTrajectory([
      ev(
        'action',
        { action: 'click', success: false, feedback: 'nothing happened' },
        1000,
        'tool-output',
      ),
      ev('network', { url: '/api', status: 403 }, 1100),
    ]);
    expect(r.firstFailure?.category).toBe('auth-failure');
  });

  it('summarizes a PASSIVE session (navigations/evaluations/waits) with no failures', () => {
    seq = 0;
    const r = analyzeTrajectory([
      ev('navigation', { url: 'https://app/' }, 1000),
      ev('interaction', { type: 'evaluate', expression: 'document.title' }, 1100, 'tool-output'),
      ev('interaction', { type: 'evaluate', expression: 'window.x' }, 1200, 'tool-output'),
      ev('interaction', { type: 'wait', met: true }, 1300, 'tool-output'),
      ev('network', { url: '/api', status: 200 }, 1400),
    ]);
    expect(r.failureCount).toBe(0);
    expect(r.totalActions).toBe(0); // no clicks/types — but the session was not empty
    expect(r.activity.navigations).toBe(1);
    expect(r.activity.evaluations).toBe(2);
    expect(r.activity.waits).toBe(1);
    expect(r.activity.networkRequests).toBe(1);
    expect(r.summary).toContain('No failures');
    expect(r.summary).toContain('2 evaluation(s)');
  });
});
