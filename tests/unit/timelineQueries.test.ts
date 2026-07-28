// Mock-free unit tests for the trace-as-database timeline queries.
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventKind, Trust } from '../../src/core/EventBus.js';
import type { SessionArchive, Keyframe } from '../../src/timemachine/SessionArchive.js';
import { queryTimeline, whenChanged } from '../../src/timemachine/queries.js';

let seq = 0;
function ev(
  kind: EventKind,
  data: unknown,
  timestamp: number,
  trust: Trust = 'page-controlled',
): BusEvent {
  return { seq: ++seq, timestamp, kind, trust, data };
}
function archive(events: BusEvent[], keyframes: Keyframe[] = []): SessionArchive {
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

describe('queryTimeline', () => {
  it('finds all failed network requests (statusGte)', () => {
    seq = 0;
    const events = [
      ev('network', { url: '/a', status: 200 }, 100),
      ev('network', { url: '/b', status: 500 }, 200),
      ev('network', { url: '/c', status: 404 }, 300),
    ];
    const hits = queryTimeline(events, { kind: 'network', statusGte: 400 });
    expect(hits.map((e) => (e.data as any).url)).toEqual(['/b', '/c']);
  });

  it('filters by console level and by free-text', () => {
    seq = 0;
    const events = [
      ev('console', { level: 'log', text: 'hello' }, 100),
      ev('console', { level: 'error', text: 'TypeError: boom' }, 200),
    ];
    expect(queryTimeline(events, { kind: 'console', level: 'error' }).length).toBe(1);
    expect(queryTimeline(events, { textContains: 'typeerror' }).length).toBe(1);
  });

  it('respects time bounds and trust', () => {
    seq = 0;
    const events = [
      ev('action', { action: 'click' }, 100, 'tool-output'),
      ev('interaction', { source: 'human' }, 200, 'user'),
    ];
    expect(queryTimeline(events, { trust: 'user' }).length).toBe(1);
    expect(queryTimeline(events, { from: 150 }).length).toBe(1);
  });
});

describe('whenChanged', () => {
  it('finds the last URL change before a moment', () => {
    seq = 0;
    const a = archive([
      ev('navigation', { url: 'https://app/login' }, 100),
      ev('navigation', { url: 'https://app/dashboard' }, 500),
      ev('navigation', { url: 'https://app/settings' }, 900),
    ]);
    const r = whenChanged(a, { type: 'url' }, 600);
    expect(r.found).toBe(true);
    expect(r.changedAt).toBe(500);
    expect(r.from).toBe('https://app/login');
    expect(r.to).toBe('https://app/dashboard');
  });

  it('detects a localStorage key change between keyframes', () => {
    seq = 0;
    const kf = (t: number, val: string): Keyframe => ({
      kind: 'storage',
      timestamp: t,
      localStorage: { token: val },
      sessionStorage: {},
      cookies: [],
    });
    const a = archive([], [kf(100, 'a'), kf(200, 'a'), kf(300, 'b'), kf(400, 'b')]);
    const r = whenChanged(a, { type: 'storage', key: 'token' }, 500);
    expect(r.found).toBe(true);
    expect(r.changedAt).toBe(300);
    expect(r.from).toBe('a');
    expect(r.to).toBe('b');
  });

  it('reports no change when the value was stable', () => {
    seq = 0;
    const kf = (t: number): Keyframe => ({
      kind: 'storage',
      timestamp: t,
      localStorage: { theme: 'dark' },
      sessionStorage: {},
      cookies: [],
    });
    const a = archive([], [kf(100), kf(200)]);
    const r = whenChanged(a, { type: 'storage', key: 'theme' }, 300);
    expect(r.found).toBe(false);
    expect(r.note).toContain('did not change');
  });

  it('finds the last matching DOM mutation before a moment', () => {
    seq = 0;
    const a = archive([
      ev('mutation', { type: 'childList', details: 'added .modal-backdrop' }, 100),
      ev('mutation', { type: 'attributes', details: 'class on .modal-backdrop' }, 400),
      ev('mutation', { type: 'childList', details: 'removed .modal-backdrop' }, 900),
    ]);
    const r = whenChanged(a, { type: 'dom', textContains: 'modal-backdrop' }, 500);
    expect(r.found).toBe(true);
    expect(r.changedAt).toBe(400);
  });
});
