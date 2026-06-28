import puppeteer, { Browser, Page, CDPSession, ElementHandle } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Worker } from 'worker_threads';
import { formatAccessibilityTree, AXNode } from './usag.js';

// ─── Recording Types ────────────────────────────────────────────────────────

interface RecordingFrame {
  data: string; // base64 JPEG
  timestamp: number;
}

interface RecordingState {
  frames: RecordingFrame[];
  startedAt: number;
  autoStopTimer: ReturnType<typeof setTimeout>;
  outputDir: string;
}

const MAX_RECORDING_DURATION_MS = 300_000; // 5 minute safety limit

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const MUTATION_INJECT_SCRIPT = `
(function() {
  if (window.__mcp_observer_initialized) return;
  window.__mcp_observer_initialized = true;
  window.__mcp_id_seq = 1;
  window.__mcp_mutations = [];
  window.__mcp_cls = 0;

  // Setup layout shift observer for CLS tracking
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__mcp_cls += entry.value;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}
  }

  function getOrAssignId(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    let id = node.getAttribute('data-mcp-id');
    if (!id) {
      id = String(window.__mcp_id_seq++);
      node.setAttribute('data-mcp-id', id);
    }
    return parseInt(id, 10);
  }

  function attachInputListener(el) {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      if (el.__mcp_input_listener_attached) return;
      el.__mcp_input_listener_attached = true;
      el.addEventListener('input', () => {
        const id = getOrAssignId(el);
        window.__mcp_mutations.push({
          type: 'input',
          targetId: id,
          value: el.value,
          timestamp: Date.now()
        });
      });
    }
  }

  function assignIdsRecursively(root) {
    getOrAssignId(root);
    attachInputListener(root);
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of elements) {
      getOrAssignId(el);
      attachInputListener(el);
    }
  }

  // Run initial pass on document load
  if (document.documentElement) {
    assignIdsRecursively(document.documentElement);
  }

  // Also run on DOMContentLoaded just in case it executes early
  document.addEventListener('DOMContentLoaded', () => {
    if (document.documentElement) {
      assignIdsRecursively(document.documentElement);
    }
  });

  // Setup Observer for live tracking
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const payload = {
        type: mutation.type,
        timestamp: Date.now(),
      };

      if (mutation.type === 'childList') {
        const added = [];
        for (const n of mutation.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            assignIdsRecursively(n);
            const id = getOrAssignId(n);
            const descendants = [];
            const childElements = n.querySelectorAll('*');
            for (const c of childElements) {
              descendants.push({
                id: getOrAssignId(c),
                tagName: c.tagName.toLowerCase(),
                parentId: getOrAssignId(c.parentElement)
              });
            }
            added.push({
              id,
              tagName: n.tagName.toLowerCase(),
              parentId: getOrAssignId(mutation.target),
              descendants
            });
          }
        }

        const removed = [];
        for (const n of mutation.removedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE) {
            const id = getOrAssignId(n);
            removed.push({
              id,
              tagName: n.tagName.toLowerCase()
            });
          }
        }

        if (added.length === 0 && removed.length === 0) continue;
        payload.addedNodes = added;
        payload.removedNodes = removed;

      } else if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'data-mcp-id') continue;
        const id = getOrAssignId(mutation.target);
        if (id === null) continue;
        payload.targetId = id;
        payload.attributeName = mutation.attributeName;
        payload.attributeValue = mutation.target.getAttribute(mutation.attributeName);

      } else if (mutation.type === 'characterData') {
        const parentId = getOrAssignId(mutation.target.parentElement);
        if (parentId === null) continue;
        payload.parentId = parentId;
        payload.newValue = mutation.target.nodeValue;
      }

      window.__mcp_mutations.push(payload);
    }
  });

  observer.observe(document, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
  });
})();
`;

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private worker: Worker | null = null;
  private screencastActive = false;
  private fetchInterceptHandler: ((...args: unknown[]) => void) | null = null;
  private activeRecording: RecordingState | null = null;
  private recordingFrameHandler: ((...args: unknown[]) => void) | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker() {
    let workerPath = join(__dirname, 'dvrWorker.js');
    if (!existsSync(workerPath)) {
      workerPath = join(__dirname, 'dvrWorker.ts');
    }

    this.worker = new Worker(workerPath, {
      execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [],
    });

    this.worker.on('error', (err) => {
      console.error('DVR Worker encountered an error:', err);
    });
  }

  private findChromeExecutable(): string {
    for (const path of CHROME_PATHS) {
      if (existsSync(path)) {
        return path;
      }
    }
    throw new Error('Google Chrome or Chromium executable not found on Mac. Please install Chrome.');
  }

  public async launch(options: { headless?: boolean; userDataDir?: string } = {}): Promise<string> {
    if (this.browser) {
      return 'Browser is already running.';
    }

    const executablePath = this.findChromeExecutable();
    const headless = options.headless !== false; // default headless to true

    const launchArgs: string[] = ['--no-sandbox', '--disable-setuid-sandbox'];
    
    this.browser = await puppeteer.launch({
      executablePath,
      headless: headless ? 'shell' : false,
      args: launchArgs,
      userDataDir: options.userDataDir,
      defaultViewport: { width: 1280, height: 720 },
    });

    this.page = await this.browser.newPage();
    await this.setupPageSession(this.page);

    return `Browser launched successfully (headless: ${headless}).`;
  }

  public async close(): Promise<string> {
    // Auto-finalize any active recording before closing
    if (this.activeRecording) {
      try { await this.stopRecording(); } catch { /* best effort */ }
    }
    if (this.worker) {
      this.worker.postMessage({ type: 'clear' });
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      this.screencastActive = false;
      return 'Browser closed.';
    }
    return 'No active browser session.';
  }

  private async setupPageSession(page: Page) {
    this.cdpSession = await page.createCDPSession();

    // Enable CDP domains
    await this.cdpSession.send('Accessibility.enable');
    await this.cdpSession.send('DOM.enable');

    // Inject object permanence mutation observer
    await page.evaluateOnNewDocument(MUTATION_INJECT_SCRIPT);
    
    // Evaluate it directly too on the current initial page loading blank target
    await page.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});

    // Hook telemetry listeners
    page.on('console', (msg) => {
      this.worker?.postMessage({
        type: 'console',
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    page.on('request', (req) => {
      this.worker?.postMessage({
        type: 'network',
        method: req.method(),
        url: req.url(),
        status: undefined,
        timestamp: Date.now(),
      });
    });

    page.on('response', (res) => {
      this.worker?.postMessage({
        type: 'network',
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        timestamp: Date.now(),
      });
    });

    // Start screencast recording
    await this.startScreencast();
  }

  private async startScreencast() {
    if (!this.cdpSession || this.screencastActive) return;

    try {
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        maxWidth: 1024,
        maxHeight: 576,
        everyNthFrame: 1,
      });

      this.screencastActive = true;

      this.cdpSession.on('Page.screencastFrame', (event) => {
        this.worker?.postMessage({
          type: 'frame',
          data: event.data,
          timestamp: Date.now(),
        });

        this.cdpSession?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      });
    } catch (err) {
      console.error('Failed to start screencast:', err);
    }
  }

  public async navigate(url: string): Promise<string> {
    if (!this.page) {
      await this.launch();
    }
    await this.page!.goto(url, { waitUntil: 'load' });
    // Re-inject mutation observer manually just in case
    await this.page!.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
    return `Navigated to ${url}`;
  }

  public async getAccessibilityTree(): Promise<string> {
    if (!this.cdpSession) {
      throw new Error('No active CDP session. Launch browser first.');
    }
    const result = await this.cdpSession.send('Accessibility.getFullAXTree');
    return formatAccessibilityTree(result.nodes as AXNode[]);
  }

  public async getMutations(): Promise<unknown[]> {
    if (!this.page) return [];
    return await this.page.evaluate(() => {
      const win = window as unknown as { __mcp_mutations?: unknown[] };
      const result = win.__mcp_mutations || [];
      win.__mcp_mutations = [];
      return result;
    });
  }

  /**
   * Mathematically validates if an element is occluded before interaction.
   * Returns validation coordinates or throws error detailing occlusion reasons.
   */
  private async validateSpatialGuard(backendNodeId: number): Promise<{ x: number; y: number }> {
    if (!this.page) {
      throw new Error('No active page session.');
    }

    let elementHandle;
    try {
      const frame = this.page.mainFrame() as unknown as {
        mainRealm(): {
          adoptBackendNode(id: number): Promise<ElementHandle<Element>>;
        };
      };
      elementHandle = await frame.mainRealm().adoptBackendNode(backendNodeId);
    } catch (err) {
      throw new Error(`Failed to resolve backend node ID ${backendNodeId}: ${err}`);
    }

    if (!elementHandle) {
      throw new Error(`Could not adopt backend node ID ${backendNodeId}`);
    }

    try {
      const checkResult = (await this.page.evaluate((el: Element) => {
        if (!(el instanceof Element)) {
          return { error: 'Node is not a DOM Element' };
        }
        
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return { error: 'Element is invisible (zero width or height)' };
        }

        // Calculate center coordinate
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        // Perform raycast check at coordinates
        const topEl = document.elementFromPoint(x, y);
        if (!topEl) {
          return { error: `No element found at center coordinates (${x}, ${y})` };
        }

        // Check if the top element is the target element or its child/parent
        const contains = el.contains(topEl) || topEl.contains(el);
        if (!contains) {
          const occluderInfo = `${topEl.tagName.toLowerCase()}${topEl.id ? '#' + topEl.id : ''}${topEl.className ? '.' + topEl.className.trim().split(/\s+/).join('.') : ''}`;
          return {
            occluded: true,
            occluder: occluderInfo,
            coordinates: { x, y }
          };
        }

        return {
          occluded: false,
          coordinates: { x, y }
        };
      }, elementHandle)) as {
        error?: string;
        occluded?: boolean;
        occluder?: string;
        coordinates?: { x: number; y: number };
      };

      if (checkResult.error) {
        throw new Error(checkResult.error);
      }

      if (checkResult.occluded) {
        throw new Error(`Pre-Execution Spatial Validation Failed: Element ID ${backendNodeId} is occluded by '<${checkResult.occluder}>' at coordinates (${checkResult.coordinates?.x}, ${checkResult.coordinates?.y}).`);
      }

      // Return absolute viewport coordinates (adding frame offsets if any, though standard is viewport layout)
      return checkResult.coordinates!;
    } finally {
      // Dispose of the element handle to avoid leaks
      await elementHandle.dispose().catch(() => {});
    }
  }

  public async click(backendNodeId: number): Promise<string> {
    if (!this.page) throw new Error('No active page session.');
    const coords = await this.validateSpatialGuard(backendNodeId);
    await this.page.mouse.click(coords.x, coords.y);
    return `Successfully clicked element ID ${backendNodeId} at coordinates (${coords.x}, ${coords.y})`;
  }

  public async type(backendNodeId: number, text: string): Promise<string> {
    if (!this.page) throw new Error('No active page session.');
    const coords = await this.validateSpatialGuard(backendNodeId);
    await this.page.mouse.click(coords.x, coords.y);
    // Double click to focus / clear
    await this.page.mouse.click(coords.x, coords.y, { count: 2 });
    await this.page.keyboard.type(text);
    return `Successfully typed text into element ID ${backendNodeId}`;
  }

  public async hover(backendNodeId: number): Promise<string> {
    if (!this.page) throw new Error('No active page session.');
    const coords = await this.validateSpatialGuard(backendNodeId);
    await this.page.mouse.move(coords.x, coords.y);
    return `Successfully hovered over element ID ${backendNodeId} at coordinates (${coords.x}, ${coords.y})`;
  }

  public async dumpDvr(outputPath: string): Promise<{ success: boolean; frameCount: number; logCount: number; outputPath: string }> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('DVR worker thread is not initialized.'));
        return;
      }

      const handler = (msg: {
        type: string;
        success?: boolean;
        frameCount?: number;
        logCount?: number;
        outputPath?: string;
        error?: string;
      }) => {
        if (msg.type === 'dump_complete') {
          this.worker?.off('message', handler);
          if (msg.success) {
            resolve({
              success: true,
              frameCount: msg.frameCount || 0,
              logCount: msg.logCount || 0,
              outputPath: msg.outputPath || outputPath,
            });
          } else {
            reject(new Error(msg.error || 'Unknown DVR dump error'));
          }
        }
      };

      this.worker.on('message', handler);
      this.worker.postMessage({ type: 'dump', outputPath });
    });
  }

  public async runHandoff(userDataDir?: string): Promise<string> {
    if (this.browser) {
      await this.close();
    }

    const profileDir = userDataDir || join(process.cwd(), '.chrome-profile');
    const executablePath = this.findChromeExecutable();

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userDataDir: profileDir,
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());
    await this.setupPageSession(this.page);

    return new Promise<string>((resolve) => {
      this.browser!.once('disconnected', () => {
        this.browser = null;
        this.page = null;
        this.cdpSession = null;
        this.screencastActive = false;
        resolve(`Headful handoff session closed. Local profile saved to ${profileDir}`);
      });
    });
  }

  public async getEventListeners(backendNodeId: number): Promise<unknown[]> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

    await this.cdpSession.send('DOM.enable');
    const { object } = (await this.cdpSession.send('DOM.resolveNode', {
      backendNodeId,
    })) as { object: { objectId?: string } };

    if (!object || !object.objectId) {
      throw new Error(`Failed to resolve backend node ID ${backendNodeId} to an object ID`);
    }

    try {
      const response = await this.cdpSession.send('DOMDebugger.getEventListeners', {
        objectId: object.objectId,
      });
      return response.listeners;
    } finally {
      await this.cdpSession
        .send('Runtime.releaseObject', { objectId: object.objectId })
        .catch(() => {});
    }
  }

  public async togglePaintFlash(enabled: boolean): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');
    const session = this.cdpSession as unknown as {
      send(method: string, args?: Record<string, unknown>): Promise<unknown>;
    };
    try {
      await session.send('Rendering.setShowPaintRects', { show: enabled });
      return `Paint flashing set to: ${enabled}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("wasn't found") || msg.includes('not supported')) {
        return `Paint flashing is unavailable in headless shell mode. Launch with headless:false for visual debugging. (Requested: ${enabled})`;
      }
      throw err;
    }
  }

  public async getPerformanceMetrics(): Promise<{ name: string; value: number }[]> {
    if (!this.cdpSession) throw new Error('No active CDP session.');
    await this.cdpSession.send('Performance.enable');
    const response = await this.cdpSession.send('Performance.getMetrics');
    return response.metrics;
  }

  public async sniffFrameworkState(): Promise<unknown> {
    if (!this.page) throw new Error('No active page session.');

    const script = `(() => {
      const results = [];

      function findReactData(element) {
        let key = null;
        for (const k in element) {
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
            key = k;
            break;
          }
        }
        if (!key) return;

        const fiber = element[key];
        if (!fiber) return;

        let current = fiber;
        while (current) {
          const type = current.type;
          const name =
            typeof type === 'function'
              ? type.name
              : typeof type === 'string'
                ? type
                : (type && typeof type === 'object' && typeof type.name === 'string'
                  ? type.name
                  : null);

          if (name) {
            results.push({
              component: name,
              state: current.memoizedState,
              props: current.memoizedProps,
            });
          }
          current = current.return;
        }
      }

      const allElements = document.getElementsByTagName('*');
      for (let i = 0; i < allElements.length; i++) {
        findReactData(allElements[i]);
      }

      return results;
    })()`;

    return await this.page.evaluate(script);
  }

  public async detectLeaksAndAnomalies(): Promise<{
    layoutShiftScore: number;
    bodyBrightness: number;
    activeNodesCount: number;
    domElementsCount: number;
    detachedNodesCount: number;
  }> {
    if (!this.page || !this.cdpSession) throw new Error('No active page session.');

    const performanceMetrics = await this.getPerformanceMetrics();
    const nodeMetric = performanceMetrics.find((m) => m.name === 'Nodes');
    const activeNodesCount = nodeMetric ? nodeMetric.value : 0;

    const domNodeCounts = await this.page.evaluate(() => {
      // Count ALL node types via TreeWalker to match CDP's Nodes metric
      // (which counts elements, text nodes, comments, doctypes, etc.)
      const walker = document.createTreeWalker(
        document,
        NodeFilter.SHOW_ALL,
      );
      let totalNodes = 1; // count the root (document)
      let elementCount = 0;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        totalNodes++;
        if (node.nodeType === Node.ELEMENT_NODE) elementCount++;
      }
      return { totalNodes, elementCount };
    });

    const bodyBrightnessAndCls = (await this.page.evaluate(`(() => {
      const win = window;
      const cls = win.__mcp_cls || 0;
      let bodyBrightness = 255;
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const rgbaMatch = bodyBg.match(/rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)/);
      if (rgbaMatch) {
        const alpha = parseFloat(rgbaMatch[4]);
        if (alpha === 0) {
          bodyBrightness = 255;
        } else {
          const r = parseInt(rgbaMatch[1], 10);
          const g = parseInt(rgbaMatch[2], 10);
          const b = parseInt(rgbaMatch[3], 10);
          bodyBrightness = (r + g + b) / 3;
        }
      } else {
        const rgbMatch = bodyBg.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);
        if (rgbMatch) {
          const r = parseInt(rgbMatch[1], 10);
          const g = parseInt(rgbMatch[2], 10);
          const b = parseInt(rgbMatch[3], 10);
          bodyBrightness = (r + g + b) / 3;
        }
      }
      return { cls, bodyBrightness };
    })()`)) as { cls: number; bodyBrightness: number };

    return {
      layoutShiftScore: bodyBrightnessAndCls.cls,
      bodyBrightness: bodyBrightnessAndCls.bodyBrightness,
      activeNodesCount,
      domElementsCount: domNodeCounts.elementCount,
      detachedNodesCount: Math.max(0, activeNodesCount - domNodeCounts.totalNodes),
    };
  }

  public async throttleNetwork(
    latencyMs: number,
    downloadKbps: number,
    uploadKbps: number
  ): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

    const downloadBps = downloadKbps > 0 ? downloadKbps * 125 : -1;
    const uploadBps = uploadKbps > 0 ? uploadKbps * 125 : -1;

    await this.cdpSession.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: latencyMs,
      downloadThroughput: downloadBps,
      uploadThroughput: uploadBps,
    });

    return `Network throttled: latency=${latencyMs}ms, download=${downloadKbps}Kbps, upload=${uploadKbps}Kbps`;
  }

  public async enableRequestInterception(
    pattern: string,
    action: 'delay' | 'fail',
    delayMs?: number
  ): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

    // Remove any previously attached handler to prevent accumulation
    if (this.fetchInterceptHandler) {
      this.cdpSession.off('Fetch.requestPaused', this.fetchInterceptHandler);
      this.fetchInterceptHandler = null;
    }

    await this.cdpSession.send('Fetch.enable', {
      patterns: [{ urlPattern: pattern }],
    });

    const handler = async (event: { requestId: string }) => {
      const requestId = event.requestId;

      if (action === 'fail') {
        await this.cdpSession?.send('Fetch.failRequest', {
          requestId,
          errorReason: 'Failed',
        }).catch(() => {});
      } else if (action === 'delay' && delayMs) {
        setTimeout(async () => {
          await this.cdpSession?.send('Fetch.continueRequest', { requestId }).catch(() => {});
        }, delayMs);
      } else {
        await this.cdpSession?.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    };

    this.fetchInterceptHandler = handler as (...args: unknown[]) => void;
    this.cdpSession.on('Fetch.requestPaused', this.fetchInterceptHandler);

    return `Interception enabled for pattern '${pattern}' with action '${action}'`;
  }

  public async disableRequestInterception(): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

    // Remove the listener before disabling Fetch to prevent leak
    if (this.fetchInterceptHandler) {
      this.cdpSession.off('Fetch.requestPaused', this.fetchInterceptHandler);
      this.fetchInterceptHandler = null;
    }

    await this.cdpSession.send('Fetch.disable');
    return 'Request interception disabled';
  }

  public async testResponsiveLayout(
    url: string,
    viewports: { width: number; height: number; name: string }[]
  ): Promise<{ viewport: string; accessibilityTree: string }[]> {
    if (!this.page) throw new Error('No active page session.');

    const results: { viewport: string; accessibilityTree: string }[] = [];

    for (const vp of viewports) {
      await this.page.setViewport({ width: vp.width, height: vp.height });
      await this.page.goto(url, { waitUntil: 'load' });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const tree = await this.getAccessibilityTree();
      results.push({
        viewport: `${vp.name} (${vp.width}x${vp.height})`,
        accessibilityTree: tree,
      });
    }

    // Restore default viewport
    await this.page.setViewport({ width: 1280, height: 720 });
    return results;
  }

  public getActivePage(): Page | null {
    return this.page;
  }

  // ─── Screenshot ──────────────────────────────────────────────────────────

  public async screenshot(options: {
    savePath?: string;
    fullPage?: boolean;
    format?: 'png' | 'jpeg';
    quality?: number;
    backendNodeId?: number;
  } = {}): Promise<{ data: string; mimeType: string; savedTo?: string }> {
    if (!this.page) throw new Error('No active page session.');

    const format = options.format || 'png';
    const encoding = 'base64' as const;

    let buffer: string;

    if (options.backendNodeId !== undefined) {
      // Element-specific screenshot
      if (!this.cdpSession) throw new Error('No active CDP session.');
      const { object } = (await this.cdpSession.send('DOM.resolveNode', {
        backendNodeId: options.backendNodeId,
      })) as { object: { objectId?: string } };

      if (!object?.objectId) {
        throw new Error(`Failed to resolve node ID ${options.backendNodeId}`);
      }

      const { model } = (await this.cdpSession.send('DOM.getBoxModel', {
        backendNodeId: options.backendNodeId,
      })) as { model: { content: number[] } };

      // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
      const q = model.content;
      const x = Math.min(q[0], q[2], q[4], q[6]);
      const y = Math.min(q[1], q[3], q[5], q[7]);
      const width = Math.max(q[0], q[2], q[4], q[6]) - x;
      const height = Math.max(q[1], q[3], q[5], q[7]) - y;

      const result = await this.cdpSession.send('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? (options.quality ?? 80) : undefined,
        clip: { x, y, width, height, scale: 1 },
      });

      buffer = (result as { data: string }).data;

      // Release object
      await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    } else {
      // Full viewport or full page screenshot
      buffer = (await this.page.screenshot({
        encoding,
        type: format,
        quality: format === 'jpeg' ? (options.quality ?? 80) : undefined,
        fullPage: options.fullPage ?? false,
      })) as string;
    }

    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

    // Save to disk if requested
    if (options.savePath) {
      await mkdir(join(options.savePath, '..'), { recursive: true }).catch(() => {});
      await writeFile(options.savePath, Buffer.from(buffer, 'base64'));
      return { data: buffer, mimeType, savedTo: options.savePath };
    }

    return { data: buffer, mimeType };
  }

  // ─── Screen Recording ───────────────────────────────────────────────────

  public async startRecording(options: {
    outputDir?: string;
  } = {}): Promise<string> {
    if (this.activeRecording) {
      throw new Error(
        'A recording is already in progress. Call stopRecording first to finalize the current recording.'
      );
    }
    if (!this.cdpSession) throw new Error('No active CDP session. Launch browser first.');

    const outputDir = options.outputDir || join(process.cwd(), 'dist', 'recordings', `rec_${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });

    const frames: RecordingFrame[] = [];

    // Start a dedicated high-quality screencast for recording
    // (This is separate from the DVR screencast which is low-res)
    const handler = (event: { data: string; metadata: { timestamp: number }; sessionId: number }) => {
      frames.push({
        data: event.data,
        timestamp: Date.now(),
      });
      // Acknowledge frame to keep screencast flowing
      this.cdpSession?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    };

    this.recordingFrameHandler = handler as (...args: unknown[]) => void;
    this.cdpSession.on('Page.screencastFrame', this.recordingFrameHandler);

    // If screencast isn't already active (from DVR), start it
    // If it is active, the existing screencast will feed both DVR and recording handlers
    if (!this.screencastActive) {
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        maxWidth: 1920,
        maxHeight: 1080,
        everyNthFrame: 1,
      });
    }

    // Safety auto-stop timer
    const autoStopTimer = setTimeout(async () => {
      console.error(`Recording auto-stopped after ${MAX_RECORDING_DURATION_MS / 1000}s safety limit.`);
      try { await this.stopRecording(); } catch { /* best effort */ }
    }, MAX_RECORDING_DURATION_MS);

    this.activeRecording = {
      frames,
      startedAt: Date.now(),
      autoStopTimer,
      outputDir,
    };

    return (
      `Recording started — frames are being captured now. ` +
      `Proceed with interactions immediately; there is no warmup delay. ` +
      `Output directory: ${outputDir}. ` +
      `Call browser_stop_recording when done. Auto-stops after 5 minutes.`
    );
  }

  public async stopRecording(): Promise<{
    status: string;
    outputDir: string;
    frameCount: number;
    durationSeconds: number;
    manifestPath: string;
  }> {
    if (!this.activeRecording) {
      throw new Error('No recording in progress. Use browser_start_recording first.');
    }

    const recording = this.activeRecording;
    clearTimeout(recording.autoStopTimer);

    // Remove the recording frame handler
    if (this.recordingFrameHandler && this.cdpSession) {
      this.cdpSession.off('Page.screencastFrame', this.recordingFrameHandler);
      this.recordingFrameHandler = null;
    }

    const durationSeconds = Math.round((Date.now() - recording.startedAt) / 1000);
    const { frames, outputDir } = recording;

    // Write frames to disk as numbered JPEGs
    for (let i = 0; i < frames.length; i++) {
      const filename = `frame_${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(join(outputDir, filename), Buffer.from(frames[i].data, 'base64'));
    }

    // Write a manifest with timestamps for potential video assembly
    const manifest = {
      frameCount: frames.length,
      durationSeconds,
      startedAt: new Date(recording.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      fps: frames.length > 0 ? Math.round(frames.length / Math.max(durationSeconds, 1)) : 0,
      frames: frames.map((f, i) => ({
        index: i,
        file: `frame_${String(i).padStart(5, '0')}.jpg`,
        timestamp: f.timestamp,
        relativeMs: f.timestamp - recording.startedAt,
      })),
      ffmpegCommand: `ffmpeg -framerate ${Math.round(frames.length / Math.max(durationSeconds, 1))} -i "${outputDir}/frame_%05d.jpg" -c:v libx264 -pix_fmt yuv420p "${outputDir}/recording.mp4"`,
    };

    const manifestPath = join(outputDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    this.activeRecording = null;

    return {
      status: 'success',
      outputDir,
      frameCount: frames.length,
      durationSeconds,
      manifestPath,
    };
  }

  // ─── Batch Actions ──────────────────────────────────────────────────────

  public async executeBatch(
    actions: { tool: string; args: Record<string, unknown> }[]
  ): Promise<{ results: { tool: string; success: boolean; result?: unknown; error?: string }[] }> {
    const results: { tool: string; success: boolean; result?: unknown; error?: string }[] = [];

    const toolMap: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
      browser_click: (a) => this.click(a.backendNodeId as number),
      browser_type: (a) => this.type(a.backendNodeId as number, a.text as string),
      browser_hover: (a) => this.hover(a.backendNodeId as number),
      browser_navigate: (a) => this.navigate(a.url as string),
      browser_get_accessibility_tree: () => this.getAccessibilityTree(),
      browser_get_mutations: () => this.getMutations(),
      browser_get_listeners: (a) => this.getEventListeners(a.backendNodeId as number),
      browser_get_performance_metrics: () => this.getPerformanceMetrics(),
      browser_sniff_framework_state: () => this.sniffFrameworkState(),
      browser_detect_leaks_and_anomalies: () => this.detectLeaksAndAnomalies(),
      browser_throttle_network: (a) => this.throttleNetwork(
        a.latencyMs as number, a.downloadKbps as number, a.uploadKbps as number
      ),
      browser_intercept_request: (a) => this.enableRequestInterception(
        a.pattern as string, a.action as 'delay' | 'fail', a.delayMs as number | undefined
      ),
      browser_disable_interception: () => this.disableRequestInterception(),
      browser_screenshot: (a) => this.screenshot(a as Parameters<typeof this.screenshot>[0]),
      browser_toggle_paint_flash: (a) => this.togglePaintFlash(a.enabled as boolean),
      browser_dump_dvr: (a) => this.dumpDvr(a.outputPath as string),
    };

    for (const action of actions) {
      const handler = toolMap[action.tool];
      if (!handler) {
        results.push({
          tool: action.tool,
          success: false,
          error: `Unknown tool '${action.tool}'. Supported: ${Object.keys(toolMap).join(', ')}`,
        });
        break; // Stop on first error
      }

      try {
        const result = await handler(action.args);
        results.push({ tool: action.tool, success: true, result });
      } catch (err) {
        results.push({
          tool: action.tool,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        break; // Stop on first error
      }
    }

    return { results };
  }
}
