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
    description: 'Launch the browser. headless defaults to true. userDataDir is optional.',
    inputSchema: {
      headless: z.boolean().optional().describe('Launch browser in headless mode (default: true)'),
      userDataDir: z.string().optional().describe('Optional custom user profile directory path'),
    },
  },
  async ({ headless, userDataDir }) => {
    const result = await browserManager.launch({ headless, userDataDir });
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
  { description: 'Get the USAG accessibility tree of the active page in LLM-optimized Markdown.' },
  async () => {
    const result = await browserManager.getAccessibilityTree();
    return { content: [{ type: 'text', text: result }] };
  }
);

// 6. Click element
server.registerTool(
  'browser_click',
  {
    description: 'Perform pre-execution spatial validation and click the target element by its backendNodeId.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the element to click'),
    },
  },
  async ({ backendNodeId }) => {
    const result = await browserManager.click(backendNodeId);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 7. Type text
server.registerTool(
  'browser_type',
  {
    description: 'Perform pre-execution spatial validation and type text into the target element by its backendNodeId.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the element to type into'),
      text: z.string().describe('The text string to type into the element'),
    },
  },
  async ({ backendNodeId, text }) => {
    const result = await browserManager.type(backendNodeId, text);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 8. Hover element
server.registerTool(
  'browser_hover',
  {
    description: 'Perform pre-execution spatial validation and hover over the target element by its backendNodeId.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the element to hover over'),
    },
  },
  async ({ backendNodeId }) => {
    const result = await browserManager.hover(backendNodeId);
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
  { description: 'Sniff React component fiber trees and retrieve active state trees from the page DOM.' },
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
    description: 'Assert and retrieve the state (visible, disabled, text, checked) of an element without pulling the full tree.',
    inputSchema: { 
      backendNodeId: z.number().optional().describe('The backend node ID of the element'),
      selector: z.string().optional().describe('CSS selector (used if backendNodeId is omitted)')
    }
  },
  async ({ backendNodeId, selector }) => {
    const result = await browserManager.assertElement(backendNodeId, selector);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
