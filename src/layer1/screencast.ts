// ─── Screencast ─────────────────────────────────────────────────────────────
// Non-blocking visual streaming using async CDP Page.startScreencast.
// Streams compressed JPEG frames to a rolling buffer without lagging the page.
// Designed for Canvas/WebGL interfaces where DOM inspection is meaningless.

import type { CDPSession } from 'puppeteer-core';
import type { WorkerBridge } from '../workers/workerBridge.js';
import ffmpegPath from 'ffmpeg-static';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export class ScreencastManager {
  private active = false;
  private latestFrame: { data: string; timestamp: number } | null = null;

  // Recording state
  private recordingFrames: { data: string; timestamp: number }[] = [];
  private isRecording = false;
  private recordingStartTimestamp = 0;
  private recordingLimitTimeout: NodeJS.Timeout | null = null;
  private recordingOutputDir = '';

  constructor(
    private cdpSession: CDPSession,
    private workerBridge?: WorkerBridge | null
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

      // Forward to worker's DVR buffer if available
      if (this.workerBridge) {
        this.workerBridge.postFrame(event.data, Date.now());
      }

      // Collect frames if recording is active
      if (this.isRecording) {
        this.recordingFrames.push({ data: event.data, timestamp: Date.now() });
      }

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

  isRecordingActive(): boolean {
    return this.isRecording;
  }

  /**
   * Start recording frames for video output.
   */
  async startRecording(outputDir?: string): Promise<string> {
    if (this.isRecording) {
      throw new Error('A recording is already in progress.');
    }

    this.recordingOutputDir = outputDir || join(process.cwd(), 'recordings', `rec_${Date.now()}`);
    mkdirSync(this.recordingOutputDir, { recursive: true });

    this.recordingFrames = [];
    this.recordingStartTimestamp = Date.now();
    this.isRecording = true;

    // Ensure screencast is active
    if (!this.active) {
      await this.start();
    }

    // Auto-stop after 5 minutes (safety limit)
    const MAX_DURATION_MS = 5 * 60 * 1000;
    this.recordingLimitTimeout = setTimeout(async () => {
      try {
        await this.stopRecording();
      } catch {
        // best effort
      }
    }, MAX_DURATION_MS);

    return `Recording started. Output directory: ${this.recordingOutputDir}`;
  }

  /**
   * Stop recording frames and compile MP4 video.
   */
  async stopRecording(): Promise<{
    status: string;
    outputDir: string;
    frameCount: number;
    durationSeconds: number;
    manifestPath: string;
    videoPath: string | null;
  }> {
    if (!this.isRecording) {
      throw new Error('No recording in progress.');
    }

    if (this.recordingLimitTimeout) {
      clearTimeout(this.recordingLimitTimeout);
      this.recordingLimitTimeout = null;
    }

    this.isRecording = false;
    const durationSeconds = Math.round((Date.now() - this.recordingStartTimestamp) / 1000);
    const frames = [...this.recordingFrames];
    this.recordingFrames = [];

    const outputDir = this.recordingOutputDir;

    // Write JPEGs to outputDir
    for (let i = 0; i < frames.length; i++) {
      const filename = `frame_${String(i).padStart(5, '0')}.jpg`;
      writeFileSync(join(outputDir, filename), Buffer.from(frames[i].data, 'base64'));
    }

    const fps = frames.length > 0 ? Math.max(1, Math.round(frames.length / Math.max(durationSeconds, 1))) : 1;
    const videoOutputPath = join(outputDir, 'recording.mp4');

    let videoPath: string | null = null;
    if (ffmpegPath && frames.length > 0) {
      try {
        execFileSync(ffmpegPath as any, [
          '-y',
          '-framerate', String(fps),
          '-i', join(outputDir, 'frame_%05d.jpg'),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          videoOutputPath,
        ], { timeout: 30_000 });
        videoPath = videoOutputPath;
      } catch (err) {
        console.error('ffmpeg assembly failed:', err);
      }
    }

    const manifest = {
      frameCount: frames.length,
      durationSeconds,
      startedAt: new Date(this.recordingStartTimestamp).toISOString(),
      stoppedAt: new Date().toISOString(),
      fps,
      videoPath,
      frames: frames.map((f, i) => ({
        index: i,
        file: `frame_${String(i).padStart(5, '0')}.jpg`,
        timestamp: f.timestamp,
        relativeMs: f.timestamp - this.recordingStartTimestamp,
      })),
    };

    const manifestPath = join(outputDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return {
      status: 'success',
      outputDir,
      frameCount: frames.length,
      durationSeconds,
      manifestPath,
      videoPath,
    };
  }
}
