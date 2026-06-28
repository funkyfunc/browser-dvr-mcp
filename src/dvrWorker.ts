import { parentPort } from 'worker_threads';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

interface Frame {
  data: string;
  timestamp: number;
}

interface LogEntry {
  type: 'console' | 'network';
  text: string;
  timestamp: number;
}

let frames: Frame[] = [];
let logs: LogEntry[] = [];

// Clean up old entries in the rolling buffer every 1 second
setInterval(() => {
  const cutoff = Date.now() - 10000; // 10 seconds rolling
  frames = frames.filter((f) => f.timestamp >= cutoff);
  logs = logs.filter((l) => l.timestamp >= cutoff);
}, 1000);

if (parentPort) {
  parentPort.on('message', (message) => {
    const now = Date.now();

    if (message.type === 'frame') {
      frames.push({
        data: message.data,
        timestamp: message.timestamp || now,
      });
    } else if (message.type === 'console') {
      logs.push({
        type: 'console',
        text: `[${message.level || 'info'}] ${message.text}`,
        timestamp: message.timestamp || now,
      });
    } else if (message.type === 'network') {
      logs.push({
        type: 'network',
        text: `[${message.method}] ${message.url} -> ${message.status || 'pending'}`,
        timestamp: message.timestamp || now,
      });
    } else if (message.type === 'clear') {
      frames = [];
      logs = [];
    } else if (message.type === 'dump') {
      const { outputPath } = message;
      try {
        mkdirSync(outputPath, { recursive: true });

        // Save frames as JPGs
        frames.forEach((frame, idx) => {
          const filename = `frame_${String(idx).padStart(4, '0')}_${frame.timestamp}.jpg`;
          const filepath = join(outputPath, filename);
          writeFileSync(filepath, Buffer.from(frame.data, 'base64'));
        });

        // Save trace timeline
        const sortedLogs = [...logs].sort((a, b) => a.timestamp - b.timestamp);
        const logContent = sortedLogs
          .map((l) => `[${new Date(l.timestamp).toISOString()}] ${l.type.toUpperCase()}: ${l.text}`)
          .join('\n');

        writeFileSync(join(outputPath, 'session_trace.txt'), logContent);

        parentPort?.postMessage({
          type: 'dump_complete',
          success: true,
          frameCount: frames.length,
          logCount: logs.length,
          outputPath,
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        parentPort?.postMessage({
          type: 'dump_complete',
          success: false,
          error: errorMsg,
        });
      }
    }
  });
}
