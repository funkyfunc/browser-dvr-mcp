#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BrowserManager } from './browser.js';

const browserManager = new BrowserManager();

const server = new McpServer({
  name: 'agentic-browser-observability',
  version: '0.1.0',
});

// 1. Ping
server.registerTool(
  'ping',
  { description: 'Verify connection to the Browser Observability server' },
  async () => {
    return {
      content: [{ type: 'text', text: 'pong - Browser Observability MCP server is running!' }],
    };
  }
);

// 2. Launch
server.registerTool(
  'browser_launch',
  {
    description: 'Launch the browser. headless defaults to true. userDataDir is optional. If url is provided, navigates directly.',
    inputSchema: {
      headless: z.boolean().optional().describe('Launch browser in headless mode (default: true)'),
      userDataDir: z.string().optional().describe('Optional custom user profile directory path'),
      url: z.string().url().optional().describe('Optional URL to navigate to immediately after launch'),
    },
  },
  async ({ headless, userDataDir, url }) => {
    const result = await browserManager.launch({ headless, userDataDir, url });
    return { content: [{ type: 'text', text: result }] };
  }
);

// 3. Close
server.registerTool(
  'browser_close',
  { description: 'Close the active browser session.' },
  async () => {
    const result = await browserManager.close();
    return { content: [{ type: 'text', text: result }] };
  }
);

// 4. Navigate
server.registerTool(
  'browser_navigate',
  {
    description: 'Navigate the active browser tab to the specified URL.',
    inputSchema: {
      // eslint-disable-next-line deprecation/deprecation
      url: z.string().url().describe('The URL to navigate to'),
    },
  },
  async ({ url }) => {
    const result = await browserManager.navigate(url);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 5. Get Accessibility Tree (USAG)
server.registerTool(
  'browser_get_accessibility_tree',
  { 
    description: 'Get the USAG accessibility tree of the active page in LLM-optimized Markdown. Natively pierces and aggregates all iframes. Each node includes a [backendNodeId: 123] tag which CAN and SHOULD be used directly in interactive tools like browser_click and browser_type as the backendNodeId argument.',
    inputSchema: {
      semanticOnly: z.boolean().optional().describe('Prune generic, non-interactive structural nodes (e.g., wrapper divs) from the tree to reduce density'),
    },
  },
  async ({ semanticOnly }) => {
    const result = await browserManager.getAccessibilityTree(semanticOnly);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 6. Click element
server.registerTool(
  'browser_click',
  {
    description: 'Click an element on the page. Provides feedback on whether the click resulted in DOM mutations.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('The backend DOM node ID of the element to click'),
      mcpId: z.string().optional().describe('The mcpId of the element to click (returned by query_selector)'),
      coordinate: z.array(z.number()).length(2).optional().describe('X, Y coordinates to click. Will bypass spatial occlusion checks.'),
      timeoutMs: z.number().optional().describe('Time in ms to wait for the element to appear and become visible/unoccluded before clicking (default: 0)'),
      forceSynthetic: z.boolean().optional().describe('Force a synthetic JavaScript click (el.click()) instead of a native mouse click. Useful for React SPA iframe boundaries.'),
    },
  },
  async ({ backendNodeId, mcpId, coordinate, timeoutMs, forceSynthetic }) => {
    let target: any = undefined;
    if (coordinate) target = { coordinate, timeoutMs, forceSynthetic };
    else if (backendNodeId) target = { backendNodeId, timeoutMs, forceSynthetic };
    else if (mcpId) target = { mcpId, timeoutMs, forceSynthetic };
    else throw new Error('Must provide either backendNodeId, mcpId, or coordinate. Note: coordinate must be an array of two numbers [x, y], not an object {x: 1, y: 1}.');

    const result = await browserManager.click(target);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 7. Type text
server.registerTool(
  'browser_type',
  {
    description: 'Type text into an element on the page. Automatically clicks the element first to focus it.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('The backend DOM node ID of the element'),
      mcpId: z.string().optional().describe('The mcpId of the element'),
      coordinate: z.array(z.number()).length(2).optional().describe('X, Y coordinates of the element'),
      text: z.string().describe('The text to type'),
      timeoutMs: z.number().optional().describe('Time in ms to wait for the element to appear and become visible/unoccluded before typing (default: 0)'),
    },
  },
  async ({ backendNodeId, mcpId, coordinate, text, timeoutMs }) => {
    let target: any = { text, timeoutMs };
    if (coordinate) target.coordinate = coordinate;
    else if (backendNodeId) target.backendNodeId = backendNodeId;
    else if (mcpId) target.mcpId = mcpId;
    else throw new Error('Must provide either backendNodeId, mcpId, or coordinate. Note: coordinate must be an array of two numbers [x, y], not an object {x: 1, y: 1}.');

    const result = await browserManager.type(target);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 8. Hover element
server.registerTool(
  'browser_hover',
  {
    description: 'Hover over an element on the page.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('The backend DOM node ID of the element to hover over'),
      mcpId: z.string().optional().describe('The mcpId of the element to hover over (returned by query_selector)'),
      coordinate: z.array(z.number()).length(2).optional().describe('X, Y coordinates to hover over. Will bypass spatial occlusion checks.'),
      timeoutMs: z.number().optional().describe('Time in ms to wait for the element to appear and become visible/unoccluded before hovering (default: 0)'),
    },
  },
  async ({ backendNodeId, mcpId, coordinate, timeoutMs }) => {
    let target: any = undefined;
    if (coordinate) target = { coordinate, timeoutMs };
    else if (backendNodeId) target = { backendNodeId, timeoutMs };
    else if (mcpId) target = { mcpId, timeoutMs };
    else throw new Error('Must provide either backendNodeId, mcpId, or coordinate. Note: coordinate must be an array of two numbers [x, y], not an object {x: 1, y: 1}.');

    const result = await browserManager.hover(target);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 9. Get Mutations
server.registerTool(
  'browser_get_mutations',
  { description: 'Retrieve buffered JSON deltas of DOM mutations occurred since the last request.' },
  async () => {
    const mutations = await browserManager.getMutations();
    return {
      content: [{ type: 'text', text: JSON.stringify(mutations, null, 2) }],
    };
  }
);

// 10. Dump DVR Buffer
server.registerTool(
  'browser_dump_dvr',
  {
    description: 'Dump the rolling 10s DVR screenshots and console/network logs to a local folder.',
    inputSchema: {
      outputPath: z.string().describe('The local absolute output directory path where files should be saved'),
    },
  },
  async ({ outputPath }) => {
    const result = await browserManager.dumpDvr(outputPath);
    return {
      content: [
        {
          type: 'text',
          text: `DVR buffer dumped successfully.\nOutput directory: ${result.outputPath}\nFrames captured: ${result.frameCount}\nLogs recorded: ${result.logCount}`,
        },
      ],
    };
  }
);

// 11. Human Handoff Session
server.registerTool(
  'browser_handoff',
  {
    description: 'Start a headful browser session with a persistent user profile for manual debugging.',
    inputSchema: {
      userDataDir: z.string().optional().describe('Optional custom user profile directory path'),
    },
  },
  async ({ userDataDir }) => {
    const result = await browserManager.runHandoff(userDataDir);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 12. Get event listeners
server.registerTool(
  'browser_get_listeners',
  {
    description: 'Get all active Javascript event listeners attached to the element.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the element'),
    },
  },
  async ({ backendNodeId }) => {
    const result = await browserManager.getEventListeners(backendNodeId);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// 13. Toggle paint flash
server.registerTool(
  'browser_toggle_paint_flash',
  {
    description: 'Toggle visual paint flash overlays in Chromium.',
    inputSchema: {
      enabled: z.boolean().describe('Enable or disable paint flashing rects'),
    },
  },
  async ({ enabled }) => {
    const result = await browserManager.togglePaintFlash(enabled);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 14. Get performance metrics
server.registerTool(
  'browser_get_performance_metrics',
  { description: 'Get Chromium internal performance/rendering metrics.' },
  async () => {
    const result = await browserManager.getPerformanceMetrics();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// 15. Sniff Framework State
server.registerTool(
  'browser_sniff_framework_state',
  { description: 'Sniff React component fiber trees, Redux stores (__REDUX_DEVTOOLS_EXTENSION__ / window.store), and Zustand stores. Returns the current state snapshot and a diff against the previous call, enabling before/after state comparison across interactions.' },
  async () => {
    const result = await browserManager.sniffFrameworkState();
    const text = JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text: text ?? 'undefined' }] };
  }
);

// 16. Detect Leaks & Visual Anomalies
server.registerTool(
  'browser_detect_leaks_and_anomalies',
  { description: 'Calculate layout shifts (CLS), background brightness, and identify memory leaks (detached DOM nodes count).' },
  async () => {
    const result = await browserManager.detectLeaksAndAnomalies();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// 17. Throttle Network
server.registerTool(
  'browser_throttle_network',
  {
    description: 'Emulate network conditions by throttling bandwidth and adding latency.',
    inputSchema: {
      latencyMs: z.number().describe('Latency delay to inject in milliseconds'),
      downloadKbps: z.number().describe('Max download bandwidth in Kilobits per second (0 to disable throttling)'),
      uploadKbps: z.number().describe('Max upload bandwidth in Kilobits per second (0 to disable throttling)'),
    },
  },
  async ({ latencyMs, downloadKbps, uploadKbps }) => {
    const result = await browserManager.throttleNetwork(latencyMs, downloadKbps, uploadKbps);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 18. Intercept Requests
server.registerTool(
  'browser_intercept_request',
  {
    description: 'Pause and intercept matching network requests to inject delay or fail them.',
    inputSchema: {
      pattern: z.string().describe('URL glob/regex pattern to intercept (e.g. *api*)'),
      action: z.enum(['delay', 'fail']).describe('Action to apply'),
      delayMs: z.number().optional().describe('Delay in milliseconds (required for delay action)'),
    },
  },
  async ({ pattern, action, delayMs }) => {
    const result = await browserManager.enableRequestInterception(pattern, action, delayMs);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 19. Disable request interception
server.registerTool(
  'browser_disable_interception',
  { description: 'Disable and clear all active network request interception rules.' },
  async () => {
    const result = await browserManager.disableRequestInterception();
    return { content: [{ type: 'text', text: result }] };
  }
);

// 20. Test responsive layouts
server.registerTool(
  'browser_test_responsive',
  {
    description: 'Test page accessibility and layouts across standard viewports (Mobile, Tablet, Desktop).',
    inputSchema: {
      // eslint-disable-next-line deprecation/deprecation
      url: z.string().url().describe('The URL to test'),
    },
  },
  async ({ url }) => {
    const viewports = [
      { width: 375, height: 667, name: 'Mobile (iPhone)' },
      { width: 768, height: 1024, name: 'Tablet (iPad)' },
      { width: 1280, height: 800, name: 'Desktop (Standard)' },
    ];
    const result = await browserManager.testResponsiveLayout(url, viewports);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// 21. Screenshot
server.registerTool(
  'browser_screenshot',
  {
    description:
      'Capture a screenshot. Without a backendNodeId, captures the full viewport (or full scrollable page with fullPage=true). ' +
      'With a backendNodeId, captures just that element. Returns the image inline or saves to disk.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('If provided, capture just this element'),
      fullPage: z.boolean().optional().describe('Capture the entire scrollable page instead of just the viewport (default: false)'),
      format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
      quality: z.number().optional().describe('JPEG quality 0-100 (only for jpeg format, default: 80)'),
      savePath: z.string().optional().describe('Optional absolute file path to save the image. If omitted, returns base64 inline.'),
    },
  },
  async (args) => {
    const result = await browserManager.screenshot(args);

    if (result.savedTo) {
      return {
        content: [
          { type: 'text' as const, text: `Screenshot saved to ${result.savedTo}` },
          { type: 'image' as const, data: result.data, mimeType: result.mimeType },
        ],
      };
    }

    return {
      content: [
        { type: 'image' as const, data: result.data, mimeType: result.mimeType },
      ],
    };
  }
);

// 22. Start Recording
server.registerTool(
  'browser_start_recording',
  {
    description:
      'Start recording the browser screen. Frames are captured immediately — proceed with interactions right away. ' +
      'Only one recording at a time. Auto-stops after 5 minutes. Call browser_stop_recording to finalize.',
    inputSchema: {
      outputDir: z
        .string()
        .optional()
        .describe('Optional directory to save recording frames. Defaults to dist/recordings/rec_<timestamp>'),
    },
  },
  async ({ outputDir }) => {
    const result = await browserManager.startRecording({ outputDir });
    return { content: [{ type: 'text', text: result }] };
  }
);

// 23. Stop Recording
server.registerTool(
  'browser_stop_recording',
  {
    description:
      'Stop the active recording and finalize output. Returns frame count, duration, output directory, and a ready-to-use ffmpeg command to assemble frames into an MP4 video.',
  },
  async () => {
    const result = await browserManager.stopRecording();
    const lines = [
      `Recording stopped.`,
      `Output: ${result.outputDir}`,
      `Frames: ${result.frameCount}`,
      `Duration: ${result.durationSeconds}s`,
    ];
    if (result.videoPath) {
      lines.push(`Video: ${result.videoPath}`);
    }
    lines.push(`Manifest: ${result.manifestPath}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }
);

// 24. Batch Actions
server.registerTool(
  'browser_batch',
  {
    description:
      'Execute multiple browser tools in a single call. Actions run sequentially and stop on first error. ' +
      'Reduces agent round-trips for multi-step workflows like: click → wait → screenshot → check metrics.',
    inputSchema: {
      actions: z
        .array(
          z.object({
            tool: z.string().describe('Tool name to execute (e.g. browser_click, browser_screenshot)'),
            args: z
              .record(z.string(), z.unknown())
              .describe('Arguments for the tool'),
          })
        )
        .describe('Array of actions to execute sequentially'),
    },
  },
  async ({ actions }) => {
    const result = await browserManager.executeBatch(
      actions as { tool: string; args: Record<string, unknown> }[]
    );
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);
// ─── Agent Observation & State Tools ────────────────────────────────────────

server.registerTool(
  'browser_get_console_logs',
  { 
    description: 'Retrieve buffered console logs and uncaught exceptions since the last check.',
    inputSchema: { clear: z.boolean().optional().describe('Clear the log buffer after reading (default: false)') }
  },
  async ({ clear }) => {
    const result = browserManager.getConsoleLogs(clear);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_get_network_activity',
  { 
    description: 'Retrieve buffered network requests and responses since the last check.',
    inputSchema: { clear: z.boolean().optional().describe('Clear the network buffer after reading (default: false)') }
  },
  async ({ clear }) => {
    const result = browserManager.getNetworkActivity(clear);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_press_key',
  { 
    description: 'Press a specific keyboard key (e.g., Enter, Escape, Tab).',
    inputSchema: { key: z.string().describe('The key to press (e.g. Enter, Escape, ArrowDown)') }
  },
  async ({ key }) => {
    const result = await browserManager.pressKey(key);
    return { content: [{ type: 'text', text: result }] };
  }
);

server.registerTool(
  'browser_scroll',
  { 
    description: 'Scroll the page up, down, or to the top/bottom.',
    inputSchema: { 
      direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Scroll direction'),
      amount: z.number().optional().describe('Amount in pixels to scroll (defaults to viewport height if omitted)')
    }
  },
  async ({ direction, amount }) => {
    const result = await browserManager.scroll(direction, amount);
    return { content: [{ type: 'text', text: result }] };
  }
);

server.registerTool(
  'browser_manage_storage',
  { 
    description: 'Get, set, or clear localStorage, sessionStorage, or cookies.',
    inputSchema: { 
      action: z.enum(['get', 'set', 'clear']).describe('Action to perform'),
      type: z.enum(['localStorage', 'sessionStorage', 'cookies']).describe('Storage type'),
      key: z.string().optional().describe('Key to set (required for set)'),
      value: z.string().optional().describe('Value to set (required for set)'),
      domain: z.string().optional().describe('Domain for cookies (default: localhost)')
    }
  },
  async ({ action, type, key, value, domain }) => {
    const result = await browserManager.manageStorage(action, type, key, value, domain);
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_assert_element',
  { 
    description: 'Assert and retrieve the state (visible, disabled, text, checked, backendNodeId) of an element without pulling the full tree. Supports querying inside iframes.',
    inputSchema: { 
      backendNodeId: z.number().optional().describe('The backend DOM node ID of the element'),
      mcpId: z.string().optional().describe('The mcpId of the element (returned by query_selector)'),
      selector: z.string().optional().describe('CSS or XPath selector of the element'),
      iframeSelector: z.string().optional().describe('Optional CSS selector for an iframe containing the element'),
      iframeMcpId: z.string().optional().describe('Optional mcpId for an iframe containing the element')
    }
  },
  async ({ backendNodeId, mcpId, selector, iframeSelector, iframeMcpId }) => {
    const result = await browserManager.assertElement({ backendNodeId, mcpId, selector, iframeSelector, iframeMcpId });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Query Selector Tool ──────────────────────────────────────────────────

server.registerTool(
  'browser_query_selector',
  {
    description: 'Query the DOM using a CSS selector or XPath (prefix with "xpath/") and return all matching elements with their tag names, text content, bounding boxes, and backendNodeIds. Supports querying inside iframes.',
    inputSchema: {
      selector: z.string().describe('CSS selector or XPath (prefix with "xpath/") to query. Use ">>" to cross iframe boundaries (e.g. "iframe >> .btn").'),
      iframeSelector: z.string().optional().describe('Optional CSS selector for an iframe to scope the query into'),
      iframeMcpId: z.string().optional().describe('Optional mcpId for an iframe to scope the query into'),
      pierceAllFrames: z.boolean().optional().describe('Defaults to true. NOTE: Standard CSS selectors cannot natively cross iframe boundaries (e.g. "iframe h1" will fail). To query inside an iframe, use iframeMcpId or iframeSelector.'),
      visibleOnly: z.boolean().optional().describe('Strip out invisible or non-rendered elements (e.g., meta, script, hidden divs)'),
      timeoutMs: z.number().optional().describe('Implicit wait time in ms to poll for the element before returning (default: 0)'),
    },
  },
  async ({ selector, iframeSelector, visibleOnly, iframeMcpId, timeoutMs }) => {
    // The underlying browser_query_selector already pierces all frames if iframe limits aren't set
    let result;
    if (timeoutMs && timeoutMs > 0) {
      result = await browserManager.waitForSelector(selector, iframeSelector, visibleOnly, iframeMcpId, timeoutMs);
    } else {
      result = await browserManager.querySelector(selector, iframeSelector, visibleOnly, iframeMcpId);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Wait For Selector Tool ───────────────────────────────────────────────

server.registerTool(
  'browser_wait_for_selector',
  {
    description: 'Wait for an element to appear in the DOM matching the given selector. Supports querying inside iframes. Returns the matched elements once found.',
    inputSchema: {
      selector: z.string().describe('CSS selector or XPath (prefix with "xpath/") to wait for. Use ">>" to cross iframe boundaries (e.g. "iframe >> .btn").'),
      iframeSelector: z.string().optional().describe('Optional CSS selector for an iframe to scope the query into'),
      iframeMcpId: z.string().optional().describe('Optional mcpId for an iframe to scope the query into'),
      visibleOnly: z.boolean().optional().describe('Only match if the element is visible'),
      timeoutMs: z.number().optional().describe('Maximum time to wait in milliseconds (default: 5000)'),
    },
  },
  async ({ selector, iframeSelector, visibleOnly, iframeMcpId, timeoutMs }) => {
    const result = await browserManager.waitForSelector(selector, iframeSelector, visibleOnly, iframeMcpId, timeoutMs);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Get Element At Point Tool ────────────────────────────────────────────

server.registerTool(
  'browser_get_element_at_point',
  {
    description: 'Get the topmost element details at a specific X/Y coordinate. Automatically traverses into iframes to find the true target element.',
    inputSchema: {
      x: z.number().describe('The X coordinate'),
      y: z.number().describe('The Y coordinate'),
    },
  },
  async ({ x, y }) => {
    const result = await browserManager.getElementAtPoint(x, y);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Evaluate Tool ────────────────────────────────────────────────────────

server.registerTool(
  'browser_evaluate',
  {
    description: 'Execute a JavaScript expression in the active page context and return the result. Useful for checking global variables, triggering custom lookups, or running quick queries. Times out after 5 seconds.',
    inputSchema: {
      expression: z.string().describe('JavaScript expression to evaluate in the page context'),
    },
  },
  async ({ expression }) => {
    const result = await browserManager.evaluate(expression);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Mock Date and Time Tool ──────────────────────────────────────────────

server.registerTool(
  'browser_mock_date_and_time',
  {
    description: 'Mock, freeze, or shift browser time for deterministic testing of time-dependent UI. Overrides Date, Date.now(), and performance.now(). Persists across page navigations.',
    inputSchema: {
      mode: z.enum(['freeze', 'travel', 'reset']).describe('freeze: stop time at a specific moment. travel: offset all times by deltaMs. reset: restore native time.'),
      isoDate: z.string().optional().describe('ISO 8601 date string to freeze time at (only for freeze mode, e.g. "2025-01-01T00:00:00Z")'),
      deltaMs: z.number().optional().describe('Millisecond offset to shift time by (only for travel mode, e.g. 3600000 for +1 hour)'),
    },
  },
  async ({ mode, isoDate, deltaMs }) => {
    const result = await browserManager.mockDateTime({ mode, isoDate, deltaMs });
    return { content: [{ type: 'text', text: result }] };
  }
);

// ─── Simulate Tab Flow Tool ───────────────────────────────────────────────

server.registerTool(
  'browser_simulate_tab_flow',
  {
    description: 'Simulate pressing Tab through the page to audit keyboard accessibility. Reports the focus traversal order with element details and backendNodeIds, and flags potential focus traps where keyboard users would get stuck.',
    inputSchema: {
      maxSteps: z.number().optional().describe('Maximum number of Tab presses to simulate (default: 20)'),
    },
  },
  async ({ maxSteps }) => {
    const result = await browserManager.simulateTabFlow(maxSteps);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Set Offline Mode Tool ─────────────────────────────────────────────────

server.registerTool(
  'browser_set_offline',
  {
    description: 'Toggle the browser network between online and offline mode. Useful for testing PWA offline behavior, Service Worker fallbacks, and error handling for network failures.',
    inputSchema: {
      offline: z.boolean().describe('Set to true to go offline, false to restore online connectivity'),
    },
  },
  async ({ offline }) => {
    const result = await browserManager.setOfflineMode(offline);
    return { content: [{ type: 'text', text: result }] };
  }
);

// ─── Session Management Tools ─────────────────────────────────────────────

server.registerTool(
  'browser_session_summary',
  {
    description: 'Get a compact, high-level summary of the current session including navigation history, network stats, console errors, interaction counts, and auto-generated alerts. This is the primary observability entry point — use this first, then drill down.',
  },
  async () => {
    const result = browserManager.getSessionSummary();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_session_drilldown',
  {
    description: 'Drill into a specific category of the session data. Categories: network (filter: failed|slow|api|status:NNN|url text), console (filter: errors|warnings|text search), mutations (filter: structural|attributes|elementId), interactions (filter: clicks|typing|keys), navigation.',
    inputSchema: {
      category: z.enum(['network', 'console', 'mutations', 'interactions', 'navigation']).describe('Category to drill into'),
      filter: z.string().optional().describe('Optional filter within the category'),
    },
  },
  async ({ category, filter }) => {
    const result = browserManager.sessionDrillDown(category, filter);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ─── Human Recording Tools ───────────────────────────────────────────────

server.registerTool(
  'browser_start_human_session',
  {
    description: 'Launch a visible browser for human-driven recording. The human interacts with the browser while all clicks, inputs, network traffic, console logs, and mutations are captured. Call browser_stop_human_session when done.',
    inputSchema: {
      url: z.string().optional().describe('Optional URL to navigate to on launch'),
    },
  },
  async ({ url }) => {
    const result = await browserManager.startHumanSession(url);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_stop_human_session',
  {
    description: 'Stop the active human recording session. Saves the session to disk and returns a summary of everything captured.',
  },
  async () => {
    const result = await browserManager.stopHumanSession();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_load_session',
  {
    description: 'Load a previously saved session from disk. After loading, use browser_session_summary and browser_session_drilldown to inspect it.',
    inputSchema: {
      path: z.string().describe('Absolute path to the .session.json file'),
    },
  },
  async ({ path }) => {
    const result = browserManager.loadSession(path);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'browser_list_sessions',
  {
    description: 'List all saved sessions on disk with their IDs, modes, and durations.',
  },
  async () => {
    const result = browserManager.listSessions();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Observability MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
