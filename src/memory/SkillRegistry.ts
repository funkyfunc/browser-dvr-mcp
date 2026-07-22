// ─── Skill Registry ─────────────────────────────────────────────────────────
// Durable, per-origin store for validation-gated skills. Wraps the pure gate in
// skillGate.ts with persistence (JsonStore) and the validation drive: replay the
// candidate + peers against the live site and apply the admission decision.
//
// The live-browser dependencies (replay driver + assertion checker + clock) are
// INJECTED — same pattern as runScenario — so the whole flow is unit-testable
// without Chrome. Privacy inherits from JsonStore (contained + redacted).

import { JsonStore, originKey } from '../persistence/store.js';
import { runScenario, type Assertion, type ScenarioResult } from '../eval/Scenario.js';
import type { ReproBundle, ReplayReport } from '../replay/ReplayEngine.js';
import type { Gotcha } from './SiteMemory.js';
import {
  evaluateAdmission,
  applyDecision,
  markStale,
  skillToGotcha,
  newCandidate,
  type Skill,
  type SkillStatus,
  type GateDecision,
} from './skillGate.js';

/** Live-browser dependencies for a validation run (injected, like runScenario). */
export interface ValidateDeps {
  replay: (bundle: ReproBundle) => Promise<ReplayReport>;
  check: (assertion: Assertion) => Promise<{ met: boolean; details: string }>;
  now: () => number;
}

export interface ValidationOutcome {
  decision: GateDecision;
  candidate: ScenarioResult;
  peers: { name: string; result: ScenarioResult }[];
  skill: Skill;
  /** Gotchas produced by rejected/stale skills, for the caller to persist. */
  gotchas: Gotcha[];
}

const CAP_SKILLS = 50;

export class SkillRegistry {
  private store = new JsonStore<Skill[]>('skills');
  private readonly enabled = process.env.BROWSER_MCP_NO_MEMORY !== '1';

  private async load(url: string): Promise<Skill[]> {
    return (await this.store.read(originKey(url))) ?? [];
  }

  private async save(url: string, skills: Skill[]): Promise<void> {
    await this.store.write(originKey(url), skills.slice(-CAP_SKILLS));
  }

  /** Record the current session's bundle as a candidate skill (overwrites by name). */
  async propose(
    url: string,
    name: string,
    bundle: ReproBundle,
    assertions: Assertion[],
    now: number,
  ): Promise<Skill | undefined> {
    if (!this.enabled) return undefined;
    const origin = originKey(url);
    const skills = await this.load(url);
    const candidate = newCandidate(origin, name, bundle, assertions, now);
    const next = skills.filter((s) => s.name !== name);
    next.push(candidate);
    await this.save(url, next);
    return candidate;
  }

  async list(url: string, status?: SkillStatus): Promise<Skill[]> {
    if (!this.enabled) return [];
    const skills = await this.load(url);
    return status ? skills.filter((s) => s.status === status) : skills;
  }

  async get(url: string, name: string): Promise<Skill | undefined> {
    if (!this.enabled) return undefined;
    return (await this.load(url)).find((s) => s.name === name);
  }

  /**
   * The gate. Replays the named candidate against the live site and checks its
   * probe; admits iff the probe fully passes. Simultaneously re-checks every
   * currently-admitted peer — any that now fails is demoted to `stale` and
   * turned into a gotcha. Persists all transitions and returns the outcome.
   */
  async validate(url: string, name: string, deps: ValidateDeps): Promise<ValidationOutcome> {
    if (!this.enabled) throw new Error('Skill memory is disabled (BROWSER_MCP_NO_MEMORY=1).');

    const skills = await this.load(url);
    const idx = skills.findIndex((s) => s.name === name);
    if (idx === -1) {
      throw new Error(
        `No skill named "${name}" for this origin. Propose one with browser_propose_skill first.`,
      );
    }
    const target = skills[idx];

    const run = (s: Skill) =>
      runScenario(
        { name: s.name, createdAt: s.proposedAt, bundle: s.bundle, assertions: s.assertions },
        { replay: deps.replay, check: deps.check },
      );

    // Validate the candidate first, then re-check admitted peers against the
    // same live state to detect drift.
    const candidate = await run(target);
    const peerSkills = skills.filter((s) => s.name !== name && s.status === 'admitted');
    const peers: { name: string; result: ScenarioResult }[] = [];
    for (const p of peerSkills) {
      peers.push({ name: p.name, result: await run(p) });
    }

    const decision = evaluateAdmission(candidate, peers);
    const now = deps.now();
    const gotchas: Gotcha[] = [];

    // Apply the decision to the candidate.
    const decided = applyDecision(target, decision, now);
    skills[idx] = decided;
    if (!decision.admit) {
      const g = skillToGotcha(decided);
      if (g) gotchas.push(g);
    }

    // Demote any regressed peer and record its gotcha.
    for (const regressedName of decision.peerRegressions) {
      const pIdx = skills.findIndex((s) => s.name === regressedName);
      if (pIdx === -1) continue;
      const stale = markStale(
        skills[pIdx],
        now,
        `probe failed on re-validation while admitting "${name}"`,
      );
      skills[pIdx] = stale;
      const g = skillToGotcha(stale);
      if (g) gotchas.push(g);
    }

    await this.save(url, skills);
    return { decision, candidate, peers, skill: decided, gotchas };
  }
}
