// ─── CDPConnectionManager ───────────────────────────────────────────────────
// Owns the browser lifecycle: launch, connect, close, and auto-attach to all
// execution contexts (OOPIFs, Service Workers, etc.) via Target.setAutoAttach.
// This is the ONLY module that holds references to puppeteer-core.

import puppeteer, { Browser, Page, CDPSession } from 'puppeteer-core';
import { existsSync } from 'fs';
import type { LaunchOptions, FrameInfo } from './types.js';

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
  private page: Page | null = null;
  private cdpSession: CDPSession | null = null;
  private isHeadless = true;

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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-features=site-per-process', // Allow same-process iframes for easier CDP access
      ],
      userDataDir: options.userDataDir,
      defaultViewport: { width: 1280, height: 720 },
    });

    this.page = await this.browser.newPage();
    this.cdpSession = await this.page.createCDPSession();

    // Enable core CDP domains
    await this.enableCDPDomains();

    const message = `Browser launched (headless: ${headless}).`;
    return { cdpSession: this.cdpSession, page: this.page, message };
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      userDataDir: options.userDataDir,
      defaultViewport: null,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());
    this.cdpSession = await this.page.createCDPSession();

    await this.enableCDPDomains();

    return {
      cdpSession: this.cdpSession,
      page: this.page,
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
    const waitUntil = options.waitUntil || 'load';
    await this.page.goto(url, { waitUntil, timeout: 30000 });

    // Re-enable CDP domains — cross-origin navigations can invalidate them.
    // This is critical: without this, Accessibility.getFullAXTree and
    // DOM.describeNode return empty results after cross-origin navigations.
    await this.enableCDPDomains();

    return `Navigated to ${url} (waitUntil: ${waitUntil})`;
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
