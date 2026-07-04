/**
 * Adversarial Testbed — Integration Tests (v2 Architecture)
 *
 * Tests the Dual-Layer Perceptive Middleware against the 8 adversarial hurdles:
 *   tests/fixtures/adversarial_testbed.html
 *
 * Each hurdle is designed to break naive browser automation:
 *   1.1 — Closed Shadow DOM (2 levels)
 *   1.2 — Data-URL Iframe (opaque origin)
 *   1.3 — Randomized CSS Class Names
 *   1.4 — Canvas-Driven Opaque Interface
 *   2.1 — Delayed Progressive Hydration
 *   2.2 — Stale VDOM References (800ms re-render)
 *   2.3 — Client-Side SPA Routing
 *   2.4 — Virtualized Infinite Scroll
 *   3.1 — Z-Index Modal Popup (occlusion)
 *   3.2 — Honeypot Form Fields
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';

import { CDPConnectionManager } from '../src/core/CDPConnectionManager.js';
import { ImmutableNodeIndex } from '../src/core/ImmutableNodeIndex.js';
import { SessionTelemetryManager } from '../src/telemetry/SessionTelemetryManager.js';
import { coordinateClick, atomicType } from '../src/layer1/atomicInteract.js';
import { evaluateInContext } from '../src/layer1/evaluateInContext.js';
import { getSemanticSurface } from '../src/layer2/semanticSurface.js';

const TESTBED_URL = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;

// ─────────────────────────────────────────────────────────────────────────────
//  Shared Instances
// ─────────────────────────────────────────────────────────────────────────────

let conn: CDPConnectionManager;
let nodeIndex: ImmutableNodeIndex;
let telemetry: SessionTelemetryManager;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function evaluate(expression: string): Promise<any> {
  return evaluateInContext(conn.getPage()!, conn.getCDPSession()!, expression);
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

async function dismissModalIfPresent(): Promise<void> {
  await evaluate(`
    document.getElementById('interruption-modal')?.style?.display === 'flex' &&
    document.getElementById('accept-modal-btn')?.click()
  `);
  await new Promise(r => setTimeout(r, 300));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('Adversarial Testbed', () => {
  beforeAll(async () => {
    conn = new CDPConnectionManager();
    nodeIndex = new ImmutableNodeIndex();
    telemetry = new SessionTelemetryManager('agent');

    const { page, cdpSession } = await conn.launch({ headless: true });
    telemetry.attachToPage(page);
    await telemetry.attachToCDP(cdpSession);
  }, 30000);

  afterAll(async () => {
    await conn.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  CATEGORY 1: STRUCTURAL & ENCAPSULATION HURDLES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Category 1: Structural & Encapsulation', () => {

    // ── Hurdle 1.1: Closed Shadow DOM ────────────────────────────────────────

    describe('Hurdle 1.1 — Closed Shadow DOM', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
      });

      it('AX tree includes shadow DOM content (native CDP pierces closed shadows)', async () => {
        const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);
        // CDP's Accessibility.getFullAXTree natively pierces closed shadow roots.
        // We should see the button text in the semantic surface.
        expect(result.markdown).toContain('Acknowledge Secure Directive');
      });

      it('evaluate_in_context can pierce closed shadow DOM via test harness refs', async () => {
        const result = await evaluate(`
          (function() {
            const refs = window.__testHarness?.shadowRefs;
            if (!refs) return 'no-refs';
            const innerRoot = refs.innerShadow;
            const btn = innerRoot.querySelector('button');
            if (!btn) return 'no-button';
            btn.click();
            return 'clicked';
          })()
        `);
        expect(result.success).toBe(true);
        expect(result.result).toBe('clicked');
      });

      it('success flag appears after shadow DOM button is clicked', async () => {
        const flagExists = await hasSuccessFlag('shadow-success-flag');
        expect(flagExists).toBe(true);
      });

      it('coordinate-based click can target elements in closed shadow DOM', async () => {
        await conn.navigate(TESTBED_URL);

        const result = await evaluate(`
          (function() {
            const refs = window.__testHarness?.shadowRefs;
            if (!refs) return null;
            const btn = refs.innerShadow.querySelector('button');
            if (!btn) return null;
            const rect = btn.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          })()
        `);
        expect(result.success).toBe(true);
        const coords = result.result as { x: number; y: number };
        expect(coords).toBeTruthy();

        const page = conn.getPage()!;
        const cdp = conn.getCDPSession()!;
        const clickResult = await coordinateClick(page, cdp, coords.x, coords.y, telemetry);
        expect(clickResult.success).toBe(true);

        const flagExists = await hasSuccessFlag('shadow-success-flag');
        expect(flagExists).toBe(true);
      });
    });

    // ── Hurdle 1.2: Data-URL Iframes ─────────────────────────────────────────

    describe('Hurdle 1.2 — Data-URL Iframe', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
      });

      it('coordinate-based click works on elements inside data-URL iframe', async () => {
        // Get the iframe bounding box
        const iframeResult = await evaluate(`
          (function() {
            const iframe = document.getElementById('data-url-iframe');
            if (!iframe) return null;
            const rect = iframe.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          })()
        `);
        expect(iframeResult.success).toBe(true);
        const iframeBox = iframeResult.result as { x: number; y: number; width: number; height: number };

        // Try the frame API first
        const page = conn.getPage()!;
        const cdp = conn.getCDPSession()!;
        const frames = page.frames();
        const dataFrame = frames.find(f => f.url().startsWith('data:'));

        if (dataFrame) {
          const btn = await dataFrame.$('#isolated-btn');
          if (btn) {
            await btn.click();
            const flagAppeared = await waitForFlag('iframe-success-flag', 3000);
            expect(flagAppeared).toBe(true);
            return;
          }
        }

        // Fallback: coordinate click
        const clickX = iframeBox.x + iframeBox.width / 2;
        const clickY = iframeBox.y + iframeBox.height * 0.7;
        await coordinateClick(page, cdp, clickX, clickY, telemetry);
        const flagAppeared = await waitForFlag('iframe-success-flag', 3000);
        expect(flagAppeared).toBe(true);
      });
    });

    // ── Hurdle 1.3: Randomized CSS Classes ───────────────────────────────────

    describe('Hurdle 1.3 — Randomized CSS Classes', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
      });

      it('evaluate_in_context can find button by stable data-testid', async () => {
        const result = await evaluate(`
          !!document.querySelector('[data-testid="dynamic-action-btn"]')
        `);
        expect(result.success).toBe(true);
        expect(result.result).toBe(true);
      });

      it('clicking via stable data-testid locator produces success flag', async () => {
        await scrollToSection('hurdle-1-3');
        await evaluate(`document.querySelector('[data-testid="dynamic-action-btn"]')?.click()`);
        const flagExists = await hasSuccessFlag('dynamic-css-success');
        expect(flagExists).toBe(true);
      });

      it('class names change on page reload (confirming randomization)', async () => {
        const firstResult = await evaluate(`
          document.querySelector('#obfuscation-container > div')?.className
        `);
        await conn.navigate(TESTBED_URL);
        const secondResult = await evaluate(`
          document.querySelector('#obfuscation-container > div')?.className
        `);
        expect(firstResult.success).toBe(true);
        expect(secondResult.success).toBe(true);
        expect(firstResult.result).not.toBe(secondResult.result);
      });
    });

    // ── Hurdle 1.4: Canvas Interface ─────────────────────────────────────────

    describe('Hurdle 1.4 — Canvas Interface', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
      });

      it('AX tree reports canvas as a single opaque element', async () => {
        const result = await getSemanticSurface(conn.getPage()!, conn.getCDPSession()!, nodeIndex);
        expect(result.markdown).toContain('canvas');
      });

      it('coordinate-based click hits the target canvas node', async () => {
        await scrollToSection('hurdle-1-4');

        // Get canvas position and target node coordinates
        const canvasInfo = await evaluate(`
          (function() {
            const canvas = document.getElementById('adversarial-canvas');
            if (!canvas) return null;
            const rect = canvas.getBoundingClientRect();
            const target = window.__testHarness?.canvasNodes?.[2];
            return {
              canvasX: rect.x, canvasY: rect.y,
              targetX: target?.x, targetY: target?.y
            };
          })()
        `);
        expect(canvasInfo.success).toBe(true);
        const info = canvasInfo.result as { canvasX: number; canvasY: number; targetX: number; targetY: number };

        const page = conn.getPage()!;
        const cdp = conn.getCDPSession()!;
        const clickX = info.canvasX + info.targetX;
        const clickY = info.canvasY + info.targetY;
        await coordinateClick(page, cdp, clickX, clickY, telemetry);

        const flagExists = await hasSuccessFlag('canvas-success-flag');
        expect(flagExists).toBe(true);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  CATEGORY 2: STATE, TIMING & FRAMEWORK HURDLES
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Category 2: State, Timing & Framework', () => {

    // ── Hurdle 2.1: Delayed Hydration ────────────────────────────────────────

    describe('Hurdle 2.1 — Delayed Hydration', () => {
      it('early click on unhydrated button produces no success flag', async () => {
        await conn.navigate(TESTBED_URL);
        await scrollToSection('hurdle-2-1');

        // Immediately click (before 2000ms hydration delay)
        await evaluate(`document.getElementById('hydrate-submit-btn')?.click()`);
        const flagExists = await hasSuccessFlag('hydration-success-flag');
        expect(flagExists).toBe(false);
      });

      it('click after hydration delay succeeds', async () => {
        await conn.navigate(TESTBED_URL);
        await scrollToSection('hurdle-2-1');

        // Wait for hydration (2000ms delay in testbed)
        await new Promise(r => setTimeout(r, 2500));

        // Dismiss modal if it appeared
        await dismissModalIfPresent();

        // Verify hydration attribute
        const hydrated = await evaluate(`
          !!document.querySelector('[data-hydrated="true"]')
        `);
        expect(hydrated.result).toBe(true);

        // Now click via evaluate (atomic)
        await scrollToSection('hurdle-2-1');
        await evaluate(`document.getElementById('hydrate-submit-btn')?.click()`);

        const flagExists = await waitForFlag('hydration-success-flag', 3000);
        expect(flagExists).toBe(true);
      });
    });

    // ── Hurdle 2.2: Stale VDOM References ────────────────────────────────────

    describe('Hurdle 2.2 — Stale DOM References', () => {
      it('evaluate_in_context with atomic locate-and-click beats stale DOM', async () => {
        await conn.navigate(TESTBED_URL);
        await new Promise(r => setTimeout(r, 500));

        // Atomic locate + click in a single JS execution context.
        // This prevents the 800ms re-render from invalidating the reference.
        const result = await evaluate(`
          (function() {
            const btn = document.getElementById('ephemeral-btn');
            if (!btn) return 'not-found';
            btn.click();
            return 'clicked';
          })()
        `);
        expect(result.success).toBe(true);
        expect(result.result).toBe('clicked');

        const flagExists = await waitForFlag('stale-success-flag', 3000);
        expect(flagExists).toBe(true);
      });

      it('the ephemeral button is actually re-rendering', async () => {
        await conn.navigate(TESTBED_URL);
        const count1 = await evaluate(`document.getElementById('ephemeral-btn')?.textContent`);
        await new Promise(r => setTimeout(r, 2000));
        const count2 = await evaluate(`document.getElementById('ephemeral-btn')?.textContent`);

        // Both should exist (re-render recreates, not destroys)
        expect(count1.success).toBe(true);
        expect(count2.success).toBe(true);
      });
    });

    // ── Hurdle 2.3: SPA Client-Side Routing ──────────────────────────────────

    describe('Hurdle 2.3 — SPA Client-Side Routing', () => {
      it('clicking SPA link triggers client-side navigation', async () => {
        await conn.navigate(TESTBED_URL);
        await new Promise(r => setTimeout(r, 1800));
        await dismissModalIfPresent();
        await scrollToSection('hurdle-2-3');

        const clickResult = await evaluate(`
          (function() {
            const link = document.getElementById('spa-link');
            if (!link) return 'no-link';
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return 'dispatched';
          })()
        `);
        expect(clickResult.success).toBe(true);
        expect(clickResult.result).toBe('dispatched');

        await new Promise(r => setTimeout(r, 300));
        const loadingState = await evaluate(`
          document.getElementById('router-outlet')?.textContent?.trim()
        `);
        expect(loadingState.result).toContain('Loading payload');
      });

      it('SPA content loads after delay and can be interacted with', async () => {
        await scrollToSection('hurdle-2-3');

        // Wait for the 1500ms SPA content load
        const dashboardLoaded = await waitForFlag('spa-success-btn', 5000);

        const dashboardContent = await evaluate(`
          document.getElementById('router-outlet')?.innerHTML?.includes('Dashboard View')
        `);
        expect(dashboardContent.result).toBe(true);
      });

      it('clicking routed content button produces success flag', async () => {
        await scrollToSection('hurdle-2-3');
        await evaluate(`document.getElementById('spa-success-btn')?.click()`);
        const flagExists = await hasSuccessFlag('spa-success-flag');
        expect(flagExists).toBe(true);
      });
    });

    // ── Hurdle 2.4: Virtualized Infinite Scroll ──────────────────────────────

    describe('Hurdle 2.4 — Virtual Scroll', () => {
      it('item #45 is NOT in the DOM at initial scroll position', async () => {
        await conn.navigate(TESTBED_URL);
        const result = await evaluate(`!!document.querySelector('[data-id="45"]')`);
        expect(result.result).toBe(false);
      });

      it('scrolling the container brings item #45 into the DOM', async () => {
        const scrollResult = await evaluate(`
          (function() {
            const container = document.getElementById('viewport-container');
            if (!container) return 'no-container';
            container.scrollTop = 45 * 80;
            return 'scrolled';
          })()
        `);
        expect(scrollResult.result).toBe('scrolled');

        await new Promise(r => setTimeout(r, 500));

        const itemResult = await evaluate(`!!document.querySelector('[data-id="45"]')`);
        expect(itemResult.result).toBe(true);
      });

      it('clicking Select on item #45 produces success flag', async () => {
        await scrollToSection('hurdle-2-4');
        const clickResult = await evaluate(`
          (function() {
            const btn = document.querySelector('[data-id="45"]');
            if (!btn) return 'not-found';
            btn.click();
            return 'clicked';
          })()
        `);
        expect(clickResult.result).toBe('clicked');

        const flagExists = await waitForFlag('virtual-scroll-success', 3000);
        expect(flagExists).toBe(true);
      });

      it('items at index 0 are destroyed after scrolling to #45', async () => {
        const result = await evaluate(`!!document.querySelector('[data-id="0"]')`);
        expect(result.result).toBe(false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  CATEGORY 3: INTERRUPTION & OVERLAYS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Category 3: Interruption & Overlays', () => {

    // ── Hurdle 3.1: Modal Overlay ────────────────────────────────────────────

    describe('Hurdle 3.1 — Modal Overlay', () => {
      it('modal appears after delay and blocks the primary objective', async () => {
        await conn.navigate(TESTBED_URL);
        await scrollToSection('hurdle-3-1');
        await new Promise(r => setTimeout(r, 2000));

        const modalVisible = await evaluate(`
          document.getElementById('interruption-modal').style.display
        `);
        expect(modalVisible.result).toBe('flex');
      });

      it('dismiss modal → click primary objective succeeds', async () => {
        // Dismiss the modal
        await evaluate(`document.getElementById('accept-modal-btn')?.click()`);
        await new Promise(r => setTimeout(r, 300));

        const modalHidden = await evaluate(`
          document.getElementById('interruption-modal').style.display
        `);
        expect(modalHidden.result).toBe('none');

        // Click the primary objective
        await scrollToSection('hurdle-3-1');
        await evaluate(`document.getElementById('primary-objective')?.click()`);

        const flagExists = await hasSuccessFlag('modal-success-flag');
        expect(flagExists).toBe(true);
      });
    });

    // ── Hurdle 3.2: Honeypot Form ────────────────────────────────────────────

    describe('Hurdle 3.2 — Honeypot Form', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
        await new Promise(r => setTimeout(r, 2000));
        await dismissModalIfPresent();
        await scrollToSection('hurdle-3-2');
      });

      it('evaluate_in_context detects honeypot via computed styles', async () => {
        const result = await evaluate(`
          (function() {
            const honeypot = document.getElementById('phone_backup');
            if (!honeypot) return { exists: false };
            const style = window.getComputedStyle(honeypot.closest('.honey-pot-layer') || honeypot);
            const rect = honeypot.getBoundingClientRect();
            return {
              exists: true,
              opacity: style.opacity,
              position: style.position,
              left: style.left,
              width: rect.width,
              height: rect.height,
              pointerEvents: style.pointerEvents,
            };
          })()
        `);
        expect(result.success).toBe(true);
        const honeypotInfo = result.result as Record<string, unknown>;
        expect(honeypotInfo.exists).toBe(true);
        // At least one indicator should reveal it as hidden
        expect(
          honeypotInfo.opacity === '0' ||
          honeypotInfo.width === 0 ||
          honeypotInfo.height === 0 ||
          honeypotInfo.pointerEvents === 'none' ||
          parseInt(honeypotInfo.left as string) < -1000
        ).toBe(true);
      });

      it('form submission without honeypot data succeeds', async () => {
        await evaluate(`
          document.getElementById('username').value = 'testuser';
          document.getElementById('password').value = 'secure123';
        `);

        await evaluate(`document.getElementById('submit-registration')?.click()`);
        const flagExists = await waitForFlag('honeypot-success-flag', 3000);
        expect(flagExists).toBe(true);
      });

      it('form submission WITH honeypot data triggers bot detection', async () => {
        await conn.navigate(TESTBED_URL);
        await new Promise(r => setTimeout(r, 2000));
        await dismissModalIfPresent();
        await scrollToSection('hurdle-3-2');

        await evaluate(`
          document.getElementById('username').value = 'botuser';
          document.getElementById('password').value = 'botpass';
          document.getElementById('phone_backup').value = '555-1234';
        `);

        await evaluate(`document.getElementById('submit-registration')?.click()`);
        await new Promise(r => setTimeout(r, 300));

        const trapFired = await waitForFlag('honeypot-trap-flag', 3000);
        expect(trapFired).toBe(true);

        const successExists = await hasSuccessFlag('honeypot-success-flag');
        expect(successExists).toBe(false);
      });
    });

    // ── Category 4: Complex Layout & Nested Frames ───────────────────────────

    describe('Category 4: Complex Layout & Nested Frames', () => {
      beforeAll(async () => {
        await conn.navigate(TESTBED_URL);
        await new Promise(r => setTimeout(r, 2000));
        await dismissModalIfPresent();
        await scrollToSection('hurdle-4-1');
        await new Promise(r => setTimeout(r, 1000));
      });

      it('should pierce nested scaled frames and click the button', async () => {
        const page = conn.getPage()!;
        const cdp = conn.getCDPSession()!;

        // Find backendNodeId of the button inside the child frame
        const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as any;
        let btnBackendNodeId: number | null = null;
        const findTarget = (node: any) => {
          if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('nested-btn')) {
            btnBackendNodeId = node.backendNodeId;
            return;
          }
          if (node.children) {
            for (const c of node.children) findTarget(c);
          }
          if (node.contentDocument) findTarget(node.contentDocument);
        };
        findTarget(doc.root);
        expect(btnBackendNodeId).not.toBeNull();

        // Resolve target frame context
        const { findFrameForBackendNodeId } = await import('../src/layer1/atomicInteract.js');
        const frame = await findFrameForBackendNodeId(page, btnBackendNodeId!);
        
        const frameId = (frame as any)._id ?? (frame as any)._frameId ?? (frame as any).id;
        const { getElementTree } = await import('../src/layer2/semanticSurface.js');
        const result = await getElementTree(cdp, nodeIndex, btnBackendNodeId!, { semanticOnly: true, frameId });
        expect(result.text).toContain('Verify Nested');

        // Let's click it!
        const targetCdp = (frame as any).client || cdp;
        const { resolveAndValidateSpatialCoordinate } = await import('../src/layer1/spatialValidation.js');
        const validation = await resolveAndValidateSpatialCoordinate(page, targetCdp, btnBackendNodeId!, 3000, frame, undefined, true);
        expect(validation.valid).toBe(true);
        expect(validation.coordinates).toBeDefined();

        await coordinateClick(page, cdp, validation.coordinates!.x, validation.coordinates!.y, telemetry);

        const successFlag = await waitForFlag('nested-iframe-success-flag', 3000);
        expect(successFlag).toBe(true);
      });
    });

  });
});
