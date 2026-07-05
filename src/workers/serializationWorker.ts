// ─── Serialization Worker ────────────────────────────────────────────────────
// Runs in a dedicated worker_thread to offload CPU-intensive operations:
// 1. AX tree → Markdown serialization (string manipulation)
// 2. State delta computation (deep comparison)
// 3. DVR frame buffering (binary data management)
//
// This prevents heavy serialization from choking the main Node.js event loop
// and blocking the JSON-RPC transport.

import { parentPort } from 'worker_threads';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { serializeAXTreeToMarkdown } from '../core/treeSerializer.js';

// ─── State Delta Computation ────────────────────────────────────────────────

interface SnapshotNode {
  stableId: number;
  backendNodeId: number;
  role: string;
  name: string;
  value?: string;
  properties?: { name: string; value: unknown }[];
  childIds: number[];
}

function computeStateDelta(
  previous: Record<string, SnapshotNode>,
  current: Record<string, SnapshotNode>,
): unknown {
  const added: SnapshotNode[] = [];
  const removed: { stableId: number; role: string; name: string }[] = [];
  const modified: {
    stableId: number;
    changes: Record<string, { previous: unknown; current: unknown }>;
  }[] = [];

  for (const [id, curr] of Object.entries(current)) {
    const prev = previous[id];
    if (!prev) {
      added.push(curr);
      continue;
    }
    const changes: Record<string, { previous: unknown; current: unknown }> = {};
    if (prev.role !== curr.role) changes['role'] = { previous: prev.role, current: curr.role };
    if (prev.name !== curr.name) changes['name'] = { previous: prev.name, current: curr.name };
    if (prev.value !== curr.value) changes['value'] = { previous: prev.value, current: curr.value };
    if (JSON.stringify(prev.properties) !== JSON.stringify(curr.properties)) {
      changes['properties'] = { previous: prev.properties, current: curr.properties };
    }
    if (JSON.stringify(prev.childIds) !== JSON.stringify(curr.childIds)) {
      changes['children'] = { previous: prev.childIds, current: curr.childIds };
    }
    if (Object.keys(changes).length > 0) modified.push({ stableId: curr.stableId, changes });
  }

  for (const [id, prev] of Object.entries(previous)) {
    if (!current[id]) {
      removed.push({ stableId: prev.stableId, role: prev.role, name: prev.name });
    }
  }

  return { added, removed, modified, timestamp: Date.now() };
}

class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
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
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}

interface Frame {
  data: string;
  timestamp: number;
}

const frames = new RingBuffer<Frame>(150); // Cap at 150 frames max (~15 seconds at 10 FPS)

setInterval(() => {
  const cutoff = Date.now() - 10000; // 10-second rolling window
  const active = frames.toArray().filter((f) => f.timestamp >= cutoff);
  frames.clear();
  for (const f of active) {
    frames.push(f);
  }
}, 1000);

// ─── Message Handler ────────────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message.type === 'serializeAXTree') {
      const renderedNodeIds: number[] = [];
      const markdown = serializeAXTreeToMarkdown(
        message.nodes,
        message.semanticOnly,
        message.targetBackendNodeId,
        renderedNodeIds,
      );
      parentPort!.postMessage({
        type: 'serializeAXTree',
        id: message.id,
        markdown,
        renderedNodeIds,
      });
    } else if (message.type === 'computeStateDelta') {
      const delta = computeStateDelta(message.previous, message.current);
      parentPort!.postMessage({
        type: 'computeStateDelta',
        id: message.id,
        delta,
      });
    } else if (message.type === 'frame') {
      frames.push({ data: message.data, timestamp: message.timestamp || Date.now() });
    } else if (message.type === 'clear') {
      frames.clear();
    } else if (message.type === 'dump') {
      // Minimal frame dump — legacy support
      const { outputPath, id } = message;
      try {
        mkdirSync(outputPath, { recursive: true });
        const allFrames = frames.toArray();
        allFrames.forEach((frame, idx) => {
          const filename = `frame_${String(idx).padStart(4, '0')}_${frame.timestamp}.jpg`;
          writeFileSync(join(outputPath, filename), Buffer.from(frame.data, 'base64'));
        });
        parentPort!.postMessage({
          type: 'dump_complete',
          id,
          success: true,
          frameCount: allFrames.length,
          logCount: 0,
          outputPath,
        });
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'dump_complete',
          id,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
