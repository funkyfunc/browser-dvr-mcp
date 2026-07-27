// ─── Session Recorder ───────────────────────────────────────────────────────
// Capture wiring for the flight recorder. Subscribes to the active session's
// EventBus (same pattern as SiteMemory), buffers the full provenance-tagged
// timeline, and captures periodic KEYFRAMES of the heavy modalities the per-event
// stream can't carry: a visual frame, a storage snapshot, and a state snapshot.
//
// The live-browser capture functions are INJECTED (grabFrame / grabStorage /
// grabState / now), so the recorder is fully unit-testable without Chrome. It
// writes visual frames to the SessionArchiveStore as binary at capture time and
// records their relative paths; on save it assembles and persists a SessionArchive.
//
// BROWSER_MCP_NO_MEMORY=1 disables recording; BROWSER_MCP_NO_VISUAL=1 keeps the
// timeline + storage/state but skips the (screen-content-bearing) visual frames.

import type { BusEvent } from '../core/EventBus.js';
import type { EventBus } from '../core/EventBus.js';
import { originKey } from '../persistence/store.js';
import type {
  SessionArchive,
  Keyframe,
  VisualKeyframe,
  StorageKeyframe,
  StateKeyframe,
} from './SessionArchive.js';
import type { SessionArchiveStore } from './SessionArchiveStore.js';

export interface CaptureDeps {
  grabFrame: () => Promise<{ base64: string; width?: number; height?: number } | null>;
  grabStorage: () => Promise<Omit<StorageKeyframe, 'kind' | 'timestamp'> | null>;
  grabState: () => Promise<Omit<StateKeyframe, 'kind' | 'timestamp'> | null>;
  now: () => number;
}

const CAP = { visual: 300, storage: 300, state: 300, events: 20000 } as const;

export class SessionRecorder {
  private buffer: BusEvent[] = [];
  private keyframes: Keyframe[] = [];
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameSeq = 0;
  private sessionId: string | null = null;
  private startUrl: string | undefined;
  private capturing = false;

  private readonly enabled = process.env.BROWSER_MCP_NO_MEMORY !== '1';
  private readonly visualEnabled = process.env.BROWSER_MCP_NO_VISUAL !== '1';

  constructor(private readonly store: SessionArchiveStore) {}

  /** Subscribe to a session's bus and begin buffering. Detaches from any prior bus. */
  attach(bus: EventBus, sessionId: string, startUrl?: string): void {
    if (!this.enabled) return;
    if (this.unsub) this.unsub();
    this.buffer = [];
    this.keyframes = [];
    this.frameSeq = 0;
    this.sessionId = sessionId;
    this.startUrl = startUrl;
    this.unsub = bus.subscribe((e) => {
      if (this.buffer.length < CAP.events) this.buffer.push(e);
    });
  }

  /** Start periodic keyframe capture. Safe to call once per session. */
  start(deps: CaptureDeps, intervalMs = 1000): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.captureKeyframe(deps);
    }, intervalMs);
    // Don't keep the process alive solely for capture.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Capture one keyframe across the requested modalities (all by default).
   * Every grab is best-effort: a failure yields no keyframe for that modality,
   * never an exception. Re-entrancy is guarded so a slow grab can't overlap.
   */
  async captureKeyframe(
    deps: CaptureDeps,
    kinds: ('visual' | 'storage' | 'state')[] = ['visual', 'storage', 'state'],
  ): Promise<void> {
    if (!this.enabled || !this.sessionId || this.capturing) return;
    this.capturing = true;
    try {
      const now = deps.now();

      if (kinds.includes('visual') && this.visualEnabled) {
        try {
          const frame = await deps.grabFrame();
          if (frame) {
            const path = await this.store.writeFrame(this.sessionId, this.frameSeq++, frame.base64);
            const kf: VisualKeyframe = {
              kind: 'visual',
              timestamp: now,
              path,
              width: frame.width,
              height: frame.height,
            };
            this.push(kf, CAP.visual);
          }
        } catch {
          /* best-effort */
        }
      }

      if (kinds.includes('storage')) {
        try {
          const s = await deps.grabStorage();
          if (s) this.push({ kind: 'storage', timestamp: now, ...s }, CAP.storage);
        } catch {
          /* best-effort */
        }
      }

      if (kinds.includes('state')) {
        try {
          const st = await deps.grabState();
          if (st) this.push({ kind: 'state', timestamp: now, ...st }, CAP.state);
        } catch {
          /* best-effort */
        }
      }
    } finally {
      this.capturing = false;
    }
  }

  /** Append a keyframe, evicting the oldest of that kind past the cap. */
  private push(kf: Keyframe, cap: number): void {
    this.keyframes.push(kf);
    const ofKind = this.keyframes.filter((k) => k.kind === kf.kind);
    if (ofKind.length > cap) {
      const drop = ofKind[0];
      const i = this.keyframes.indexOf(drop);
      if (i >= 0) this.keyframes.splice(i, 1);
    }
  }

  /** Assemble the current buffer + keyframes into a SessionArchive. */
  buildArchive(now: number, name?: string): SessionArchive {
    const events = this.buffer;
    const origin = this.startUrl ? originKey(this.startUrl) : undefined;
    return {
      version: 1,
      meta: {
        id: this.sessionId ?? `sess_${now}`,
        startedAt: events.length ? events[0].timestamp : null,
        endedAt: events.length ? events[events.length - 1].timestamp : now,
        startUrl: this.startUrl,
        origin,
        eventCount: events.length,
        name,
      },
      events: [...events],
      keyframes: [...this.keyframes],
    };
  }

  /** Build and persist the archive; returns the saved archive's meta. */
  async save(now: number, name?: string): Promise<SessionArchive | null> {
    if (!this.enabled || !this.sessionId) return null;
    const archive = this.buildArchive(now, name);
    await this.store.save(archive);
    return archive;
  }

  get id(): string | null {
    return this.sessionId;
  }
}
