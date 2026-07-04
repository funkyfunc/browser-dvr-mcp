// ─── Human Recording ────────────────────────────────────────────────────────
// Pauses agent automation for a human developer takeover. The Black Box
// continuously records physical clicks, console logs, and network traffic.
//
// Once stopped, the server aligns the telemetry streams (DVR loop) and
// delivers a synchronized, timestamped semantic timeline of the human's
// successful replication back to the agent.

import { CDPConnectionManager } from '../core/CDPConnectionManager.js';
import { SessionTelemetryManager } from '../telemetry/SessionTelemetryManager.js';

const HUMAN_INTERACTION_TRACKER = `
(function() {
  if (window.__bbmcp_human_tracker) return;
  window.__bbmcp_human_tracker = true;
  window.__bbmcp_human_events = [];

  document.addEventListener('click', (e) => {
    const t = e.target;
    const tag = t.tagName ? t.tagName.toLowerCase() : 'unknown';
    const id = t.id ? '#' + t.id : '';
    const text = (t.innerText || t.textContent || '').substring(0, 50).trim();
    window.__bbmcp_human_events.push({
      type: 'click', x: e.clientX, y: e.clientY,
      target: tag + id, text, timestamp: Date.now()
    });
  }, true);

  document.addEventListener('input', (e) => {
    const t = e.target;
    const tag = t.tagName ? t.tagName.toLowerCase() : 'unknown';
    const id = t.id ? '#' + t.id : '';
    window.__bbmcp_human_events.push({
      type: 'input', target: tag + id,
      value: t.value ? t.value.substring(0, 100) : '',
      timestamp: Date.now()
    });
  }, true);

  document.addEventListener('keydown', (e) => {
    if (['Enter', 'Escape', 'Tab', 'Backspace', 'Delete'].includes(e.key) || e.ctrlKey || e.metaKey) {
      window.__bbmcp_human_events.push({
        type: 'keypress',
        key: (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Cmd+' : '') + e.key,
        timestamp: Date.now()
      });
    }
  }, true);
})();
`;

export class HumanRecordingManager {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connectionManager: CDPConnectionManager;
  private telemetry: SessionTelemetryManager | null = null;

  constructor(connectionManager: CDPConnectionManager) {
    this.connectionManager = connectionManager;
  }

  /**
   * Start a human recording session. Opens a visible browser.
   */
  async start(url?: string): Promise<{
    sessionId: string;
    message: string;
    telemetry: SessionTelemetryManager;
  }> {
    const { page, cdpSession } = await this.connectionManager.launchHeadful();

    this.telemetry = new SessionTelemetryManager('human');
    this.telemetry.attachToPage(page);
    await this.telemetry.attachToCDP(cdpSession);

    // Inject human interaction tracker
    await page.evaluateOnNewDocument(HUMAN_INTERACTION_TRACKER);
    await page.evaluate(HUMAN_INTERACTION_TRACKER).catch(() => {});

    if (url) {
      await page.goto(url, { waitUntil: 'load' });
      await page.evaluate(HUMAN_INTERACTION_TRACKER).catch(() => {});
      this.telemetry.addNavigation(url);
    }

    // Poll for human interactions
    this.pollTimer = setInterval(async () => {
      const currentPage = this.connectionManager.getPage();
      if (!currentPage) return;
      try {
        const interactions = await currentPage.evaluate(() => {
          const win = window as any;
          const result = win.__bbmcp_human_events || [];
          win.__bbmcp_human_events = [];
          return result;
        });
        for (const interaction of interactions) {
          this.telemetry?.addInteraction(interaction);
        }
      } catch {
        // Page may have navigated
      }
    }, 500);

    // Track navigation changes
    page.on('framenavigated', async () => {
      try {
        const currentPage = this.connectionManager.getPage();
        await currentPage?.evaluate(HUMAN_INTERACTION_TRACKER).catch(() => {});
        const pageUrl = currentPage?.url();
        if (pageUrl && pageUrl !== 'about:blank') {
          this.telemetry?.addNavigation(pageUrl);
        }
      } catch { /* ignore */ }
    });

    // Auto-stop on browser close
    this.connectionManager.onDisconnected(() => {
      this.stop().catch(() => {});
    });

    return {
      sessionId: this.telemetry.id,
      message: `Human recording started${url ? ` at ${url}` : ''}. Interact with the browser, then call stop_human_recording.`,
      telemetry: this.telemetry,
    };
  }

  /**
   * Stop the recording and return the synchronized timeline.
   */
  async stop(): Promise<{
    sessionId: string;
    summary: unknown;
    timeline: unknown[];
  }> {
    if (!this.telemetry) {
      throw new Error('No active human recording session.');
    }

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Final poll
    const currentPage = this.connectionManager.getPage();
    if (currentPage) {
      try {
        const interactions = await currentPage.evaluate(() => {
          const win = window as any;
          const result = win.__bbmcp_human_events || [];
          win.__bbmcp_human_events = [];
          return result;
        });
        for (const interaction of interactions) {
          this.telemetry.addInteraction(interaction);
        }
      } catch { /* ignore */ }
    }

    const summary = this.telemetry.getSummary();
    const timeline = this.telemetry.getTimeline();

    await this.connectionManager.close();

    const result = {
      sessionId: summary.sessionId,
      summary,
      timeline,
    };

    this.telemetry = null;
    return result;
  }

  getTelemetry(): SessionTelemetryManager | null {
    return this.telemetry;
  }
}
