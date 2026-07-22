// Mock-free unit tests for SkillRegistry: real disk (temp-sandboxed), injected
// browser deps. Exercises the full propose -> validate -> admit/reject/stale loop.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { SkillRegistry, type ValidateDeps } from '../../src/memory/SkillRegistry.js';
import type { ReproBundle } from '../../src/replay/ReplayEngine.js';
import type { Assertion } from '../../src/eval/Scenario.js';

const SANDBOX = path.join(os.tmpdir(), `bbmcp-skills-test-${process.pid}`);
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
  process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
  else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

const URL = 'https://shop.example/cart';

function bundle(): ReproBundle {
  return {
    version: 1,
    eventCount: 1,
    startedAt: 0,
    endedAt: 1,
    actions: [
      { seq: 0, timestamp: 0, action: 'click', coordinates: { x: 5, y: 5 }, success: true },
    ],
    navigations: [{ timestamp: 0, url: URL }],
    networkFailures: [],
  };
}

// Deps whose assertion checker consults a mutable map keyed by assertion value —
// lets a test flip the "live site" state between validations to simulate drift.
function makeDeps(state: Record<string, boolean>, clock = { t: 1000 }): ValidateDeps {
  return {
    replay: async () => ({ replayed: 1, skipped: 0, steps: [] }),
    check: async (a: Assertion) => {
      const met = state[a.value ?? ''] ?? false;
      return { met, details: met ? 'present' : 'absent' };
    },
    now: () => clock.t++,
  };
}

describe('SkillRegistry', () => {
  it('proposes a candidate that is not yet admitted', async () => {
    const reg = new SkillRegistry();
    const c = await reg.propose(
      URL,
      'add-to-cart',
      bundle(),
      [{ type: 'text', value: 'In cart' }],
      100,
    );
    expect(c?.status).toBe('candidate');
    expect(await reg.list(URL, 'admitted')).toEqual([]);
    expect((await reg.list(URL, 'candidate')).length).toBe(1);
  });

  it('admits a candidate whose probe passes against the live site', async () => {
    const reg = new SkillRegistry();
    await reg.propose(URL, 'add-to-cart', bundle(), [{ type: 'text', value: 'In cart' }], 100);
    const out = await reg.validate(URL, 'add-to-cart', makeDeps({ 'In cart': true }));
    expect(out.decision.admit).toBe(true);
    expect(out.skill.status).toBe('admitted');
    expect(out.skill.passes).toBe(1);
    expect(out.gotchas).toEqual([]);
    // Persisted.
    expect((await reg.list(URL, 'admitted')).map((s) => s.name)).toEqual(['add-to-cart']);
  });

  it('rejects a candidate whose probe fails and emits a gotcha', async () => {
    const reg = new SkillRegistry();
    await reg.propose(URL, 'checkout', bundle(), [{ type: 'text', value: 'Order placed' }], 100);
    const out = await reg.validate(URL, 'checkout', makeDeps({ 'Order placed': false }));
    expect(out.decision.admit).toBe(false);
    expect(out.skill.status).toBe('rejected');
    expect(out.gotchas.length).toBe(1);
    expect(out.gotchas[0].reason).toContain('checkout');
  });

  it('demotes a drifted admitted peer to stale when validating a new candidate', async () => {
    const reg = new SkillRegistry();
    const state = { search: true, cart: true };
    const deps = makeDeps(state);

    // Admit "search" while its probe passes.
    await reg.propose(URL, 'search', bundle(), [{ type: 'text', value: 'search' }], 100);
    const first = await reg.validate(URL, 'search', deps);
    expect(first.skill.status).toBe('admitted');

    // Site drifts: search's probe no longer holds. Now validate a new candidate.
    state.search = false;
    await reg.propose(URL, 'cart', bundle(), [{ type: 'text', value: 'cart' }], 200);
    const second = await reg.validate(URL, 'cart', deps);

    expect(second.decision.admit).toBe(true); // cart itself is fine
    expect(second.decision.peerRegressions).toEqual(['search']);
    const stale = await reg.get(URL, 'search');
    expect(stale?.status).toBe('stale');
    // The drift became negative knowledge.
    expect(second.gotchas.some((g) => g.reason.includes('search'))).toBe(true);
  });

  it('throws for an unknown skill name', async () => {
    const reg = new SkillRegistry();
    await expect(reg.validate(URL, 'nope', makeDeps({}))).rejects.toThrow(/No skill named/);
  });
});
