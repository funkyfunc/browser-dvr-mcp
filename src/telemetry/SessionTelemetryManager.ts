// ─── SessionTelemetryManager ────────────────────────────────────────────────
// The "Black Box" flight recorder. Uses low-overhead CDP listeners to silently
// capture network traffic, console exceptions, and DOM mutations in memory.
//
// Implements the Progressive Disclosure pattern:
// 1. getSummary() → token-efficient overview (counts, alerts)
// 2. drillDown(category, filter) → surgical extraction of specific events
//
// All buffers are capped ring buffers to prevent unbounded memory growth.

import type { CDPSession, Page } from 'puppeteer-core';
import {
  RingBuffer,
  type NavigationEvent,
  type NetworkEvent,
  type ConsoleEvent,
  type MutationEvent,
  type InteractionEvent,
  type SessionSummary,
} from '../core/types.js';

let sessionCounter = 0;

export class SessionTelemetryManager {
  public readonly id: string;
  public readonly startedAt: number;
  public readonly mode: 'agent' | 'human';

  // Capped ring buffers — O(1) push, bounded memory
  private networkBuffer = new RingBuffer<NetworkEvent>(5000);
  private consoleBuffer = new RingBuffer<ConsoleEvent>(2000);
  private mutationBuffer = new RingBuffer<MutationEvent>(5000);
  private interactionLog: InteractionEvent[] = [];
  private navigationHistory: NavigationEvent[] = [];

  // Aggregate counters — O(1) reads for summary
  private cumulativeLayoutShift = 0;
  private unhandledExceptionCount = 0;
  private failedRequestCount = 0;

  // Pending request tracking
  private pendingRequests = new Map<string, { method: string; url: string; timestamp: number }>();
  private requestIdCounter = 0;
  private currentUrl = '';

  constructor(mode: 'agent' | 'human' = 'agent') {
    sessionCounter++;
    this.id = `sess_${Date.now()}_${sessionCounter}`;
    this.startedAt = Date.now();
    this.mode = mode;
  }

  // ─── CDP Listener Wiring ──────────────────────────────────────────────

  /**
   * Attaches all CDP event listeners to silently capture telemetry.
   * This is the zero-overhead passive recording layer.
   */
  attachToPage(page: Page): void {
    // Console events
    page.on('console', (msg) => {
      this.consoleBuffer.push({
        level: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      });
    });

    page.on('pageerror', (err: unknown) => {
      this.unhandledExceptionCount++;
      this.consoleBuffer.push({
        level: 'error',
        text: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    });

    // Network events
    page.on('request', (req) => {
      const reqId = `req-${++this.requestIdCounter}`;
      (req as any).__telemetryReqId = reqId;
      this.pendingRequests.set(reqId, {
        method: req.method(),
        url: req.url(),
        timestamp: Date.now(),
      });
      this.networkBuffer.push({
        id: reqId,
        method: req.method(),
        url: req.url(),
        eventType: 'request',
        timestamp: Date.now(),
      });
    });

    page.on('response', (res) => {
      const reqId = (res.request() as any).__telemetryReqId || 'req-unknown';
      const pending = this.pendingRequests.get(reqId);
      const duration = pending ? Date.now() - pending.timestamp : undefined;
      this.pendingRequests.delete(reqId);

      if (res.status() >= 400) {
        this.failedRequestCount++;
      }

      this.networkBuffer.push({
        id: reqId,
        method: res.request().method(),
        url: res.url(),
        status: res.status(),
        duration,
        eventType: 'response',
        timestamp: Date.now(),
      });
    });

    page.on('requestfailed', (req) => {
      const reqId = (req as any).__telemetryReqId || 'req-unknown';
      const pending = this.pendingRequests.get(reqId);
      const duration = pending ? Date.now() - pending.timestamp : undefined;
      this.pendingRequests.delete(reqId);
      this.failedRequestCount++;

      this.networkBuffer.push({
        id: reqId,
        method: req.method(),
        url: req.url(),
        duration,
        eventType: 'failed',
        timestamp: Date.now(),
        errorText: req.failure()?.errorText,
      });
    });
  }

  /**
   * Sets up CDP-level listeners for CLS tracking.
   */
  async attachToCDP(cdpSession: CDPSession): Promise<void> {
    // Enable performance observer for CLS tracking via CDP
    try {
      await cdpSession.send('Performance.enable');
    } catch {
      // Best effort
    }
  }

  // ─── Event Ingestion ──────────────────────────────────────────────────

  addNavigation(url: string, statusCode?: number): void {
    this.currentUrl = url;
    this.navigationHistory.push({ url, timestamp: Date.now(), statusCode });
  }

  addMutation(type: string, targetId?: string, details?: unknown): void {
    this.mutationBuffer.push({ type, timestamp: Date.now(), targetId, details });
  }

  addInteraction(event: InteractionEvent): void {
    this.interactionLog.push({ ...event, timestamp: event.timestamp || Date.now() });
  }

  addLayoutShift(value: number): void {
    this.cumulativeLayoutShift += value;
  }

  // ─── Layer 2: Progressive Disclosure ──────────────────────────────────

  /**
   * Token-efficient summary. The primary observability entry point.
   * Agent should call this FIRST, then drill down into specific categories.
   */
  getSummary(): SessionSummary {
    const now = Date.now();
    const durationMs = now - this.startedAt;
    const durationSec = (durationMs / 1000).toFixed(1);

    const allNetwork = this.networkBuffer.toArray();
    const responses = allNetwork.filter(e => e.eventType === 'response');
    const failures = allNetwork.filter(e => e.eventType === 'failed');
    const okCount = responses.filter(e => e.status !== undefined && e.status < 400).length;

    const allConsole = this.consoleBuffer.toArray();
    const logs = allConsole.filter(e => ['log', 'info', 'debug'].includes(e.level)).length;
    const warnings = allConsole.filter(e => ['warning', 'warn'].includes(e.level)).length;
    const errors = allConsole.filter(e => e.level === 'error').length;

    const allMutations = this.mutationBuffer.toArray();
    const structural = allMutations.filter(e => e.type === 'childList').length;
    const attribute = allMutations.filter(e => e.type === 'attributes').length;

    const clicks = this.interactionLog.filter(e => e.type === 'click').length;
    const typing = this.interactionLog.filter(e => e.type === 'type' || e.type === 'input').length;
    const keyPresses = this.interactionLog.filter(e => e.type === 'keypress').length;
    const scrolls = this.interactionLog.filter(e => e.type === 'scroll').length;
    const hovers = this.interactionLog.filter(e => e.type === 'hover').length;

    // JS errors
    const jsErrors = allConsole
      .filter(e => e.level === 'error' && e.text.startsWith('Uncaught'))
      .map(e => e.text.substring(0, 200));

    // Auto-generated alerts
    const alerts: string[] = [];

    const serverErrors = responses.filter(e => e.status !== undefined && e.status >= 500);
    for (const err of serverErrors.slice(0, 5)) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} → ${err.status}`);
    }

    const clientErrors = responses.filter(e => e.status !== undefined && e.status >= 400 && e.status < 500);
    for (const err of clientErrors.slice(0, 5)) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} → ${err.status}`);
    }
    if (clientErrors.length > 5) {
      alerts.push(`  ...and ${clientErrors.length - 5} more 4xx errors`);
    }

    for (const f of failures.slice(0, 3)) {
      alerts.push(`🔴 ${f.method} ${this.truncateUrl(f.url)} failed${f.errorText ? `: ${f.errorText}` : ''}`);
    }

    for (const err of jsErrors.slice(0, 3)) {
      alerts.push(`🔴 ${err}`);
    }

    const slowRequests = responses.filter(e => e.duration !== undefined && e.duration > 2000);
    if (slowRequests.length > 0) {
      alerts.push(`🐢 ${slowRequests.length} slow request(s) over 2s`);
    }

    if (this.cumulativeLayoutShift > 0.1) {
      alerts.push(`📐 CLS: ${this.cumulativeLayoutShift.toFixed(3)} (threshold: 0.1)`);
    }

    const pagesVisited = this.navigationHistory.map(n => {
      const statusStr = n.statusCode ? ` (${n.statusCode})` : '';
      return `${this.truncateUrl(n.url)}${statusStr}`;
    });

    return {
      sessionId: this.id,
      mode: this.mode,
      duration: `${durationSec}s`,
      currentUrl: this.currentUrl || '(no navigation)',
      pagesVisited,
      network: {
        total: responses.length + failures.length,
        ok: okCount,
        failed: this.failedRequestCount,
        pending: this.pendingRequests.size,
      },
      console: { logs, warnings, errors },
      mutations: { total: allMutations.length, structural, attribute },
      interactions: { clicks, typing, keyPresses, scrolls, hovers },
      cumulativeLayoutShift: this.cumulativeLayoutShift,
      detachedDOMNodes: 0, // Updated externally via CDP Performance.getMetrics
      jsErrors,
      alerts,
    };
  }

  /**
   * Progressive disclosure drill-down. Returns detailed events for a specific category.
   */
  drillDown(category: string, filter?: string): unknown {
    switch (category) {
      case 'network':
        return this.drillDownNetwork(filter);
      case 'console':
        return this.drillDownConsole(filter);
      case 'mutations':
        return this.drillDownMutations(filter);
      case 'interactions':
        return this.drillDownInteractions(filter);
      case 'navigation':
        return this.navigationHistory;
      default:
        return { error: `Unknown category '${category}'. Valid: network, console, mutations, interactions, navigation` };
    }
  }

  // ─── Drill-Down Implementations ───────────────────────────────────────

  private drillDownNetwork(filter?: string): NetworkEvent[] {
    const events = this.networkBuffer.filter(e => e.eventType === 'response' || e.eventType === 'failed');
    if (!filter) return events;

    switch (filter) {
      case 'failed':
        return events.filter(e => e.eventType === 'failed' || (e.status !== undefined && e.status >= 400));
      case 'slow':
        return events.filter(e => e.duration !== undefined && e.duration > 2000);
      case 'api':
        return events.filter(e => {
          const url = e.url.toLowerCase();
          return url.includes('/api/') || url.includes('/graphql') ||
            (e.resourceType && ['xhr', 'fetch'].includes(e.resourceType));
        });
      default:
        if (filter.startsWith('status:')) {
          const code = parseInt(filter.split(':')[1], 10);
          return events.filter(e => e.status === code);
        }
        if (filter.startsWith('id:')) {
          const id = filter.slice(3);
          return this.networkBuffer.filter(e => e.id === id);
        }
        return events.filter(e => e.url.includes(filter));
    }
  }

  private drillDownConsole(filter?: string): ConsoleEvent[] {
    const events = this.consoleBuffer.toArray();
    if (!filter) return events;

    switch (filter) {
      case 'errors':
        return events.filter(e => e.level === 'error');
      case 'warnings':
        return events.filter(e => ['warning', 'warn'].includes(e.level));
      default:
        return events.filter(e => e.text.toLowerCase().includes(filter.toLowerCase()));
    }
  }

  private drillDownMutations(filter?: string): MutationEvent[] {
    const events = this.mutationBuffer.toArray();
    if (!filter) return events;

    switch (filter) {
      case 'structural':
        return events.filter(e => e.type === 'childList');
      case 'attributes':
        return events.filter(e => e.type === 'attributes');
      default:
        return events.filter(e => e.targetId === filter);
    }
  }

  private drillDownInteractions(filter?: string): InteractionEvent[] {
    if (!filter) return this.interactionLog;

    switch (filter) {
      case 'clicks':
        return this.interactionLog.filter(e => e.type === 'click');
      case 'typing':
        return this.interactionLog.filter(e => e.type === 'type' || e.type === 'input');
      case 'keys':
        return this.interactionLog.filter(e => e.type === 'keypress');
      default:
        return this.interactionLog;
    }
  }

  // ─── Timeline (for Human Recording alignment) ─────────────────────────

  getTimeline(sinceMs?: number): unknown[] {
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const events: { type: string; timestamp: number; data: unknown }[] = [];

    for (const e of this.networkBuffer.toArray()) {
      if (e.timestamp >= cutoff) events.push({ type: 'network', timestamp: e.timestamp, data: e });
    }
    for (const e of this.consoleBuffer.toArray()) {
      if (e.timestamp >= cutoff) events.push({ type: 'console', timestamp: e.timestamp, data: e });
    }
    for (const e of this.interactionLog) {
      if (e.timestamp >= cutoff) events.push({ type: 'interaction', timestamp: e.timestamp, data: e });
    }
    for (const e of this.navigationHistory) {
      if (e.timestamp >= cutoff) events.push({ type: 'navigation', timestamp: e.timestamp, data: e });
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ─── Serialization ────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      id: this.id,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      mode: this.mode,
      currentUrl: this.currentUrl,
      navigations: this.navigationHistory,
      networkEvents: this.networkBuffer.toArray(),
      consoleEvents: this.consoleBuffer.toArray(),
      mutationEvents: this.mutationBuffer.toArray(),
      interactionEvents: this.interactionLog,
    }, null, 2);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private truncateUrl(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname + u.search;
      if (path.length > 60) return u.hostname + path.substring(0, 57) + '...';
      return u.hostname + path;
    } catch {
      return url.length > 80 ? url.substring(0, 77) + '...' : url;
    }
  }
}
