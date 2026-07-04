// ─── Semantic Surface ───────────────────────────────────────────────────────
// The core perception primitive. Queries the browser's native Accessibility
// Object Model via CDP (Accessibility.getFullAXTree).
//
// The worker thread flattens this tree — which natively resolves closed shadow
// roots and computes accessible names — into a hyper-compressed, hierarchical
// Markdown document (Unified Semantic Accessibility Graph / USAG).
//
// Each node includes a stable backendNodeId tag for direct interaction targeting.

import type { CDPSession, Page } from 'puppeteer-core';
import type { WorkerBridge } from '../workers/workerBridge.js';
import { ImmutableNodeIndex } from '../core/ImmutableNodeIndex.js';

export interface SemanticSurfaceResult {
  markdown: string;
  nodeCount: number;
  frameCount: number;
}

/**
 * Get the semantic surface: the LLM's primary perception of the page.
 * Queries the native AX tree via CDP and serializes it to Markdown
 * on the worker thread.
 */
export async function getSemanticSurface(
  page: Page,
  cdpSession: CDPSession,
  workerBridge: WorkerBridge,
  nodeIndex: ImmutableNodeIndex,
  options: { semanticOnly?: boolean } = {}
): Promise<SemanticSurfaceResult> {
  const frames = page.frames();
  let totalNodeCount = 0;
  let frameCount = 0;
  let combinedMarkdown = '';

  for (const frame of frames) {
    const frameId = (frame as any)._id || (frame as any).id;
    try {
      const result = await cdpSession.send('Accessibility.getFullAXTree', { frameId });
      const nodes = result.nodes as any[];

      if (!nodes || nodes.length === 0) continue;

      // Update immutable node index with this frame's nodes
      nodeIndex.buildFromAXNodes(nodes);

      // Serialize on worker thread (non-blocking)
      const markdown = await workerBridge.serializeAXTree(nodes, options.semanticOnly || false);

      if (markdown && markdown !== '*(Empty accessibility tree)*') {
        const frameUrl = frame.url();
        const isMainFrame = frame === page.mainFrame();
        if (isMainFrame) {
          combinedMarkdown += markdown + '\n';
        } else {
          combinedMarkdown += `\n--- iframe: ${frameUrl} ---\n${markdown}\n`;
        }
        totalNodeCount += nodes.length;
        frameCount++;
      }
    } catch {
      // Frame may be cross-origin or destroyed — skip silently
    }
  }

  return {
    markdown: combinedMarkdown.trim() || '*(Empty accessibility tree)*',
    nodeCount: totalNodeCount,
    frameCount,
  };
}
