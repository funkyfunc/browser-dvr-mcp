#!/usr/bin/env node
// ─── Best Browser MCP: Dual-Layer Perceptive Middleware ─────────────────────
// A perception engine for AI agents. Not a browser driver — an optic nerve.
//
// Layer 1: Atomic Action Primitives (interact, evaluate, spatial validation)
// Layer 2: Perception & Telemetry (semantic surface, session telemetry, state delta)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { CDPConnectionManager } from './core/CDPConnectionManager.js';
import { ImmutableNodeIndex } from './core/ImmutableNodeIndex.js';
import { SessionTelemetryManager } from './telemetry/SessionTelemetryManager.js';
import { WorkerBridge } from './workers/workerBridge.js';
import { ScreencastManager } from './layer1/screencast.js';
import { HumanRecordingManager } from './layer2/humanRecording.js';

// Layer 1 actions
import {
  atomicClick,
  coordinateClick,
  atomicDoubleClick,
  atomicType,
  atomicClear,
  atomicHover,
  atomicKeyPress,
  atomicScroll,
} from './layer1/atomicInteract.js';
import { validateSpatialCoordinate } from './layer1/spatialValidation.js';
import { evaluateInContext, listFrameContexts } from './layer1/evaluateInContext.js';

// Layer 2 perception
import { getSemanticSurface, getElementTree } from './layer2/semanticSurface.js';
import { getStateDelta } from './layer2/stateDelta.js';

// ─── Singletons ─────────────────────────────────────────────────────────────

const connectionManager = new CDPConnectionManager();
const nodeIndex = new ImmutableNodeIndex();
const humanRecording = new HumanRecordingManager(connectionManager);

// WorkerBridge is optional — it's only used for DVR frame buffering (screencast).
// In production builds (esbuild --bundle), the worker file doesn't exist as a
// separate file, so WorkerBridge construction will fail. This is non-fatal.
let workerBridge: WorkerBridge | null = null;
try {
  workerBridge = new WorkerBridge();
} catch {
  console.error('WorkerBridge unavailable (bundled build). DVR frame buffering disabled.');
}

let telemetry: SessionTelemetryManager | null = null;
let screencast: ScreencastManager | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireSession(): { page: NonNullable<ReturnType<typeof connectionManager.getPage>>; cdp: NonNullable<ReturnType<typeof connectionManager.getCDPSession>> } {
  const page = connectionManager.getPage();
  const cdp = connectionManager.getCDPSession();
  if (!page || !cdp) throw new Error('No active browser session. Call browser_launch first.');
  return { page, cdp };
}

function requireTelemetry(): SessionTelemetryManager {
  if (!telemetry) throw new Error('No active session. Call browser_launch first.');
  return telemetry;
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'best-browser-mcp',
  version: '2.0.0',
});

// ═══════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'ping',
  {
    description: 'Verify connection to the Best Browser MCP server. Returns "pong" if the server is healthy and ready to accept commands.',
  },
  async () => ({
    content: [{ type: 'text', text: 'pong — Best Browser MCP v2.0 is running.' }],
  })
);

server.registerTool(
  'browser_launch',
  {
    description:
      'Launch a Chromium browser instance and establish a CDP session. This is the mandatory first step before any other tool can be used. ' +
      'By default, launches in headless mode. Set headless=false for visual debugging. ' +
      'If a URL is provided, the browser navigates to it immediately after launch (waits for load event). ' +
      'The launched session automatically enables: Accessibility domain, DOM domain, Performance domain, and Target.setAutoAttach for OOPIF discovery.',
    inputSchema: {
      headless: z.boolean().optional().describe('Launch in headless mode (default: true). Set false to see the browser window.'),
      userDataDir: z.string().optional().describe('Path to a persistent Chrome user profile directory. Useful for preserving cookies and localStorage across sessions.'),
      url: z.string().url().optional().describe('URL to navigate to immediately after launch.'),
    },
  },
  async ({ headless, userDataDir, url }) => {
    const result = await connectionManager.launch({ headless, userDataDir });

    // Initialize telemetry
    telemetry = new SessionTelemetryManager('agent');
    telemetry.attachToPage(result.page);
    await telemetry.attachToCDP(result.cdpSession);

    // Checkpoint the node index for delta tracking
    nodeIndex.clear();

    // Navigate BEFORE starting screencast to avoid race condition on about:blank.
    // The screencast requires a rendered page; starting it before navigation can
    // crash with "Protocol error (Page.startScreencast): Session closed".
    if (url) {
      await connectionManager.navigate(url);
      telemetry.addNavigation(url);
    }

    // Initialize screencast (non-fatal if it fails — perception still works)
    // Requires workerBridge for DVR frame buffering; skip if unavailable
    if (workerBridge) {
      screencast = new ScreencastManager(result.cdpSession, workerBridge);
      try {
        await screencast.start();
      } catch (err) {
        console.error('Screencast start failed (non-fatal):', err);
      }
    }

    return {
      content: [{ type: 'text', text: `${result.message} Session: ${telemetry.id}${url ? `. Navigated to ${url}` : ''}` }],
    };
  }
);

server.registerTool(
  'browser_close',
  {
    description: 'Close the active browser session and release all resources. Stops any active screencast or recording.',
  },
  async () => {
    if (screencast) {
      await screencast.stop();
      screencast = null;
    }
    workerBridge?.clearBuffers();
    nodeIndex.clear();
    const result = await connectionManager.close();
    telemetry = null;
    return { content: [{ type: 'text', text: result }] };
  }
);

server.registerTool(
  'browser_navigate',
  {
    description:
      'Navigate the active browser tab to a new URL. By default, waits for the page load event before returning. ' +
      'For SPAs (React, Vue, etc.), use waitUntil="networkidle0" to wait for all async requests to complete. ' +
      'After navigation, call get_semantic_surface to perceive the new page content.',
    inputSchema: {
      url: z.string().url().describe('The full URL to navigate to (must include protocol, e.g., https://)'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2'])
        .optional()
        .describe(
          'Navigation wait strategy. ' +
          '"load" (default) waits for the window load event. ' +
          '"networkidle0" waits until there are no network connections for 500ms — ideal for SPAs that fetch data after mount. ' +
          '"networkidle2" allows up to 2 open connections (for long-polling/WebSocket apps). ' +
          '"domcontentloaded" returns as soon as the DOM is parsed (fastest, but page may still be loading).'
        ),
    },
  },
  async ({ url, waitUntil }) => {
    requireSession();
    const result = await connectionManager.navigate(url, { waitUntil });
    requireTelemetry().addNavigation(url);
    nodeIndex.checkpoint(); // Checkpoint for delta tracking across navigations
    return { content: [{ type: 'text', text: result }] };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1: ACTION PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'atomic_interact',
  {
    description:
      'THE PRIMARY INTERACTION TOOL. Combines element location and action into a single, uninterruptible browser engine tick. ' +
      'This eliminates Virtual DOM detachment race conditions that plague multi-step locate→act patterns. ' +
      'Uses direct CDP Input.dispatch* commands — not high-level Puppeteer abstractions.\n\n' +
      'ACTIONS:\n' +
      '• click — Click an element. Uses spatial validation to verify the target is not occluded.\n' +
      '• dblclick — Double-click an element (useful for canvas items or file explorers).\n' +
      '• type — Focus an element and type text into it. Automatically clears existing content first.\n' +
      '• clear — Clear an input element.\n' +
      '• hover — Move the mouse to an element\'s center to trigger hover states.\n' +
      '• key — Press a keyboard key (e.g., "Enter", "Escape", "Tab", "ArrowDown").\n' +
      '• scroll — Scroll the page (direction: "up", "down", "top", "bottom").\n\n' +
      'LOCATOR STRATEGIES:\n' +
      '• backendNodeId (number) — The most reliable. Obtained from get_semantic_surface output (the [id: NNN] tag on each node).\n' +
      '• coordinate ([x, y]) — Raw pixel coordinates. Use for Canvas/WebGL or when backendNodeId is unavailable.\n\n' +
      'IMPORTANT: Always prefer backendNodeId from get_semantic_surface over CSS selectors or coordinates. ' +
      'backendNodeIds are assigned by the browser engine and survive React/Vue re-renders.',
    inputSchema: {
      action: z.enum(['click', 'dblclick', 'type', 'clear', 'hover', 'key', 'scroll']).describe('The interaction action to perform'),
      backendNodeId: z.number().optional().describe('The backend DOM node ID from get_semantic_surface (the [id: NNN] tag). Preferred locator.'),
      coordinate: z.array(z.number()).length(2).optional().describe('Raw [x, y] pixel coordinates. Use for Canvas or as fallback.'),
      text: z.string().optional().describe('Text to type (required for action="type")'),
      key: z.string().optional().describe('Key name to press (required for action="key", e.g., "Enter", "Escape", "Tab")'),
      clearFirst: z.boolean().optional().describe('For "type": clear the input field first (default: true)'),
      direction: z.enum(['up', 'down', 'top', 'bottom']).optional().describe('Scroll direction (required for action="scroll")'),
      amount: z.number().optional().describe('Scroll amount in pixels (default: viewport height)'),
      timeoutMs: z.number().optional().describe('Max time in ms to wait for the element to become interactable (default: 2000)'),
    },
  },
  async ({ action, backendNodeId, coordinate, text, key, clearFirst, direction, amount, timeoutMs }) => {
    const { page, cdp } = requireSession();
    const tel = requireTelemetry();

    // Take checkpoint before action for delta tracking
    nodeIndex.checkpoint();

    let result;

    switch (action) {
      case 'click':
        if (coordinate) {
          result = await coordinateClick(page, cdp, coordinate[0], coordinate[1], tel);
        } else if (backendNodeId !== undefined) {
          result = await atomicClick(page, cdp, backendNodeId, tel, { timeoutMs });
        } else {
          throw new Error('click requires either backendNodeId or coordinate.');
        }
        break;

      case 'dblclick':
        if (backendNodeId !== undefined) {
          result = await atomicDoubleClick(page, cdp, backendNodeId, tel, { timeoutMs });
        } else {
          throw new Error('dblclick requires backendNodeId.');
        }
        break;

      case 'type':
        if (!text) throw new Error('type action requires the "text" parameter.');
        if (backendNodeId !== undefined) {
          result = await atomicType(page, cdp, backendNodeId, text, tel, { clearFirst, timeoutMs });
        } else if (coordinate) {
          // Click coordinate first, then type
          await coordinateClick(page, cdp, coordinate[0], coordinate[1], tel);
          // Use CDP insertText for typing
          await cdp.send('Input.insertText', { text });
          result = { success: true, action: 'type', feedback: `Typed "${text.substring(0, 30)}" at (${coordinate[0]}, ${coordinate[1]}).` };
        } else {
          throw new Error('type requires either backendNodeId or coordinate.');
        }
        break;

      case 'clear':
        if (backendNodeId !== undefined) {
          result = await atomicClear(page, cdp, backendNodeId, tel, { timeoutMs });
        } else {
          throw new Error('clear requires backendNodeId.');
        }
        break;

      case 'hover':
        if (backendNodeId !== undefined) {
          result = await atomicHover(page, cdp, backendNodeId, tel, { timeoutMs });
        } else if (coordinate) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: Math.round(coordinate[0]), y: Math.round(coordinate[1]),
          });
          result = { success: true, action: 'hover', feedback: `Hovered at (${coordinate[0]}, ${coordinate[1]}).` };
        } else {
          throw new Error('hover requires either backendNodeId or coordinate.');
        }
        break;

      case 'key':
        if (!key) throw new Error('key action requires the "key" parameter.');
        result = await atomicKeyPress(page, cdp, key, tel);
        break;

      case 'scroll':
        if (!direction) throw new Error('scroll action requires the "direction" parameter.');
        result = await atomicScroll(page, cdp, direction, tel, amount);
        break;
    }

    return { content: [{ type: 'text', text: result?.feedback || 'Action completed.' }] };
  }
);

server.registerTool(
  'evaluate_in_context',
  {
    description:
      'Execute arbitrary JavaScript in any frame context, including out-of-process iframes (OOPIFs) and shadow DOM hosts. ' +
      'Uses Target.setAutoAttach to discover all execution contexts automatically.\n\n' +
      'USE CASES:\n' +
      '• Inspect React/Vue/Angular state: evaluate_in_context({ expression: "document.querySelector(\'#app\').__vue__.$data" })\n' +
      '• Read computed styles: evaluate_in_context({ expression: "getComputedStyle(document.body).backgroundColor" })\n' +
      '• Trigger custom app logic: evaluate_in_context({ expression: "window.myApp.reset()" })\n' +
      '• Execute in an iframe: evaluate_in_context({ expression: "document.title", frameIndex: 1 })\n\n' +
      'IMPORTANT: This is the tool that replaces framework-specific macros. Instead of using a React-specific sniffer, ' +
      'write the exact JS introspection you need. This keeps the MCP server unopinionated.',
    inputSchema: {
      expression: z.string().describe('JavaScript expression to evaluate. The result is returned as JSON.'),
      frameIndex: z.number().optional().describe('Frame index to evaluate in (0 = main frame). Call with no args to list available frames.'),
      timeoutMs: z.number().optional().describe('Evaluation timeout in milliseconds (default: 5000)'),
    },
  },
  async ({ expression, frameIndex, timeoutMs }) => {
    const { page, cdp } = requireSession();

    // If no expression, list available frames
    if (!expression || expression.trim() === '') {
      const contexts = await listFrameContexts(page);
      return { content: [{ type: 'text', text: JSON.stringify(contexts, null, 2) }] };
    }

    const result = await evaluateInContext(page, cdp, expression, frameIndex, timeoutMs);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'validate_spatial_coordinate',
  {
    description:
      'PRE-EXECUTION SAFETY NET. Before clicking or hovering on a coordinate, call this tool to verify that the intended ' +
      'target is actually at those coordinates and is not occluded by an overlay, modal, cookie banner, or layout shift.\n\n' +
      'Returns:\n' +
      '• valid=true → Safe to proceed with click/hover.\n' +
      '• valid=false, occluded=true → Another element is blocking the target. The occluder CSS selector is returned ' +
      '  so the agent can dismiss it or find an alternative path.\n' +
      '• valid=false, occluded=false → Target element is invisible, zero-sized, or out of viewport.\n\n' +
      'NOTE: atomic_interact already runs spatial validation internally. Use this tool only for explicit pre-flight checks.',
    inputSchema: {
      x: z.number().describe('X coordinate to validate'),
      y: z.number().describe('Y coordinate to validate'),
      targetBackendNodeId: z.number().optional().describe('Expected backendNodeId at this coordinate. If omitted, only bounds checking is performed.'),
    },
  },
  async ({ x, y, targetBackendNodeId }) => {
    const { page, cdp } = requireSession();
    const result = await validateSpatialCoordinate(page, cdp, x, y, targetBackendNodeId);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'coordinate_click',
  {
    description:
      'BYPASS THE DOM ENTIRELY. Dispatches a raw mouse click at exact pixel coordinates via CDP Input.dispatchMouseEvent. ' +
      'Designed for Canvas, WebGL, and other non-DOM interfaces where backendNodeId is meaningless.\n\n' +
      'No spatial validation is performed — the click goes directly to the specified coordinates. ' +
      'For DOM-based interactions, prefer atomic_interact with a backendNodeId instead.',
    inputSchema: {
      x: z.number().describe('X pixel coordinate'),
      y: z.number().describe('Y pixel coordinate'),
    },
  },
  async ({ x, y }) => {
    const { page, cdp } = requireSession();
    const result = await coordinateClick(page, cdp, x, y, requireTelemetry());
    return { content: [{ type: 'text', text: result.feedback }] };
  }
);

server.registerTool(
  'stream_screencast',
  {
    description:
      'NON-BLOCKING VISUAL CAPTURE. Returns the latest frame from the async CDP Page.startScreencast stream. ' +
      'Unlike browser_screenshot, this does NOT block the browser\'s main thread or force a synchronous render. ' +
      'The screencast runs continuously in the background at 60% JPEG quality.\n\n' +
      'USE CASES:\n' +
      '• Visual verification after an action without blocking the page\n' +
      '• Canvas/WebGL interfaces where AX tree is empty\n' +
      '• Monitoring animations or transitions\n\n' +
      'Returns the latest frame as a base64-encoded JPEG image.',
  },
  async () => {
    requireSession();
    if (!screencast) throw new Error('Screencast not initialized. Launch browser first.');

    const frame = screencast.getLatestFrame();
    if (!frame) {
      return { content: [{ type: 'text', text: 'No screencast frame available yet. The page may not have rendered.' }] };
    }

    return {
      content: [
        { type: 'image' as const, data: frame.data, mimeType: frame.mimeType },
      ],
    };
  }
);

server.registerTool(
  'browser_screenshot',
  {
    description:
      'Capture a screenshot of the current page. Returns a compressed JPEG image by default. ' +
      'For non-blocking visual capture, prefer stream_screencast instead.\n\n' +
      'Options:\n' +
      '• fullPage — Capture the entire scrollable page, not just the viewport.\n' +
      '• backendNodeId — Capture just a specific element by its backend node ID.\n' +
      '• savePath — Save the image to disk instead of returning inline.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('Capture only this element'),
      fullPage: z.boolean().optional().describe('Capture entire scrollable page (default: false)'),
      format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: jpeg)'),
      quality: z.number().optional().describe('JPEG quality 0-100 (default: 60)'),
      savePath: z.string().optional().describe('Absolute file path to save the image'),
    },
  },
  async (args) => {
    const { page, cdp } = requireSession();

    const format = args.format || 'jpeg';
    const quality = args.quality ?? 60;

    let buffer: string;

    if (args.backendNodeId !== undefined) {
      const { model } = await cdp.send('DOM.getBoxModel', {
        backendNodeId: args.backendNodeId,
      }) as { model: { content: number[] } };

      const q = model.content;
      const x = Math.min(q[0], q[2], q[4], q[6]);
      const y = Math.min(q[1], q[3], q[5], q[7]);
      const width = Math.max(q[0], q[2], q[4], q[6]) - x;
      const height = Math.max(q[1], q[3], q[5], q[7]) - y;

      const result = await cdp.send('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? quality : undefined,
        clip: { x, y, width, height, scale: 1 },
      });
      buffer = (result as { data: string }).data;
    } else {
      buffer = (await page.screenshot({
        encoding: 'base64',
        type: format,
        quality: format === 'jpeg' ? quality : undefined,
        fullPage: args.fullPage ?? false,
      })) as string;
    }

    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

    if (args.savePath) {
      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');
      await mkdir(join(args.savePath, '..'), { recursive: true }).catch(() => {});
      await writeFile(args.savePath, Buffer.from(buffer, 'base64'));
      return {
        content: [
          { type: 'text' as const, text: `Screenshot saved to ${args.savePath}` },
          { type: 'image' as const, data: buffer, mimeType },
        ],
      };
    }

    return {
      content: [{ type: 'image' as const, data: buffer, mimeType }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2: PERCEPTION & TELEMETRY
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'get_semantic_surface',
  {
    description:
      'THE PRIMARY PERCEPTION TOOL. Queries the browser\'s native Accessibility Object Model via CDP and returns a ' +
      'hyper-compressed hierarchical Markdown document — the Unified Semantic Accessibility Graph (USAG).\n\n' +
      'WHY THIS EXISTS:\n' +
      '• Raw HTML is 90% semantic noise (CSS classes, nested divs, tracking pixels). This tool strips all of it.\n' +
      '• The AX tree natively resolves closed shadow roots, computes accessible names, and pierces iframes.\n' +
      '• Each node includes a stable [id: NNN] tag (backendNodeId) that you MUST use with atomic_interact.\n\n' +
      'WORKFLOW:\n' +
      '1. Call get_semantic_surface to perceive the page.\n' +
      '2. Read the Markdown to understand the page structure, interactive elements, and their backendNodeIds.\n' +
      '3. Use atomic_interact with the backendNodeId to interact with specific elements.\n' +
      '4. Call get_state_delta to see what changed after your action.\n\n' +
      'SERIALIZATION: The AX tree → Markdown conversion runs on a dedicated worker thread to avoid blocking the JSON-RPC transport.\n\n' +
      'OPTIONS:\n' +
      '• semanticOnly=true — Aggressively prunes non-interactive structural nodes (wrapper divs). ' +
      'Use this for large pages where you only need interactive elements.',
    inputSchema: {
      semanticOnly: z.boolean().optional().describe('Prune non-interactive structural nodes to reduce output size (default: false)'),
    },
  },
  async ({ semanticOnly }) => {
    const { page, cdp } = requireSession();

    // Checkpoint for state delta tracking
    nodeIndex.checkpoint();

    const result = await getSemanticSurface(page, cdp, nodeIndex, { semanticOnly });
    return { content: [{ type: 'text', text: result.markdown }] };
  }
);

server.registerTool(
  'get_element_tree',
  {
    description:
      'Extract the semantic surface (accessibility tree) for a specific element and its descendants. ' +
      'Returns a Markdown-formatted hierarchical list of nodes containing interactive or text elements. ' +
      'Use this when you need context about a specific panel, modal, or component without fetching the entire page.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the root element to inspect'),
      semanticOnly: z.boolean().optional().describe('Filter out structural-only nodes (default: true)'),
    },
  },
  async ({ backendNodeId, semanticOnly }) => {
    const { cdp } = requireSession();
    const result = await getElementTree(cdp, nodeIndex, backendNodeId, { semanticOnly });
    return {
      content: [
        { type: 'text', text: result.text },
        ...(result.diagnostics ? [{ type: 'text' as const, text: `Diagnostics:\n- ${result.diagnostics.join('\n- ')}` }] : []),
      ],
    };
  }
);

server.registerTool(
  'get_session_summary',
  {
    description:
      'THE PRIMARY OBSERVABILITY ENTRY POINT. Returns a token-efficient JSON summary of all telemetry captured since the session started.\n\n' +
      'INCLUDES:\n' +
      '• Network stats: total requests, successes, failures, pending, slow requests\n' +
      '• Console stats: log/warning/error counts\n' +
      '• DOM mutation counts (structural vs attribute changes)\n' +
      '• Interaction counts (clicks, typing, key presses, scrolls)\n' +
      '• Cumulative Layout Shift (CLS) score\n' +
      '• Auto-generated alerts for: server errors (5xx), client errors (4xx), failed requests, uncaught JS exceptions, slow requests\n\n' +
      'PROGRESSIVE DISCLOSURE WORKFLOW:\n' +
      '1. Call get_session_summary — scan alerts for problems.\n' +
      '2. If alerts flag issues, call query_session_telemetry to drill down into the specific category.\n' +
      '3. Never dump all logs/network at once. Always start with the summary.',
  },
  async () => {
    const tel = requireTelemetry();
    const summary = tel.getSummary();
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
  }
);

server.registerTool(
  'query_session_telemetry',
  {
    description:
      'PROGRESSIVE DISCLOSURE DRILL-DOWN. If get_session_summary flags errors, use this tool to surgically extract ' +
      'the specific failing events without flooding your context window.\n\n' +
      'CATEGORIES:\n' +
      '• network — All request/response events. Filters: "failed" | "slow" | "api" | "status:NNN" | URL text search\n' +
      '• console — All console output. Filters: "errors" | "warnings" | text search\n' +
      '• mutations — DOM mutation events. Filters: "structural" | "attributes" | elementId\n' +
      '• interactions — Agent and human interactions. Filters: "clicks" | "typing" | "keys"\n' +
      '• navigation — Page navigation history (no filters)\n\n' +
      'EXAMPLES:\n' +
      '• query_session_telemetry({ category: "network", filter: "failed" }) — Get only failed network requests.\n' +
      '• query_session_telemetry({ category: "console", filter: "errors" }) — Get only console errors.\n' +
      '• query_session_telemetry({ category: "network", filter: "status:500" }) — Get only 500 errors.\n' +
      '• query_session_telemetry({ category: "network", filter: "api/users" }) — Search by URL substring.',
    inputSchema: {
      category: z.enum(['network', 'console', 'mutations', 'interactions', 'navigation']).describe('Telemetry category to drill into'),
      filter: z.string().optional().describe('Filter within the category (see description for valid filter values per category)'),
    },
  },
  async ({ category, filter }) => {
    const tel = requireTelemetry();
    const result = tel.drillDown(category, filter);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  'get_state_delta',
  {
    description:
      'DIFFERENTIAL STATE STREAMING. Computes the structural delta between the current page state and the state at the ' +
      'time of the last get_semantic_surface or atomic_interact call.\n\n' +
      'Returns ONLY what changed:\n' +
      '• added — New nodes that appeared\n' +
      '• removed — Nodes that disappeared\n' +
      '• modified — Nodes whose role, name, value, or properties changed\n\n' +
      'USE THIS TOOL after every action to instantly see:\n' +
      '• Did a modal appear? (added nodes with role="dialog")\n' +
      '• Did a loading spinner vanish? (removed nodes)\n' +
      '• Did a button label change? (modified name)\n' +
      '• Did a toast notification fire? (transient added then removed)\n\n' +
      'If delta is null, no structural changes occurred since the last checkpoint.',
  },
  async () => {
    const { page, cdp } = requireSession();
    const result = await getStateDelta(page, cdp, nodeIndex);
    return { content: [{ type: 'text', text: result.text }] };
  }
);

server.registerTool(
  'browser_get_computed_style',
  {
    description:
      'Get the computed CSS styles for a specific element. Use this to verify visual changes ' +
      'like colors, fonts, or dimensions that are not reflected in the accessibility tree.',
    inputSchema: {
      backendNodeId: z.number().describe('The backend DOM node ID of the target element'),
      properties: z.array(z.string()).optional().describe('Optional list of CSS properties to filter by (e.g., ["color", "font-size"])'),
    },
  },
  async ({ backendNodeId, properties }) => {
    const { cdp } = requireSession();
    
    // Ensure DOM and CSS domains are enabled
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    
    let nodeId: number;
    try {
      const result = await cdp.send('DOM.describeNode', { backendNodeId });
      nodeId = result.node.nodeId;
    } catch (err: any) {
      throw new Error(`Failed to resolve node for backendNodeId ${backendNodeId}: ${err.message}`);
    }
    
    const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
    
    let filteredStyles = computedStyle;
    if (properties && properties.length > 0) {
      filteredStyles = computedStyle.filter(p => properties.includes(p.name));
    }
    
    const styleObj = Object.fromEntries(filteredStyles.map(p => [p.name, p.value]));
    return { content: [{ type: 'text', text: JSON.stringify(styleObj, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// HUMAN RECORDING
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'start_human_recording',
  {
    description:
      'HUMAN DEVELOPER TAKEOVER. Pauses agent automation and opens a visible browser window for a human to interact with. ' +
      'The Black Box flight recorder continuously captures all physical clicks, console logs, network traffic, and DOM mutations.\n\n' +
      'WORKFLOW:\n' +
      '1. Call start_human_recording — browser window opens.\n' +
      '2. Human interacts with the page (reproduce a bug, navigate flows, etc.).\n' +
      '3. Call stop_human_recording — returns a synchronized, timestamped timeline of everything the human did.\n' +
      '4. Use this timeline to understand the human\'s successful workflow and replicate it programmatically.\n\n' +
      'NOTE: This closes any existing browser session and opens a new headful instance.',
    inputSchema: {
      url: z.string().optional().describe('URL to navigate to when the browser opens'),
    },
  },
  async ({ url }) => {
    const result = await humanRecording.start(url);
    telemetry = result.telemetry;
    return { content: [{ type: 'text', text: result.message }] };
  }
);

server.registerTool(
  'stop_human_recording',
  {
    description:
      'Stop the active human recording session. Closes the browser and returns a synchronized timeline of all captured events: ' +
      'physical clicks, keyboard inputs, network requests, console logs, and DOM mutations — all timestamped and aligned.\n\n' +
      'Use get_session_summary and query_session_telemetry to inspect the recording in detail.',
  },
  async () => {
    const result = await humanRecording.stop();
    telemetry = null;
    return { content: [{ type: 'text', text: JSON.stringify(result.summary, null, 2) }] };
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// UTILITY TOOLS (retained from v1, minimal changes)
// ═══════════════════════════════════════════════════════════════════════════

server.registerTool(
  'browser_query_selector',
  {
    description:
      'Query the DOM using a CSS selector or XPath and return matching elements with their backendNodeIds, text, and bounding boxes. ' +
      'Automatically searches across all frames (pierces iframes).\n\n' +
      'PREFER get_semantic_surface for page understanding. Use this tool only when you need to find elements by a specific CSS selector ' +
      'that the AX tree doesn\'t surface (e.g., elements with specific data-* attributes).\n\n' +
      'Returns backendNodeIds that can be used directly with atomic_interact.',
    inputSchema: {
      selector: z.string().describe('CSS selector or XPath (prefix with "xpath/") to query'),
      visibleOnly: z.boolean().optional().describe('Only return visible elements (default: false)'),
      timeoutMs: z.number().optional().describe('Wait this many ms for the element to appear (default: 0 = instant check)'),
    },
  },
  async ({ selector, visibleOnly, timeoutMs = 0 }) => {
    const { cdp } = requireSession();

    const isXPath = selector.startsWith('xpath/');

    const matches: { tag: string; text: string; backendNodeId: number; boundingBox: { x: number; y: number; width: number; height: number } | null }[] = [];
    const errors: string[] = [];

    const startTime = Date.now();
    const deadline = startTime + (timeoutMs || 0);

    do {
      try {
        // Use pure CDP for robust cross-version compatibility.
        // DOM.querySelectorAll returns nodeIds, DOM.describeNode gives us backendNodeIds.
        const { root } = await cdp.send('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };

        let nodeIds: number[] = [];
        if (isXPath) {
          // XPath via CDP
          const xpathExpr = selector.slice('xpath/'.length);
          const { searchId, resultCount } = await cdp.send('DOM.performSearch', { query: xpathExpr }) as { searchId: string; resultCount: number };
          if (resultCount > 0) {
            const { nodeIds: found } = await cdp.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: resultCount }) as { nodeIds: number[] };
            nodeIds = found;
          }
          await cdp.send('DOM.discardSearchResults', { searchId }).catch(() => {});
        } else {
          // CSS selector via CDP
          const { nodeIds: found } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector }) as { nodeIds: number[] };
          nodeIds = found;
        }

        for (const nodeId of nodeIds) {
          try {
            // Get backendNodeId and tag name from CDP
            const { node } = await cdp.send('DOM.describeNode', { nodeId }) as {
              node: { backendNodeId: number; nodeName: string; nodeType: number };
            };

            // Get bounding box via getBoxModel (may fail for invisible elements)
            let boundingBox: { x: number; y: number; width: number; height: number } | null = null;
            try {
              const { model } = await cdp.send('DOM.getBoxModel', { nodeId }) as {
                model: { content: number[] };
              };
              // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
              const q = model.content;
              boundingBox = {
                x: Math.min(q[0], q[2], q[4], q[6]),
                y: Math.min(q[1], q[3], q[5], q[7]),
                width: Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
                height: Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]),
              };
            } catch {
              // Element may be invisible — no box model
              if (visibleOnly) continue;
            }

            if (visibleOnly && (!boundingBox || boundingBox.width === 0 || boundingBox.height === 0)) continue;

            // Get text content via Runtime
            let text = '';
            try {
              const { object } = await cdp.send('DOM.resolveNode', { nodeId }) as { object: { objectId?: string } };
              if (object?.objectId) {
                const evalResult = await cdp.send('Runtime.callFunctionOn', {
                  objectId: object.objectId,
                  functionDeclaration: `function() { return (this.innerText || this.textContent || '').substring(0, 200).trim(); }`,
                  returnByValue: true,
                }) as { result: { value: unknown } };
                text = String(evalResult.result.value || '');
                await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
              }
            } catch { /* text extraction failed — non-fatal */ }

            matches.push({
              tag: node.nodeName.toLowerCase(),
              text,
              backendNodeId: node.backendNodeId,
              boundingBox,
            });
          } catch (err) {
            errors.push(`Node ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        errors.push(`Query error: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (matches.length > 0 || !timeoutMs || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 200));
    } while (Date.now() < deadline);

    // Include errors in the response if no matches found, so agents can diagnose
    const response: Record<string, unknown> = { matches };
    if (matches.length === 0 && errors.length > 0) {
      response.diagnostics = errors;
    }

    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  }
);

server.registerTool(
  'browser_find_text_coordinates',
  {
    description:
      'Find elements matching a fuzzy text string and return their bounding boxes and text content. ' +
      'This is a crucial fallback when the AX tree is broken or an element lacks semantic meaning. ' +
      'Automatically searches across all frames and penetrates shadow DOMs using the Puppeteer ::-p-text() engine.\n\n' +
      'You can use the returned coordinates with validate_spatial_coordinate or coordinate_click.',
    inputSchema: {
      text: z.string().describe('The text to search for (case-insensitive fuzzy match)'),
      visibleOnly: z.boolean().optional().describe('Only return visible elements (default: true)'),
      timeoutMs: z.number().optional().describe('Wait this many ms for the text to appear (default: 0 = instant check)'),
    },
  },
  async ({ text, visibleOnly = true, timeoutMs = 0 }) => {
    const { page } = requireSession();

    const matches: { text: string; boundingBox: { x: number; y: number; width: number; height: number } }[] = [];
    const errors: string[] = [];

    const startTime = Date.now();
    const deadline = startTime + (timeoutMs || 0);
    const searchText = text.toLowerCase();

    do {
      for (const frame of page.frames()) {
        try {
          const frameMatches = await frame.evaluate((searchStr, reqVisible) => {
            const results: Element[] = [];
            
            function walk(node: Node) {
              if (node.nodeType === 1) { // Element
                const el = node as Element;
                if (reqVisible) {
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden') return;
                }
                if (el.shadowRoot) walk(el.shadowRoot);
                for (let i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
              } else if (node.nodeType === 3) { // Text
                if (node.textContent && node.textContent.toLowerCase().includes(searchStr)) {
                  if (node.parentElement && !results.includes(node.parentElement)) {
                    results.push(node.parentElement);
                  }
                }
              }
            }
            
            walk(document.body || document.documentElement);
            
            return results.map(el => {
              const rect = el.getBoundingClientRect();
              return {
                text: ((el as HTMLElement).innerText || el.textContent || '').substring(0, 200).trim(),
                visible: rect.width > 0 && rect.height > 0,
                boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              };
            });
          }, searchText, visibleOnly);

          for (const m of frameMatches) {
            if (visibleOnly && !m.visible) continue;
            matches.push({
              text: m.text,
              boundingBox: m.boundingBox,
            });
          }
        } catch (err) {
          errors.push(`Frame ${frame.url()}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (matches.length > 0 || !timeoutMs || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 200));
    } while (Date.now() < deadline);

    const response: Record<string, unknown> = { matches };
    if (matches.length === 0 && errors.length > 0) {
      response.diagnostics = errors;
    }

    return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
  }
);

server.registerTool(
  'browser_assert_element',
  {
    description:
      'Assert the state of a specific element without pulling the full semantic surface. ' +
      'Returns: visible (boolean), disabled (boolean), text content, checked state (for checkboxes/radios), and backendNodeId.\n\n' +
      'Use this for quick state checks on known elements after an action, rather than re-fetching the entire page.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('Backend DOM node ID of the element'),
      selector: z.string().optional().describe('CSS selector to find the element'),
    },
  },
  async ({ backendNodeId, selector }) => {
    const { page, cdp } = requireSession();

    let targetEl;
    let resolvedBackendNodeId = backendNodeId;

    if (backendNodeId) {
      const frame = page.mainFrame() as unknown as {
        mainRealm(): { adoptBackendNode(id: number): Promise<import('puppeteer-core').ElementHandle<Element>> };
      };
      targetEl = await frame.mainRealm().adoptBackendNode(backendNodeId).catch(() => null);
    } else if (selector) {
      for (const frame of page.frames()) {
        targetEl = await frame.$(selector);
        if (targetEl) break;
      }
    } else {
      throw new Error('Must provide either backendNodeId or selector.');
    }

    if (!targetEl) throw new Error('Element not found.');

    // Resolve backendNodeId if not provided
    if (!resolvedBackendNodeId) {
      const remoteObject = (targetEl as any).remoteObject?.() || (targetEl as any)._remoteObject;
      if (remoteObject?.objectId) {
        try {
          const { node } = await cdp.send('DOM.describeNode', { objectId: remoteObject.objectId });
          resolvedBackendNodeId = node.backendNodeId;
        } catch { /* best effort */ }
      }
    }

    const result = await targetEl.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      const disabled = (htmlEl as any).disabled === true || el.getAttribute('aria-disabled') === 'true';
      const text = htmlEl.innerText || el.textContent || '';
      const isCheckbox = el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.getAttribute('type') || '');
      const checked = isCheckbox ? (htmlEl as HTMLInputElement).checked : undefined;
      return { visible, disabled, text: text.trim(), checked };
    });

    await targetEl.dispose().catch(() => {});

    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, backendNodeId: resolvedBackendNodeId }, null, 2) }],
    };
  }
);

server.registerTool(
  'browser_manage_storage',
  {
    description:
      'Get, set, or clear browser storage (localStorage, sessionStorage, or cookies). ' +
      'Useful for testing auth flows, clearing state between test runs, or inspecting cached data.',
    inputSchema: {
      action: z.enum(['get', 'set', 'clear']).describe('Storage action'),
      type: z.enum(['localStorage', 'sessionStorage', 'cookies']).describe('Storage type'),
      key: z.string().optional().describe('Key (required for set)'),
      value: z.string().optional().describe('Value (required for set)'),
      domain: z.string().optional().describe('Cookie domain (default: current page domain)'),
    },
  },
  async ({ action, type, key, value, domain }) => {
    const { page } = requireSession();

    if (type === 'cookies') {
      if (action === 'get') {
        const cookies = await page.cookies();
        return { content: [{ type: 'text', text: JSON.stringify(cookies, null, 2) }] };
      }
      if (action === 'clear') {
        const cookies = await page.cookies();
        await page.deleteCookie(...cookies);
        return { content: [{ type: 'text', text: 'Cookies cleared.' }] };
      }
      if (action === 'set' && key && value) {
        await page.setCookie({ name: key, value, domain: domain || 'localhost' });
        return { content: [{ type: 'text', text: `Cookie "${key}" set.` }] };
      }
    } else {
      const storageObj = type;
      const result = await page.evaluate((act, store, k, v) => {
        const s = window[store as 'localStorage' | 'sessionStorage'];
        if (act === 'clear') { s.clear(); return `${store} cleared.`; }
        if (act === 'get') return JSON.stringify(Object.fromEntries(Object.entries(s)));
        if (act === 'set' && k && v) { s.setItem(k, v); return `${store}["${k}"] set.`; }
        return 'Invalid operation.';
      }, action, storageObj, key, value);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
    }

    return { content: [{ type: 'text', text: 'Invalid storage operation.' }] };
  }
);

server.registerTool(
  'browser_set_offline',
  {
    description:
      'Toggle browser network between online and offline mode. Use for testing PWA offline behavior, ' +
      'Service Worker fallbacks, and error handling for network failures.',
    inputSchema: {
      offline: z.boolean().describe('true = go offline, false = restore connectivity'),
    },
  },
  async ({ offline }) => {
    const { cdp } = requireSession();
    await cdp.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    return {
      content: [{ type: 'text', text: offline ? 'Network set to offline mode.' : 'Network restored to online mode.' }],
    };
  }
);

server.registerTool(
  'browser_throttle_network',
  {
    description:
      'Emulate slow network conditions by throttling bandwidth and adding latency. ' +
      'Useful for testing loading states, skeleton screens, and timeout handling.',
    inputSchema: {
      latencyMs: z.number().describe('Latency delay in milliseconds'),
      downloadKbps: z.number().describe('Max download bandwidth in Kbps (0 = no limit)'),
      uploadKbps: z.number().describe('Max upload bandwidth in Kbps (0 = no limit)'),
    },
  },
  async ({ latencyMs, downloadKbps, uploadKbps }) => {
    const { cdp } = requireSession();
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: latencyMs,
      downloadThroughput: downloadKbps > 0 ? downloadKbps * 125 : -1,
      uploadThroughput: uploadKbps > 0 ? uploadKbps * 125 : -1,
    });
    return {
      content: [{ type: 'text', text: `Network throttled: ${latencyMs}ms latency, ${downloadKbps}Kbps down, ${uploadKbps}Kbps up.` }],
    };
  }
);

server.registerTool(
  'browser_intercept_request',
  {
    description:
      'Intercept matching network requests to inject delays or force failures. ' +
      'Uses CDP Fetch domain for precise request-level control.',
    inputSchema: {
      pattern: z.string().describe('URL glob pattern to match (e.g., "*api*", "*graphql*")'),
      action: z.enum(['delay', 'fail']).describe('"delay" = add latency, "fail" = reject the request'),
      delayMs: z.number().optional().describe('Delay in ms (required for action="delay")'),
    },
  },
  async ({ pattern, action, delayMs }) => {
    const { cdp } = requireSession();

    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: pattern }] });

    cdp.on('Fetch.requestPaused', async (event: { requestId: string }) => {
      if (action === 'fail') {
        await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {});
      } else if (action === 'delay' && delayMs) {
        setTimeout(async () => {
          await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        }, delayMs);
      } else {
        await cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
      }
    });

    return { content: [{ type: 'text', text: `Interception enabled: ${pattern} → ${action}${delayMs ? ` (${delayMs}ms)` : ''}` }] };
  }
);

server.registerTool(
  'browser_disable_interception',
  {
    description: 'Disable all active network request interception rules.',
  },
  async () => {
    const { cdp } = requireSession();
    await cdp.send('Fetch.disable');
    return { content: [{ type: 'text', text: 'Request interception disabled.' }] };
  }
);

server.registerTool(
  'browser_mock_date_and_time',
  {
    description:
      'Mock, freeze, or shift browser time for deterministic testing. Overrides Date, Date.now(), and performance.now(). ' +
      'Persists across page navigations.',
    inputSchema: {
      mode: z.enum(['freeze', 'travel', 'reset']).describe('"freeze" = stop time, "travel" = offset time, "reset" = restore native time'),
      isoDate: z.string().optional().describe('ISO 8601 date for freeze mode (e.g., "2025-01-01T00:00:00Z")'),
      deltaMs: z.number().optional().describe('Millisecond offset for travel mode'),
    },
  },
  async ({ mode, isoDate, deltaMs }) => {
    const { page } = requireSession();

    if (mode === 'reset') {
      await page.evaluate(`(() => {
        if (window.__mcp_original_Date) {
          window.Date = window.__mcp_original_Date;
          delete window.__mcp_original_Date;
        }
        if (window.__mcp_original_performance_now) {
          performance.now = window.__mcp_original_performance_now;
          delete window.__mcp_original_performance_now;
        }
      })()`);
      return { content: [{ type: 'text', text: 'Time mocking reset.' }] };
    }

    const script = mode === 'freeze'
      ? `(() => {
          if (!window.__mcp_original_Date) window.__mcp_original_Date = window.Date;
          if (!window.__mcp_original_performance_now) window.__mcp_original_performance_now = performance.now.bind(performance);
          const frozenTime = ${isoDate ? `new window.__mcp_original_Date('${isoDate}').getTime()` : 'window.__mcp_original_Date.now()'};
          const frozenPerf = window.__mcp_original_performance_now();
          const O = window.__mcp_original_Date;
          function M(...a) { return a.length === 0 ? new O(frozenTime) : new O(...a); }
          M.prototype = O.prototype; M.now = () => frozenTime; M.parse = O.parse; M.UTC = O.UTC;
          window.Date = M; performance.now = () => frozenPerf;
        })()`
      : `(() => {
          if (!window.__mcp_original_Date) window.__mcp_original_Date = window.Date;
          if (!window.__mcp_original_performance_now) window.__mcp_original_performance_now = performance.now.bind(performance);
          const d = ${deltaMs || 0}; const O = window.__mcp_original_Date;
          function M(...a) { return a.length === 0 ? new O(O.now() + d) : new O(...a); }
          M.prototype = O.prototype; M.now = () => O.now() + d; M.parse = O.parse; M.UTC = O.UTC;
          window.Date = M; const p = window.__mcp_original_performance_now; performance.now = () => p() + d;
        })()`;

    await page.evaluate(script);
    await page.evaluateOnNewDocument(script);

    return {
      content: [{ type: 'text', text: mode === 'freeze' ? `Time frozen at ${isoDate || 'current time'}.` : `Time shifted by ${deltaMs}ms.` }],
    };
  }
);

server.registerTool(
  'browser_simulate_tab_flow',
  {
    description:
      'Simulate pressing Tab through the page to audit keyboard accessibility. ' +
      'Reports the focus traversal order with element details and backendNodeIds, and flags potential focus traps.',
    inputSchema: {
      maxSteps: z.number().optional().describe('Maximum Tab presses to simulate (default: 20)'),
    },
  },
  async ({ maxSteps = 20 }) => {
    const { page, cdp } = requireSession();

    const focusFlow: { step: number; tag: string; role: string; name: string; backendNodeId: number }[] = [];
    const focusTraps: string[] = [];
    const seen = new Map<string, number>();

    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur?.();
      document.body.focus();
    });

    for (let step = 1; step <= maxSteps; step++) {
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 50));

      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { tag: 'body', role: '', name: '', fingerprint: 'body' };
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).innerText?.substring(0, 50)?.trim() || '',
          fingerprint: `${el.tagName}#${el.id}.${el.className}`,
        };
      });

      let backendNodeId = 0;
      try {
        const handle = await page.evaluateHandle(() => document.activeElement);
        const remoteObject = (handle as any).remoteObject?.() || (handle as any)._remoteObject;
        if (remoteObject?.objectId) {
          const { node } = await cdp.send('DOM.describeNode', { objectId: remoteObject.objectId });
          backendNodeId = node.backendNodeId;
        }
        await handle.dispose().catch(() => {});
      } catch { /* continue */ }

      focusFlow.push({ step, tag: info.tag, role: info.role, name: info.name, backendNodeId });

      if (seen.has(info.fingerprint)) {
        const firstStep = seen.get(info.fingerprint)!;
        if (step - firstStep < maxSteps - 1) {
          focusTraps.push(`Focus trap: <${info.tag}> at step ${step} was at step ${firstStep} (cycle: ${step - firstStep})`);
        }
        break;
      }
      seen.set(info.fingerprint, step);
      if (info.tag === 'body') break;
    }

    return { content: [{ type: 'text', text: JSON.stringify({ focusFlow, focusTraps, totalSteps: focusFlow.length }, null, 2) }] };
  }
);

server.registerTool(
  'browser_get_element_at_point',
  {
    description:
      'Get the topmost element at specific X/Y coordinates. Returns tag, text, and backendNodeId. ' +
      'Automatically traverses into iframes.',
    inputSchema: {
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    },
  },
  async ({ x, y }) => {
    const { cdp } = requireSession();

    try {
      const nodeResult = await cdp.send('DOM.getNodeForLocation', {
        x: Math.round(x),
        y: Math.round(y),
        includeUserAgentShadowDOM: false,
      }) as { backendNodeId: number; frameId?: string; nodeId?: number };

      const { object } = await cdp.send('DOM.resolveNode', {
        backendNodeId: nodeResult.backendNodeId,
      }) as { object: { objectId?: string } };

      let details: any = { backendNodeId: nodeResult.backendNodeId };

      if (object?.objectId) {
        const result = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function() {
            return {
              tag: this.tagName?.toLowerCase() || 'unknown',
              text: (this.innerText || this.textContent || '').substring(0, 200).trim(),
              id: this.id || undefined,
              className: this.className || undefined,
            };
          }`,
          returnByValue: true,
        }) as { result: { value: unknown } };
        details = { ...details, ...(result.result.value as object) };
        await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      }

      return { content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `No element found at (${x}, ${y}): ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }
);

server.registerTool(
  'browser_get_listeners',
  {
    description:
      'Get all active JavaScript event listeners attached to an element. ' +
      'Useful for understanding interactive behavior before dispatching events.',
    inputSchema: {
      backendNodeId: z.number().describe('Backend DOM node ID of the element'),
    },
  },
  async ({ backendNodeId }) => {
    const { cdp } = requireSession();

    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId?: string } };
    if (!object?.objectId) throw new Error(`Cannot resolve node ${backendNodeId}`);

    try {
      const response = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId });
      return { content: [{ type: 'text', text: JSON.stringify(response.listeners, null, 2) }] };
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }
);

server.registerTool(
  'browser_get_performance_metrics',
  {
    description: 'Get Chromium internal performance and rendering metrics (Nodes, JSHeapUsedSize, LayoutCount, etc.).',
  },
  async () => {
    const { cdp } = requireSession();
    const response = await cdp.send('Performance.getMetrics');
    return { content: [{ type: 'text', text: JSON.stringify(response.metrics, null, 2) }] };
  }
);

server.registerTool(
  'browser_get_outer_html',
  {
    description:
      'DEBUG FALLBACK. Get the raw outerHTML of a DOM element by backendNodeId, or the entire document root if no ID is specified. ' +
      'Use this when get_semantic_surface returns an empty tree — it helps diagnose whether the page actually rendered.\\n\\n' +
      'WARNING: Raw HTML is token-expensive. Always prefer get_semantic_surface for page understanding. ' +
      'Use this tool ONLY for debugging perception failures.\\n\\n' +
      'The output is truncated to maxLength characters (default: 5000) to protect your context window.',
    inputSchema: {
      backendNodeId: z.number().optional().describe('Backend node ID of the element. Omit to get document.documentElement.outerHTML.'),
      maxLength: z.number().optional().describe('Truncate HTML output to this many characters (default: 5000). Set higher for full inspection.'),
    },
  },
  async ({ backendNodeId, maxLength = 5000 }) => {
    const { page, cdp } = requireSession();

    let html: string;

    if (backendNodeId !== undefined) {
      // Get outerHTML of a specific node via CDP
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }) as { object: { objectId?: string } };
      if (!object?.objectId) throw new Error(`Cannot resolve node ${backendNodeId}. It may have been destroyed by a re-render.`);

      try {
        const result = await cdp.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function() { return this.outerHTML; }`,
          returnByValue: true,
        }) as { result: { value: unknown } };
        html = String(result.result.value || '');
      } finally {
        await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      }
    } else {
      // Get the entire document root
      html = await page.evaluate(() => document.documentElement.outerHTML) as string;
    }

    const truncated = html.length > maxLength;
    const output = truncated ? html.substring(0, maxLength) : html;

    return {
      content: [{
        type: 'text',
        text: truncated
          ? `${output}\n\n--- TRUNCATED (${html.length} chars total, showing first ${maxLength}). Increase maxLength to see more. ---`
          : output,
      }],
    };
  }
);

// ─── Server Boot ────────────────────────────────────────────────────────────

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Best Browser MCP v2.0 running on stdio');
}

run().catch((error) => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
