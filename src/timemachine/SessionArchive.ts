// ─── Session Archive & Time Machine ─────────────────────────────────────────
// The flight-recorder core. A SessionArchive is the durable, re-openable record
// of one browser session: the full provenance-tagged event timeline plus periodic
// KEYFRAMES — point-in-time snapshots of the heavy modalities (visual, storage,
// state) that can't live on the per-event stream.
//
// TimeMachine.reconstructAt(archive, t) is the synchronization capstone: given any
// timestamp it returns EVERYTHING as it was at that instant — the nearest visual /
// storage / state keyframe at-or-before t, the console tail and network window
// around t, the events in a window, and the anchoring action. Pure over the
// archive — unit-tested without a live browser.

import type { BusEvent } from '../core/EventBus.js';

/** A periodic snapshot of one heavy modality, tagged by wall-clock timestamp. */
export type Keyframe = VisualKeyframe | StorageKeyframe | StateKeyframe;

export interface VisualKeyframe {
  kind: 'visual';
  timestamp: number;
  /** Path to the JPEG on disk (frames are binary, never inlined/redacted). */
  path: string;
  width?: number;
  height?: number;
}

export interface StorageKeyframe {
  kind: 'storage';
  timestamp: number;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: { name: string; value: string; domain?: string }[];
}

export interface StateKeyframe {
  kind: 'state';
  timestamp: number;
  url: string;
  title?: string;
  /** A compact digest of the semantic surface (not the whole tree). */
  digest?: string;
}

export interface SessionMeta {
  id: string;
  startedAt: number | null;
  endedAt: number | null;
  startUrl?: string;
  origin?: string;
  eventCount: number;
  name?: string;
}

export interface SessionArchive {
  version: 1;
  meta: SessionMeta;
  events: BusEvent[];
  keyframes: Keyframe[];
}

// ── Reconstruction result ────────────────────────────────────────────────────

export interface ReconstructedMoment {
  /** The timestamp actually resolved to (may differ from the requested one). */
  at: number;
  /** The screen as of `at` — nearest visual keyframe at or before it. */
  screen: VisualKeyframe | null;
  /** Storage as of `at` — nearest storage keyframe at or before it. */
  storage: StorageKeyframe | null;
  /** App/page state as of `at` — nearest state keyframe at or before it. */
  state: StateKeyframe | null;
  /** Console messages up to `at` (most recent last), capped. */
  consoleTail: BusEvent[];
  /** Network events within the window around `at`. */
  networkWindow: BusEvent[];
  /** The action nearest to `at` (before or straddling it), if any. */
  action: BusEvent | null;
  /** All events within the window around `at`, in order. */
  events: BusEvent[];
  /** The window bounds used. */
  window: { fromMs: number; toMs: number };
}

export interface ReconstructOptions {
  /** Absolute timestamp to reconstruct at. */
  at?: number;
  /** Anchor to the sequence number of a specific event instead of a timestamp. */
  seq?: number;
  /** Anchor to `beforeMs` before the last failed action / error, if present. */
  beforeLastError?: boolean;
  /** How far before the last error to land (default 500ms). */
  beforeMs?: number;
  /** Half-width of the event/network window around the moment (default 2000ms). */
  windowMs?: number;
  /** Max console-tail entries (default 20). */
  consoleTailLimit?: number;
}

const DEFAULT_WINDOW_MS = 2000;
const DEFAULT_BEFORE_MS = 500;
const DEFAULT_CONSOLE_TAIL = 20;

function isErrorEvent(e: BusEvent): boolean {
  if (e.kind === 'console') return (e.data as { level?: string }).level === 'error';
  if (e.kind === 'action') return (e.data as { success?: boolean }).success === false;
  if (e.kind === 'network') {
    const d = e.data as { eventType?: string; status?: number };
    return d.eventType === 'failed' || (typeof d.status === 'number' && d.status >= 400);
  }
  return false;
}

/** Nearest keyframe of a given kind at or before `t` (or null). */
function nearestKeyframeAtOrBefore<K extends Keyframe['kind']>(
  keyframes: Keyframe[],
  kind: K,
  t: number,
): Extract<Keyframe, { kind: K }> | null {
  let best: Extract<Keyframe, { kind: K }> | null = null;
  for (const k of keyframes) {
    if (k.kind !== kind) continue;
    if (k.timestamp <= t && (!best || k.timestamp > best.timestamp)) {
      best = k as Extract<Keyframe, { kind: K }>;
    }
  }
  return best;
}

export class TimeMachine {
  /**
   * Resolve the target timestamp from the options against an archive: an explicit
   * `at`, the timestamp of a given `seq`, or `beforeMs` before the last error.
   * Falls back to the last event's timestamp, then 0.
   */
  static resolveTarget(archive: SessionArchive, opts: ReconstructOptions): number {
    const { events } = archive;
    if (opts.at !== undefined) return opts.at;
    if (opts.seq !== undefined) {
      const e = events.find((ev) => ev.seq === opts.seq);
      if (e) return e.timestamp;
    }
    if (opts.beforeLastError) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (isErrorEvent(events[i])) {
          return events[i].timestamp - (opts.beforeMs ?? DEFAULT_BEFORE_MS);
        }
      }
    }
    return events.length ? events[events.length - 1].timestamp : 0;
  }

  /**
   * Reconstruct the full synchronized moment at a timestamp (or anchor). This is
   * the Time Machine's headline operation.
   */
  static reconstructAt(
    archive: SessionArchive,
    opts: ReconstructOptions = {},
  ): ReconstructedMoment {
    const t = TimeMachine.resolveTarget(archive, opts);
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const fromMs = t - windowMs;
    const toMs = t + windowMs;

    const eventsInWindow = archive.events.filter(
      (e) => e.timestamp >= fromMs && e.timestamp <= toMs,
    );

    const consoleTail = archive.events
      .filter((e) => e.kind === 'console' && e.timestamp <= t)
      .slice(-(opts.consoleTailLimit ?? DEFAULT_CONSOLE_TAIL));

    const networkWindow = eventsInWindow.filter((e) => e.kind === 'network');

    // Nearest action at or before t (straddling counts as "before or at").
    let action: BusEvent | null = null;
    for (const e of archive.events) {
      if (e.kind === 'action' && e.timestamp <= t) {
        if (!action || e.timestamp > action.timestamp) action = e;
      }
    }

    return {
      at: t,
      screen: nearestKeyframeAtOrBefore(archive.keyframes, 'visual', t),
      storage: nearestKeyframeAtOrBefore(archive.keyframes, 'storage', t),
      state: nearestKeyframeAtOrBefore(archive.keyframes, 'state', t),
      consoleTail,
      networkWindow,
      action,
      events: eventsInWindow,
      window: { fromMs, toMs },
    };
  }
}
