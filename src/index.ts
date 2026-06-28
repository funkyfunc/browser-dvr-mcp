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
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Observability MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
