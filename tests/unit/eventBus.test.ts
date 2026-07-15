// Mock-free unit tests for the provenance-tagged EventBus and its telemetry
// integration.
import { describe, it, expect } from 'vitest';
import { EventBus } from '../../src/core/EventBus.js';
import { SessionTelemetryManager } from '../../src/telemetry/SessionTelemetryManager.js';

describe('EventBus', () => {
  it('assigns increasing seq, stores, and returns the event', () => {
    const bus = new EventBus();
    const a = bus.emit('console', 'page-controlled', { text: 'hi' });
    const b = bus.emit('interaction', 'tool-output', { type: 'click' });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(bus.size).toBe(2);
    expect(bus.recent(1)[0]).toBe(b);
  });

  it('notifies subscribers and supports unsubscribe', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe((e) => seen.push(e.kind));
    bus.emit('network', 'page-controlled', {});
    off();
    bus.emit('mutation', 'page-controlled', {});
    expect(seen).toEqual(['network']);
  });

  it('a throwing subscriber does not break ingestion', () => {
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    expect(() => bus.emit('console', 'page-controlled', {})).not.toThrow();
    expect(bus.size).toBe(1);
  });

  it('filters by trust and timestamp window', () => {
    const bus = new EventBus();
    bus.emit('console', 'page-controlled', { n: 1 }, 100);
    bus.emit('interaction', 'tool-output', { n: 2 }, 200);
    bus.emit('mutation', 'page-controlled', { n: 3 }, 300);
    expect(bus.withTrust('tool-output').map((e) => (e.data as any).n)).toEqual([2]);
    expect(bus.since(200).map((e) => (e.data as any).n)).toEqual([2, 3]);
  });

  it('stays bounded to its capacity', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 10; i++) bus.emit('console', 'page-controlled', { i });
    expect(bus.size).toBe(3);
    expect(bus.recent().map((e) => (e.data as any).i)).toEqual([7, 8, 9]);
  });
});

describe('SessionTelemetryManager -> EventBus mirroring with provenance', () => {
  it('tags interactions as tool-output and page events as page-controlled', () => {
    const bus = new EventBus();
    const tel = new SessionTelemetryManager('agent', bus);
    tel.addInteraction({ type: 'click', timestamp: Date.now(), x: 1, y: 2 });
    tel.addNavigation('https://example.com/a?token=secret');
    tel.addMutation('childList', 'n1', {});

    const kinds = bus.recent().map((e) => `${e.kind}:${e.trust}`);
    expect(kinds).toContain('interaction:tool-output');
    expect(kinds).toContain('navigation:page-controlled');
    expect(kinds).toContain('mutation:page-controlled');

    // Navigation URL is redacted before it reaches the bus.
    const nav = bus.recent().find((e) => e.kind === 'navigation')!;
    expect(JSON.stringify(nav.data)).not.toContain('secret');
  });

  it('tags a human operator’s interactions as user provenance', () => {
    const bus = new EventBus();
    const tel = new SessionTelemetryManager('human', bus);
    tel.addInteraction({ type: 'click', timestamp: Date.now() });
    expect(bus.recent(1)[0].trust).toBe('user');
  });
});
