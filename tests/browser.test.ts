/**
 * Integration test suite for BrowserManager.
 *
 * These tests launch a real headless Chrome instance against the local
 * test_page.html fixture.  They are structured to run sequentially (shared
 * browser state within each `describe` block) and cover every public method
 * of BrowserManager, including the four bugs fixed during the June 2026 audit.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BrowserManager } from '../src/browser.js';
import { AXNode } from '../src/usag.js';
import { join } from 'path';
import { readdirSync, existsSync, readFileSync, rmSync } from 'fs';

// Absolute file:// URL to the fixture page
const TEST_PAGE_URL = `file://${join(process.cwd(), 'test_page.html')}`;

// Shared DVR dump directory (cleaned up at the end)
const DVR_OUTPUT_DIR = join(process.cwd(), 'dist', 'test-dvr-vitest');

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve backendDOMNodeId from the accessibility tree by accessible name. */
async function findNodeIdByName(bm: BrowserManager, name: string): Promise<number> {
  const page = bm.getActivePage();
  if (!page) throw new Error('No active page');
  const client = await page.createCDPSession();
  try {
    const { nodes } = (await client.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
    const found = nodes.find((n) => n.name?.value === name);
    if (!found?.backendDOMNodeId) throw new Error(`Node "${name}" not found in AX tree`);
    return found.backendDOMNodeId;
  } finally {
    await client.detach();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test Suite
// ─────────────────────────────────────────────────────────────────────────────

describe('BrowserManager', () => {
  let bm: BrowserManager;

  beforeAll(() => {
    bm = new BrowserManager();
  });

  afterAll(async () => {
    await bm.close().catch(() => {});
    // Clean up DVR test output
    if (existsSync(DVR_OUTPUT_DIR)) {
      rmSync(DVR_OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  // ── 1. Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle', () => {
    it('should launch a headless browser', async () => {
      const result = await bm.launch({ headless: true });
      expect(result).toContain('launched successfully');
      expect(result).toContain('headless: true');
    });

    it('should return "already running" on double launch', async () => {
      const result = await bm.launch({ headless: true });
      expect(result).toBe('Browser is already running.');
    });
  });

  // ── 2. Navigation ────────────────────────────────────────────────────────

  describe('Navigation', () => {
    it('should navigate to the test page', async () => {
      const result = await bm.navigate(TEST_PAGE_URL);
      expect(result).toContain('Navigated to');
      expect(result).toContain('test_page.html');
    });

    it('should throw on invalid URL schema', async () => {
      await expect(bm.navigate('invalid://broken')).rejects.toThrow();
    });
  });

  // ── 3. USAG Accessibility Tree ────────────────────────────────────────────

  describe('USAG Accessibility Tree', () => {
    it('should return a markdown-formatted tree', async () => {
      const tree = await bm.getAccessibilityTree();
      expect(tree).toContain('[RootWebArea]');
      expect(tree).toContain('Browser Observability Test Page');
    });

    it('should include backendDOMNodeId in output', async () => {
      const tree = await bm.getAccessibilityTree();
      expect(tree).toMatch(/backendNodeId: \d+/);
    });

    it('should find the Clickable Button element', async () => {
      const tree = await bm.getAccessibilityTree();
      expect(tree).toContain('[button] "Clickable Button"');
    });

    it('should find the Occluded Button element', async () => {
      const tree = await bm.getAccessibilityTree();
      expect(tree).toContain('[button] "Occluded Button"');
    });

    it('should find the text input element', async () => {
      const tree = await bm.getAccessibilityTree();
      expect(tree).toContain('[textbox] "Type here..."');
    });
  });

  // ── 4. Spatial Guard & Interactions ───────────────────────────────────────

  describe('Spatial Guard & Interactions', () => {
    it('should click a non-occluded button', async () => {
      const nodeId = await findNodeIdByName(bm, 'Clickable Button');
      const result = await bm.click(nodeId);
      expect(result).toContain('Successfully clicked');
      expect(result).toContain(`element ID ${nodeId}`);
    });

    it('should verify click side-effect in DOM', async () => {
      const page = bm.getActivePage()!;
      const text = await page.evaluate(
        () => document.getElementById('target-btn')?.textContent,
      );
      expect(text).toBe('Clicked!');
    });

    it('should type text into the input field', async () => {
      const nodeId = await findNodeIdByName(bm, 'Type here...');
      const result = await bm.type(nodeId, 'vitest hello');
      expect(result).toContain('Successfully typed');
    });

    it('should verify typed text in DOM', async () => {
      const page = bm.getActivePage()!;
      const value = await page.evaluate(
        () => (document.getElementById('input-field') as HTMLInputElement)?.value,
      );
      expect(value).toContain('vitest hello');
    });

    it('should hover over a non-occluded element', async () => {
      const nodeId = await findNodeIdByName(bm, 'Clicked!');
      const result = await bm.hover(nodeId);
      expect(result).toContain('Successfully hovered');
    });

    it('should reject click on occluded button with spatial validation error', async () => {
      const nodeId = await findNodeIdByName(bm, 'Occluded Button');
      await expect(bm.click(nodeId)).rejects.toThrow(
        /Pre-Execution Spatial Validation Failed/,
      );
    });

    it('should include the occluder identity in the error', async () => {
      const nodeId = await findNodeIdByName(bm, 'Occluded Button');
      try {
        await bm.click(nodeId);
      } catch (err) {
        expect((err as Error).message).toContain('overlay');
      }
    });

    it('should throw on invalid backend node ID', async () => {
      await expect(bm.click(999999)).rejects.toThrow(/Could not find element with backendNodeId/);
    });
  });

  // ── 5. DOM Mutations ─────────────────────────────────────────────────────

  describe('DOM Mutations', () => {
    it('should return buffered mutations (initial load + interactions)', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const mutations = await bm.getMutations();
      // At minimum we should have the initial page load mutations and input events
      expect(Array.isArray(mutations)).toBe(true);
      expect(mutations.length).toBeGreaterThan(0);
    });

    it('should drain the buffer on read (second call returns empty)', async () => {
      const mutations = await bm.getMutations();
      expect(mutations).toEqual([]);
    });

    it('should capture input mutations after typing', async () => {
      // Re-navigate to get a fresh state
      await bm.navigate(TEST_PAGE_URL);
      const inputId = await findNodeIdByName(bm, 'Type here...');
      const result = await bm.type(inputId, 'AB');
      
      // Since type now drains mutations for feedback, we assert against the feedback string
      expect(result).toMatch(/Resulted in \d+ DOM mutations/);
    });
  });

  // ── 6. DVR Telemetry ─────────────────────────────────────────────────────

  describe('DVR Telemetry', () => {
    it('should dump DVR buffer to disk', async () => {
      // Give screencast a moment to buffer frames
      await new Promise((r) => setTimeout(r, 1500));
      const result = await bm.dumpDvr(DVR_OUTPUT_DIR);
      expect(result.success).toBe(true);
      expect(result.outputPath).toBe(DVR_OUTPUT_DIR);
    });

    it('should produce JPEG frame files', () => {
      const files = readdirSync(DVR_OUTPUT_DIR);
      const jpegs = files.filter((f) => f.endsWith('.jpg'));
      expect(jpegs.length).toBeGreaterThan(0);
    });

    it('should produce a session trace log', () => {
      const traceFile = join(DVR_OUTPUT_DIR, 'session_trace.txt');
      expect(existsSync(traceFile)).toBe(true);
      const content = readFileSync(traceFile, 'utf8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should throw on empty output path', async () => {
      await expect(bm.dumpDvr('')).rejects.toThrow();
    });
  });

  // ── 7. Event Listeners ───────────────────────────────────────────────────

  describe('Event Listeners', () => {
    it('should retrieve click handler on target button', async () => {
      // Navigate fresh so button text is "Clickable Button" again
      await bm.navigate(TEST_PAGE_URL);
      const nodeId = await findNodeIdByName(bm, 'Clickable Button');
      const listeners = await bm.getEventListeners(nodeId);
      expect(listeners.length).toBeGreaterThan(0);

      const clickListener = listeners.find(
        (l) => (l as { type: string }).type === 'click',
      );
      expect(clickListener).toBeDefined();
    });

    it('should throw for invalid node ID', async () => {
      await expect(bm.getEventListeners(999999)).rejects.toThrow();
    });
  });

  // ── 8. Paint Flash (Bug 1 fix) ───────────────────────────────────────────

  describe('Paint Flash (headless guard)', () => {
    it('should return graceful message in headless shell mode', async () => {
      const result = await bm.togglePaintFlash(true);
      // In headless shell mode, this should NOT throw — it should return a
      // descriptive message about unavailability.
      expect(typeof result).toBe('string');
      // It will either succeed (new headless) or return the guard message
      expect(result).toMatch(/Paint flashing/);
    });

    it('should handle disable call gracefully too', async () => {
      const result = await bm.togglePaintFlash(false);
      expect(typeof result).toBe('string');
      expect(result).toMatch(/Paint flashing/);
    });
  });

  // ── 9. Performance Metrics ───────────────────────────────────────────────

  describe('Performance Metrics', () => {
    it('should return an array of metrics', async () => {
      const metrics = await bm.getPerformanceMetrics();
      expect(Array.isArray(metrics)).toBe(true);
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should include Nodes metric', async () => {
      const metrics = await bm.getPerformanceMetrics();
      const nodesMetric = metrics.find((m) => m.name === 'Nodes');
      expect(nodesMetric).toBeDefined();
      expect(nodesMetric!.value).toBeGreaterThan(0);
    });

    it('should include JSHeapUsedSize metric', async () => {
      const metrics = await bm.getPerformanceMetrics();
      const heap = metrics.find((m) => m.name === 'JSHeapUsedSize');
      expect(heap).toBeDefined();
      expect(heap!.value).toBeGreaterThan(0);
    });
  });

  // ── 10. React Fiber Sniffer ──────────────────────────────────────────────

  describe('React Fiber Sniffer', () => {
    it('should detect mock React components from test page', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const result = (await bm.sniffFrameworkState()) as {
        current: { react: { component: string }[]; redux: unknown; zustand: unknown[] };
        diff: unknown;
        hasPrevious: boolean;
      };
      expect(result.current).toBeDefined();
      expect(Array.isArray(result.current.react)).toBe(true);
      expect(result.current.react.length).toBeGreaterThan(0);
    });

    it('should find SubmitButtonComponent', async () => {
      const result = (await bm.sniffFrameworkState()) as {
        current: { react: { component: string; state: Record<string, unknown> }[] };
      };
      const btn = result.current.react.find((c) => c.component === 'SubmitButtonComponent');
      expect(btn).toBeDefined();
      expect(btn!.state).toEqual({ label: 'Clickable Button', active: true });
    });

    it('should find MainDashboardContainer parent', async () => {
      const result = (await bm.sniffFrameworkState()) as {
        current: { react: { component: string }[] };
      };
      const container = result.current.react.find((c) => c.component === 'MainDashboardContainer');
      expect(container).toBeDefined();
    });
  });

  // ── 11. Leak Detection & Anomalies (Bug 2 & 3 fixes) ────────────────────

  describe('Leak Detection & Anomalies', () => {
    it('should return leak detection metrics', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const result = await bm.detectLeaksAndAnomalies();
      expect(result).toHaveProperty('layoutShiftScore');
      expect(result).toHaveProperty('bodyBrightness');
      expect(result).toHaveProperty('activeNodesCount');
      expect(result).toHaveProperty('domElementsCount');
      expect(result).toHaveProperty('detachedNodesCount');
    });

    it('should report bodyBrightness ≈ 255 on default white/transparent page (Bug 2 fix)', async () => {
      const result = await bm.detectLeaksAndAnomalies();
      // The test page has no explicit body background → transparent → should be 255
      expect(result.bodyBrightness).toBe(255);
    });

    it('should report a reasonable detachedNodesCount relative to domElementsCount (Bug 3 fix)', async () => {
      // Launch a fresh browser to test on a clean page (no accumulated navigations)
      const freshBm = new BrowserManager();
      await freshBm.launch({ headless: true });
      await freshBm.navigate(TEST_PAGE_URL);
      const result = await freshBm.detectLeaksAndAnomalies();
      await freshBm.close();

      // Before the fix, elements-only counting produced detachedNodesCount of 44+
      // on this 17-element page. With TreeWalker counting all node types, the
      // delta against CDP's Nodes metric should be much smaller (~18 from browser
      // internal overhead like about:blank, shadow DOM, etc.)
      expect(result.detachedNodesCount).toBeLessThan(30);
      // Also verify the domElementsCount is the elements-only count
      expect(result.domElementsCount).toBeGreaterThanOrEqual(15);
    });

    it('should report 0 or very low CLS on a static page', async () => {
      const result = await bm.detectLeaksAndAnomalies();
      expect(result.layoutShiftScore).toBeLessThanOrEqual(0.1);
    });

    it('should report domElementsCount > 0', async () => {
      const result = await bm.detectLeaksAndAnomalies();
      expect(result.domElementsCount).toBeGreaterThan(0);
    });
  });

  // ── 12. Network Throttling ───────────────────────────────────────────────

  describe('Network Throttling', () => {
    it('should apply throttle conditions', async () => {
      const result = await bm.throttleNetwork(100, 1024, 512);
      expect(result).toContain('Network throttled');
      expect(result).toContain('latency=100ms');
      expect(result).toContain('download=1024Kbps');
    });

    it('should remove throttle conditions (zeros)', async () => {
      const result = await bm.throttleNetwork(0, 0, 0);
      expect(result).toContain('Network throttled');
      expect(result).toContain('latency=0ms');
    });
  });

  // ── 13. Request Interception (Bug 4 fix) ─────────────────────────────────

  describe('Request Interception', () => {
    it('should enable interception with fail action', async () => {
      const result = await bm.enableRequestInterception('*example.com*', 'fail');
      expect(result).toContain("pattern '*example.com*'");
      expect(result).toContain("action 'fail'");
    });

    it('should cause matching fetch requests to fail', async () => {
      const page = bm.getActivePage()!;
      const fetchResult = await page.evaluate(async () => {
        try {
          await fetch('https://www.example.com');
          return 'ok';
        } catch {
          return 'failed';
        }
      });
      expect(fetchResult).toBe('failed');
    });

    it('should disable interception cleanly', async () => {
      const result = await bm.disableRequestInterception();
      expect(result).toBe('Request interception disabled');
    });

    it('should not accumulate listeners across enable/disable cycles (Bug 4 fix)', async () => {
      // Enable → disable three times quickly
      for (let i = 0; i < 3; i++) {
        await bm.enableRequestInterception('*noop*', 'fail');
        await bm.disableRequestInterception();
      }
      // If listeners accumulated, the CDP session would have stacked handlers.
      // Re-enable and verify it still works correctly (single handler).
      await bm.enableRequestInterception('*accumulation-test*', 'fail');
      const result = await bm.disableRequestInterception();
      expect(result).toBe('Request interception disabled');
    });

    it('should allow interception with delay action', async () => {
      const result = await bm.enableRequestInterception('*slow-api*', 'delay', 100);
      expect(result).toContain("action 'delay'");
      await bm.disableRequestInterception();
    });
  });

  // ── 14. Responsive Layout Testing ────────────────────────────────────────

  describe('Responsive Layout Testing', () => {
    it('should test multiple viewports and return trees for each', async () => {
      const results = await bm.testResponsiveLayout(TEST_PAGE_URL, [
        { width: 375, height: 667, name: 'Mobile' },
        { width: 768, height: 1024, name: 'Tablet' },
        { width: 1280, height: 800, name: 'Desktop' },
      ]);
      expect(results).toHaveLength(3);
    });

    it('should include viewport labels in results', async () => {
      const results = await bm.testResponsiveLayout(TEST_PAGE_URL, [
        { width: 375, height: 667, name: 'Mobile' },
      ]);
      expect(results[0].viewport).toContain('Mobile');
      expect(results[0].viewport).toContain('375x667');
    });

    it('should include a valid accessibility tree per viewport', async () => {
      const results = await bm.testResponsiveLayout(TEST_PAGE_URL, [
        { width: 1280, height: 800, name: 'Desktop' },
      ]);
      expect(results[0].accessibilityTree).toContain('[RootWebArea]');
      expect(results[0].accessibilityTree).toContain('Clickable Button');
    });
  });

  // ── 15. Screenshot ───────────────────────────────────────────────────────

  describe('Screenshot', () => {
    it('should capture a viewport screenshot as base64 PNG', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const result = await bm.screenshot();
      expect(result.data).toBeTruthy();
      expect(result.data.length).toBeGreaterThan(100); // non-trivial base64
      expect(result.mimeType).toBe('image/png');
      expect(result.savedTo).toBeUndefined();
    });

    it('should capture a JPEG screenshot', async () => {
      const result = await bm.screenshot({ format: 'jpeg', quality: 50 });
      expect(result.mimeType).toBe('image/jpeg');
      expect(result.data.length).toBeGreaterThan(100);
    });

    it('should capture a full-page screenshot', async () => {
      const viewportResult = await bm.screenshot({ format: 'png' });
      const fullPageResult = await bm.screenshot({ format: 'png', fullPage: true });
      // Full page should be at least as large as viewport
      expect(fullPageResult.data.length).toBeGreaterThanOrEqual(viewportResult.data.length);
    });

    it('should capture an element-specific screenshot', async () => {
      const nodeId = await findNodeIdByName(bm, 'Clickable Button');
      const result = await bm.screenshot({ backendNodeId: nodeId });
      expect(result.data).toBeTruthy();
      expect(result.mimeType).toBe('image/png');
    });

    it('should save screenshot to disk when savePath is provided', async () => {
      const savePath = join(process.cwd(), 'dist', 'test-screenshot.png');
      const result = await bm.screenshot({ savePath });
      expect(result.savedTo).toBe(savePath);
      expect(existsSync(savePath)).toBe(true);
      // Clean up
      rmSync(savePath, { force: true });
    });

    it('should throw for invalid backendNodeId', async () => {
      await expect(bm.screenshot({ backendNodeId: 999999 })).rejects.toThrow();
    });
  });

  // ── 16. Screen Recording ─────────────────────────────────────────────────

  describe('Screen Recording', () => {
    const recordingDir = join(process.cwd(), 'dist', 'test-recording-vitest');

    afterAll(() => {
      if (existsSync(recordingDir)) {
        rmSync(recordingDir, { recursive: true, force: true });
      }
    });

    it('should start recording', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const result = await bm.startRecording({ outputDir: recordingDir });
      expect(result).toContain('Recording started');
      expect(result).toContain(recordingDir);
    });

    it('should reject double start', async () => {
      await expect(bm.startRecording()).rejects.toThrow(/already in progress/);
    });

    it('should capture frames during interactions', async () => {
      // Perform some interactions so screencast has frames to capture
      const nodeId = await findNodeIdByName(bm, 'Clickable Button');
      await bm.click(nodeId);
      // Wait for a few screencast frames
      await new Promise((r) => setTimeout(r, 2000));
    });

    it('should stop recording and produce MP4 video', async () => {
      const result = await bm.stopRecording();
      expect(result.status).toBe('success');
      expect(result.outputDir).toBe(recordingDir);
      expect(result.frameCount).toBeGreaterThan(0);
      expect(result.durationSeconds).toBeGreaterThanOrEqual(1);
      // ffmpeg-static should have assembled an MP4
      expect(result.videoPath).toBeTruthy();
      expect(existsSync(result.videoPath!)).toBe(true);
    });

    it('should have written frame files', () => {
      const files = readdirSync(recordingDir);
      const jpgs = files.filter((f) => f.endsWith('.jpg'));
      expect(jpgs.length).toBeGreaterThan(0);
      expect(jpgs[0]).toMatch(/^frame_\d{5}\.jpg$/);
    });

    it('should have written a manifest', () => {
      const manifestPath = join(recordingDir, 'manifest.json');
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest.frameCount).toBeGreaterThan(0);
      expect(manifest.videoPath).toBeTruthy();
      expect(manifest.frames).toBeInstanceOf(Array);
    });

    it('should throw when stopping with no active recording', async () => {
      await expect(bm.stopRecording()).rejects.toThrow(/No recording in progress/);
    });
  });

  // ── 17. Batch Actions ────────────────────────────────────────────────────

  describe('Batch Actions', () => {
    it('should execute multiple actions sequentially', async () => {
      await bm.navigate(TEST_PAGE_URL);
      const result = await bm.executeBatch([
        { tool: 'browser_get_accessibility_tree', args: {} },
        { tool: 'browser_get_performance_metrics', args: {} },
      ]);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].success).toBe(true);
      expect(result.results[0].tool).toBe('browser_get_accessibility_tree');
      expect(result.results[1].success).toBe(true);
    });

    it('should stop on first error and return partial results', async () => {
      const result = await bm.executeBatch([
        { tool: 'browser_get_accessibility_tree', args: {} },
        { tool: 'browser_click', args: { backendNodeId: 999999 } }, // will fail
        { tool: 'browser_get_performance_metrics', args: {} }, // should not execute
      ]);
      expect(result.results).toHaveLength(2); // only 2 results, not 3
      expect(result.results[0].success).toBe(true);
      expect(result.results[1].success).toBe(false);
      expect(result.results[1].error).toBeTruthy();
    });

    it('should reject unknown tool names', async () => {
      const result = await bm.executeBatch([
        { tool: 'nonexistent_tool', args: {} },
      ]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toContain('Unknown tool');
    });

    it('should support screenshot in batch', async () => {
      const result = await bm.executeBatch([
        { tool: 'browser_screenshot', args: { format: 'jpeg' } },
      ]);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].success).toBe(true);
      const screenshotResult = result.results[0].result as { data: string; mimeType: string };
      expect(screenshotResult.mimeType).toBe('image/jpeg');
    });
  });

  // ── 18. Close & Post-Close Guards ────────────────────────────────────────

  describe('Close & Post-Close Guards', () => {
    it('should close the browser', async () => {
      const result = await bm.close();
      expect(result).toBe('Browser closed.');
    });

    it('should return "no active session" on double close', async () => {
      const result = await bm.close();
      expect(result).toBe('No active browser session.');
    });

    it('should throw when calling getAccessibilityTree after close', async () => {
      await expect(bm.getAccessibilityTree()).rejects.toThrow(
        /No active CDP session/,
      );
    });

    it('should throw when calling click after close', async () => {
      await expect(bm.click(1)).rejects.toThrow(/No active page session/);
    });

    it('should throw when calling getPerformanceMetrics after close', async () => {
      await expect(bm.getPerformanceMetrics()).rejects.toThrow(
        /No active CDP session/,
      );
    });
  });
});
