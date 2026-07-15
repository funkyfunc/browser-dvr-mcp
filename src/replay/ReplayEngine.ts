// ─── ReplayEngine ───────────────────────────────────────────────────────────
// Turns a recorded session (the provenance-tagged event timeline) into a
// portable repro bundle: the ordered list of agent actions plus the navigations
// and network failures that surrounded them. This is the "recorded session ->
// reproducible bug" half of the differentiator.
//
// Deterministic live re-drive (replaying via the Fetch mock + time-warp already
// in the codebase) is the next step; this module produces the artifact that
// re-drive and human inspection consume.
//
// Pure over the event list — unit-tested without a live browser.

import type { BusEvent } from '../core/EventBus.js';

export interface ReproAction {
  seq: number;
  timestamp: number;
  action: string;
  target?: unknown;
  coordinates?: { x: number; y: number };
  text?: string;
  success: boolean;
}

/** Driver the live re-drive calls into (provided by the tool layer). */
export interface ReplayDriver {
  navigate(url: string): Promise<unknown>;
  clickAt(x: number, y: number): Promise<unknown>;
  typeAt?(x: number, y: number, text: string): Promise<unknown>;
}

export interface ReplayStep {
  action: string;
  status: 'replayed' | 'skipped';
  at?: { x: number; y: number };
  reason?: string;
}

export interface ReplayReport {
  replayed: number;
  skipped: number;
  steps: ReplayStep[];
}

export interface ReproNavigation {
  timestamp: number;
  url: string;
  statusCode?: number;
}

export interface ReproNetworkFailure {
  timestamp: number;
  method?: string;
  url?: string;
  status?: number;
  errorText?: string;
}

export interface ReproBundle {
  version: 1;
  eventCount: number;
  startedAt: number | null;
  endedAt: number | null;
  actions: ReproAction[];
  navigations: ReproNavigation[];
  networkFailures: ReproNetworkFailure[];
}

export class ReplayEngine {
  /** Extract a portable repro bundle from a recorded event timeline. */
  static record(events: BusEvent[]): ReproBundle {
    const actions: ReproAction[] = [];
    const navigations: ReproNavigation[] = [];
    const networkFailures: ReproNetworkFailure[] = [];

    for (const e of events) {
      const d = (e.data ?? {}) as Record<string, unknown>;
      if (e.kind === 'action') {
        const coords = d.coordinates as { x: number; y: number } | undefined;
        actions.push({
          seq: e.seq,
          timestamp: e.timestamp,
          action: String(d.action ?? 'action'),
          target: d.target,
          coordinates:
            coords && typeof coords.x === 'number' && typeof coords.y === 'number'
              ? { x: coords.x, y: coords.y }
              : undefined,
          text: typeof d.text === 'string' ? d.text : undefined,
          success: d.success !== false,
        });
      } else if (e.kind === 'navigation') {
        navigations.push({
          timestamp: e.timestamp,
          url: String(d.url ?? ''),
          statusCode: typeof d.statusCode === 'number' ? d.statusCode : undefined,
        });
      } else if (e.kind === 'network') {
        const isFailure =
          d.eventType === 'failed' || (typeof d.status === 'number' && (d.status as number) >= 400);
        if (isFailure) {
          networkFailures.push({
            timestamp: e.timestamp,
            method: d.method as string | undefined,
            url: d.url as string | undefined,
            status: d.status as number | undefined,
            errorText: d.errorText as string | undefined,
          });
        }
      }
    }

    return {
      version: 1,
      eventCount: events.length,
      startedAt: events.length ? events[0].timestamp : null,
      endedAt: events.length ? events[events.length - 1].timestamp : null,
      actions,
      navigations,
      networkFailures,
    };
  }

  /** Render a repro bundle as a human/agent-readable, ordered step script. */
  static toScript(bundle: ReproBundle): string {
    const lines: string[] = ['# Repro script', `# ${bundle.actions.length} action(s) recorded`, ''];
    const rel = (t: number) => (bundle.startedAt ? `${t - bundle.startedAt}ms` : `${t}`);

    if (bundle.navigations.length > 0) {
      lines.push(`1. Navigate to ${bundle.navigations[0].url}`);
    }
    let step = bundle.navigations.length > 0 ? 2 : 1;
    for (const a of bundle.actions) {
      const target =
        a.target && typeof a.target === 'object'
          ? Object.entries(a.target as Record<string, unknown>)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(' ')
          : '';
      lines.push(
        `${step++}. [@${rel(a.timestamp)}] ${a.action}${target ? ` (${target})` : ''}${a.success ? '' : '  ← FAILED here'}`,
      );
    }
    if (bundle.networkFailures.length > 0) {
      lines.push('', '## Network failures during the run');
      for (const f of bundle.networkFailures.slice(0, 10)) {
        lines.push(
          `- [@${rel(f.timestamp)}] ${f.method ?? ''} ${f.url ?? ''} → ${f.status ?? f.errorText ?? 'failed'}`,
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Deterministically re-drive a repro bundle through the given driver: replay
   * the first navigation, then each action by its RESOLVED viewport coordinates
   * (stable across sessions, unlike backendNodeIds). Actions without recorded
   * coordinates are skipped with a reason so the report is honest about coverage.
   */
  static async replay(bundle: ReproBundle, driver: ReplayDriver): Promise<ReplayReport> {
    const steps: ReplayStep[] = [];

    if (bundle.navigations[0]?.url) {
      await driver.navigate(bundle.navigations[0].url);
      steps.push({ action: 'navigate', status: 'replayed' });
    }

    const CLICK_ACTIONS = new Set(['click', 'coordinate_click', 'dblclick']);
    for (const a of bundle.actions) {
      const c = a.coordinates;
      if (!c) {
        steps.push({
          action: a.action,
          status: 'skipped',
          reason: 'no resolved coordinates were recorded for this action',
        });
        continue;
      }
      if (CLICK_ACTIONS.has(a.action)) {
        await driver.clickAt(c.x, c.y);
        steps.push({ action: a.action, status: 'replayed', at: c });
      } else if (a.action === 'type' && driver.typeAt) {
        await driver.typeAt(c.x, c.y, a.text ?? '');
        steps.push({ action: a.action, status: 'replayed', at: c });
      } else {
        steps.push({
          action: a.action,
          status: 'skipped',
          reason: `action "${a.action}" is not supported by live re-drive`,
        });
      }
    }

    return {
      replayed: steps.filter((s) => s.status === 'replayed').length,
      skipped: steps.filter((s) => s.status === 'skipped').length,
      steps,
    };
  }
}
