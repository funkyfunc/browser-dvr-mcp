/**
 * Regression tests for agent feedback fixes.
 *
 * Tests the critical fixes:
 * - Bug 1: Launch with URL no longer crashes (navigate before screencast)
 * - Bug 2: Semantic surface returns non-empty AX tree after navigation
 *          (serialization runs inline, not on broken worker thread)
 * - Bug 3: Query selector works after navigation (CDP domains re-enabled)
 * - FR 1: browser_navigate waitUntil parameter
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';

import { CDPConnectionManager } from '../src/core/CDPConnectionManager.js';
import { ImmutableNodeIndex } from '../src/core/ImmutableNodeIndex.js';
import { getSemanticSurface } from '../src/layer2/semanticSurface.js';

const TEST_PAGE_URL = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared Instances
// ─────────────────────────────────────────────────────────────────────────────

let conn: CDPConnectionManager;
let nodeIndex: ImmutableNodeIndex;

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite: Agent Feedback Regressions
// ─────────────────────────────────────────────────────────────────────────────

describe('Agent Feedback Regression Tests', () => {
  afterAll(async () => {
    if (conn?.isConnected()) {
      await conn.close();
    }
  });

  // ── Bug 1: Launch with URL ──────────────────────────────────────────────

  describe('Bug 1: Launch with URL (no crash)', () => {
    beforeAll(async () => {
      conn = new CDPConnectionManager();
      nodeIndex = new ImmutableNodeIndex();
    }, 30000);

    it('should launch and navigate without crashing', async () => {
      const result = await conn.launch({ headless: true });
      expect(result.message).toContain('launched');
      expect(conn.isConnected()).toBe(true);

      const navResult = await conn.navigate(TEST_PAGE_URL);
      expect(navResult).toContain('Navigated to');
    });

    it('should have a working page after launch + navigate', async () => {
      const page = conn.getPage()!;
      const title = await page.title();
      expect(title).toContain('Adversarial');
    });
  });

  // ── Bug 2: Semantic surface after navigation ───────────────────────────

  describe('Bug 2: Semantic surface after navigation', () => {
    it('should return non-empty AX tree after navigation', async () => {
      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);

      // The critical assertion: this should NOT return empty
      expect(result.markdown).not.toBe('*(Empty accessibility tree)*');
      expect(result.nodeCount).toBeGreaterThan(0);
    });

    it('should contain backendNodeId references', async () => {
      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);

      // Each interactive node should have an [id: NNN] tag
      expect(result.markdown).toMatch(/\[.*id: \d+.*\]/);
    });

    it('should survive a second navigation to the same page', async () => {
      await conn.navigate(TEST_PAGE_URL);

      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);

      expect(result.markdown).not.toBe('*(Empty accessibility tree)*');
      expect(result.nodeCount).toBeGreaterThan(0);
    });
  });

  // ── Bug 3: Query selector after navigation ─────────────────────────────

  describe('Bug 3: DOM.describeNode works after navigation', () => {
    it('should resolve nodes via DOM.describeNode after navigation', async () => {
      const cdp = conn.getCDPSession()!;

      const { root } = (await cdp.send('DOM.getDocument')) as {
        root: { nodeId: number; backendNodeId: number };
      };
      expect(root.nodeId).toBeGreaterThan(0);

      const { node } = (await cdp.send('DOM.describeNode', {
        backendNodeId: root.backendNodeId,
      })) as { node: { backendNodeId: number; nodeName: string } };
      expect(node.backendNodeId).toBe(root.backendNodeId);
    });
  });

  // ── FR 1: waitUntil parameter ─────────────────────────────────────────

  describe('FR 1: Navigate with waitUntil', () => {
    it('should accept waitUntil=domcontentloaded', async () => {
      const result = await conn.navigate(TEST_PAGE_URL, { waitUntil: 'domcontentloaded' });
      expect(result).toContain('waitUntil: domcontentloaded');
    });

    it('should default to waitUntil=load when not specified', async () => {
      const result = await conn.navigate(TEST_PAGE_URL);
      expect(result).toContain('waitUntil: load');
    });

    it('should have working perception after networkidle0 navigation', async () => {
      await conn.navigate(TEST_PAGE_URL, { waitUntil: 'networkidle0' });

      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);

      expect(result.markdown).not.toBe('*(Empty accessibility tree)*');
      expect(result.nodeCount).toBeGreaterThan(0);
    });
  });
});
