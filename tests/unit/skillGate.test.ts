// Mock-free unit tests for the validation-gated memory loop's pure core.
import { describe, it, expect } from 'vitest';
import type { ScenarioResult } from '../../src/eval/Scenario.js';
import type { ReproBundle } from '../../src/replay/ReplayEngine.js';
import {
  evaluateAdmission,
  applyDecision,
  markStale,
  skillToGotcha,
  newCandidate,
  type Skill,
} from '../../src/memory/skillGate.js';

const emptyReplay = { replayed: 0, skipped: 0, steps: [] };

function result(name: string, mets: boolean[]): ScenarioResult {
  const assertions = mets.map((met, i) => ({
    type: 'text',
    value: `probe-${i}`,
    met,
    details: met ? 'met' : 'not met',
  }));
  return {
    name,
    passed: assertions.length > 0 && assertions.every((a) => a.met),
    replay: emptyReplay,
    assertions,
  };
}

function bundle(actions: number): ReproBundle {
  return {
    version: 1,
    eventCount: actions,
    startedAt: 0,
    endedAt: actions,
    actions: Array.from({ length: actions }, (_, i) => ({
      seq: i,
      timestamp: i,
      action: 'click',
      coordinates: { x: i, y: i },
      success: true,
    })),
    navigations: [{ timestamp: 0, url: 'https://shop.example/cart' }],
    networkFailures: [],
  };
}

describe('evaluateAdmission', () => {
  it('admits a candidate whose probe fully passes', () => {
    const d = evaluateAdmission(result('add-to-cart', [true, true]), []);
    expect(d.admit).toBe(true);
    expect(d.failedAssertions).toEqual([]);
    expect(d.reason).toContain('Admitted');
  });

  it('rejects a candidate with any unmet assertion and names it', () => {
    const d = evaluateAdmission(result('checkout', [true, false]), []);
    expect(d.admit).toBe(false);
    expect(d.failedAssertions).toEqual(['text "probe-1"']);
    expect(d.reason).toContain('Rejected');
  });

  it('never admits a skill with no assertions (success undefined)', () => {
    const d = evaluateAdmission(result('empty', []), []);
    expect(d.admit).toBe(false);
    expect(d.reason.toLowerCase()).toContain('no assertions');
  });

  it('admits the candidate but reports peer regressions from site drift', () => {
    const peers = [
      { name: 'search', result: result('search', [true]) },
      { name: 'login', result: result('login', [false]) }, // regressed
    ];
    const d = evaluateAdmission(result('add-to-cart', [true]), peers);
    expect(d.admit).toBe(true);
    expect(d.peerRegressions).toEqual(['login']);
    expect(d.reason).toContain('drifted');
    expect(d.reason).toContain('login');
  });
});

describe('applyDecision / markStale', () => {
  const base: Skill = newCandidate('https://shop.example', 'add-to-cart', bundle(2), [], 1000);

  it('admits: flips status, bumps trials+passes, records history', () => {
    const decided = applyDecision(base, evaluateAdmission(result('x', [true]), []), 2000);
    expect(decided.status).toBe('admitted');
    expect(decided.trials).toBe(1);
    expect(decided.passes).toBe(1);
    expect(decided.decidedAt).toBe(2000);
    expect(decided.history.at(-1)?.outcome).toBe('admitted');
  });

  it('rejects: flips status, bumps trials but not passes', () => {
    const decided = applyDecision(base, evaluateAdmission(result('x', [false]), []), 2000);
    expect(decided.status).toBe('rejected');
    expect(decided.trials).toBe(1);
    expect(decided.passes).toBe(0);
    expect(decided.history.at(-1)?.outcome).toBe('rejected');
  });

  it('marks a drifted admitted skill stale without deleting it', () => {
    const admitted: Skill = { ...base, status: 'admitted' };
    const stale = markStale(admitted, 3000, 'probe text no longer present');
    expect(stale.status).toBe('stale');
    expect(stale.bundle).toEqual(admitted.bundle); // preserved, re-validatable
    expect(stale.history.at(-1)?.outcome).toBe('stale');
  });

  it('caps history growth', () => {
    let s = base;
    for (let i = 0; i < 30; i++) {
      s = applyDecision(s, evaluateAdmission(result('x', [true]), []), 1000 + i);
    }
    expect(s.history.length).toBeLessThanOrEqual(20);
    expect(s.trials).toBe(30);
  });
});

describe('skillToGotcha', () => {
  it('converts a stale skill into negative knowledge anchored on its first action', () => {
    const stale = markStale(
      { ...newCandidate('o', 'checkout', bundle(1), [], 1), status: 'admitted' },
      2,
      'button gone',
    );
    const g = skillToGotcha(stale);
    expect(g?.action).toBe('click');
    expect(g?.reason).toContain('checkout');
    expect(g?.reason).toContain('button gone');
  });

  it('returns undefined when there is no action to anchor on', () => {
    const empty = newCandidate('o', 'noop', bundle(0), [], 1);
    expect(skillToGotcha(empty)).toBeUndefined();
  });
});
