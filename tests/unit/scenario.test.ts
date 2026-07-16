// Mock-free unit tests for the scenario runner (injected fakes, no Chrome).
import { describe, it, expect } from 'vitest';
import { runScenario, type Scenario } from '../../src/eval/Scenario.js';
import type { ReproBundle } from '../../src/replay/ReplayEngine.js';

const bundle: ReproBundle = {
  version: 1,
  eventCount: 1,
  startedAt: 0,
  endedAt: 1,
  actions: [{ seq: 1, timestamp: 0, action: 'click', success: true, coordinates: { x: 1, y: 2 } }],
  navigations: [{ timestamp: 0, url: 'http://localhost/app' }],
  networkFailures: [],
};

const emptyReplay = { replayed: 2, skipped: 0, steps: [] };

describe('runScenario', () => {
  it('passes when every assertion is met', async () => {
    const scenario: Scenario = {
      name: 's',
      createdAt: 0,
      bundle,
      assertions: [
        { type: 'text', value: 'Success' },
        { type: 'url', value: '/app' },
      ],
    };
    const result = await runScenario(scenario, {
      replay: async () => emptyReplay,
      check: async () => ({ met: true, details: 'ok' }),
    });
    expect(result.passed).toBe(true);
    expect(result.assertions).toHaveLength(2);
    expect(result.replay.replayed).toBe(2);
  });

  it('fails when any assertion is unmet', async () => {
    const scenario: Scenario = {
      name: 's',
      createdAt: 0,
      bundle,
      assertions: [
        { type: 'text', value: 'Success' },
        { type: 'text', value: 'NeverAppears' },
      ],
    };
    const result = await runScenario(scenario, {
      replay: async () => emptyReplay,
      check: async (a) => ({ met: a.value === 'Success', details: a.value ?? '' }),
    });
    expect(result.passed).toBe(false);
    expect(result.assertions.filter((a) => a.met)).toHaveLength(1);
  });

  it('does not pass a scenario with no assertions', async () => {
    const scenario: Scenario = { name: 's', createdAt: 0, bundle, assertions: [] };
    const result = await runScenario(scenario, {
      replay: async () => emptyReplay,
      check: async () => ({ met: true, details: 'ok' }),
    });
    expect(result.passed).toBe(false);
  });
});
