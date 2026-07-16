// ─── Site Memory ────────────────────────────────────────────────────────────
// Durable, per-origin comprehension that compounds across sessions. Instead of
// re-deriving a site from scratch every run, we distill the provenance-tagged
// event timeline into a structural model per origin: reusable element landmarks,
// successful action flows, and encountered gotchas.
//
// Privacy: structural fingerprints only (roles/names/relative geometry) — never
// captured input values. URLs are redacted; the JsonStore redacts payloads as a
// backstop; everything is origin-scoped; BROWSER_MCP_NO_MEMORY=1 disables it.

import type { BusEvent } from '../core/EventBus.js';
import type { EventBus } from '../core/EventBus.js';
import { JsonStore, originKey } from '../persistence/store.js';
import { redactUrl } from '../security/redaction.js';

export interface Landmark {
  role: string;
  name: string;
  action: string;
}
export interface FlowStep {
  action: string;
  role?: string;
  name?: string;
  coordinates?: { x: number; y: number };
}
export interface Flow {
  steps: FlowStep[];
  recordedAt: number;
}
export interface Gotcha {
  action: string;
  reason: string;
}
export interface SiteModel {
  origin: string;
  landmarks: Landmark[];
  flows: Flow[];
  gotchas: Gotcha[];
  navGraph: { from: string; to: string }[];
  stats: { visitCount: number; firstSeen: number; lastSeen: number };
}

const CAP = { landmarks: 200, flows: 20, gotchas: 50, navGraph: 100 } as const;

function emptyModel(origin: string, now: number): SiteModel {
  return {
    origin,
    landmarks: [],
    flows: [],
    gotchas: [],
    navGraph: [],
    stats: { visitCount: 0, firstSeen: now, lastSeen: now },
  };
}

const lmKey = (l: Landmark) => `${l.role}|${l.name}|${l.action}`;

/**
 * Distill a batch of timeline events for one origin into (or merged onto) a
 * SiteModel. Pure — unit-tested with synthetic events.
 */
export function distill(
  origin: string,
  events: BusEvent[],
  existing: SiteModel | undefined,
  now: number,
): SiteModel {
  const model = existing ?? emptyModel(origin, now);

  const landmarks = new Map(model.landmarks.map((l) => [lmKey(l), l]));
  const gotchas = new Map(model.gotchas.map((g) => [`${g.action}|${g.reason}`, g]));
  const flowSteps: FlowStep[] = [];

  for (const e of events) {
    if (e.kind !== 'action') continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const action = String(d.action ?? 'action');
    const role = typeof d.targetRole === 'string' ? d.targetRole : undefined;
    const name = typeof d.targetName === 'string' ? d.targetName : undefined;
    const coordinates = d.coordinates as { x: number; y: number } | undefined;

    if (d.success !== false) {
      flowSteps.push({ action, role, name, coordinates });
      if (role || name) {
        const lm: Landmark = { role: role ?? '', name: name ?? '', action };
        landmarks.set(lmKey(lm), lm);
      }
    } else {
      const reason = String(d.feedback ?? '')
        .split('\n')[0]
        .slice(0, 160);
      gotchas.set(`${action}|${reason}`, { action, reason });
    }
  }

  // Navigation graph (URLs already redacted on the bus; redact again defensively).
  const navUrls = events
    .filter((e) => e.kind === 'navigation')
    .map((e) => redactUrl(String((e.data as Record<string, unknown>).url ?? '')));
  const navGraph = [...model.navGraph];
  for (let i = 1; i < navUrls.length; i++) {
    navGraph.push({ from: navUrls[i - 1], to: navUrls[i] });
  }
  const seenNav = new Set<string>();
  const dedupedNav = navGraph.filter((n) => {
    const k = `${n.from}->${n.to}`;
    if (seenNav.has(k)) return false;
    seenNav.add(k);
    return true;
  });

  const flows = [...model.flows];
  if (flowSteps.length > 0) flows.push({ steps: flowSteps, recordedAt: now });

  return {
    origin,
    landmarks: [...landmarks.values()].slice(-CAP.landmarks),
    flows: flows.slice(-CAP.flows),
    gotchas: [...gotchas.values()].slice(-CAP.gotchas),
    navGraph: dedupedNav.slice(-CAP.navGraph),
    stats: {
      visitCount: model.stats.visitCount + 1,
      firstSeen: model.stats.firstSeen,
      lastSeen: now,
    },
  };
}

export class SiteMemory {
  private store = new JsonStore<SiteModel>('site-memory');
  private buffer: BusEvent[] = [];
  private currentOrigin: string | null = null;
  private unsub: (() => void) | null = null;
  private readonly enabled = process.env.BROWSER_MCP_NO_MEMORY !== '1';

  /** Subscribe to a session's event bus. Detaches from any prior bus. */
  attach(bus: EventBus): void {
    if (!this.enabled) return;
    if (this.unsub) this.unsub();
    this.buffer = [];
    this.currentOrigin = null;
    this.unsub = bus.subscribe((e) => this.onEvent(e));
  }

  private onEvent(e: BusEvent): void {
    if (e.kind === 'navigation') {
      const origin = originKey(String((e.data as Record<string, unknown>).url ?? ''));
      if (this.currentOrigin && origin !== this.currentOrigin) {
        // Origin changed mid-session (e.g. OAuth popup) — persist the old one first.
        void this.flushOrigin(this.currentOrigin, this.buffer.slice());
        this.buffer = [];
      }
      this.currentOrigin = origin;
    }
    this.buffer.push(e);
  }

  private async flushOrigin(origin: string, events: BusEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.store.merge(origin, (existing) => distill(origin, events, existing, Date.now()));
  }

  /** Persist buffered events for the current origin (call on browser_close). */
  async flush(): Promise<void> {
    if (!this.enabled || !this.currentOrigin) return;
    await this.flushOrigin(this.currentOrigin, this.buffer.slice());
    this.buffer = [];
  }

  /** What we know about the origin of `url` (undefined if nothing/disabled). */
  async recall(url: string): Promise<SiteModel | undefined> {
    if (!this.enabled) return undefined;
    return this.store.read(originKey(url));
  }
}
