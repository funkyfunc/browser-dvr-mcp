// ─── CDPConnectionManager ───────────────────────────────────────────────────
// Owns the browser lifecycle: launch, connect, close, and auto-attach to all
// execution contexts (OOPIFs, Service Workers, etc.) via Target.setAutoAttach.
// This is the ONLY module that holds references to puppeteer-core.

import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core';
import { existsSync } from 'fs';
import type { LaunchOptions, FrameInfo } from './types.js';
import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function checkPortListening(
  port: number,
  host: string = 'localhost',
  timeoutMs: number = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeoutMs);

    const onConnect = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(true);
      }
    };

    const onError = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(false);
      }
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('timeout', onError);

    socket.connect(port, host);
  });
}

async function getActiveListeningPorts(): Promise<number[]> {
  const ports = new Set<number>();
  try {
    const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n');
    const lines = stdout.split('\n');
    for (const line of lines) {
      const match = line.match(
        /(?:\*|(?:\d{1,3}\.){3}\d{1,3}|\[?[0-9a-fA-F:]+\]?):(\d+)\s+\(LISTEN\)/,
      );
      if (match && match[1]) {
        ports.add(parseInt(match[1], 10));
      }
    }
  } catch (e) {
    const fallbackPorts = [3000, 3001, 5000, 5173, 5174, 8000, 8080, 8081, 9000];
    for (const p of fallbackPorts) {
      if (await checkPortListening(p)) {
        ports.add(p);
      }
    }
  }
  return Array.from(ports).sort((a, b) => a - b);
}

/** Cloud/link-local metadata hosts that must never be reachable via navigation. */
function isMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  // IPv4 link-local block 169.254.0.0/16
  if (h.startsWith('169.254.')) return true;
  // IPv6 link-local (fe80::/10) and unique-local (fc00::/7) metadata addresses
  if (h.startsWith('fe80:') || h.startsWith('fd00:') || h.startsWith('fc00:')) return true;
  return false;
}

function isLocalUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Chrome launch args. The sandbox is left ON by default (dropping it turns any
 * renderer exploit on an untrusted page into host RCE). Set BROWSER_MCP_NO_SANDBOX=1
 * only inside a container that already provides isolation. Site isolation stays
 * disabled deliberately: the perception layer relies on same-process iframes for
 * single-call CDP/DOMSnapshot access (see ARCHITECTURE.md).
 */
function chromeArgs(): string[] {
  const args = ['--disable-features=site-per-process'];
  if (process.env.BROWSER_MCP_NO_SANDBOX === '1') {
    args.push('--no-sandbox', '--disable-setuid-sandbox');
  }
  return args;
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export class CDPConnectionManager {
  private browser: Browser | null = null;
  // `page`/`cdpSession` always mirror the ACTIVE tab, so every existing tool
  // (which calls getPage()/getCDPSession()) operates on the active tab for free.
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private isHeadless = true;

  // Multi-tab registry.
  private tabs = new Map<string, { page: Page; cdp: CDPSession }>();
  private activeTabId = '';
  private tabCounter = 0;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async launch(options: LaunchOptions = {}): Promise<{
    cdpSession: CDPSession;
    page: Page;
    message: string;
  }> {
    if (this.browser) {
      return {
        cdpSession: this.cdpSession!,
        page: this.page!,
        message: 'Browser is already running.',
      };
    }

    const headless = options.headless ?? true;
    this.isHeadless = headless;

    this.browser = await puppeteer.launch({
      executablePath: this.findChromeExecutable(),
      headless,
      args: chromeArgs(),
      userDataDir: options.userDataDir,
      defaultViewport: { width: 1280, height: 720 },
    });

    const page = await this.browser.newPage();
    const cdp = await page.createCDPSession();
    this.registerTab(page, cdp);

    // Enable core CDP domains
    await this.enableCDPDomains();

    const message = `Browser launched (headless: ${headless}).`;
    return { cdpSession: cdp, page, message };
  }

  // ─── Tab management ───────────────────────────────────────────────────────

  private registerTab(page: Page, cdp: CDPSession): string {
    const id = `tab-${++this.tabCounter}`;
    this.tabs.set(id, { page, cdp });
    this.activeTabId = id;
    this.page = page;
    this.cdpSession = cdp;
    page.once('close', () => {
      this.tabs.delete(id);
      if (this.activeTabId === id) {
        const next = this.tabs.values().next().value;
        if (next) {
          this.activeTabId = [...this.tabs.keys()][0];
          this.page = next.page;
          this.cdpSession = next.cdp;
        } else {
          this.activeTabId = '';
          this.page = null;
          this.cdpSession = null;
        }
      }
    });
    return id;
  }

  getActiveTabId(): string {
    return this.activeTabId;
  }

  /** Open a new tab, make it active, and enable perception domains on it. */
  async newTab(): Promise<{ tabId: string; page: Page; cdp: CDPSession }> {
    if (!this.browser) throw new Error('No active browser. Call browser_launch first.');
    const page = await this.browser.newPage();
    const cdp = await page.createCDPSession();
    const tabId = this.registerTab(page, cdp);
    await this.enableCDPDomains();
    return { tabId, page, cdp };
  }

  async switchTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No such tab: ${tabId}. Use browser_list_tabs to see open tabs.`);
    this.activeTabId = tabId;
    this.page = tab.page;
    this.cdpSession = tab.cdp;
    await tab.page.bringToFront().catch(() => {});
  }

  listTabs(): { tabId: string; url: string; active: boolean }[] {
    return [...this.tabs.entries()].map(([tabId, { page }]) => ({
      tabId,
      url: page.url(),
      active: tabId === this.activeTabId,
    }));
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No such tab: ${tabId}.`);
    if (this.tabs.size === 1) {
      throw new Error('Cannot close the last tab. Use browser_close to end the session.');
    }
    await tab.page.close().catch(() => {}); // 'close' handler cleans up + reassigns active
  }

  async launchHeadful(options: { userDataDir?: string } = {}): Promise<{
    cdpSession: CDPSession;
    page: Page;
    browser: Browser;
    message: string;
  }> {
    if (this.browser) {
      await this.close();
    }

    this.isHeadless = false;

    this.browser = await puppeteer.launch({
      executablePath: this.findChromeExecutable(),
      headless: false,
      args: chromeArgs(),
      userDataDir: options.userDataDir,
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    const page = pages[0] || (await this.browser.newPage());
    const cdp = await page.createCDPSession();
    this.registerTab(page, cdp);

    await this.enableCDPDomains();

    return {
      cdpSession: cdp,
      page,
      browser: this.browser,
      message: 'Headful browser launched.',
    };
  }

  async close(): Promise<string> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.cdpSession = null;
      this.tabs.clear();
      this.activeTabId = '';
      return 'Browser closed.';
    }
    return 'No active browser session.';
  }

  async navigate(
    url: string,
    options: { waitUntil?: 'load' | 'networkidle0' | 'networkidle2' | 'domcontentloaded' } = {},
  ): Promise<string> {
    if (!this.page) {
      throw new Error('No active page. Launch browser first.');
    }

    // Guard navigation against SSRF-style exfiltration. For a local-dev tool
    // the sharp risk is the agent being steered to a cloud-metadata endpoint
    // (169.254.169.254 and friends) and reading credentials back through the
    // semantic surface; file:// and localhost are legitimate here. We therefore
    // (a) restrict to web/file/about schemes and (b) block link-local metadata
    // hosts. Override the scheme list with BROWSER_MCP_ALLOW_SCHEMES if needed.
    const allowedSchemes = (
      process.env.BROWSER_MCP_ALLOW_SCHEMES
        ? process.env.BROWSER_MCP_ALLOW_SCHEMES.split(',').map((s) => s.trim().toLowerCase())
        : ['http:', 'https:', 'about:', 'file:']
    ).filter(Boolean);
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.toLowerCase();
      if (!allowedSchemes.includes(scheme)) {
        throw new Error(
          `Refusing to navigate to disallowed scheme "${scheme}". Allowed: ${allowedSchemes.join(', ')}. ` +
            `Set BROWSER_MCP_ALLOW_SCHEMES to permit others.`,
        );
      }
      if (isMetadataHost(parsed.hostname)) {
        throw new Error(
          `Refusing to navigate to link-local/cloud-metadata host "${parsed.hostname}" (SSRF guard).`,
        );
      }
    } catch (err: any) {
      if (err?.message?.includes('Refusing to navigate')) throw err;
      throw new Error(`Invalid URL "${url}": ${err?.message || err}`);
    }

    const waitUntil = options.waitUntil || 'load';
    let targetUrl = url;
    let shiftWarning = '';

    if (isLocalUrl(url)) {
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        const originalPort = parsed.port
          ? parseInt(parsed.port, 10)
          : parsed.protocol === 'https:'
            ? 443
            : 80;

        let isListening = false;
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          isListening = await checkPortListening(originalPort, host);
          if (isListening) break;
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }

        if (!isListening) {
          // Port is closed, look for shifted ports (originalPort + 1, originalPort + 2)
          let shiftedPort: number | null = null;
          const potentialShifts = [originalPort + 1, originalPort + 2];
          for (const p of potentialShifts) {
            if (await checkPortListening(p, host)) {
              shiftedPort = p;
              break;
            }
          }

          if (shiftedPort !== null) {
            parsed.port = String(shiftedPort);
            targetUrl = parsed.toString();
            shiftWarning = ` (Warning: Local port ${originalPort} was closed. Automatically shifted to active port ${shiftedPort})`;
            console.warn(shiftWarning.trim());
          } else {
            const activePorts = await getActiveListeningPorts();
            throw new Error(
              `Failed to connect to local server at ${host}:${originalPort} (Connection Refused). ` +
                `Active listening TCP ports: ${activePorts.join(', ') || 'none'}. ` +
                `Please ensure your local server is running.`,
            );
          }
        }
      } catch (err: any) {
        if (err.message.includes('Connection Refused')) {
          throw err;
        }
      }
    }

    try {
      await this.page.goto(targetUrl, { waitUntil, timeout: 30000 });
    } catch (err: any) {
      if (isLocalUrl(targetUrl)) {
        const activePorts = await getActiveListeningPorts();
        throw new Error(
          `Failed to navigate to ${targetUrl}: ${err.message}. ` +
            `Active listening TCP ports: ${activePorts.join(', ') || 'none'}`,
        );
      }
      throw err;
    }

    // Re-enable CDP domains — cross-origin navigations can invalidate them.
    // This is critical: without this, Accessibility.getFullAXTree and
    // DOM.describeNode return empty results after cross-origin navigations.
    await this.enableCDPDomains();

    return `Navigated to ${targetUrl}${shiftWarning} (waitUntil: ${waitUntil})`;
  }

  // ─── Accessors ──────────────────────────────────────────────────────────

  getPage(): Page | null {
    return this.page;
  }

  getCDPSession(): CDPSession | null {
    return this.cdpSession;
  }

  getBrowser(): Browser | null {
    return this.browser;
  }

  getIsHeadless(): boolean {
    return this.isHeadless;
  }

  isConnected(): boolean {
    return this.browser !== null && this.browser.connected;
  }

  // ─── Frame Discovery ───────────────────────────────────────────────────

  async getFrameTree(): Promise<FrameInfo[]> {
    if (!this.cdpSession) return [];
    try {
      const result = (await this.cdpSession.send('Page.getFrameTree')) as {
        frameTree: {
          frame: { id: string; url: string; parentId?: string; securityOrigin: string };
          childFrames?: {
            frame: { id: string; url: string; parentId?: string; securityOrigin: string };
          }[];
        };
      };

      const frames: FrameInfo[] = [];
      const flatten = (tree: typeof result.frameTree) => {
        frames.push({
          frameId: tree.frame.id,
          url: tree.frame.url,
          parentFrameId: tree.frame.parentId,
          securityOrigin: tree.frame.securityOrigin,
        });
        if (tree.childFrames) {
          for (const child of tree.childFrames) {
            flatten(child as typeof result.frameTree);
          }
        }
      };
      flatten(result.frameTree);
      return frames;
    } catch {
      return [];
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /**
   * Enable all core CDP domains required for perception and interaction.
   * Must be called after launch AND after every cross-origin navigation,
   * because cross-origin navigations can invalidate domain enablement.
   */
  private async enableCDPDomains(): Promise<void> {
    if (!this.cdpSession) return;
    await this.cdpSession.send('Accessibility.enable');
    await this.cdpSession.send('DOM.enable');
    await this.cdpSession.send('Performance.enable');

    // Auto-attach to all targets (OOPIFs, service workers, etc.)
    await this.cdpSession.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  private findChromeExecutable(): string {
    for (const path of CHROME_PATHS) {
      if (existsSync(path)) {
        return path;
      }
    }
    throw new Error(
      'Google Chrome or Chromium executable not found. Please install Chrome or set executablePath.',
    );
  }

  // Listen for browser disconnection
  onDisconnected(callback: () => void): void {
    if (this.browser) {
      this.browser.once('disconnected', callback);
    }
  }
}
