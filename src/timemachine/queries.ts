// ─── Timeline queries ───────────────────────────────────────────────────────
// "Execution as a queryable database of time." Two retrospective queries over a
// recorded session — the time-travel-debugger moves adapted to our event/keyframe
// record (no instruction-level re-execution; these answer purely from captured
// data):
//
//  • queryTimeline  — trace-as-database: find all recorded events matching a
//                     declarative predicate (retroactive logpoints for free).
//  • whenChanged    — backward data-breakpoint: when did a URL / storage key /
//                     DOM region LAST change before a moment, and to what?
//
// Pure — unit-tested with synthetic archives.

import type { BusEvent, EventKind, Trust } from '../core/EventBus.js';
import type { SessionArchive, StorageKeyframe } from './SessionArchive.js';

// ── queryTimeline ────────────────────────────────────────────────────────────

export interface TimelineQuery {
  kind?: EventKind;
  trust?: Trust;
  /** Exact network status (e.g. 404). */
  status?: number;
  /** Network status at or above (e.g. 400 → all client/server errors). */
  statusGte?: number;
  /** Console level (e.g. "error"). */
  level?: string;
  /** Substring match on a network/navigation url. */
  urlContains?: string;
  /** Substring match anywhere in the event's stringified data. */
  textContains?: string;
  /** Timestamp bounds. */
  from?: number;
  to?: number;
}

function matches(e: BusEvent, q: TimelineQuery): boolean {
  if (q.kind && e.kind !== q.kind) return false;
  if (q.trust && e.trust !== q.trust) return false;
  if (q.from !== undefined && e.timestamp < q.from) return false;
  if (q.to !== undefined && e.timestamp > q.to) return false;

  const d = (e.data ?? {}) as Record<string, unknown>;
  if (q.status !== undefined && d.status !== q.status) return false;
  if (q.statusGte !== undefined) {
    if (typeof d.status !== 'number' || d.status < q.statusGte) return false;
  }
  if (q.level !== undefined && String(d.level ?? '') !== q.level) return false;
  if (q.urlContains !== undefined && !String(d.url ?? '').includes(q.urlContains)) return false;
  if (q.textContains !== undefined) {
    if (!JSON.stringify(d).toLowerCase().includes(q.textContains.toLowerCase())) return false;
  }
  return true;
}

/** All recorded events matching the predicate, in order. */
export function queryTimeline(events: BusEvent[], q: TimelineQuery, limit = 200): BusEvent[] {
  const hits = events.filter((e) => matches(e, q));
  return hits.slice(-limit);
}

// ── whenChanged ──────────────────────────────────────────────────────────────

export type ChangeTarget =
  | { type: 'url' }
  | { type: 'storage'; key: string; store?: 'local' | 'session' }
  | { type: 'dom'; textContains: string };

export interface ChangeResult {
  found: boolean;
  target: string;
  changedAt?: number;
  from?: string;
  to?: string;
  event?: BusEvent;
  note: string;
}

function storageValue(
  kf: StorageKeyframe,
  key: string,
  store: 'local' | 'session',
): string | undefined {
  const map = store === 'session' ? kf.sessionStorage : kf.localStorage;
  return map[key];
}

/**
 * When did `target` LAST change at or before `beforeTs`? Answered from the
 * recorded timeline (URL/DOM) or storage keyframes. Granularity for storage is
 * the keyframe interval — honest, not instruction-precise.
 */
export function whenChanged(
  archive: SessionArchive,
  target: ChangeTarget,
  beforeTs: number,
): ChangeResult {
  if (target.type === 'url') {
    const navs = archive.events.filter((e) => e.kind === 'navigation' && e.timestamp <= beforeTs);
    let last: { at: number; from?: string; to: string; event: BusEvent } | null = null;
    let prev: string | undefined;
    for (const e of navs) {
      const url = String((e.data as { url?: string }).url ?? '');
      if (url !== prev) last = { at: e.timestamp, from: prev, to: url, event: e };
      prev = url;
    }
    return last
      ? {
          found: true,
          target: 'url',
          changedAt: last.at,
          from: last.from,
          to: last.to,
          event: last.event,
          note: 'last navigation before the moment',
        }
      : { found: false, target: 'url', note: 'no navigation recorded before the moment' };
  }

  if (target.type === 'storage') {
    const store = target.store ?? 'local';
    const frames = archive.keyframes
      .filter((k): k is StorageKeyframe => k.kind === 'storage' && k.timestamp <= beforeTs)
      .sort((a, b) => a.timestamp - b.timestamp);
    let last: { at: number; from?: string; to?: string } | null = null;
    let prev: string | undefined;
    let first = true;
    for (const kf of frames) {
      const val = storageValue(kf, target.key, store);
      if (!first && val !== prev) last = { at: kf.timestamp, from: prev, to: val };
      prev = val;
      first = false;
    }
    const label = `${store}Storage["${target.key}"]`;
    return last
      ? {
          found: true,
          target: label,
          changedAt: last.at,
          from: last.from,
          to: last.to,
          note: 'change detected between storage keyframes (interval-granular)',
        }
      : {
          found: false,
          target: label,
          note: frames.length
            ? 'value did not change across the recorded storage keyframes before the moment'
            : 'no storage keyframes were recorded before the moment',
        };
  }

  // dom: last mutation whose stringified details mention the text.
  const needle = target.textContains.toLowerCase();
  const muts = archive.events.filter(
    (e) =>
      e.kind === 'mutation' &&
      e.timestamp <= beforeTs &&
      JSON.stringify(e.data ?? {})
        .toLowerCase()
        .includes(needle),
  );
  const last = muts[muts.length - 1];
  return last
    ? {
        found: true,
        target: `dom~"${target.textContains}"`,
        changedAt: last.timestamp,
        event: last,
        note: 'last DOM mutation matching the text before the moment',
      }
    : {
        found: false,
        target: `dom~"${target.textContains}"`,
        note: 'no matching DOM mutation recorded before the moment',
      };
}
