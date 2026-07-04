// ─── Evaluate In Context ────────────────────────────────────────────────────
// Execute JavaScript in any frame context, including OOPIFs and closed shadow
// roots. Uses Target.setAutoAttach (already enabled by CDPConnectionManager)
// to auto-discover all execution contexts.

import type { CDPSession, Page } from 'puppeteer-core';

export interface EvaluateResult {
  success: boolean;
  result?: unknown;
  error?: string;
  frameUrl?: string;
}

/**
 * Execute a JavaScript expression in a specific frame context.
 * frameIndex=0 is the main frame. Higher indices are child frames
 * in the order they appear in Page.getFrameTree.
 */
export async function evaluateInContext(
  page: Page,
  _cdpSession: CDPSession,
  expression: string,
  frameIndex?: number,
  timeoutMs: number = 5000,
): Promise<EvaluateResult> {
  try {
    const frames = page.frames();
    const targetFrameIndex = frameIndex ?? 0;

    if (targetFrameIndex < 0 || targetFrameIndex >= frames.length) {
      return {
        success: false,
        error: `Frame index ${targetFrameIndex} out of range. Available frames: ${frames.length} (0-${frames.length - 1}). Frame URLs: ${frames.map((f, i) => `[${i}] ${f.url()}`).join(', ')}`,
      };
    }

    const targetFrame = frames[targetFrameIndex];
    const result = await Promise.race([
      targetFrame.evaluate(expression),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Evaluation timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    return {
      success: true,
      result,
      frameUrl: targetFrame.url(),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List all available execution contexts (frames).
 */
export async function listFrameContexts(page: Page): Promise<{
  frames: { index: number; url: string; isMainFrame: boolean; name: string }[];
}> {
  const frames = page.frames();
  return {
    frames: frames.map((frame, index) => ({
      index,
      url: frame.url(),
      isMainFrame: frame === page.mainFrame(),
      name: frame.name() || `frame-${index}`,
    })),
  };
}
