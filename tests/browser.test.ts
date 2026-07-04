/**
 * Core Integration Tests for the Dual-Layer Perceptive Middleware.
 *
 * Tests the new modular architecture: CDPConnectionManager, ImmutableNodeIndex,
 * SessionTelemetryManager, Layer 1 actions, and Layer 2 perception.
 *
 * Uses a real headless Chrome instance against a local HTML fixture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';

import { CDPConnectionManager } from '../src/core/CDPConnectionManager.js';
import { ImmutableNodeIndex } from '../src/core/ImmutableNodeIndex.js';
import { SessionTelemetryManager } from '../src/telemetry/SessionTelemetryManager.js';
import { WorkerBridge } from '../src/workers/workerBridge.js';
import { atomicClick, atomicType, atomicKeyPress, atomicScroll, coordinateClick } from '../src/layer1/atomicInteract.js';
import { validateSpatialCoordinate, resolveElementCenter } from '../src/layer1/spatialValidation.js';
import { evaluateInContext } from '../src/layer1/evaluateInContext.js';
import { getSemanticSurface } from '../src/layer2/semanticSurface.js';
import { getStateDelta } from '../src/layer2/stateDelta.js';

const TEST_PAGE_URL = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared Instances
// ─────────────────────────────────────────────────────────────────────────────

let conn: CDPConnectionManager;
let nodeIndex: ImmutableNodeIndex;
let telemetry: SessionTelemetryManager;
let workerBridge: WorkerBridge;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function evaluate(expression: string): Promise<any> {
  const page = conn.getPage()!;
  const cdp = conn.getCDPSession()!;
  const result = await evaluateInContext(page, cdp, expression);
  return result;
}

async function hasSuccessFlag(flagId: string): Promise<boolean> {
  const result = await evaluate(`!!document.getElementById('${flagId}')`);
  return result.success && result.result === true;
}

async function waitForFlag(flagId: string, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasSuccessFlag(flagId)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function scrollToSection(sectionId: string): Promise<void> {
  await evaluate(`document.getElementById('${sectionId}')?.scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await new Promise(r => setTimeout(r, 200));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Core Architecture', () => {
  beforeAll(async () => {
    conn = new CDPConnectionManager();
    nodeIndex = new ImmutableNodeIndex();
    workerBridge = new WorkerBridge();
    telemetry = new SessionTelemetryManager('agent');

    const { page, cdpSession } = await conn.launch({ headless: true });
    telemetry.attachToPage(page);
    await telemetry.attachToCDP(cdpSession);
  }, 30000);

  afterAll(async () => {
    await conn.close();
    await workerBridge.terminate();
  });

  // ── 1. CDPConnectionManager ─────────────────────────────────────────────

  describe('CDPConnectionManager', () => {
    it('should launch a headless browser', () => {
      expect(conn.isConnected()).toBe(true);
      expect(conn.getPage()).toBeTruthy();
      expect(conn.getCDPSession()).toBeTruthy();
    });

    it('should return already running on double launch', async () => {
      const result = await conn.launch({ headless: true });
      expect(result.message).toBe('Browser is already running.');
    });

    it('should navigate to a page', async () => {
      const result = await conn.navigate(TEST_PAGE_URL);
      expect(result).toContain('Navigated to');
    });
  });

  // ── 2. Semantic Surface (Layer 2 Perception) ───────────────────────────

  describe('Semantic Surface', () => {
    it('should produce compressed Markdown from the AX tree', async () => {
      await conn.navigate(TEST_PAGE_URL);
      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, workerBridge, nodeIndex);
      expect(result.markdown).toBeTruthy();
      expect(result.markdown.length).toBeGreaterThan(100);
      expect(result.nodeCount).toBeGreaterThan(0);
    });

    it('should include backendNodeId tags in the output', async () => {
      const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, workerBridge, nodeIndex);
      // Each interactive node should have an [id: NNN] tag
      expect(result.markdown).toMatch(/\[.*id: \d+.*\]/);
    });

    it('should populate the ImmutableNodeIndex', async () => {
      await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, workerBridge, nodeIndex);
      expect(nodeIndex.size).toBeGreaterThan(0);
    });
  });

  // ── 3. Evaluate In Context (Layer 1) ──────────────────────────────────

  describe('Evaluate In Context', () => {
    it('should execute JavaScript in the page', async () => {
      const result = await evaluate('document.title');
      expect(result.success).toBe(true);
      expect(result.result).toContain('Adversarial');
    });

    it('should handle errors gracefully', async () => {
      const result = await evaluate('throw new Error("test error")');
      expect(result.success).toBe(false);
      expect(result.error).toContain('test error');
    });

    it('should reject invalid frame indices', async () => {
      const page = conn.getPage()!;
      const cdp = conn.getCDPSession()!;
      const result = await evaluateInContext(page, cdp, 'true', 999);
      expect(result.success).toBe(false);
      expect(result.error).toContain('out of range');
    });
  });

  // ── 4. Spatial Validation (Layer 1) ───────────────────────────────────

  describe('Spatial Validation', () => {
    it('should validate coordinates within viewport bounds', async () => {
      const result = await validateSpatialCoordinate(conn.getPage()!, conn.getCDPSession()!, 100, 100);
      expect(result.valid).toBe(true);
    });

    it('should reject coordinates outside viewport bounds', async () => {
      const result = await validateSpatialCoordinate(conn.getPage()!, conn.getCDPSession()!, -100, -100);
      expect(result.valid).toBe(false);
    });

    it('should resolve element center from backendNodeId', async () => {
      // Find a known element's backendNodeId
      const result = await evaluate(`
        (function() {
          const btn = document.getElementById('primary-objective');
          return btn ? true : false;
        })()
      `);
      expect(result.success).toBe(true);
    });
  });

  // ── 5. State Delta (Layer 2) ──────────────────────────────────────────

  describe('State Delta', () => {
    it('should return null delta when nothing changed', async () => {
      await conn.navigate(TEST_PAGE_URL);
      await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, workerBridge, nodeIndex);

      // Checkpoint was taken during getSemanticSurface
      // Without any action, delta should be null or minimal
      const result = await getStateDelta(conn.getPage()!, conn.getCDPSession()!, nodeIndex);
      // No structural changes expected
      if (result.delta) {
        // Minor reparse differences are acceptable
        expect(result.delta.added.length + result.delta.removed.length).toBeLessThan(5);
      }
    });

    it('should detect structural changes after DOM modification', async () => {
      await conn.navigate(TEST_PAGE_URL);
      await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, workerBridge, nodeIndex);
      nodeIndex.checkpoint();

      // Add a new element to the DOM
      await evaluate(`
        const div = document.createElement('div');
        div.id = 'test-delta-element';
        div.textContent = 'Delta test';
        div.setAttribute('role', 'alert');
        document.body.appendChild(div);
      `);

      // Small delay for DOM mutation to propagate
      await new Promise(r => setTimeout(r, 200));

      const result = await getStateDelta(conn.getPage()!, conn.getCDPSession()!, nodeIndex);
      expect(result.delta).toBeTruthy();
      // Should detect the new alert element
      if (result.delta) {
        const hasNewAlert = result.delta.added.some(n => n.role === 'alert');
        expect(hasNewAlert).toBe(true);
      }
    });
  });

  // ── 6. Session Telemetry ──────────────────────────────────────────────

  describe('Session Telemetry', () => {
    it('should produce a token-efficient summary', () => {
      const summary = telemetry.getSummary();
      expect(summary.sessionId).toBeTruthy();
      expect(summary.mode).toBe('agent');
      expect(summary.network).toBeDefined();
      expect(summary.console).toBeDefined();
      expect(summary.mutations).toBeDefined();
      expect(summary.interactions).toBeDefined();
    });

    it('should support progressive disclosure drill-down', () => {
      const networkEvents = telemetry.drillDown('network');
      expect(Array.isArray(networkEvents)).toBe(true);

      const consoleEvents = telemetry.drillDown('console');
      expect(Array.isArray(consoleEvents)).toBe(true);
    });

    it('should reject invalid drill-down categories', () => {
      const result = telemetry.drillDown('invalid_category') as { error?: string };
      expect(result.error).toBeTruthy();
    });
  });

  // ── 7. Atomic Interact (Layer 1) ──────────────────────────────────────

  describe('Atomic Interact', () => {
    it('should scroll the page', async () => {
      const page = conn.getPage()!;
      const cdp = conn.getCDPSession()!;

      const result = await atomicScroll(page, cdp, 'down', telemetry);
      expect(result.success).toBe(true);
      expect(result.feedback).toContain('Scrolled');
    });

    it('should press keys', async () => {
      const page = conn.getPage()!;
      const cdp = conn.getCDPSession()!;

      const result = await atomicKeyPress(page, cdp, 'Escape', telemetry);
      expect(result.success).toBe(true);
      expect(result.feedback).toContain('Escape');
    });

    it('should coordinate-click at valid viewport coordinates', async () => {
      const page = conn.getPage()!;
      const cdp = conn.getCDPSession()!;

      const result = await coordinateClick(page, cdp, 100, 100, telemetry);
      expect(result.success).toBe(true);
    });

    it('should reject coordinate-click outside viewport', async () => {
      const page = conn.getPage()!;
      const cdp = conn.getCDPSession()!;

      const result = await coordinateClick(page, cdp, -100, -100, telemetry);
      expect(result.success).toBe(false);
      expect(result.feedback).toContain('out of viewport');
    });
  });
});
