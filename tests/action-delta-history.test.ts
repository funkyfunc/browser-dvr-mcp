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
    expect(historyContent).toContain('# Best Browser Session History');
    expect(historyContent).toContain('Step 1: navigate');
    expect(historyContent).toContain('Step 2: click');
    expect(historyContent).toContain('### DOM Changes');
    expect(historyContent).toContain('### Visual State');
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
