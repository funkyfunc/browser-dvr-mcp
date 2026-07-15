// ─── BrowserSession ─────────────────────────────────────────────────────────
// The canonical owner of all per-session state that used to live as scattered
// mutable module globals in index.ts (telemetry, screencast, the node index,
// interception handler, and auto-history bookkeeping).
//
// Centralizing this into one object (a) removes the lifecycle hazard where a
// relaunch replaced `telemetry`/`screencast` without tearing down the previous
// instance — leaking a drain interval and a live screencast — and (b) is the
// unit the SessionRegistry hands out, making multi-tab / multi-session a matter
// of holding more than one BrowserSession rather than reworking global state.

import { ImmutableNodeIndex } from './ImmutableNodeIndex.js';
import { EventBus } from './EventBus.js';
import type { SessionTelemetryManager } from '../telemetry/SessionTelemetryManager.js';
import type { ScreencastManager } from '../layer1/screencast.js';

export type FetchInterceptHandler = (event: { requestId: string }) => Promise<void>;

let sessionSeq = 0;

export class BrowserSession {
  readonly id: string;

  // Per-session perception + telemetry state.
  readonly nodeIndex = new ImmutableNodeIndex();
  // Unified, provenance-tagged timeline of afferent + efferent events.
  readonly eventBus = new EventBus();
  telemetry: SessionTelemetryManager | null = null;
  screencast: ScreencastManager | null = null;
  fetchInterceptHandler: FetchInterceptHandler | null = null;

  // Auto-history bookkeeping.
  autoTrackHistory = false;
  sessionHistoryDir = '';
  stepCounter = 0;

  constructor() {
    this.id = `bsession-${++sessionSeq}`;
  }

  /**
   * Release everything this session owns. Safe to call more than once and safe
   * to call when nothing was ever started. This is the fix for the relaunch
   * leak: the old session is torn down before a new one takes over.
   */
  async teardown(): Promise<void> {
    if (this.screencast) {
      try {
        if (this.screencast.isRecordingActive()) {
          await this.screencast.stopRecording().catch(() => {});
        }
        await this.screencast.stop();
      } catch {
        // best effort
      }
      this.screencast = null;
    }
    if (this.telemetry) {
      this.telemetry.destroy();
      this.telemetry = null;
    }
    this.fetchInterceptHandler = null;
    this.nodeIndex.clear();
    this.eventBus.clear();
    this.autoTrackHistory = false;
    this.sessionHistoryDir = '';
    this.stepCounter = 0;
  }
}
