// ─── Handoff Controller ─────────────────────────────────────────────────────
// Human takeover WITHIN a live agent session. When an agent can't reproduce a
// behavior, it hands control to a human, who reproduces it in the same browser
// window. Unlike the standalone start_human_recording (a separate browser with
// orphan telemetry), this emits the human's actions onto the SESSION EventBus
// with `user` provenance — so the Time Machine recorder (already subscribed to
// that bus) captures the human's reproduction into the same durable archive:
// screen/network/storage/state keyframes plus the human's clicks and inputs.
//
// The human signals "done" either by telling the agent (which calls end) or with
// an in-browser chord (Ctrl/Cmd+Shift+Enter) the tracker records — so the exact
// end moment is timestamped on the timeline regardless.

import type { Page } from 'puppeteer-core';
import type { EventBus } from '../core/EventBus.js';
import { redactText } from '../security/redaction.js';
import { HUMAN_INTERACTION_TRACKER } from '../layer2/humanRecording.js';

interface RawHumanEvent {
  type: string;
  x?: number;
  y?: number;
  target?: string;
  text?: string;
  value?: string;
  key?: string;
  timestamp: number;
}

export interface HandoffSummary {
  active: boolean;
  interactionCount: number;
  startedAt: number | null;
  endedAt: number | null;
  /** True if the human ended via the in-browser Ctrl/Cmd+Shift+Enter chord. */
  signaledByHuman: boolean;
  note?: string;
}

export class HandoffController {
  private bus: EventBus | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private startedAt: number | null = null;
  private count = 0;
  private signaled = false;
  private note?: string;

  isActive(): boolean {
    return this.bus !== null;
  }

  /** Begin a handoff: inject the tracker into the live page and stream human
   *  events onto the session bus as `user`-trust interactions. */
  async begin(page: Page, bus: EventBus, note?: string): Promise<void> {
    if (this.bus) throw new Error('A handoff is already active. Call browser_end_handoff first.');
    this.bus = bus;
    this.startedAt = Date.now();
    this.count = 0;
    this.signaled = false;
    this.note = note;

    // Survive navigations + take effect on the currently-loaded page.
    await page.evaluateOnNewDocument(HUMAN_INTERACTION_TRACKER);
    await page.evaluate(HUMAN_INTERACTION_TRACKER).catch(() => {});

    bus.emit('interaction', 'user', { type: 'handoff-start', note }, this.startedAt);

    this.poll = setInterval(() => {
      void this.drain(page);
    }, 500);
    (this.poll as { unref?: () => void }).unref?.();
  }

  /** Drain buffered human events from the page and emit them onto the bus. */
  private async drain(page: Page): Promise<void> {
    if (!this.bus) return;
    let events: RawHumanEvent[] = [];
    try {
      events = (await page.evaluate(() => {
        const w = window as unknown as { __bbmcp_human_events?: RawHumanEvent[] };
        const out = w.__bbmcp_human_events ?? [];
        w.__bbmcp_human_events = [];
        return out;
      })) as RawHumanEvent[];
    } catch {
      return; // page may be navigating
    }
    for (const e of events) {
      if (e.type === 'handoff_done') {
        this.signaled = true;
        this.bus.emit('interaction', 'user', { type: 'handoff-signal' }, e.timestamp);
        continue;
      }
      this.count++;
      this.bus.emit(
        'interaction',
        'user',
        {
          type: e.type,
          target: e.target,
          text: e.text ? redactText(e.text) : undefined,
          value: e.value ? redactText(e.value) : undefined,
          key: e.key,
          x: e.x,
          y: e.y,
          source: 'human',
        },
        e.timestamp,
      );
    }
  }

  /** End the handoff: final drain, stop polling, mark the end on the timeline. */
  async end(page: Page): Promise<HandoffSummary> {
    if (!this.bus) throw new Error('No active handoff. Call browser_begin_handoff first.');
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    await this.drain(page); // capture anything since the last tick
    const endedAt = Date.now();
    this.bus.emit('interaction', 'user', { type: 'handoff-end' }, endedAt);

    const summary: HandoffSummary = {
      active: false,
      interactionCount: this.count,
      startedAt: this.startedAt,
      endedAt,
      signaledByHuman: this.signaled,
      note: this.note,
    };
    this.bus = null;
    this.startedAt = null;
    this.count = 0;
    this.signaled = false;
    this.note = undefined;
    return summary;
  }

  /** Force-stop without a final drain (used on teardown when the page is gone). */
  abort(): void {
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.bus = null;
    this.startedAt = null;
    this.count = 0;
    this.signaled = false;
    this.note = undefined;
  }

  /** Current status without ending. */
  status(): HandoffSummary {
    return {
      active: this.isActive(),
      interactionCount: this.count,
      startedAt: this.startedAt,
      endedAt: null,
      signaledByHuman: this.signaled,
      note: this.note,
    };
  }
}
