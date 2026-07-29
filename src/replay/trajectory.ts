// ─── Trajectory analysis ────────────────────────────────────────────────────
// causalExplain diagnoses ONE action. This scans the WHOLE run to find every
// failure point, label each with an error taxonomy, and surface the EARLIEST one
// — the "first point of failure" (à la Stagehand's verifier). The earliest
// failure is usually the true root cause; later failures are often its fallout.
//
// Pure over the event timeline — unit-tested with synthetic runs.

import type { BusEvent } from '../core/EventBus.js';

export type FailureCategory =
  | 'occluded-target'
  | 'target-not-found'
  | 'timeout'
  | 'auth-failure'
  | 'server-error'
  | 'network-failure'
  | 'navigation-lost'
  | 'console-exception'
  | 'assertion-failed'
  | 'unknown';

export interface FailurePoint {
  seq: number;
  timestamp: number;
  kind: 'action' | 'assertion';
  action?: string;
  label?: string;
  category: FailureCategory;
  summary: string;
}

/** What the session actually DID — so a passive debugging run still reads usefully. */
export interface ActivitySummary {
  navigations: number;
  actions: number; // atomic_interact clicks/types/etc.
  evaluations: number; // evaluate_in_context
  waits: number; // browser_wait_for
  verifies: number; // browser_verify
  networkRequests: number;
  networkFailures: number;
  consoleErrors: number;
  mutations: number;
  totalEvents: number;
}

export interface TrajectoryReport {
  /** Interaction actions (clicks/types). Kept for back-compat; see `activity` for the full picture. */
  totalActions: number;
  activity: ActivitySummary;
  failureCount: number;
  firstFailure: FailurePoint | null;
  failures: FailurePoint[];
  summary: string;
}

function summarize(events: BusEvent[]): ActivitySummary {
  const a: ActivitySummary = {
    navigations: 0,
    actions: 0,
    evaluations: 0,
    waits: 0,
    verifies: 0,
    networkRequests: 0,
    networkFailures: 0,
    consoleErrors: 0,
    mutations: 0,
    totalEvents: events.length,
  };
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case 'navigation':
        a.navigations++;
        break;
      case 'action':
        a.actions++;
        break;
      case 'mutation':
        a.mutations++;
        break;
      case 'console':
        if (d.level === 'error') a.consoleErrors++;
        break;
      case 'network':
        a.networkRequests++;
        if (d.eventType === 'failed' || (typeof d.status === 'number' && d.status >= 400))
          a.networkFailures++;
        break;
      case 'interaction':
        if (d.type === 'evaluate') a.evaluations++;
        else if (d.type === 'wait') a.waits++;
        else if (d.type === 'verify') a.verifies++;
        break;
    }
  }
  return a;
}

const WINDOW_MS = 1500;
const PRE_MS = 200;

function windowEvents(events: BusEvent[], ts: number): BusEvent[] {
  return events.filter((e) => e.timestamp >= ts - PRE_MS && e.timestamp <= ts + WINDOW_MS);
}

function netStatuses(win: BusEvent[]): number[] {
  return win
    .filter((e) => e.kind === 'network')
    .map((e) => (e.data as { status?: number }).status ?? 0);
}

function hasNetFailure(win: BusEvent[]): boolean {
  return win.some((e) => {
    const d = e.data as { eventType?: string; status?: number };
    return (
      e.kind === 'network' &&
      (d.eventType === 'failed' || (typeof d.status === 'number' && d.status >= 400))
    );
  });
}

function hasConsoleError(win: BusEvent[]): boolean {
  return win.some((e) => e.kind === 'console' && (e.data as { level?: string }).level === 'error');
}

/** Classify why a failed action failed, from its feedback + surrounding events. */
function classifyAction(
  feedback: string,
  navOccurred: boolean,
  win: BusEvent[],
): { category: FailureCategory; summary: string } {
  const fb = feedback.toLowerCase();
  const firstLine = feedback.split('\n')[0];

  if (fb.includes('occlud') || fb.includes('hit element') || fb.includes('intercept')) {
    return { category: 'occluded-target', summary: `Target was occluded: ${firstLine}` };
  }
  if (fb.includes('timeout') || fb.includes('did not become') || fb.includes('not interactable')) {
    return { category: 'timeout', summary: `Target never became actionable: ${firstLine}` };
  }
  if (
    fb.includes('spatial validation') ||
    fb.includes('out of viewport') ||
    fb.includes('not found') ||
    fb.includes('could not locate') ||
    fb.includes('no locator')
  ) {
    return { category: 'target-not-found', summary: `Target could not be located: ${firstLine}` };
  }

  const statuses = netStatuses(win);
  if (statuses.some((s) => s === 401 || s === 403)) {
    return {
      category: 'auth-failure',
      summary: 'An auth failure (401/403) occurred around this action.',
    };
  }
  if (statuses.some((s) => s >= 500)) {
    return {
      category: 'server-error',
      summary: 'A server error (5xx) occurred around this action.',
    };
  }
  if (hasNetFailure(win)) {
    return { category: 'network-failure', summary: 'A network request failed around this action.' };
  }
  if (hasConsoleError(win)) {
    return {
      category: 'console-exception',
      summary: 'A console exception fired around this action.',
    };
  }
  if (navOccurred) {
    return { category: 'navigation-lost', summary: 'The page navigated, resetting context.' };
  }
  return {
    category: 'unknown',
    summary: firstLine || 'The action failed for an undetermined reason.',
  };
}

/** Scan the whole timeline for failure points; surface the earliest. */
export function analyzeTrajectory(events: BusEvent[]): TrajectoryReport {
  const failures: FailurePoint[] = [];
  let totalActions = 0;

  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>;

    if (e.kind === 'action') {
      totalActions++;
      if (d.success === false) {
        const win = windowEvents(events, e.timestamp);
        const { category, summary } = classifyAction(
          String(d.feedback ?? ''),
          d.navOccurred === true,
          win,
        );
        failures.push({
          seq: e.seq,
          timestamp: e.timestamp,
          kind: 'action',
          action: String(d.action ?? 'action'),
          category,
          summary,
        });
      }
    } else if (e.kind === 'interaction' && d.type === 'verify' && d.passed === false) {
      failures.push({
        seq: e.seq,
        timestamp: e.timestamp,
        kind: 'assertion',
        label: typeof d.label === 'string' ? d.label : undefined,
        category: 'assertion-failed',
        summary:
          `Checkpoint failed${d.label ? ` (${d.label})` : ''}: ${String((d.details as string) ?? '')}`.trim(),
      });
    }
  }

  const firstFailure =
    failures.length > 0 ? failures.reduce((a, b) => (a.timestamp <= b.timestamp ? a : b)) : null;

  const activity = summarize(events);

  // A useful one-liner even when nothing failed (a passive debugging session).
  let summary: string;
  if (firstFailure) {
    summary = `${failures.length} failure(s); earliest: ${firstFailure.category} — ${firstFailure.summary}`;
  } else {
    const parts = [
      activity.navigations && `${activity.navigations} navigation(s)`,
      activity.actions && `${activity.actions} action(s)`,
      activity.evaluations && `${activity.evaluations} evaluation(s)`,
      activity.waits && `${activity.waits} wait(s)`,
      activity.networkRequests &&
        `${activity.networkRequests} request(s)${activity.networkFailures ? ` (${activity.networkFailures} failed)` : ''}`,
      activity.consoleErrors && `${activity.consoleErrors} console error(s)`,
    ].filter(Boolean);
    summary = parts.length
      ? `No failures detected. Activity: ${parts.join(', ')}.`
      : 'No activity recorded on the timeline yet.';
  }

  return { totalActions, activity, failureCount: failures.length, firstFailure, failures, summary };
}
