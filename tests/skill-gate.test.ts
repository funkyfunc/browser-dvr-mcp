// End-to-end: the validation-gated active-memory loop against a live page.
// Propose a flow as a candidate skill, validate it through the gate, and confirm
// a passing probe is admitted (and recalled as trusted) while a failing probe is
// rejected and never trusted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { rmSync, existsSync } from 'fs';
import os from 'os';
import { server } from '../src/index.js';

const PAGE = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const SANDBOX = join(os.tmpdir(), `bbmcp-skill-e2e-${process.pid}`);

function handler(name: string) {
  return (server as any)._registeredTools[name].handler as (args: any) => Promise<any>;
}

describe('Validation-gated skill loop', () => {
  let savedEnv: string | undefined;
  beforeAll(async () => {
    savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
    process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
    await handler('browser_launch')({ headless: true, url: PAGE });
  });
  afterAll(async () => {
    try {
      await handler('browser_close')({});
    } catch {
      // ignore
    }
    if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
    else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
    if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
  });

  it('proposes a candidate that is not yet trusted', async () => {
    await handler('atomic_interact')({ action: 'click', coordinate: [100, 100] });
    const res = await handler('browser_propose_skill')({
      name: 'testbed-flow',
      assertions: [{ type: 'text', value: 'Adversarial' }],
    });
    expect(res.content[0].text).toContain('Proposed candidate skill');

    const list = JSON.parse(
      (await handler('browser_list_skills')({ status: 'candidate' })).content[0].text,
    );
    expect(list.map((s: any) => s.name)).toContain('testbed-flow');

    // Not trusted until validated: no admitted skills, and recall reports no
    // trusted memory yet (plain-text "first visit" branch is acceptable).
    const admitted = JSON.parse(
      (await handler('browser_list_skills')({ status: 'admitted' })).content[0].text,
    );
    expect(admitted.map?.((s: any) => s.name) ?? []).not.toContain('testbed-flow');
  });

  it('admits the candidate to trusted memory when its probe passes', async () => {
    const out = JSON.parse(
      (await handler('browser_validate_skill')({ name: 'testbed-flow' })).content[0].text,
    );
    expect(out.admitted).toBe(true);
    expect(out.status).toBe('admitted');
    expect(out.passes).toBe(1);

    // Now recall surfaces it as trusted.
    const recall = JSON.parse((await handler('browser_recall_site')({})).content[0].text);
    expect(recall.trustedSkills.map((s: any) => s.name)).toContain('testbed-flow');
  });

  it('rejects a candidate whose probe fails and never trusts it', async () => {
    await handler('browser_propose_skill')({
      name: 'bogus-flow',
      assertions: [{ type: 'text', value: 'ThisTextIsNotOnThePageXYZ' }],
    });
    const out = JSON.parse(
      (await handler('browser_validate_skill')({ name: 'bogus-flow' })).content[0].text,
    );
    expect(out.admitted).toBe(false);
    expect(out.status).toBe('rejected');

    const trusted = JSON.parse(
      (await handler('browser_list_skills')({ status: 'admitted' })).content[0].text,
    );
    expect(trusted.map?.((s: any) => s.name) ?? []).not.toContain('bogus-flow');
  });

  it('errors clearly for an unknown skill', async () => {
    await expect(handler('browser_validate_skill')({ name: 'does-not-exist' })).rejects.toThrow(
      /No skill named/,
    );
  });
});
