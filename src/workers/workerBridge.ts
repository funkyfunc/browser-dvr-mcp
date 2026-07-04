// ─── Worker Bridge ──────────────────────────────────────────────────────────
// Type-safe RPC bridge between the main thread and the serialization worker.
// Uses a pending promise map to correlate request/response pairs over the
// MessagePort channel.

import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class WorkerBridge {
  private worker: Worker;
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private requestCounter = 0;

  constructor() {
    // Try compiled JS first, fall back to TS with tsx loader
    let workerPath = join(__dirname, 'serializationWorker.js');
    if (!existsSync(workerPath)) {
      workerPath = join(__dirname, 'serializationWorker.ts');
    }

    // Fail fast if neither file exists (happens in esbuild --bundle builds
    // where the worker is inlined into the main bundle)
    if (!existsSync(workerPath)) {
      throw new Error(
        `Serialization worker not found at ${workerPath}. DVR frame buffering unavailable.`,
      );
    }

    this.worker = new Worker(workerPath, {
      execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [],
    });

    this.worker.on('message', (msg) => {
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve } = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);
        resolve(msg);
      }
    });

    this.worker.on('error', (err) => {
      console.error('Serialization worker error:', err);
    });
  }

  /**
   * Serialize an AX tree to compressed Markdown.
   * Runs entirely on the worker thread.
   */
  async serializeAXTree(nodes: unknown[], semanticOnly: boolean): Promise<string> {
    const id = `ax-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (msg: any) => resolve(msg.markdown),
        reject,
      });
      this.worker.postMessage({ type: 'serializeAXTree', id, nodes, semanticOnly });

      // Safety timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('AX tree serialization timed out (10s)'));
        }
      }, 10000);
    });
  }

  /**
   * Compute state delta between two snapshots.
   * Runs entirely on the worker thread.
   */
  async computeStateDelta(previous: unknown, current: unknown): Promise<unknown> {
    const id = `delta-${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (msg: any) => resolve(msg.delta),
        reject,
      });
      this.worker.postMessage({ type: 'computeStateDelta', id, previous, current });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('State delta computation timed out (10s)'));
        }
      }, 10000);
    });
  }

  /**
   * Send a screencast frame to the worker's DVR buffer.
   */
  postFrame(data: string, timestamp: number): void {
    this.worker.postMessage({ type: 'frame', data, timestamp });
  }

  /**
   * Clear all DVR buffers.
   */
  clearBuffers(): void {
    this.worker.postMessage({ type: 'clear' });
  }

  /**
   * Terminate the worker thread.
   */
  async terminate(): Promise<void> {
    this.pendingRequests.clear();
    await this.worker.terminate();
  }
}
