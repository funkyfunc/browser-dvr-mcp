import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { server } from '../src/index.js';

const TEST_PAGE_URL = `file://${join(process.cwd(), 'tests', 'fixtures', 'adversarial_testbed.html')}`;
const TEST_HISTORY_DIR = join(process.cwd(), 'tests_history_run');

describe('Unified Delta & Visual Auto-History Logging', () => {
  // Clean up any previous test runs
  beforeAll(() => {
    if (existsSync(TEST_HISTORY_DIR)) {
      rmSync(TEST_HISTORY_DIR, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    // Close the browser to release resources
    try {
      await (server as any)._registeredTools['browser_close'].handler({});
    } catch {
      // Ignore if already closed
    }
    // Clean up test run directory
    if (existsSync(TEST_HISTORY_DIR)) {
      rmSync(TEST_HISTORY_DIR, { recursive: true, force: true });
    }
  });

  it('should launch browser with autoTrackHistory enabled', async () => {
    const launchHandler = (server as any)._registeredTools['browser_launch'].handler;
    const launchResult = await launchHandler({
      headless: true,
      autoTrackHistory: true,
      sessionHistoryDir: TEST_HISTORY_DIR,
      url: TEST_PAGE_URL,
    });

    expect(launchResult.content[0].text).toContain('Browser launched');
    expect(existsSync(TEST_HISTORY_DIR)).toBe(true);
  });

  it('should support returnDelta on browser_navigate', async () => {
    const navigateHandler = (server as any)._registeredTools['browser_navigate'].handler;
    const navResult = await navigateHandler({
      url: TEST_PAGE_URL,
      returnDelta: true,
    });

    expect(navResult.content[0].text).toContain('Navigated to');
    expect(navResult.content[0].text).toContain('### Action Delta Report');
    expect(navResult.content[0].text).toContain('#### DOM Changes:');
    expect(navResult.content[0].text).toContain('#### Network Activity:');
  });

  it('should support returnDelta and auto-history logging on atomic_interact', async () => {
    // First, let's query the semantic surface to populate nodeIndex and get a backendNodeId
    const surfaceHandler = (server as any)._registeredTools['get_semantic_surface'].handler;
    const surfaceResult = await surfaceHandler({});
    expect(surfaceResult.content[0].text).toContain('id:');

    // Extract a backendNodeId for the primary-objective button
    // The markdown looks like: - [button] "Objective" [id: 12]
    const match = surfaceResult.content[0].text.match(/\[button\].*?\[id:\s*(\d+)\]/);
    expect(match).not.toBeNull();
    const nodeId = parseInt(match![1], 10);

    // Interact with the button with returnDelta = true
    const interactHandler = (server as any)._registeredTools['atomic_interact'].handler;
    const interactResult = await interactHandler({
      action: 'click',
      backendNodeId: nodeId,
      returnDelta: true,
    });

    expect(interactResult.content[0].text).toContain('Clicked element');
    expect(interactResult.content[0].text).toContain('### Action Delta Report');
    expect(interactResult.content[0].text).toContain('#### DOM Changes:');
    expect(interactResult.content[0].text).toContain('#### Network Activity:');
    expect(interactResult.content[0].text).toContain('#### Console Logs:');

    // Verify history directory contents
    const files = readdirSync(TEST_HISTORY_DIR);
    expect(files).toContain('session_history.md');
    expect(files.some((f) => f.startsWith('step_') && f.endsWith('.png'))).toBe(true);

    const historyContent = readFileSync(join(TEST_HISTORY_DIR, 'session_history.md'), 'utf-8');
    expect(historyContent).toContain('# Browser DVR Session History');
    expect(historyContent).toContain('Step 1: navigate');
    expect(historyContent).toContain('Step 2: click');
    expect(historyContent).toContain('### DOM Changes');
    expect(historyContent).toContain('### Visual State');
  });

  it('should support browser_dump_dvr to dump frames', async () => {
    // Wait briefly to allow screencast to capture at least one frame
    await new Promise((r) => setTimeout(r, 1000));

    const dumpHandler = (server as any)._registeredTools['browser_dump_dvr'].handler;
    const testDumpDir = join(process.cwd(), 'tests_dvr_dump_run');
    if (existsSync(testDumpDir)) {
      rmSync(testDumpDir, { recursive: true, force: true });
    }

    const dumpResult = await dumpHandler({ outputPath: testDumpDir });
    expect(dumpResult.content[0].text).toContain('Successfully dumped');
    expect(existsSync(testDumpDir)).toBe(true);

    const files = readdirSync(testDumpDir);
    expect(files.some((f) => f.startsWith('frame_') && f.endsWith('.jpg'))).toBe(true);

    // Clean up
    rmSync(testDumpDir, { recursive: true, force: true });
  });

  it('should generate crash diagnostics on tool failure', async () => {
    const interactHandler = (server as any)._registeredTools['atomic_interact'].handler;
    let threw = false;
    let savedCrashDir = '';

    try {
      await interactHandler({
        action: 'scroll',
      });
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('Crash diagnostics saved to:');
      const match = err.message.match(/Crash diagnostics saved to:\s*(.*)\)/);
      if (match) {
        savedCrashDir = match[1].trim();
      }
    }

    expect(threw).toBe(true);
    expect(savedCrashDir).not.toBe('');
    expect(existsSync(savedCrashDir)).toBe(true);

    const files = readdirSync(savedCrashDir);
    expect(files).toContain('crash_screenshot.png');
    expect(files).toContain('crash_report.md');
    expect(files.some((f) => f.startsWith('frame_') && f.endsWith('.jpg'))).toBe(true);

    const reportContent = readFileSync(join(savedCrashDir, 'crash_report.md'), 'utf-8');
    expect(reportContent).toContain('# Browser MCP Crash Report - atomic_interact');
    expect(reportContent).toContain('Failed Tool:** `atomic_interact`');

    // Clean up
    rmSync(savedCrashDir, { recursive: true, force: true });

    // Also clean up parent crash_dumps if empty
    const crashDumpsParent = join(process.cwd(), 'crash_dumps');
    if (existsSync(crashDumpsParent) && readdirSync(crashDumpsParent).length === 0) {
      rmSync(crashDumpsParent, { recursive: true, force: true });
    }
  });

  it('should include detachedDOMNodes in session summary', async () => {
    const summaryHandler = (server as any)._registeredTools['get_session_summary'].handler;
    const summaryResult = await summaryHandler({});
    const summary = JSON.parse(summaryResult.content[0].text);

    expect(summary).toHaveProperty('detachedDOMNodes');
    expect(typeof summary.detachedDOMNodes).toBe('number');
    expect(summary.detachedDOMNodes).toBeGreaterThanOrEqual(0);
  });

  it('should finalize recording and reset variables on browser_close', async () => {
    const closeHandler = (server as any)._registeredTools['browser_close'].handler;
    const closeResult = await closeHandler({});
    expect(closeResult.content[0].text).toContain('Browser closed');

    // Verify visual recording compiled manifest and video
    const files = readdirSync(TEST_HISTORY_DIR);
    expect(files).toContain('manifest.json');
    const manifest = JSON.parse(readFileSync(join(TEST_HISTORY_DIR, 'manifest.json'), 'utf-8'));
    expect(manifest.frameCount).toBeGreaterThan(0);
  });
});
