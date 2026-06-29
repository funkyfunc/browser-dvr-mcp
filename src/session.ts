import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

// ─── Event Types ──────────────────────────────────────────────────────────────

export interface NavigationEvent {
  url: string;
  timestamp: number;
  statusCode?: number;
}

export interface NetworkEvent {
  id: string;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
  resourceType?: string;
  eventType: 'request' | 'response' | 'failed';
  timestamp: number;
  responseBody?: string;
  errorText?: string;
}

export interface ConsoleEvent {
  level: string;
  text: string;
  timestamp: number;
  source?: string;
}

export interface MutationEvent {
  type: string;
  timestamp: number;
  targetId?: string;
  details?: unknown;
}

export interface InteractionEvent {
  type: 'click' | 'type' | 'keypress' | 'hover' | 'scroll' | 'input';
  timestamp: number;
  target?: string;
  text?: string;
  x?: number;
  y?: number;
  key?: string;
  details?: string;
}

export interface SessionSummary {
  sessionId: string;
  mode: 'agent' | 'human';
  duration: string;
  currentUrl: string;
  pagesVisited: string[];
  network: { total: number; ok: number; failed: number; pending: number };
  console: { logs: number; warnings: number; errors: number };
  mutations: { total: number; structural: number; attribute: number };
  interactions: { clicks: number; typing: number; keyPresses: number; scrolls: number; hovers: number };
  jsErrors: string[];
  alerts: string[];
}

// ─── Session Class ────────────────────────────────────────────────────────────

let sessionCounter = 0;

export class Session {
  public readonly id: string;
  public readonly startedAt: number;
  public readonly mode: 'agent' | 'human';

  private navigations: NavigationEvent[] = [];
  private networkEvents: NetworkEvent[] = [];
  private consoleEvents: ConsoleEvent[] = [];
  private mutationEvents: MutationEvent[] = [];
  private interactionEvents: InteractionEvent[] = [];

  private pendingRequests = new Map<string, { method: string; url: string; timestamp: number }>();
  private currentUrl = '';

  constructor(mode: 'agent' | 'human' = 'agent') {
    sessionCounter++;
    this.id = `sess_${Date.now()}_${sessionCounter}`;
    this.startedAt = Date.now();
    this.mode = mode;
  }

  // ─── Event Ingestion ────────────────────────────────────────────────────

  addNavigation(url: string, statusCode?: number) {
    this.currentUrl = url;
    this.navigations.push({ url, timestamp: Date.now(), statusCode });
  }

  addNetworkRequest(id: string, method: string, url: string) {
    this.pendingRequests.set(id, { method, url, timestamp: Date.now() });
    this.networkEvents.push({
      id, method, url, eventType: 'request', timestamp: Date.now(),
    });
  }

  addNetworkResponse(id: string, url: string, method: string, status: number, size?: number, resourceType?: string) {
    const pending = this.pendingRequests.get(id);
    const duration = pending ? Date.now() - pending.timestamp : undefined;
    this.pendingRequests.delete(id);
    this.networkEvents.push({
      id, method, url, status, duration, size, resourceType,
      eventType: 'response', timestamp: Date.now(),
    });
  }

  addNetworkFailure(id: string, url: string, method: string, errorText?: string) {
    const pending = this.pendingRequests.get(id);
    const duration = pending ? Date.now() - pending.timestamp : undefined;
    this.pendingRequests.delete(id);
    this.networkEvents.push({
      id, method, url, duration, eventType: 'failed', timestamp: Date.now(), errorText,
    });
  }

  addConsoleEvent(level: string, text: string, source?: string) {
    this.consoleEvents.push({ level, text, timestamp: Date.now(), source });
  }

  addMutation(type: string, targetId?: string, details?: unknown) {
    this.mutationEvents.push({ type, timestamp: Date.now(), targetId, details });
  }

  addInteraction(event: InteractionEvent) {
    this.interactionEvents.push({ ...event, timestamp: event.timestamp || Date.now() });
  }

  // ─── Summary Generation ─────────────────────────────────────────────────

  getSummary(): SessionSummary {
    const now = Date.now();
    const durationMs = now - this.startedAt;
    const durationSec = (durationMs / 1000).toFixed(1);

    // Network stats
    const responses = this.networkEvents.filter(e => e.eventType === 'response');
    const failures = this.networkEvents.filter(e => e.eventType === 'failed');
    const okCount = responses.filter(e => e.status && e.status < 400).length;
    const failedCount = responses.filter(e => e.status && e.status >= 400).length + failures.length;

    // Console stats
    const logs = this.consoleEvents.filter(e => e.level === 'log' || e.level === 'info' || e.level === 'debug').length;
    const warnings = this.consoleEvents.filter(e => e.level === 'warning' || e.level === 'warn').length;
    const errors = this.consoleEvents.filter(e => e.level === 'error').length;

    // Mutation stats
    const structural = this.mutationEvents.filter(e => e.type === 'childList').length;
    const attribute = this.mutationEvents.filter(e => e.type === 'attributes').length;

    // Interaction stats
    const clicks = this.interactionEvents.filter(e => e.type === 'click').length;
    const typing = this.interactionEvents.filter(e => e.type === 'type' || e.type === 'input').length;
    const keyPresses = this.interactionEvents.filter(e => e.type === 'keypress').length;
    const scrolls = this.interactionEvents.filter(e => e.type === 'scroll').length;
    const hovers = this.interactionEvents.filter(e => e.type === 'hover').length;

    // JS errors (uncaught exceptions from console)
    const jsErrors = this.consoleEvents
      .filter(e => e.level === 'error' && e.text.startsWith('Uncaught'))
      .map(e => e.text.substring(0, 200));

    // Auto-generated alerts
    const alerts: string[] = [];

    // Flag server errors
    const serverErrors = responses.filter(e => e.status && e.status >= 500);
    for (const err of serverErrors) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} returned ${err.status}`);
    }

    // Flag client errors (4xx)
    const clientErrors = responses.filter(e => e.status && e.status >= 400 && e.status < 500);
    for (const err of clientErrors.slice(0, 5)) {
      alerts.push(`⚠ ${err.method} ${this.truncateUrl(err.url)} returned ${err.status}`);
    }
    if (clientErrors.length > 5) {
      alerts.push(`  ...and ${clientErrors.length - 5} more 4xx errors`);
    }

    // Flag failed requests
    for (const f of failures.slice(0, 3)) {
      alerts.push(`🔴 ${f.method} ${this.truncateUrl(f.url)} failed${f.errorText ? `: ${f.errorText}` : ''}`);
    }

    // Flag JS errors
    for (const err of jsErrors.slice(0, 3)) {
      alerts.push(`🔴 ${err}`);
    }

    // Flag slow requests (> 2s)
    const slowRequests = responses.filter(e => e.duration && e.duration > 2000);
    if (slowRequests.length > 0) {
      alerts.push(`🐢 ${slowRequests.length} slow request(s) over 2s`);
    }

    // Pages visited
    const pagesVisited = this.navigations.map(n => {
      const statusStr = n.statusCode ? ` (${n.statusCode})` : '';
      return `${this.truncateUrl(n.url)}${statusStr}`;
    });

    return {
      sessionId: this.id,
      mode: this.mode,
      duration: `${durationSec}s`,
      currentUrl: this.currentUrl || '(no navigation)',
      pagesVisited,
      network: { total: responses.length + failures.length, ok: okCount, failed: failedCount, pending: this.pendingRequests.size },
      console: { logs, warnings, errors },
      mutations: { total: this.mutationEvents.length, structural, attribute },
      interactions: { clicks, typing, keyPresses, scrolls, hovers },
      jsErrors,
      alerts,
    };
  }

  // ─── Drilldown ──────────────────────────────────────────────────────────

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
        return this.navigations;
      default:
        return { error: `Unknown category '${category}'. Valid: network, console, mutations, interactions, navigation` };
    }
  }

  private drillDownNetwork(filter?: string): NetworkEvent[] {
    const responses = this.networkEvents.filter(e => e.eventType === 'response' || e.eventType === 'failed');

    if (!filter) return responses;

    switch (filter) {
      case 'failed':
        return responses.filter(e => e.eventType === 'failed' || (e.status && e.status >= 400));
      case 'slow':
        return responses.filter(e => e.duration && e.duration > 2000);
      case 'api':
        return responses.filter(e => {
          const url = e.url.toLowerCase();
          return url.includes('/api/') || url.includes('/graphql') ||
                 (e.resourceType && (e.resourceType === 'xhr' || e.resourceType === 'fetch'));
        });
      default:
        // Support status:NNN filter
        if (filter.startsWith('status:')) {
          const code = parseInt(filter.split(':')[1], 10);
          return responses.filter(e => e.status === code);
        }
        // Support requestId filter
        if (filter.startsWith('req-') || filter.startsWith('id:')) {
          const id = filter.replace('id:', '');
          return this.networkEvents.filter(e => e.id === id);
        }
        // Text search on URL
        return responses.filter(e => e.url.includes(filter));
    }
  }

  private drillDownConsole(filter?: string): ConsoleEvent[] {
    if (!filter) return this.consoleEvents;

    switch (filter) {
      case 'errors':
        return this.consoleEvents.filter(e => e.level === 'error');
      case 'warnings':
        return this.consoleEvents.filter(e => e.level === 'warning' || e.level === 'warn');
      default:
        // Text search
        return this.consoleEvents.filter(e =>
          e.text.toLowerCase().includes(filter.toLowerCase())
        );
    }
  }

  private drillDownMutations(filter?: string): MutationEvent[] {
    if (!filter) return this.mutationEvents;

    switch (filter) {
      case 'structural':
        return this.mutationEvents.filter(e => e.type === 'childList');
      case 'attributes':
        return this.mutationEvents.filter(e => e.type === 'attributes');
      default:
        // Filter by elementId
        return this.mutationEvents.filter(e => e.targetId === filter);
    }
  }

  private drillDownInteractions(filter?: string): InteractionEvent[] {
    if (!filter) return this.interactionEvents;

    switch (filter) {
      case 'clicks':
        return this.interactionEvents.filter(e => e.type === 'click');
      case 'typing':
        return this.interactionEvents.filter(e => e.type === 'type' || e.type === 'input');
      case 'keys':
        return this.interactionEvents.filter(e => e.type === 'keypress');
      default:
        return this.interactionEvents;
    }
  }

  // ─── Serialization ──────────────────────────────────────────────────────

  serialize(): string {
    return JSON.stringify({
      id: this.id,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      mode: this.mode,
      currentUrl: this.currentUrl,
      navigations: this.navigations,
      networkEvents: this.networkEvents,
      consoleEvents: this.consoleEvents,
      mutationEvents: this.mutationEvents,
      interactionEvents: this.interactionEvents,
    }, null, 2);
  }

  saveToDisk(sessionsDir: string): string {
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    const filePath = join(sessionsDir, `${this.id}.session.json`);
    writeFileSync(filePath, this.serialize());
    return filePath;
  }

  static load(filePath: string): Session {
    if (!existsSync(filePath)) {
      throw new Error(`Session file not found: ${filePath}`);
    }
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const session = new Session(data.mode || 'human');

    // Override readonly fields via Object.defineProperty
    Object.defineProperty(session, 'id', { value: data.id, writable: false });
    Object.defineProperty(session, 'startedAt', { value: data.startedAt, writable: false });

    // Restore event arrays
    (session as any).navigations = data.navigations || [];
    (session as any).networkEvents = data.networkEvents || [];
    (session as any).consoleEvents = data.consoleEvents || [];
    (session as any).mutationEvents = data.mutationEvents || [];
    (session as any).interactionEvents = data.interactionEvents || [];
    (session as any).currentUrl = data.currentUrl || '';

    return session;
  }

  static listSessions(sessionsDir: string): { id: string; file: string; mode: string; startedAt: string; duration: string }[] {
    if (!existsSync(sessionsDir)) return [];

    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.session.json'));
    return files.map(file => {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
        const durationMs = (data.endedAt || Date.now()) - data.startedAt;
        return {
          id: data.id || file.replace('.session.json', ''),
          file: join(sessionsDir, file),
          mode: data.mode || 'unknown',
          startedAt: new Date(data.startedAt).toISOString(),
          duration: `${(durationMs / 1000).toFixed(1)}s`,
        };
      } catch {
        return { id: file, file: join(sessionsDir, file), mode: 'unknown', startedAt: 'unknown', duration: 'unknown' };
      }
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

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
