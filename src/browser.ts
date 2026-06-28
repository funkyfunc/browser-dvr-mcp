import puppeteer, { Browser, Page, CDPSession, ElementHandle } from 'puppeteer-core';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Worker } from 'worker_threads';
import { formatAccessibilityTree, AXNode } from './usag.js';

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

  public getActivePage(): Page | null {
    return this.page;
  }
}
