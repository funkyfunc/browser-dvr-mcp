// ─── Causal Explain ─────────────────────────────────────────────────────────
// The differentiator: given the provenance-tagged event timeline, explain WHY a
// state came to be — link a focal action to the network / console / DOM events
// in its temporal window and synthesize a human-readable hypothesis.
//
// "Your click failed because a modal covered the target; here are the 2 requests
//  that failed and the 40 DOM mutations that happened in the 900ms after."
//
// Pure over the event list — unit-tested with a synthetic timeline, no Chrome.

import type { BusEvent } from '../core/EventBus.js';

export interface ActionSummary {
  action: string;
  success: boolean;
  feedback: string;
  navOccurred: boolean;
  target?: unknown;
  timestamp: number;
}

export interface CausalReport {
  action: ActionSummary | null;
  window: { fromMs: number; toMs: number };
  network: { failures: unknown[]; totalInWindow: number };
  console: { errors: unknown[]; totalInWindow: number };
  mutations: { totalInWindow: number };
  hypotheses: string[];
  summary: string;
  /** What to actually DO about it (present when the action failed / looks wrong). */
  remediation?: Remediation;
}

export interface Remediation {
  suggestion: string;
  /** false when retrying is unlikely to help (auth, server error). */
  retrySafe: boolean;
  occluderId?: number;
  nextTool?: string;
}

/** A known failure recorded for this origin by site memory. */
export interface KnownGotcha {
  action: string;
  reason: string;
}

const DEFAULT_WINDOW_MS = 1500;
const PRE_WINDOW_MS = 200; // a little before the action, to catch the blocking state
const MUTATION_BURST = 15;

/** Best-effort parse of an occluder's backendNodeId out of a failure message. */
function parseOccluderId(feedback: string): number | undefined {
  const m = feedback.match(/id:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function asAction(e: BusEvent): ActionSummary | null {
  if (e.kind !== 'action') return null;
  const d = (e.data ?? {}) as Record<string, unknown>;
  return {
    action: String(d.action ?? 'action'),
    success: d.success !== false,
    feedback: String(d.feedback ?? ''),
    navOccurred: d.navOccurred === true,
    target: d.target,
    timestamp: e.timestamp,
  };
}

/**
 * Explain the outcome of a focal action. Anchors on `anchorSeq` if given, else
 * the most recent `action` event. Returns a structured causal report.
 */
export function causalExplain(
  events: BusEvent[],
  opts: { windowMs?: number; anchorSeq?: number; knownGotchas?: KnownGotcha[] } = {},
): CausalReport {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;

  // Find the anchor action.
  let anchor: BusEvent | undefined;
  if (opts.anchorSeq !== undefined) {
    anchor = events.find((e) => e.seq === opts.anchorSeq && e.kind === 'action');
  } else {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'action') {
        anchor = events[i];
        break;
      }
    }
  }

  const action = anchor ? asAction(anchor) : null;

  if (!action) {
    return {
      action: null,
      window: { fromMs: 0, toMs: 0 },
      network: { failures: [], totalInWindow: 0 },
      console: { errors: [], totalInWindow: 0 },
      mutations: { totalInWindow: 0 },
      hypotheses: [],
      summary: 'No action has been recorded yet, so there is nothing to explain.',
    };
  }

  const fromMs = action.timestamp - PRE_WINDOW_MS;
  const toMs = action.timestamp + windowMs;
  const inWindow = events.filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs);

  const networkEvents = inWindow.filter((e) => e.kind === 'network');
  const networkFailures = networkEvents.filter((e) => {
    const d = e.data as { eventType?: string; status?: number };
    return d.eventType === 'failed' || (typeof d.status === 'number' && d.status >= 400);
  });

  const consoleEvents = inWindow.filter((e) => e.kind === 'console');
  const consoleErrors = consoleEvents.filter(
    (e) => (e.data as { level?: string }).level === 'error',
  );

  const mutationCount = inWindow.filter((e) => e.kind === 'mutation').length;

  // ── Synthesize hypotheses (most-load-bearing first) ──────────────────────
  const hypotheses: string[] = [];

  if (!action.success) {
    const fb = action.feedback.toLowerCase();
    if (fb.includes('occlud') || fb.includes('hit element') || fb.includes('intercept')) {
      hypotheses.push(
        `The ${action.action} was blocked by another element on top of the target — ${action.feedback.split('\n')[0]}`,
      );
    } else if (fb.includes('spatial validation') || fb.includes('out of viewport')) {
      hypotheses.push(
        `The target could not be located/validated for the ${action.action}: ${action.feedback.split('\n')[0]}`,
      );
    } else {
      hypotheses.push(`The ${action.action} did not succeed: ${action.feedback.split('\n')[0]}`);
    }
  }

  if (networkFailures.length > 0) {
    const preview = networkFailures
      .slice(0, 3)
      .map((e) => {
        const d = e.data as { method?: string; url?: string; status?: number; errorText?: string };
        return `${d.method ?? ''} ${d.url ?? ''}${d.status ? ` → ${d.status}` : d.errorText ? ` (${d.errorText})` : ''}`.trim();
      })
      .join('; ');
    hypotheses.push(
      `${networkFailures.length} network request(s) failed within ${windowMs}ms of the action: ${preview}`,
    );
  }

  if (consoleErrors.length > 0) {
    const preview = consoleErrors
      .slice(0, 2)
      .map((e) => String((e.data as { text?: string }).text ?? '').slice(0, 120))
      .join(' | ');
    hypotheses.push(`${consoleErrors.length} console error(s) fired: ${preview}`);
  }

  if (action.navOccurred) {
    hypotheses.push('A navigation occurred as a result of the action — the page context reset.');
  } else if (mutationCount >= MUTATION_BURST) {
    hypotheses.push(
      `The DOM changed substantially (${mutationCount} mutations) right after the action — the target may have moved or re-rendered.`,
    );
  }

  const summary =
    hypotheses.length > 0
      ? `${action.success ? 'The ' + action.action + ' succeeded, but' : 'The ' + action.action + ' failed;'} ${hypotheses[0]}`
      : `The ${action.action} ${action.success ? 'succeeded' : 'was reported as failed'} and nothing notable happened in the ${windowMs}ms after it (no failed requests, console errors, or large DOM changes).`;

  // ── Prescriptive: turn the diagnosis into a concrete next step ───────────
  const statuses = networkFailures.map((e) => (e.data as { status?: number }).status ?? 0);
  const fb = action.feedback.toLowerCase();
  let remediation: Remediation | undefined;

  if (
    !action.success &&
    (fb.includes('occlud') || fb.includes('hit element') || fb.includes('intercept'))
  ) {
    const occluderId = parseOccluderId(action.feedback);
    remediation = {
      suggestion: `Dismiss the blocking element${occluderId ? ` (id: ${occluderId})` : ''} or press Escape, then retry the ${action.action}.`,
      retrySafe: true,
      occluderId,
      nextTool: 'atomic_interact',
    };
  } else if (statuses.some((s) => s === 401 || s === 403)) {
    remediation = {
      suggestion:
        'The action triggered an auth failure (401/403) — you likely need to authenticate before this will work.',
      retrySafe: false,
    };
  } else if (statuses.some((s) => s >= 500)) {
    remediation = {
      suggestion:
        'A server error (5xx) occurred; the failure is server-side, so retrying is unlikely to help.',
      retrySafe: false,
    };
  } else if (action.navOccurred) {
    remediation = {
      suggestion:
        'The page navigated — call get_semantic_surface to re-perceive before continuing.',
      retrySafe: true,
      nextTool: 'get_semantic_surface',
    };
  } else if (mutationCount >= MUTATION_BURST) {
    remediation = {
      suggestion: `The DOM re-rendered (${mutationCount} mutations) — re-fetch the element's id via get_semantic_surface before retrying; it may have moved.`,
      retrySafe: true,
      nextTool: 'get_semantic_surface',
    };
  } else if (!action.success) {
    remediation = {
      suggestion:
        'Re-perceive with get_semantic_surface and retry; the target may not have been where expected.',
      retrySafe: true,
      nextTool: 'get_semantic_surface',
    };
  }

  // Fold in what site memory already knows about failures on this action here.
  const knownFix = opts.knownGotchas?.find((g) => g.action === action.action);
  if (knownFix) {
    const note = `Heads up — this site has failed this ${action.action} before: "${knownFix.reason}".`;
    remediation = remediation
      ? { ...remediation, suggestion: `${remediation.suggestion} ${note}` }
      : { suggestion: note, retrySafe: true };
  }

  return {
    action,
    window: { fromMs, toMs },
    network: { failures: networkFailures.map((e) => e.data), totalInWindow: networkEvents.length },
    console: { errors: consoleErrors.map((e) => e.data), totalInWindow: consoleEvents.length },
    mutations: { totalInWindow: mutationCount },
    hypotheses,
    summary,
    remediation,
  };
}
