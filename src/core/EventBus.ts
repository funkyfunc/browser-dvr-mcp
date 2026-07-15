// ─── EventBus ───────────────────────────────────────────────────────────────
// One per-session, provenance-tagged timeline that both afferent (perception /
// telemetry) and efferent (agent actions) events flow onto.
//
// Two jobs:
//  1. Trust tagging (the S5 prompt-injection defense). Every event carries where
//     it came from, so a consumer can tell page-controlled text — which may
//     contain injected instructions — apart from chrome-native structure and
//     our own tool output, and never treat the former as commands.
//  2. Foundation for the causal / replay layer (Wave 3): a single ordered,
//     timestamped, subscribable stream is what `explain()` and the ReplayEngine
//     read from.
//
// Bounded (RingBuffer) and push-capable (subscribe) so a future streaming
// transport can surface events without polling.

import { RingBuffer } from './types.js';

/**
 * Where an event's payload originated, and therefore how much to trust it:
 *  - `chrome-native`  — CDP-sourced structure/geometry (AX roles, layout). Trusted.
 *  - `page-controlled`— text the page authored (console, mutation payloads, AX
 *                       names, URLs). UNTRUSTED — may carry injected instructions.
 *  - `tool-output`    — feedback produced by this server's own tools. Trusted.
 *  - `user`           — a human operator's recorded interactions.
 */
export type Trust = 'chrome-native' | 'page-controlled' | 'tool-output' | 'user';

export type EventKind =
  'network' | 'console' | 'mutation' | 'interaction' | 'navigation' | 'action';

export interface BusEvent {
  seq: number;
  timestamp: number;
  kind: EventKind;
  trust: Trust;
  data: unknown;
}

export type BusSubscriber = (event: BusEvent) => void;

export class EventBus {
  private readonly buffer: RingBuffer<BusEvent>;
  private readonly subscribers = new Set<BusSubscriber>();
  private seq = 0;

  constructor(capacity = 10000) {
    this.buffer = new RingBuffer<BusEvent>(capacity);
  }

  /** Append an event and notify subscribers. Returns the stored event. */
  emit(kind: EventKind, trust: Trust, data: unknown, timestamp?: number): BusEvent {
    const event: BusEvent = {
      seq: ++this.seq,
      timestamp: timestamp ?? Date.now(),
      kind,
      trust,
      data,
    };
    this.buffer.push(event);
    for (const sub of this.subscribers) {
      try {
        sub(event);
      } catch {
        // a bad subscriber must not break ingestion
      }
    }
    return event;
  }

  /** Subscribe to future events. Returns an unsubscribe function. */
  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** The most recent `n` events in order (all events if `n` is omitted). */
  recent(n?: number): BusEvent[] {
    const all = this.buffer.toArray();
    return n === undefined ? all : all.slice(-n);
  }

  /** Events at or after a timestamp — the window a causal `explain()` reads. */
  since(timestamp: number): BusEvent[] {
    return this.buffer.filter((e) => e.timestamp >= timestamp);
  }

  /** Events matching a trust level — e.g. isolate untrusted page-controlled text. */
  withTrust(trust: Trust): BusEvent[] {
    return this.buffer.filter((e) => e.trust === trust);
  }

  clear(): void {
    this.buffer.clear();
  }

  get size(): number {
    return this.buffer.size;
  }
}
