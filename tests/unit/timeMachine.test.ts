// Mock-free unit tests for the Time Machine synchronization core.
import { describe, it, expect } from 'vitest';
import type { BusEvent, EventKind, Trust } from '../../src/core/EventBus.js';
import {
  TimeMachine,
  type SessionArchive,
  type Keyframe,
} from '../../src/timemachine/SessionArchive.js';

let seq = 0;
function ev(
  kind: EventKind,
  data: unknown,
  timestamp: number,
  trust: Trust = 'page-controlled',
): BusEvent {
  return { seq: ++seq, timestamp, kind, trust, data };
}

function archive(events: BusEvent[], keyframes: Keyframe[]): SessionArchive {
  return {
    version: 1,
    meta: {
      id: 'sess-1',
      startedAt: events[0]?.timestamp ?? null,
      endedAt: events.at(-1)?.timestamp ?? null,
      eventCount: events.length,
    },
    events,
    keyframes,
  };
}

describe('TimeMachine.reconstructAt', () => {
  it('returns the nearest visual/storage/state keyframe at or before the moment', () => {
    seq = 0;
    const a = archive(
      [ev('action', { action: 'click', success: true }, 1000, 'tool-output')],
      [
        { kind: 'visual', timestamp: 500, path: 'frames/a.jpg' },
        { kind: 'visual', timestamp: 900, path: 'frames/b.jpg' },
        { kind: 'visual', timestamp: 1500, path: 'frames/c.jpg' }, // after t — excluded
        {
          kind: 'storage',
          timestamp: 800,
          localStorage: { k: 'v' },
          sessionStorage: {},
          cookies: [],
        },
        { kind: 'state', timestamp: 700, url: 'https://app/x' },
      ],
    );
    const m = TimeMachine.reconstructAt(a, { at: 1000 });
    expect(m.screen?.path).toBe('frames/b.jpg'); // 900, the latest <= 1000
    expect(m.storage?.localStorage).toEqual({ k: 'v' });
    expect(m.state?.url).toBe('https://app/x');
  });

  it('collects the console tail up to the moment and the network window around it', () => {
    seq = 0;
    const a = archive(
      [
        ev('console', { level: 'log', text: 'early' }, 100),
        ev('console', { level: 'error', text: 'boom' }, 900),
        ev('network', { method: 'GET', url: '/a', status: 200 }, 950),
        ev('network', { method: 'GET', url: '/late', status: 200 }, 5000), // outside window
        ev('console', { level: 'log', text: 'after' }, 3000), // after t — excluded from tail
      ],
      [],
    );
    const m = TimeMachine.reconstructAt(a, { at: 1000, windowMs: 1000 });
    expect(m.consoleTail.map((e) => (e.data as any).text)).toEqual(['early', 'boom']);
    expect(m.networkWindow.map((e) => (e.data as any).url)).toEqual(['/a']);
  });

  it('anchors to N ms before the last error', () => {
    seq = 0;
    const a = archive(
      [
        ev('action', { action: 'click', success: true }, 1000, 'tool-output'),
        ev('network', { method: 'POST', url: '/save', status: 500 }, 2000),
      ],
      [{ kind: 'visual', timestamp: 1400, path: 'frames/pre.jpg' }],
    );
    const m = TimeMachine.reconstructAt(a, { beforeLastError: true, beforeMs: 500 });
    expect(m.at).toBe(1500); // 2000 - 500
    expect(m.screen?.path).toBe('frames/pre.jpg'); // 1400 is the latest <= 1500
  });

  it('anchors to a specific event seq', () => {
    seq = 0;
    const first = ev('action', { action: 'a', success: true }, 1000, 'tool-output');
    const second = ev('action', { action: 'b', success: true }, 2000, 'tool-output');
    const a = archive([first, second], []);
    const m = TimeMachine.reconstructAt(a, { seq: first.seq });
    expect(m.at).toBe(1000);
    expect((m.action?.data as any).action).toBe('a');
  });

  it('defaults to the last event when no anchor is given', () => {
    seq = 0;
    const a = archive(
      [
        ev('action', { action: 'x', success: true }, 1000, 'tool-output'),
        ev('navigation', { url: '/y' }, 2000),
      ],
      [],
    );
    const m = TimeMachine.reconstructAt(a, {});
    expect(m.at).toBe(2000);
  });

  it('handles an empty archive without throwing', () => {
    seq = 0;
    const m = TimeMachine.reconstructAt(archive([], []), {});
    expect(m.at).toBe(0);
    expect(m.screen).toBeNull();
    expect(m.events).toEqual([]);
  });
});
