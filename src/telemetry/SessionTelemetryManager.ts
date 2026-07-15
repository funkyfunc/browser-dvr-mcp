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
import type { EventBus, EventKind, Trust } from '../core/EventBus.js';
import { redactUrl, redactText } from '../security/redaction.js';
import {
  RingBuffer,
  type NavigationEvent,
  type NetworkEvent,
  type ConsoleEvent,
  type MutationEvent,
  type InteractionEvent,
  type SessionSummary,
} from '../core/types.js';

const MUTATION_INJECT_SCRIPT = `
(function() {
  if (window.__mcp_observer_initialized) return;
  window.__mcp_observer_initialized = true;
  window.__mcp_frame_prefix = Math.random().toString(36).substring(2, 6);
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
      id = window.__mcp_frame_prefix + '-' + window.__mcp_id_seq++;
      node.setAttribute('data-mcp-id', id);
    }
    return id;
  }

  function isSensitiveField(el) {
    try {
      var type = (el.type || '').toLowerCase();
      if (type === 'password') return true;
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.indexOf('cc-') === 0 || ac === 'current-password' || ac === 'new-password' || ac === 'one-time-code') return true;
      var hay = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
      return /pass|passwd|pwd|card|cvv|cvc|ssn|secret|otp|token/.test(hay);
    } catch (e) { return true; }
  }

  function attachInputListener(el) {
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      if (el.__mcp_input_listener_attached) return;
      el.__mcp_input_listener_attached = true;
      el.addEventListener('input', () => {
        const id = getOrAssignId(el);
        // Redact sensitive values in-page so secrets never reach the Node
        // process, the agent context, or disk.
        const payload = {
          type: 'input',
          targetId: id,
          value: isSensitiveField(el) ? '[REDACTED]' : el.value,
          timestamp: Date.now()
        };
        report(payload);
      });
    }
  }

  function report(payload) {
    if (typeof window.__mcp_report_mutation === 'function') {
      window.__mcp_report_mutation(payload).catch(() => {});
    } else {
      window.__mcp_mutations.push(payload);
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

      report(payload);
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

let sessionCounter = 0;

export class SessionTelemetryManager {
  private static readonly MAX_PENDING_REQUESTS = 2000;

  private drainInterval: NodeJS.Timeout | null = null;
  // Pages this telemetry is attached to. Supports multi-tab: one session's
  // telemetry captures events from every tab it owns without duplicate listeners.
  private attachedPages = new Set<Page>();
  public readonly id: string;
  public readonly startedAt: number;
  public readonly mode: 'agent' | 'human';

  // Capped ring buffers — O(1) push, bounded memory
  private networkBuffer = new RingBuffer<NetworkEvent>(5000);
  private consoleBuffer = new RingBuffer<ConsoleEvent>(2000);
  private mutationBuffer = new RingBuffer<MutationEvent>(5000);
  // Bounded like the other buffers — a long-lived session can otherwise grow
  // these two without limit (the class contract promises all buffers are capped).
  private interactionLog = new RingBuffer<InteractionEvent>(5000);
  private navigationHistory = new RingBuffer<NavigationEvent>(1000);

  // Aggregate counters — O(1) reads for summary
  private cumulativeLayoutShift = 0;
  private unhandledExceptionCount = 0;
  private failedRequestCount = 0;

  // Pending request tracking
  private pendingRequests = new Map<string, { method: string; url: string; timestamp: number }>();
  private requestIdCounter = 0;
  private currentUrl = '';
  private lastMutationAt = 0;

  // Optional unified timeline. Events are mirrored here with provenance tags in
  // addition to the category buffers, so the bus is the single trust-aware
  // stream the causal/replay layer reads from.
  private readonly eventBus: EventBus | null;

  constructor(mode: 'agent' | 'human' = 'agent', eventBus: EventBus | null = null) {
    sessionCounter++;
    this.id = `sess_${Date.now()}_${sessionCounter}`;
    this.startedAt = Date.now();
    this.mode = mode;
    this.eventBus = eventBus;
  }

  /** Mirror an event onto the provenance-tagged bus, if one is attached. */
  private toBus(kind: EventKind, trust: Trust, data: unknown, timestamp?: number): void {
    this.eventBus?.emit(kind, trust, data, timestamp);
  }

  // ─── CDP Listener Wiring ──────────────────────────────────────────────

  /**
   * Attaches all CDP event listeners to silently capture telemetry.
   * This is the zero-overhead passive recording layer.
   */
  attachToPage(page: Page): void {
    // Idempotent per page so re-attaching (or attaching multiple tabs) never
    // double-registers console/network listeners.
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.once('close', () => this.attachedPages.delete(page));

    // Expose mutation reporting function to the browser
    page
      .exposeFunction('__mcp_report_mutation', (mutation: any) => {
        this.addMutation(mutation.type, mutation.targetId, mutation);
      })
      .catch(() => {});

    // Inject mutation tracker on document load
    page.evaluateOnNewDocument(MUTATION_INJECT_SCRIPT).catch(() => {});

    // Immediate injection into existing frames
    page.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
    for (const frame of page.frames()) {
      frame.evaluate(MUTATION_INJECT_SCRIPT).catch(() => {});
    }

    // A single polling interval drains mutations/layout-shifts from ALL attached
    // pages (multi-tab), created once on first attach.
    if (!this.drainInterval) {
      this.drainInterval = setInterval(async () => {
        for (const p of this.attachedPages) {
          try {
            await Promise.all(
              p.frames().map(async (frame) => {
                try {
                  const result = await frame.evaluate(() => {
                    const win = window as any;
                    const resMutations = win.__mcp_mutations || [];
                    win.__mcp_mutations = [];
                    const resCls = win.__mcp_cls || 0;
                    win.__mcp_cls = 0;
                    return { mutations: resMutations, cls: resCls };
                  });
                  if (result) {
                    for (const m of result.mutations) {
                      this.addMutation(m.type, m.targetId, m);
                    }
                    if (result.cls > 0) {
                      this.addLayoutShift(result.cls);
                    }
                  }
                } catch {
                  // Ignore frame-specific errors (cross-origin, context destroyed)
                }
              }),
            );
          } catch {
            // Page might be closed or navigated
          }
        }
      }, 1000);
    }

    // Console events (token-shaped secrets scrubbed on ingest)
    page.on('console', (msg) => {
      const ts = Date.now();
      const level = msg.type();
      const text = redactText(msg.text());
      this.consoleBuffer.push({ level, text, timestamp: ts });
      // Console text is authored by the page — untrusted.
      this.toBus('console', 'page-controlled', { level, text }, ts);
    });

    page.on('pageerror', (err: unknown) => {
      this.unhandledExceptionCount++;
      this.consoleBuffer.push({
        level: 'error',
        text: redactText(`Uncaught exception: ${err instanceof Error ? err.message : String(err)}`),
        timestamp: Date.now(),
      });
    });

    // Network events
    page.on('request', (req) => {
      const reqId = `req-${++this.requestIdCounter}`;
      (req as any).__telemetryReqId = reqId;
      // Long-lived requests (SSE, websockets, hung fetches) never fire
      // response/requestfailed, so evict the oldest pending entry once the map
      // exceeds a sane bound to keep memory (and the pending count) in check.
      if (this.pendingRequests.size >= SessionTelemetryManager.MAX_PENDING_REQUESTS) {
        const oldest = this.pendingRequests.keys().next().value;
        if (oldest !== undefined) this.pendingRequests.delete(oldest);
      }
      const reqUrl = redactUrl(req.url());
      this.pendingRequests.set(reqId, {
        method: req.method(),
        url: reqUrl,
        timestamp: Date.now(),
      });
      this.networkBuffer.push({
        id: reqId,
        method: req.method(),
        url: reqUrl,
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

      const respEvent: NetworkEvent = {
        id: reqId,
        method: res.request().method(),
        url: redactUrl(res.url()),
        status: res.status(),
        duration,
        eventType: 'response',
        timestamp: Date.now(),
      };
      this.networkBuffer.push(respEvent);
      this.toBus('network', 'page-controlled', respEvent, respEvent.timestamp);
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
        url: redactUrl(req.url()),
        duration,
        eventType: 'failed',
        timestamp: Date.now(),
        errorText: req.failure()?.errorText,
      });
    });
  }

  destroy(): void {
    if (this.drainInterval) {
      clearInterval(this.drainInterval);
      this.drainInterval = null;
    }
    this.attachedPages.clear();
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
    const safeUrl = redactUrl(url);
    const ts = Date.now();
    this.currentUrl = safeUrl;
    this.navigationHistory.push({ url: safeUrl, timestamp: ts, statusCode });
    // URL text is page-influenced — tag as page-controlled (untrusted).
    this.toBus('navigation', 'page-controlled', { url: safeUrl, statusCode }, ts);
  }

  private interactions(): InteractionEvent[] {
    return this.interactionLog.toArray();
  }

  private navigations(): NavigationEvent[] {
    return this.navigationHistory.toArray();
  }

  addMutation(type: string, targetId?: string, details?: unknown): void {
    const ts = Date.now();
    this.lastMutationAt = ts;
    this.mutationBuffer.push({ type, timestamp: ts, targetId, details });
    // Mutation payloads are authored by the page — untrusted.
    this.toBus('mutation', 'page-controlled', { type, targetId, details }, ts);
  }

  /** Timestamp of the most recent observed DOM mutation (0 if none yet). */
  getLastMutationTime(): number {
    return this.lastMutationAt;
  }

  addInteraction(event: InteractionEvent): void {
    const ts = event.timestamp || Date.now();
    this.interactionLog.push({ ...event, timestamp: ts });
    // Interactions are efferent: our tool's output, or a human's when recording.
    this.toBus('interaction', this.mode === 'human' ? 'user' : 'tool-output', event, ts);
  }

  addLayoutShift(value: number): void {
    this.cumulativeLayoutShift += value;
  }

  /**
   * Returns the number of currently in-flight (pending) network requests.
   * Used by the wait-for-condition module to implement the `network_idle` condition.
   */
  getPendingRequestCount(): number {
    return this.pendingRequests.size;
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
    const responses = allNetwork.filter((e) => e.eventType === 'response');
    const failures = allNetwork.filter((e) => e.eventType === 'failed');
    const okCount = responses.filter((e) => e.status !== undefined && e.status < 400).length;

    const allConsole = this.consoleBuffer.toArray();
    const logs = allConsole.filter((e) => ['log', 'info', 'debug'].includes(e.level)).length;
    const warnings = allConsole.filter((e) => ['warning', 'warn'].includes(e.level)).length;
    const errors = allConsole.filter((e) => e.level === 'error').length;

    const allMutations = this.mutationBuffer.toArray();
    const structural = allMutations.filter((e) => e.type === 'childList').length;
    const attribute = allMutations.filter((e) => e.type === 'attributes').length;

    const allInteractions = this.interactions();
    const clicks = allInteractions.filter((e) => e.type === 'click').length;
    const typing = allInteractions.filter((e) => e.type === 'type' || e.type === 'input').length;
    const keyPresses = allInteractions.filter((e) => e.type === 'keypress').length;
    const scrolls = allInteractions.filter((e) => e.type === 'scroll').length;
    const hovers = allInteractions.filter((e) => e.type === 'hover').length;

    // JS errors
    const jsErrors = allConsole
      .filter((e) => e.level === 'error' && e.text.startsWith('Uncaught'))
      .map((e) => e.text.substring(0, 200));

    // Auto-generated alerts
    const alerts: string[] = [];

    const serverErrors = responses.filter((e) => e.status !== undefined && e.status >= 500);
    for (const err of serverErrors.slice(0, 5)) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} → ${err.status}`);
    }

    const clientErrors = responses.filter(
      (e) => e.status !== undefined && e.status >= 400 && e.status < 500,
    );
    for (const err of clientErrors.slice(0, 5)) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} → ${err.status}`);
    }
    if (clientErrors.length > 5) {
      alerts.push(`  ...and ${clientErrors.length - 5} more 4xx errors`);
    }

    for (const f of failures.slice(0, 3)) {
      alerts.push(
        `🔴 ${f.method} ${this.truncateUrl(f.url)} failed${f.errorText ? `: ${f.errorText}` : ''}`,
      );
    }

    for (const err of jsErrors.slice(0, 3)) {
      alerts.push(`🔴 ${err}`);
    }

    const slowRequests = responses.filter((e) => e.duration !== undefined && e.duration > 2000);
    if (slowRequests.length > 0) {
      alerts.push(`🐢 ${slowRequests.length} slow request(s) over 2s`);
    }

    if (this.cumulativeLayoutShift > 0.1) {
      alerts.push(`📐 CLS: ${this.cumulativeLayoutShift.toFixed(3)} (threshold: 0.1)`);
    }

    const pagesVisited = this.navigations().map((n) => {
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
        return this.navigations();
      default:
        return {
          error: `Unknown category '${category}'. Valid: network, console, mutations, interactions, navigation`,
        };
    }
  }

  // ─── Drill-Down Implementations ───────────────────────────────────────

  private drillDownNetwork(filter?: string): NetworkEvent[] {
    const events = this.networkBuffer.filter(
      (e) => e.eventType === 'response' || e.eventType === 'failed',
    );
    if (!filter) return events;

    switch (filter) {
      case 'failed':
        return events.filter(
          (e) => e.eventType === 'failed' || (e.status !== undefined && e.status >= 400),
        );
      case 'slow':
        return events.filter((e) => e.duration !== undefined && e.duration > 2000);
      case 'api':
        return events.filter((e) => {
          const url = e.url.toLowerCase();
          return (
            url.includes('/api/') ||
            url.includes('/graphql') ||
            (e.resourceType && ['xhr', 'fetch'].includes(e.resourceType))
          );
        });
      default:
        if (filter.startsWith('status:')) {
          const code = parseInt(filter.split(':')[1], 10);
          return events.filter((e) => e.status === code);
        }
        if (filter.startsWith('id:')) {
          const id = filter.slice(3);
          return this.networkBuffer.filter((e) => e.id === id);
        }
        return events.filter((e) => e.url.includes(filter));
    }
  }

  private drillDownConsole(filter?: string): ConsoleEvent[] {
    const events = this.consoleBuffer.toArray();
    if (!filter) return events;

    switch (filter) {
      case 'errors':
        return events.filter((e) => e.level === 'error');
      case 'warnings':
        return events.filter((e) => ['warning', 'warn'].includes(e.level));
      default:
        return events.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase()));
    }
  }

  private drillDownMutations(filter?: string): MutationEvent[] {
    const events = this.mutationBuffer.toArray();
    if (!filter) return events;

    switch (filter) {
      case 'structural':
        return events.filter((e) => e.type === 'childList');
      case 'attributes':
        return events.filter((e) => e.type === 'attributes');
      default:
        return events.filter((e) => e.targetId === filter);
    }
  }

  private drillDownInteractions(filter?: string): InteractionEvent[] {
    const all = this.interactions();
    if (!filter) return all;

    switch (filter) {
      case 'clicks':
        return all.filter((e) => e.type === 'click');
      case 'typing':
        return all.filter((e) => e.type === 'type' || e.type === 'input');
      case 'keys':
        return all.filter((e) => e.type === 'keypress');
      default:
        return all;
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
    for (const e of this.interactions()) {
      if (e.timestamp >= cutoff)
        events.push({ type: 'interaction', timestamp: e.timestamp, data: e });
    }
    for (const e of this.navigations()) {
      if (e.timestamp >= cutoff)
        events.push({ type: 'navigation', timestamp: e.timestamp, data: e });
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  // ─── Serialization ────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify(
      {
        id: this.id,
        startedAt: this.startedAt,
        endedAt: Date.now(),
        mode: this.mode,
        currentUrl: this.currentUrl,
        navigations: this.navigations(),
        networkEvents: this.networkBuffer.toArray(),
        consoleEvents: this.consoleBuffer.toArray(),
        mutationEvents: this.mutationBuffer.toArray(),
        interactionEvents: this.interactions(),
      },
      null,
      2,
    );
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
