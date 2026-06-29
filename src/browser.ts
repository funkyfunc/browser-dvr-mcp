import puppeteer, { Browser, Page, CDPSession, ElementHandle } from 'puppeteer-core';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import * as os from 'os';
import { writeFile, mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Worker } from 'worker_threads';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { formatAccessibilityTree, AXNode } from './usag.js';
import { Session } from './session.js';

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require('ffmpeg-static');

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
  private isHeadless = true;
  private fetchInterceptHandler: ((...args: unknown[]) => void) | null = null;
  private activeRecording: RecordingState | null = null;
  private recordingFrameHandler: ((...args: unknown[]) => void) | null = null;
  private dateTimeMockScript: string | null = null;

  private consoleLogs: { level: string; text: string; timestamp: number }[] = [];
  private networkLogs: { method: string; url: string; status?: number; type: string; timestamp: number }[] = [];

  private session: Session | null = null;
  private sessionsDir: string;
  private requestIdCounter = 0;
  private previousFrameworkState: unknown = null;

  constructor() {
    this.sessionsDir = join(__dirname, '..', 'sessions');
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
    if (this.browser) return 'Browser is already running.';

    const headless = options.headless ?? true;
    this.isHeadless = headless;

    this.browser = await puppeteer.launch({
      executablePath: this.findChromeExecutable(),
      headless: headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userDataDir: options.userDataDir,
      defaultViewport: { width: 1280, height: 720 },
    });

    this.page = await this.browser.newPage();
    this.session = new Session('agent');
    await this.setupPageSession(this.page);

    return `Browser launched successfully (headless: ${headless}). Session: ${this.session.id}`;
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
    
    // Evaluate it directly too on all current frames (including existing iframes)
    for (const frame of page.frames()) {
      await frame.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
    }

    // Hook telemetry listeners
    page.on('console', (msg) => {
      const log = { level: msg.type(), text: msg.text(), timestamp: Date.now() };
      this.consoleLogs.push(log);
      if (this.consoleLogs.length > 1000) this.consoleLogs.shift();
      this.session?.addConsoleEvent(log.level, log.text);
      this.worker?.postMessage({ type: 'console', ...log });
    });

    page.on('pageerror', (err: any) => {
      const log = { level: 'error', text: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`, timestamp: Date.now() };
      this.consoleLogs.push(log);
      if (this.consoleLogs.length > 1000) this.consoleLogs.shift();
      this.session?.addConsoleEvent(log.level, log.text);
      this.worker?.postMessage({ type: 'console', ...log });
    });

    page.on('request', (req) => {
      const reqId = `req-${++this.requestIdCounter}`;
      (req as any).__mcpReqId = reqId;
      const log = { method: req.method(), url: req.url(), status: undefined, eventType: 'request', timestamp: Date.now() };
      this.networkLogs.push(log as any);
      if (this.networkLogs.length > 1000) this.networkLogs.shift();
      this.session?.addNetworkRequest(reqId, req.method(), req.url());
      this.worker?.postMessage({ type: 'network', method: log.method, url: log.url, status: log.status, timestamp: log.timestamp });
    });

    page.on('response', (res) => {
      const reqId = (res.request() as any).__mcpReqId || `req-unknown`;
      const log = { method: res.request().method(), url: res.url(), status: res.status(), eventType: 'response', timestamp: Date.now() };
      this.networkLogs.push(log as any);
      if (this.networkLogs.length > 1000) this.networkLogs.shift();
      this.session?.addNetworkResponse(reqId, res.url(), res.request().method(), res.status());
      this.worker?.postMessage({ type: 'network', method: log.method, url: log.url, status: log.status, timestamp: log.timestamp });
    });

    page.on('requestfailed', (req) => {
      const reqId = (req as any).__mcpReqId || `req-unknown`;
      const log = { method: req.method(), url: req.url(), status: undefined, eventType: 'failed', timestamp: Date.now() };
      this.networkLogs.push(log as any);
      if (this.networkLogs.length > 1000) this.networkLogs.shift();
      this.session?.addNetworkFailure(reqId, req.url(), req.method(), req.failure()?.errorText);
      this.worker?.postMessage({ type: 'network', method: log.method, url: log.url, status: log.status, timestamp: log.timestamp });
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
    // Re-inject mutation observer manually to all frames just in case
    for (const frame of this.page!.frames()) {
      await frame.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
    }
    this.session?.addNavigation(url);
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

  private async validateSpatialGuard(target: number | { backendNodeId?: number; mcpId?: string }): Promise<{ x: number; y: number }> {
    const options = typeof target === 'number' ? { backendNodeId: target } : target;
    if (!this.page) throw new Error('No active page session.');
    let elementHandle;
    try {
      if (options.backendNodeId !== undefined) {
        const frame = this.page.mainFrame() as unknown as {
          mainRealm(): { adoptBackendNode(id: number): Promise<ElementHandle<Element>> };
        };
        elementHandle = await frame.mainRealm().adoptBackendNode(options.backendNodeId);
      } else if (options.mcpId !== undefined) {
        for (const frame of this.page.frames()) {
          elementHandle = await frame.$(`[data-mcp-id="${options.mcpId}"]`);
          if (elementHandle) break;
        }
      } else {
        throw new Error('Must provide either backendNodeId or mcpId');
      }
    } catch (err) {
      throw new Error(`Failed to resolve backend node ID ${options.backendNodeId}: ${err}`);
    }
    if (!elementHandle) throw new Error(`Could not find element.`);
    try {
      const checkResult = (await elementHandle.evaluate((el: Element) => {
        if (!(el instanceof Element)) return { error: 'Node is not a DOM Element' };
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return { error: 'Element is invisible' };
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(x, y);
        if (!topEl) return { error: `No element found at center coordinates` };
        const contains = el.contains(topEl) || topEl.contains(el);
        if (!contains) {
          const occluderInfo = `${topEl.tagName.toLowerCase()}${topEl.id ? '#' + topEl.id : ''}${topEl.className ? '.' + topEl.className.trim().split(/\\s+/).join('.') : ''}`;
          return { occluded: true, occluder: occluderInfo, coordinates: { x, y } };
        }
        return { occluded: false, coordinates: { x, y } };
      })) as any;
      if (checkResult.error) throw new Error(checkResult.error);
      if (checkResult.occluded) throw new Error(`Pre-Execution Spatial Validation Failed: Element is occluded by '<${checkResult.occluder}>' at coordinates (${checkResult.coordinates?.x}, ${checkResult.coordinates?.y}).`);
      return checkResult.coordinates;
    } finally {
      await elementHandle.dispose().catch(() => {});
    }
  }

  public async click(target: number | { backendNodeId?: number; mcpId?: string; coordinate?: [number, number] }): Promise<string> {
    const options = typeof target === 'number' ? { backendNodeId: target } : target;
    if (!this.page) throw new Error('No active page session.');
    let x: number, y: number;
    if (options.coordinate) {
      [x, y] = options.coordinate;
    } else {
      const coords = await this.validateSpatialGuard(options);
      x = coords.x; y = coords.y;
    }
    await this.page.mouse.click(x, y);
    return `Successfully clicked element ID ${options.backendNodeId || options.mcpId} at coordinates (${x}, ${y})`;
  }

  public async type(target: number | { backendNodeId?: number; mcpId?: string; coordinate?: [number, number]; text: string }, fallbackText?: string): Promise<string> {
    const options = typeof target === 'number' ? { backendNodeId: target, text: fallbackText! } : target;
    if (!this.page) throw new Error('No active page session.');
    let x: number, y: number;
    if (options.coordinate) {
      [x, y] = options.coordinate;
    } else {
      const coords = await this.validateSpatialGuard(options);
      x = coords.x; y = coords.y;
    }
    await this.page.mouse.click(x, y);
    await this.page.mouse.click(x, y, { count: 2 });
    await this.page.keyboard.type(options.text);
    return `Successfully typed text.`;
  }

  public async hover(target: number | { backendNodeId?: number; mcpId?: string; coordinate?: [number, number] }): Promise<string> {
    const options = typeof target === 'number' ? { backendNodeId: target } : target;
    if (!this.page) throw new Error('No active page session.');
    let x: number, y: number;
    if (options.coordinate) {
      [x, y] = options.coordinate;
    } else {
      const coords = await this.validateSpatialGuard(options);
      x = coords.x; y = coords.y;
    }
    await this.page.mouse.move(x, y);
    return `Successfully hovered at (${x}, ${y})`;
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
        const hint = this.isHeadless ? ' The browser is running headless — try launching with headless:false.' : '';
        return `Paint flashing is not supported by this browser build.${hint} (Requested: ${enabled})`;
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
      const result = { react: [], redux: null, zustand: [] };

      // --- React Fiber Tree ---
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
            result.react.push({
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

      // --- Redux DevTools ---
      try {
        const devToolsExt = window.__REDUX_DEVTOOLS_EXTENSION__;
        if (devToolsExt) {
          // Try to get the store from the global Redux DevTools
          const stores = devToolsExt.getStores ? devToolsExt.getStores() : null;
          if (stores) {
            result.redux = {};
            for (const [name, store] of Object.entries(stores)) {
              result.redux[name] = store.getState ? store.getState() : null;
            }
          }
        }
        // Also check common global patterns
        if (!result.redux && window.__store__ && window.__store__.getState) {
          result.redux = window.__store__.getState();
        }
        if (!result.redux && window.store && window.store.getState) {
          result.redux = window.store.getState();
        }
      } catch (e) {}

      // --- Zustand Stores ---
      try {
        // Zustand stores are often attached to React fiber state as hooks
        // Check for common global store patterns
        for (const key of Object.keys(window)) {
          if (key.startsWith('__zustand') || key.includes('ZustandStore')) {
            try {
              const store = window[key];
              if (store && typeof store.getState === 'function') {
                result.zustand.push({ name: key, state: store.getState() });
              }
            } catch (e) {}
          }
        }
        // Also look for stores exposed via useStore pattern in React fiber hooks
        if (result.zustand.length === 0 && result.react.length > 0) {
          const seen = new Set();
          for (const comp of result.react) {
            if (comp.state && typeof comp.state === 'object' && comp.state !== null) {
              // Walk the memoizedState linked list looking for Zustand store refs
              let hookState = comp.state;
              while (hookState) {
                const q = hookState.queue;
                if (q && q.lastRenderedReducer && q.lastRenderedState && typeof q.lastRenderedState === 'object') {
                  const stateStr = JSON.stringify(q.lastRenderedState).substring(0, 100);
                  if (!seen.has(stateStr)) {
                    seen.add(stateStr);
                    result.zustand.push({ name: comp.component + '_hook', state: q.lastRenderedState });
                  }
                }
                hookState = hookState.next;
              }
            }
          }
        }
      } catch (e) {}

      return result;
    })()`;

    const currentState = await this.page.evaluate(script);

    // Compute diff against previous snapshot
    let diff: unknown = null;
    if (this.previousFrameworkState) {
      try {
        diff = this.computeStateDiff(this.previousFrameworkState, currentState);
      } catch {
        diff = { error: 'Failed to compute diff' };
      }
    }

    this.previousFrameworkState = currentState;

    return { current: currentState, diff, hasPrevious: diff !== null };
  }

  private computeStateDiff(prev: any, curr: any): unknown {
    if (typeof prev !== 'object' || typeof curr !== 'object' || prev === null || curr === null) {
      return prev === curr ? null : { previous: prev, current: curr };
    }

    const diff: Record<string, unknown> = {};
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);

    for (const key of allKeys) {
      if (!(key in prev)) {
        diff[key] = { type: 'added', value: curr[key] };
      } else if (!(key in curr)) {
        diff[key] = { type: 'removed', value: prev[key] };
      } else {
        const prevStr = JSON.stringify(prev[key]);
        const currStr = JSON.stringify(curr[key]);
        if (prevStr !== currStr) {
          diff[key] = { type: 'changed', previous: prev[key], current: curr[key] };
        }
      }
    }

    return Object.keys(diff).length > 0 ? diff : null;
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
      const walker = document.createTreeWalker(
        document,
        NodeFilter.SHOW_ALL,
      );
      let totalNodes = 1;
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

  public async setOfflineMode(offline: boolean): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

    await this.cdpSession.send('Network.emulateNetworkConditions', {
      offline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    return offline
      ? 'Network set to offline mode. All requests will fail.'
      : 'Network restored to online mode.';
  }

  public async enableRequestInterception(
    pattern: string,
    action: 'delay' | 'fail',
    delayMs?: number
  ): Promise<string> {
    if (!this.cdpSession) throw new Error('No active CDP session.');

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

    await this.page.setViewport({ width: 1280, height: 720 });
    return results;
  }

  public getActivePage(): Page | null {
    return this.page;
  }

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

      await this.cdpSession.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    } else {
      buffer = (await this.page.screenshot({
        encoding,
        type: format,
        quality: format === 'jpeg' ? (options.quality ?? 80) : undefined,
        fullPage: options.fullPage ?? false,
      })) as string;
    }

    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

    if (options.savePath) {
      await mkdir(join(options.savePath, '..'), { recursive: true }).catch(() => {});
      await writeFile(options.savePath, Buffer.from(buffer, 'base64'));
      return { data: buffer, mimeType, savedTo: options.savePath };
    }

    return { data: buffer, mimeType };
  }

  public async startRecording(options: {
    outputDir?: string;
  } = {}): Promise<string> {
    if (this.activeRecording) {
      throw new Error('A recording is already in progress.');
    }
    if (!this.cdpSession) throw new Error('No active CDP session. Launch browser first.');

    const outputDir = options.outputDir || join(os.tmpdir(), 'best-browser-recordings', `rec_${Date.now()}`);
    mkdirSync(outputDir, { recursive: true });

    const frames: RecordingFrame[] = [];

    const handler = (event: { data: string; metadata: { timestamp: number }; sessionId: number }) => {
      frames.push({
        data: event.data,
        timestamp: Date.now(),
      });
      this.cdpSession?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    };

    this.recordingFrameHandler = handler as (...args: unknown[]) => void;
    this.cdpSession.on('Page.screencastFrame', this.recordingFrameHandler);

    if (!this.screencastActive) {
      await this.cdpSession.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 85,
        maxWidth: 1920,
        maxHeight: 1080,
        everyNthFrame: 1,
      });
    }

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

    return `Recording started. Output directory: ${outputDir}.`;
  }

  public async stopRecording(): Promise<{
    status: string;
    outputDir: string;
    frameCount: number;
    durationSeconds: number;
    manifestPath: string;
    videoPath: string | null;
  }> {
    if (!this.activeRecording) {
      throw new Error('No recording in progress.');
    }

    const recording = this.activeRecording;
    clearTimeout(recording.autoStopTimer);

    if (this.recordingFrameHandler && this.cdpSession) {
      this.cdpSession.off('Page.screencastFrame', this.recordingFrameHandler);
      this.recordingFrameHandler = null;
    }

    const durationSeconds = Math.round((Date.now() - recording.startedAt) / 1000);
    const { frames, outputDir } = recording;

    for (let i = 0; i < frames.length; i++) {
      const filename = `frame_${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(join(outputDir, filename), Buffer.from(frames[i].data, 'base64'));
    }

    const fps = frames.length > 0 ? Math.max(1, Math.round(frames.length / Math.max(durationSeconds, 1))) : 1;
    const videoOutputPath = join(outputDir, 'recording.mp4');

    let videoPath: string | null = null;
    if (ffmpegPath && frames.length > 0) {
      try {
        execFileSync(ffmpegPath, [
          '-y',
          '-framerate', String(fps),
          '-i', join(outputDir, 'frame_%05d.jpg'),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          videoOutputPath,
        ], { timeout: 30_000 });
        videoPath = videoOutputPath;
      } catch (err) {
        console.error('ffmpeg assembly failed', err);
      }
    }

    const manifest = {
      frameCount: frames.length,
      durationSeconds,
      startedAt: new Date(recording.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      fps,
      videoPath,
      frames: frames.map((f, i) => ({
        index: i,
        file: `frame_${String(i).padStart(5, '0')}.jpg`,
        timestamp: f.timestamp,
        relativeMs: f.timestamp - recording.startedAt,
      })),
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
      videoPath,
    };
  }

  public getConsoleLogs(clear: boolean = false) {
    const logs = [...this.consoleLogs];
    if (clear) this.consoleLogs = [];
    return logs;
  }

  public getNetworkActivity(clear: boolean = false) {
    const logs = [...this.networkLogs];
    if (clear) this.networkLogs = [];
    return logs;
  }

  public async pressKey(key: string) {
    if (!this.page) throw new Error('No active page session.');
    await this.page.keyboard.press(key as any);
    this.session?.addInteraction({ type: 'keypress', timestamp: Date.now(), key });
    return `Pressed key: ${key}`;
  }

  public async scroll(direction: 'up' | 'down' | 'bottom' | 'top', amount?: number) {
    if (!this.page) throw new Error('No active page session.');
    await this.page.evaluate((dir, amt) => {
      const scrollAmt = amt || window.innerHeight;
      if (dir === 'down') window.scrollBy(0, scrollAmt);
      else if (dir === 'up') window.scrollBy(0, -scrollAmt);
      else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else if (dir === 'top') window.scrollTo(0, 0);
    }, direction, amount);
    this.session?.addInteraction({ type: 'scroll', timestamp: Date.now(), details: `${direction}${amount ? ` ${amount}px` : ''}` });
    return `Scrolled ${direction}`;
  }

  public async manageStorage(
    action: 'get' | 'set' | 'clear',
    type: 'localStorage' | 'sessionStorage' | 'cookies',
    key?: string,
    value?: string,
    domain?: string
  ) {
    if (!this.page) throw new Error('No active page session.');
    if (type === 'cookies') {
      if (action === 'get') return await this.page.cookies();
      if (action === 'clear') {
        const cookies = await this.page.cookies();
        await this.page.deleteCookie(...cookies);
        return 'Cookies cleared.';
      }
      if (action === 'set' && key && value) {
        await this.page.setCookie({ name: key, value, domain: domain || 'localhost' });
        return `Cookie ${key} set.`;
      }
    } else {
      const storageObj = type === 'localStorage' ? 'localStorage' : 'sessionStorage';
      return await this.page.evaluate((act, store, k, v) => {
        const s = window[store as 'localStorage' | 'sessionStorage'];
        if (act === 'clear') { s.clear(); return `${store} cleared.`; }
        if (act === 'get') return Object.fromEntries(Object.entries(s));
        if (act === 'set' && k && v) { s.setItem(k, v); return `${store} ${k} set.`; }
        return 'Invalid storage operation.';
      }, action, storageObj, key, value);
    }
    return 'Invalid storage operation or missing parameters.';
  }

  public async assertElement(options: { backendNodeId?: number; mcpId?: string; selector?: string; iframeSelector?: string }): Promise<{
    visible: boolean;
    disabled: boolean;
    text: string;
    checked?: boolean;
    backendNodeId?: number;
    mcpId?: string;
  }> {
    if (!this.page) throw new Error('No active page session.');

    const { backendNodeId, mcpId, selector, iframeSelector } = options;
    let targetEl: ElementHandle<Element> | null = null;
    let resolvedBackendNodeId = backendNodeId;
    let resolvedMcpId = mcpId;

    if (backendNodeId) {
      const frame = this.page.mainFrame() as unknown as {
        mainRealm(): { adoptBackendNode(id: number): Promise<ElementHandle<Element>> };
      };
      targetEl = await frame.mainRealm().adoptBackendNode(backendNodeId);
    } else if (mcpId) {
      for (const frame of this.page.frames()) {
        targetEl = await frame.$(`[data-mcp-id="${mcpId}"]`);
        if (targetEl) break;
      }
    } else if (selector) {
      let context: Page | import('puppeteer-core').Frame = this.page;
      if (iframeSelector) {
        const iframeHandle = await this.page.$(iframeSelector);
        if (iframeHandle) {
          const frame = await iframeHandle.contentFrame();
          if (frame) context = frame;
        }
      }
      targetEl = await context.$(selector);

      if (targetEl) {
        try {
          const mcpIdVal = await targetEl.evaluate((el) => el.getAttribute('data-mcp-id'));
          if (mcpIdVal) resolvedMcpId = mcpIdVal;

          const remoteObject = targetEl.remoteObject?.() || (targetEl as any)._remoteObject;
          if (remoteObject?.objectId && this.cdpSession) {
            const { node } = await this.cdpSession.send('DOM.describeNode', { objectId: remoteObject.objectId });
            resolvedBackendNodeId = node.backendNodeId;
          }
        } catch { }
      }
    } else {
      throw new Error('Must provide either backendNodeId, mcpId, or selector');
    }

    if (!targetEl) throw new Error('Element not found');

    const result = await targetEl.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      const disabled = (htmlEl as any).disabled === true || el.getAttribute('aria-disabled') === 'true';
      const text = htmlEl.innerText || el.textContent || '';
      const isCheckboxOrRadio = el.tagName === 'INPUT' && (el.getAttribute('type') === 'checkbox' || el.getAttribute('type') === 'radio');
      const checked = isCheckboxOrRadio ? (htmlEl as HTMLInputElement).checked : undefined;

      return { visible, disabled, text: text.trim(), checked };
    });

    await targetEl.dispose().catch(() => {});

    return { ...result, backendNodeId: resolvedBackendNodeId, mcpId: resolvedMcpId };
  }

  public async querySelector(selector: string, iframeSelector?: string): Promise<{
    matches: { tag: string; text: string; mcpId: string; boundingBox: { x: number; y: number; width: number; height: number } }[];
  }> {
    if (!this.page || !this.cdpSession) throw new Error('No active page session.');

    let context: Page | import('puppeteer-core').Frame = this.page;
    if (iframeSelector) {
      const iframeHandle = await this.page.$(iframeSelector);
      if (!iframeHandle) throw new Error(`Iframe not found for selector: ${iframeSelector}`);
      const frame = await iframeHandle.contentFrame();
      if (!frame) throw new Error(`Could not access content frame for iframe: ${iframeSelector}`);
      context = frame;
    }

    const isXPath = selector.startsWith('xpath/');
    let handles: ElementHandle<Element>[];

    if (isXPath) {
      const xpath = selector.slice('xpath/'.length);
      handles = await context.$$(`::-p-xpath(${xpath})`) as ElementHandle<Element>[];
    } else {
      handles = await context.$$(selector) as ElementHandle<Element>[];
    }

    const matches: { tag: string; text: string; mcpId: string; boundingBox: { x: number; y: number; width: number; height: number } }[] = [];

    for (const handle of handles) {
      try {
        const info = await handle.evaluate((el: Element) => {
          const rect = el.getBoundingClientRect();
          let mcpId = el.getAttribute('data-mcp-id');
          if (!mcpId && (window as any).__mcp_id_seq) {
            mcpId = String((window as any).__mcp_id_seq++);
            el.setAttribute('data-mcp-id', mcpId);
          }
          return {
            tag: el.tagName.toLowerCase(),
            text: ((el as HTMLElement).innerText || el.textContent || '').substring(0, 200).trim(),
            boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            mcpId: mcpId || ''
          };
        });

        if (info.mcpId) {
          matches.push(info);
        }
      } catch {
        // Ignore evaluation errors
      } finally {
        await handle.dispose().catch(() => {});
      }
    }

    return { matches };
  }

  // ─── Evaluate ───────────────────────────────────────────────────────────

  public async evaluate(expression: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (!this.page) throw new Error('No active page session.');

    try {
      const result = await Promise.race([
        this.page.evaluate(expression),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Evaluation timed out after 5 seconds')), 5000)),
      ]);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Simulate Tab Flow ──────────────────────────────────────────────────

  public async simulateTabFlow(maxSteps: number = 20): Promise<{
    focusFlow: { step: number; tag: string; role: string; name: string; id: string; backendNodeId: number }[];
    focusTraps: string[];
    totalSteps: number;
  }> {
    if (!this.page || !this.cdpSession) throw new Error('No active page session.');

    const focusFlow: { step: number; tag: string; role: string; name: string; id: string; backendNodeId: number }[] = [];
    const focusTraps: string[] = [];
    const seenElements = new Map<string, number>(); // fingerprint -> first step index

    // Click on the body first to reset focus
    await this.page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur?.();
      document.body.focus();
    });

    for (let step = 1; step <= maxSteps; step++) {
      await this.page.keyboard.press('Tab');

      // Small delay to let focus settle
      await new Promise(r => setTimeout(r, 50));

      const elementInfo = await this.page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) {
          return { tag: 'body', role: '', name: '', id: '', fingerprint: 'body' };
        }
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          name: el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLElement).innerText?.substring(0, 50)?.trim() || '',
          id: el.id || '',
          fingerprint: `${el.tagName}#${el.id}.${el.className}`,
        };
      });

      // Resolve backendNodeId for the focused element
      let backendNodeId = 0;
      try {
        const handle = await this.page.evaluateHandle(() => document.activeElement);
        const remoteObject = handle.remoteObject?.() || (handle as any)._remoteObject;
        if (remoteObject?.objectId) {
          const { node } = await this.cdpSession!.send('DOM.describeNode', { objectId: remoteObject.objectId });
          backendNodeId = node.backendNodeId;
        }
        await handle.dispose().catch(() => {});
      } catch {
        // Continue without backendNodeId
      }

      focusFlow.push({
        step,
        tag: elementInfo.tag,
        role: elementInfo.role,
        name: elementInfo.name,
        id: elementInfo.id,
        backendNodeId,
      });

      // Check for focus trap (element seen before)
      if (seenElements.has(elementInfo.fingerprint)) {
        const firstStep = seenElements.get(elementInfo.fingerprint)!;
        // Only flag as a trap if we cycled back within fewer steps than maxSteps
        // (cycling through the whole page is normal)
        if (step - firstStep < maxSteps - 1) {
          focusTraps.push(
            `Possible focus trap: <${elementInfo.tag}${elementInfo.id ? '#' + elementInfo.id : ''}> at step ${step} was already focused at step ${firstStep} (cycle of ${step - firstStep} elements)`
          );
        }
        break; // Stop on first cycle detection
      }

      seenElements.set(elementInfo.fingerprint, step);

      // If we hit body, focus has left all interactive elements
      if (elementInfo.tag === 'body') {
        break;
      }
    }

    return {
      focusFlow,
      focusTraps,
      totalSteps: focusFlow.length,
    };
  }

  // ─── Mock Date and Time ─────────────────────────────────────────────────

  public async mockDateTime(options: {
    mode: 'freeze' | 'travel' | 'reset';
    isoDate?: string;
    deltaMs?: number;
  }): Promise<string> {
    if (!this.page) throw new Error('No active page session.');

    if (options.mode === 'reset') {
      // Remove the injected script and restore native Date/performance
      const wasMocked = this.dateTimeMockScript !== null;
      this.dateTimeMockScript = null;
      if (!wasMocked) {
        return 'No date/time mock is active. Nothing to reset.';
      }
      await this.page.evaluate(`(() => {
        if (window.__mcp_original_Date) {
          window.Date = window.__mcp_original_Date;
          delete window.__mcp_original_Date;
        }
        if (window.__mcp_original_performance_now) {
          performance.now = window.__mcp_original_performance_now;
          delete window.__mcp_original_performance_now;
        }
      })()`);
      return 'Date/time mocking reset. Native Date and performance.now restored.';
    }

    let mockScript: string;

    if (options.mode === 'freeze') {
      const freezeTime = options.isoDate ? `new window.__mcp_original_Date('${options.isoDate}').getTime()` : 'window.__mcp_original_Date.now()';
      mockScript = `(() => {
        if (!window.__mcp_original_Date) window.__mcp_original_Date = window.Date;
        if (!window.__mcp_original_performance_now) window.__mcp_original_performance_now = performance.now.bind(performance);
        const frozenTime = ${freezeTime};
        const frozenPerfTime = window.__mcp_original_performance_now();
        const OriginalDate = window.__mcp_original_Date;

        function MockDate(...args) {
          if (args.length === 0) return new OriginalDate(frozenTime);
          return new OriginalDate(...args);
        }
        MockDate.prototype = OriginalDate.prototype;
        MockDate.now = () => frozenTime;
        MockDate.parse = OriginalDate.parse;
        MockDate.UTC = OriginalDate.UTC;
        window.Date = MockDate;
        performance.now = () => frozenPerfTime;
      })()`;
    } else {
      // travel mode
      const delta = options.deltaMs || 0;
      mockScript = `(() => {
        if (!window.__mcp_original_Date) window.__mcp_original_Date = window.Date;
        if (!window.__mcp_original_performance_now) window.__mcp_original_performance_now = performance.now.bind(performance);
        const delta = ${delta};
        const OriginalDate = window.__mcp_original_Date;

        function MockDate(...args) {
          if (args.length === 0) return new OriginalDate(OriginalDate.now() + delta);
          return new OriginalDate(...args);
        }
        MockDate.prototype = OriginalDate.prototype;
        MockDate.now = () => OriginalDate.now() + delta;
        MockDate.parse = OriginalDate.parse;
        MockDate.UTC = OriginalDate.UTC;
        window.Date = MockDate;
        const origPerfNow = window.__mcp_original_performance_now;
        performance.now = () => origPerfNow() + delta;
      })()`;
    }

    // Store and inject the script
    this.dateTimeMockScript = mockScript;
    await this.page.evaluate(mockScript);
    // Also inject on future navigations
    await this.page.evaluateOnNewDocument(mockScript);

    if (options.mode === 'freeze') {
      return `Time frozen at ${options.isoDate || 'current time'}. All Date.now() and performance.now() calls will return the frozen value.`;
    } else {
      return `Time shifted by ${options.deltaMs || 0}ms. All Date.now() and performance.now() calls are offset by the delta.`;
    }
  }

  // ─── Session Management ─────────────────────────────────────────────────

  public getSessionSummary() {
    if (!this.session) throw new Error('No active session. Launch a browser first.');
    return this.session.getSummary();
  }

  public sessionDrillDown(category: string, filter?: string) {
    if (!this.session) throw new Error('No active session. Launch a browser first.');
    return this.session.drillDown(category, filter);
  }

  // ─── Human Recording Mode ──────────────────────────────────────────────

  private static readonly HUMAN_INTERACTION_TRACKER = `
(function() {
  if (window.__mcp_human_tracker_initialized) return;
  window.__mcp_human_tracker_initialized = true;
  window.__mcp_human_interactions = [];

  document.addEventListener('click', (e) => {
    const target = e.target;
    const tagName = target.tagName ? target.tagName.toLowerCase() : 'unknown';
    const id = target.id ? '#' + target.id : '';
    const cls = target.className && typeof target.className === 'string'
      ? '.' + target.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const text = (target.innerText || target.textContent || '').substring(0, 50).trim();
    window.__mcp_human_interactions.push({
      type: 'click',
      x: e.clientX, y: e.clientY,
      target: tagName + id + cls,
      text: text,
      timestamp: Date.now()
    });
  }, true);

  document.addEventListener('input', (e) => {
    const target = e.target;
    const tagName = target.tagName ? target.tagName.toLowerCase() : 'unknown';
    const id = target.id ? '#' + target.id : '';
    window.__mcp_human_interactions.push({
      type: 'input',
      target: tagName + id,
      value: target.value ? target.value.substring(0, 100) : '',
      timestamp: Date.now()
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Escape', 'Tab', 'Backspace', 'Delete'].includes(e.key) || e.ctrlKey || e.metaKey) {
      window.__mcp_human_interactions.push({
        type: 'keypress',
        key: (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Cmd+' : '') + e.key,
        timestamp: Date.now()
      });
    }
  }, true);
})();
`;

  private humanInteractionPollTimer: ReturnType<typeof setInterval> | null = null;

  public async startHumanSession(url?: string): Promise<{ sessionId: string; message: string }> {
    // Close existing browser if running
    if (this.browser) {
      await this.close();
    }

    const executablePath = this.findChromeExecutable();

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());
    this.session = new Session('human');
    await this.setupPageSession(this.page);

    // Inject human interaction tracker
    await this.page.evaluateOnNewDocument(BrowserManager.HUMAN_INTERACTION_TRACKER);
    await this.page.evaluate(BrowserManager.HUMAN_INTERACTION_TRACKER).catch(() => {});

    // Navigate if URL provided
    if (url) {
      await this.page.goto(url, { waitUntil: 'load' });
      await this.page.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
      await this.page.evaluate(BrowserManager.HUMAN_INTERACTION_TRACKER).catch(() => {});
      this.session.addNavigation(url);
    }

    // Start polling for human interactions from the page
    this.humanInteractionPollTimer = setInterval(async () => {
      if (!this.page) return;
      try {
        const interactions = await this.page.evaluate(() => {
          const win = window as any;
          const result = win.__mcp_human_interactions || [];
          win.__mcp_human_interactions = [];
          return result;
        });
        for (const interaction of interactions) {
          this.session?.addInteraction(interaction);
        }
        // Also grab mutations for the session
        const mutations = await this.page.evaluate(() => {
          const win = window as any;
          const result = win.__mcp_mutations || [];
          win.__mcp_mutations = [];
          return result;
        });
        for (const mutation of mutations) {
          this.session?.addMutation(mutation.type, mutation.targetId, mutation);
        }
      } catch {
        // Page might have navigated, that's fine
      }
    }, 500);

    // Re-inject tracker on navigation
    this.page.on('framenavigated', async () => {
      try {
        await this.page?.evaluate(BrowserManager.HUMAN_INTERACTION_TRACKER).catch(() => {});
        const url = this.page?.url();
        if (url && url !== 'about:blank') {
          this.session?.addNavigation(url);
        }
      } catch { /* ignore */ }
    });

    // Auto-stop if the user closes the browser window
    this.browser.on('disconnected', () => {
      if (this.session && this.session.mode === 'human' && this.humanInteractionPollTimer) {
        this.stopHumanSession().catch(() => {});
      }
    });

    return {
      sessionId: this.session.id,
      message: `Human recording session started. Browser is open${url ? ` at ${url}` : ''}. Interact with it, then either close the browser window or call browser_stop_human_session when done.`,
    };
  }

  public async stopHumanSession(): Promise<{ sessionId: string; savedTo: string; summary: unknown }> {
    if (!this.session || this.session.mode !== 'human') {
      throw new Error('No active human session to stop.');
    }

    // Use the poll timer as a guard against re-entrancy (e.g. called explicitly + browser disconnected)
    if (!this.humanInteractionPollTimer) {
       const summary = this.session.getSummary();
       return { sessionId: summary.sessionId, savedTo: 'Already saved', summary };
    }

    // Stop polling
    clearInterval(this.humanInteractionPollTimer);
    this.humanInteractionPollTimer = null;

    // Do one final poll before stopping
    if (this.page) {
      try {
        const interactions = await this.page.evaluate(() => {
          const win = window as any;
          const result = win.__mcp_human_interactions || [];
          win.__mcp_human_interactions = [];
          return result;
        });
        for (const interaction of interactions) {
          this.session?.addInteraction(interaction);
        }
        const mutations = await this.page.evaluate(() => {
          const win = window as any;
          const result = win.__mcp_mutations || [];
          win.__mcp_mutations = [];
          return result;
        });
        for (const mutation of mutations) {
          this.session?.addMutation(mutation.type, mutation.targetId, mutation);
        }
      } catch { /* ignore */ }
    }

    const summary = this.session.getSummary();
    const savedTo = this.session.saveToDisk(this.sessionsDir);

    // Close the browser
    await this.close();

    return { sessionId: summary.sessionId, savedTo, summary };
  }

  public loadSession(filePath: string) {
    this.session = Session.load(filePath);
    return this.session.getSummary();
  }

  public listSessions() {
    return Session.listSessions(this.sessionsDir);
  }

  // ─── Batch Actions ──────────────────────────────────────────────────────

  public async executeBatch(
    actions: { tool: string; args: Record<string, unknown> }[]
  ): Promise<{ results: { tool: string; success: boolean; result?: unknown; error?: string }[] }> {
    const results: { tool: string; success: boolean; result?: unknown; error?: string }[] = [];

    const toolMap: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
      browser_click: (a) => this.click({ backendNodeId: a.backendNodeId as number, mcpId: a.mcpId as string, coordinate: a.coordinate as [number, number] }),
      browser_type: (a) => this.type({ backendNodeId: a.backendNodeId as number, mcpId: a.mcpId as string, coordinate: a.coordinate as [number, number], text: a.text as string }),
      browser_hover: (a) => this.hover({ backendNodeId: a.backendNodeId as number, mcpId: a.mcpId as string, coordinate: a.coordinate as [number, number] }),
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
      browser_get_console_logs: (a) => Promise.resolve(this.getConsoleLogs(a.clear as boolean)),
      browser_get_network_activity: (a) => Promise.resolve(this.getNetworkActivity(a.clear as boolean)),
      browser_press_key: (a) => this.pressKey(a.key as string),
      browser_scroll: (a) => this.scroll(a.direction as any, a.amount as number),
      browser_manage_storage: (a) => this.manageStorage(a.action as any, a.type as any, a.key as string, a.value as string, a.domain as string),
      browser_assert_element: (a) => this.assertElement({ backendNodeId: a.backendNodeId as number, mcpId: a.mcpId as string, selector: a.selector as string, iframeSelector: a.iframeSelector as string }),
      browser_query_selector: (a) => this.querySelector(a.selector as string, a.iframeSelector as string),
      browser_evaluate: (a) => this.evaluate(a.expression as string),
      browser_simulate_tab_flow: (a) => this.simulateTabFlow(a.maxSteps as number),
      browser_set_offline: (a) => this.setOfflineMode(a.offline as boolean),
      browser_mock_date_and_time: (a) => this.mockDateTime(a as { mode: 'freeze' | 'travel' | 'reset'; isoDate?: string; deltaMs?: number }),
      browser_session_summary: () => Promise.resolve(this.getSessionSummary()),
      browser_session_drilldown: (a) => Promise.resolve(this.sessionDrillDown(a.category as string, a.filter as string)),
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
