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

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Browser Observability MCP Server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
