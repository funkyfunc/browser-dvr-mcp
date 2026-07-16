// ─── Eval / Regression Scenarios ────────────────────────────────────────────
// A scenario = a recorded repro bundle + a set of end-state assertions. Saved
// once ("the agent completes checkout"), re-run against every deploy to catch
// regressions: replay the actions, then assert the page reached the expected
// state. The wedge for agent developers — record → replay → ASSERT.

import type { ReproBundle, ReplayReport } from '../replay/ReplayEngine.js';
import type { WaitCondition } from '../layer1/waitForCondition.js';

/** An end-state assertion — reuses the declarative wait-condition vocabulary. */
export type Assertion = WaitCondition;

export interface Scenario {
  name: string;
  createdAt: number;
  bundle: ReproBundle;
  assertions: Assertion[];
}

export interface AssertionResult {
  type: string;
  value?: string;
  met: boolean;
  details: string;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  replay: ReplayReport;
  assertions: AssertionResult[];
}

/**
 * Run a scenario: replay its bundle, then evaluate each assertion. Dependencies
 * (the replay driver and the assertion checker) are injected so this is pure
 * enough to unit-test without a live browser.
 */
export async function runScenario(
  scenario: Scenario,
  deps: {
    replay: (bundle: ReproBundle) => Promise<ReplayReport>;
    check: (assertion: Assertion) => Promise<{ met: boolean; details: string }>;
  },
): Promise<ScenarioResult> {
  const replay = await deps.replay(scenario.bundle);

  const assertions: AssertionResult[] = [];
  for (const a of scenario.assertions) {
    const r = await deps.check(a);
    assertions.push({ type: a.type, value: a.value, met: r.met, details: r.details });
  }

  return {
    name: scenario.name,
    passed: assertions.length > 0 && assertions.every((a) => a.met),
    replay,
    assertions,
  };
}
