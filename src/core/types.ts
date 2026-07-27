// ─── Shared Types for Best Browser MCP ──────────────────────────────────────
// All cross-module interfaces live here to prevent circular dependencies.

import type { CDPSession } from 'puppeteer-core';

// ─── CDP Connection ─────────────────────────────────────────────────────────

export interface LaunchOptions {
  headless?: boolean;
  userDataDir?: string;
  url?: string;
}

export interface BrowserContext {
  cdpSession: CDPSession;
  targetId: string;
  frameTree: FrameInfo[];
}

export interface FrameInfo {
  frameId: string;
  url: string;
  parentFrameId?: string;
  securityOrigin?: string;
}

// ─── Immutable Node Index (rrweb-style) ─────────────────────────────────────

export interface NodeSnapshot {
  stableId: number;
  backendNodeId: number;
  role: string;
  name: string;
  value?: string;
  properties?: { name: string; value: unknown }[];
  // Fused from DOMSnapshot geometry/styles (the "AX spine + layout" model).
  boundingBox?: BoundingBox;
  cursor?: string;
  clickable?: boolean;
  visible?: boolean;
  childIds: number[];
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StateDelta {
  added: NodeSnapshot[];
  removed: { stableId: number; role: string; name: string }[];
  modified: {
    stableId: number;
    changes: Record<string, { previous: unknown; current: unknown }>;
  }[];
  timestamp: number;
}

// ─── Telemetry Events ───────────────────────────────────────────────────────

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
  mimeType?: string;
  /** Request/response headers, with sensitive ones redacted (HAR-grade context). */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  eventType: 'request' | 'response' | 'failed';
  timestamp: number;
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
  type: 'click' | 'type' | 'keypress' | 'hover' | 'scroll' | 'input' | 'drag';
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
  interactions: {
    clicks: number;
    typing: number;
    keyPresses: number;
    scrolls: number;
    hovers: number;
  };
  cumulativeLayoutShift: number;
  detachedDOMNodes: number;
  jsErrors: string[];
  alerts: string[];
}

// ─── Layer 1: Action Primitives ─────────────────────────────────────────────

export type InteractionAction = 'click' | 'type' | 'hover' | 'scroll' | 'key' | 'drag_and_drop';

export interface AtomicInteractOptions {
  locatorStrategy: 'backendNodeId' | 'coordinate' | 'cssSelector' | 'accessibleName';
  locatorValue: string | number | [number, number];
  action: InteractionAction;
  text?: string; // For type action
  key?: string; // For key action
  direction?: 'up' | 'down' | 'top' | 'bottom'; // For scroll
  amount?: number; // For scroll
  frameIndex?: number; // Target frame
  timeoutMs?: number; // Wait for element
  dragToBackendNodeId?: number;
  dragToCoordinate?: [number, number];
  offset?: [number, number];
}

export interface SpatialValidationResult {
  valid: boolean;
  coordinates: { x: number; y: number };
  occluded?: boolean;
  occluder?: string; // CSS selector of blocking element
  occluderRect?: BoundingBox;
  targetRect?: BoundingBox;
}

// ─── Layer 2: Perception ────────────────────────────────────────────────────

export interface SemanticSurfaceOptions {
  semanticOnly?: boolean;
  frameIndex?: number;
}

export interface TelemetryDrilldownOptions {
  category: 'network' | 'console' | 'mutations' | 'interactions' | 'navigation';
  filter?: string;
}

// ─── Worker Messages ────────────────────────────────────────────────────────

export type WorkerRequest =
  | {
      type: 'serializeAXTree';
      id: string;
      nodes: unknown[];
      semanticOnly: boolean;
      targetBackendNodeId?: number;
    }
  | { type: 'computeStateDelta'; id: string; previous: unknown; current: unknown }
  | { type: 'frame'; data: string; timestamp: number }
  | { type: 'clear' }
  | { type: 'dump'; outputPath: string };

export type WorkerResponse =
  | { type: 'serializeAXTree'; id: string; markdown: string; renderedNodeIds: number[] }
  | { type: 'computeStateDelta'; id: string; delta: StateDelta }
  | {
      type: 'dump_complete';
      success: boolean;
      frameCount?: number;
      logCount?: number;
      outputPath?: string;
      error?: string;
    };

// ─── Ring Buffer Utility ────────────────────────────────────────────────────

export class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buffer = new Array<T>(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): T[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Wrap-around: oldest items are at `head`, newest just before it
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.toArray().filter(predicate);
  }
}
