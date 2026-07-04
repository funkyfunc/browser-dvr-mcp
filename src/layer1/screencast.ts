// ─── Screencast ─────────────────────────────────────────────────────────────
// Non-blocking visual streaming using async CDP Page.startScreencast.
// Streams compressed JPEG frames to a rolling buffer without lagging the page.
// Designed for Canvas/WebGL interfaces where DOM inspection is meaningless.

import type { CDPSession } from 'puppeteer-core';
import type { WorkerBridge } from '../workers/workerBridge.js';

export class ScreencastManager {
  private active = false;
  private latestFrame: { data: string; timestamp: number } | null = null;

  constructor(
    private cdpSession: CDPSession,
    private workerBridge: WorkerBridge
  ) {}

  /**
   * Start async screencast. Frames are delivered via CDP events
   * and routed to the worker's rolling buffer.
   */
  async start(): Promise<void> {
    if (this.active) return;

    await this.cdpSession.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,       // Compressed for token efficiency
      maxWidth: 1024,
      maxHeight: 576,
      everyNthFrame: 2,  // Every other frame to reduce load
    });

    this.active = true;

    this.cdpSession.on('Page.screencastFrame', (event: any) => {
      this.latestFrame = { data: event.data, timestamp: Date.now() };

      // Forward to worker's DVR buffer
      this.workerBridge.postFrame(event.data, Date.now());

      // Ack the frame to keep the stream flowing
      this.cdpSession.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
  }

  /**
   * Stop the screencast stream.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    try {
      await this.cdpSession.send('Page.stopScreencast');
    } catch {
      // Best effort
    }
    this.active = false;
  }

  /**
   * Get the latest captured frame without blocking the page.
   */
  getLatestFrame(): { data: string; timestamp: number; mimeType: string } | null {
    if (!this.latestFrame) return null;
    return {
      data: this.latestFrame.data,
      timestamp: this.latestFrame.timestamp,
      mimeType: 'image/jpeg',
    };
  }

  isActive(): boolean {
    return this.active;
  }
}
