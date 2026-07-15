// Mock-free unit tests for BrowserSession + SessionRegistry lifecycle.
// Verifies the A5 fix: relaunch tears down the previous session's telemetry and
// screencast instead of leaking them.
import { describe, it, expect } from 'vitest';
import { BrowserSession } from '../../src/core/BrowserSession.js';
import { SessionRegistry } from '../../src/core/SessionRegistry.js';

function fakeTelemetry() {
  return {
    destroyed: 0,
    destroy() {
      this.destroyed++;
    },
  };
}

function fakeScreencast(recording = false) {
  return {
    recording,
    stopped: 0,
    recordingStopped: 0,
    isRecordingActive() {
      return this.recording;
    },
    async stopRecording() {
      this.recordingStopped++;
      this.recording = false;
    },
    async stop() {
      this.stopped++;
    },
  };
}

describe('BrowserSession.teardown', () => {
  it('destroys telemetry, stops screencast, and resets state', async () => {
    const s = new BrowserSession();
    const tel = fakeTelemetry();
    const cast = fakeScreencast(true);
    s.telemetry = tel as any;
    s.screencast = cast as any;
    s.fetchInterceptHandler = async () => {};
    s.autoTrackHistory = true;
    s.sessionHistoryDir = '/tmp/x';
    s.stepCounter = 7;

    await s.teardown();

    expect(tel.destroyed).toBe(1);
    expect(cast.recordingStopped).toBe(1); // active recording stopped
    expect(cast.stopped).toBe(1);
    expect(s.telemetry).toBeNull();
    expect(s.screencast).toBeNull();
    expect(s.fetchInterceptHandler).toBeNull();
    expect(s.autoTrackHistory).toBe(false);
    expect(s.sessionHistoryDir).toBe('');
    expect(s.stepCounter).toBe(0);
  });

  it('is safe on an untouched session', async () => {
    const s = new BrowserSession();
    await expect(s.teardown()).resolves.toBeUndefined();
  });
});

describe('SessionRegistry', () => {
  it('exposes a default active session', () => {
    const reg = new SessionRegistry();
    expect(reg.active()).toBeInstanceOf(BrowserSession);
    expect(reg.ids().length).toBe(1);
  });

  it('reset() tears down the old session and swaps in a fresh one', async () => {
    const reg = new SessionRegistry();
    const first = reg.active();
    const tel = fakeTelemetry();
    first.telemetry = tel as any;

    const second = await reg.reset();

    expect(tel.destroyed).toBe(1); // old session torn down (the leak fix)
    expect(second).not.toBe(first);
    expect(reg.active()).toBe(second);
    expect(reg.ids().length).toBe(1); // old session removed
    expect(reg.get(first.id)).toBeUndefined();
  });

  it('closeActive() tears down but keeps a valid idle session', async () => {
    const reg = new SessionRegistry();
    const active = reg.active();
    const cast = fakeScreencast(false);
    active.screencast = cast as any;

    await reg.closeActive();

    expect(cast.stopped).toBe(1);
    expect(reg.active()).toBe(active); // still present
    expect(reg.active().screencast).toBeNull(); // but idle
  });
});
