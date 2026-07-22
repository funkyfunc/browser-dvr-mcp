// ─── Skill Gate ─────────────────────────────────────────────────────────────
// The validation-gated active-memory loop. A "skill" is a reusable flow for an
// origin (a recorded action bundle + an end-state probe that defines success).
// A skill does NOT enter trusted, recall-able site memory just because it was
// observed once — it must PASS its probe against the live site first. This is
// the difference between validated learning and replay-and-hope caching.
//
// Positive learning: a candidate whose probe passes is ADMITTED and recalled as
// a trusted flow. Negative learning: a previously-admitted skill whose probe now
// fails is demoted to STALE (the site drifted) and becomes a gotcha that feeds
// prescriptive explain. Reversible (history, never deleted), bounded, versioned.
//
// Pure over the validation results — unit-tested with synthetic outcomes.

import type { Assertion, ScenarioResult } from '../eval/Scenario.js';
import type { ReproBundle } from '../replay/ReplayEngine.js';
import type { Gotcha } from './SiteMemory.js';

export type SkillStatus = 'candidate' | 'admitted' | 'stale' | 'rejected';

export interface SkillTrial {
  at: number;
  outcome: 'admitted' | 'rejected' | 'stale';
  reason: string;
}

export interface Skill {
  origin: string;
  name: string;
  status: SkillStatus;
  /** The recorded action sequence, re-drivable by resolved coordinates. */
  bundle: ReproBundle;
  /** The end-state probe that defines "this flow succeeded". */
  assertions: Assertion[];
  proposedAt: number;
  decidedAt?: number;
  /** Total validation attempts and how many were green — versioning signal. */
  trials: number;
  passes: number;
  history: SkillTrial[];
}

export interface GateDecision {
  admit: boolean;
  reason: string;
  /** The candidate's own probe assertions that were not met. */
  failedAssertions: string[];
  /** Previously-admitted peers whose probe now fails (site drift). */
  peerRegressions: string[];
}

const HISTORY_CAP = 20;

function describeAssertion(a: { type: string; value?: string }): string {
  return `${a.type}${a.value ? ` "${a.value}"` : ''}`;
}

/**
 * The admission rule. A candidate is admitted iff its own probe FULLY passes
 * (a skill with no assertions can never be admitted — you must define success).
 * Admitting is independent of peers, but peers that regressed are reported so
 * the caller can demote them to `stale`: negative knowledge, not deletion.
 */
export function evaluateAdmission(
  candidate: ScenarioResult,
  peers: { name: string; result: ScenarioResult }[],
): GateDecision {
  const failedAssertions = candidate.assertions.filter((a) => !a.met).map(describeAssertion);
  const admit = candidate.passed;
  const peerRegressions = peers.filter((p) => !p.result.passed).map((p) => p.name);

  let reason: string;
  if (admit) {
    reason =
      peerRegressions.length > 0
        ? `Admitted: the skill's probe passed. But ${peerRegressions.length} previously-admitted skill(s) now fail (${peerRegressions.join(', ')}) — the site likely drifted; they were demoted to stale.`
        : "Admitted: the skill's probe passed and no admitted peer regressed.";
  } else {
    reason = `Rejected: the skill's probe did not pass (${
      failedAssertions.length
        ? `unmet: ${failedAssertions.join('; ')}`
        : 'no assertions were defined or met'
    }). Not admitted to trusted site memory.`;
  }

  return { admit, reason, failedAssertions, peerRegressions };
}

/** Transition a candidate by a gate decision. Reversible: appends to history. */
export function applyDecision(skill: Skill, decision: GateDecision, now: number): Skill {
  const trial: SkillTrial = {
    at: now,
    outcome: decision.admit ? 'admitted' : 'rejected',
    reason: decision.reason,
  };
  return {
    ...skill,
    status: decision.admit ? 'admitted' : 'rejected',
    decidedAt: now,
    trials: skill.trials + 1,
    passes: skill.passes + (decision.admit ? 1 : 0),
    history: [...skill.history, trial].slice(-HISTORY_CAP),
  };
}

/** Demote a drifted, previously-admitted skill. Not deleted — re-validatable. */
export function markStale(skill: Skill, now: number, reason: string): Skill {
  return {
    ...skill,
    status: 'stale',
    decidedAt: now,
    history: [...skill.history, { at: now, outcome: 'stale' as const, reason }].slice(-HISTORY_CAP),
  };
}

/**
 * Turn a rejected/stale skill into a gotcha for site memory — negative knowledge
 * that prescriptive explain already consumes. Returns undefined if the skill has
 * no anchoring action to describe.
 */
export function skillToGotcha(skill: Skill): Gotcha | undefined {
  const first = skill.bundle.actions[0];
  if (!first) return undefined;
  const last = skill.history[skill.history.length - 1]?.reason ?? 'failed validation';
  return {
    action: first.action,
    reason: `flow "${skill.name}" no longer completes: ${last}`.slice(0, 160),
  };
}

/** Build a fresh candidate skill. */
export function newCandidate(
  origin: string,
  name: string,
  bundle: ReproBundle,
  assertions: Assertion[],
  now: number,
): Skill {
  return {
    origin,
    name,
    status: 'candidate',
    bundle,
    assertions,
    proposedAt: now,
    trials: 0,
    passes: 0,
    history: [],
  };
}
