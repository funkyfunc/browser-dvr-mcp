// ─── SessionRegistry ────────────────────────────────────────────────────────
// Owns the set of BrowserSessions and which one is active. Today it holds a
// single default session, but the shape (a keyed map + an active id) is what
// multi-tab / multi-client support grows into — tools resolve their context
// from here instead of from module globals.

import { BrowserSession } from './BrowserSession.js';

export class SessionRegistry {
  private sessions = new Map<string, BrowserSession>();
  private activeId: string;

  constructor() {
    const first = new BrowserSession();
    this.sessions.set(first.id, first);
    this.activeId = first.id;
  }

  /** The currently active session. Always defined. */
  active(): BrowserSession {
    return this.sessions.get(this.activeId)!;
  }

  get(id: string): BrowserSession | undefined {
    return this.sessions.get(id);
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Tear down the active session and replace it with a fresh one. Used by
   * browser_launch so relaunching never leaks the previous session's telemetry
   * interval or screencast. Returns the new active session.
   */
  async reset(): Promise<BrowserSession> {
    const old = this.sessions.get(this.activeId);
    if (old) {
      await old.teardown();
      this.sessions.delete(old.id);
    }
    const next = new BrowserSession();
    this.sessions.set(next.id, next);
    this.activeId = next.id;
    return next;
  }

  /**
   * Tear down the active session's resources but keep an (empty) session in
   * place, so post-close reads see a valid-but-idle session (telemetry null,
   * etc.) exactly as the old module-global model did after browser_close.
   */
  async closeActive(): Promise<void> {
    const active = this.sessions.get(this.activeId);
    if (active) await active.teardown();
  }
}
