// ─── Semantic Surface ───────────────────────────────────────────────────────
// The core perception primitive. Queries the browser's native Accessibility
// Object Model via CDP (Accessibility.getFullAXTree).
//
// Serializes the AX tree — which natively resolves closed shadow roots and
// computes accessible names — into a hyper-compressed, hierarchical Markdown
// document (Unified Semantic Accessibility Graph / USAG).
//
// IMPORTANT: Serialization runs inline on the main thread. The previous
// worker_thread approach was broken in production because esbuild's --bundle
// produces a single file, so the worker JS never existed at the expected path.
// The serialization is fast (simple string ops on ~1000 nodes) and doesn't
// justify the complexity of a worker thread.
//
// Each node includes a stable backendNodeId tag for direct interaction targeting.

import type { Page, CDPSession } from 'puppeteer-core';
import { ImmutableNodeIndex } from '../core/ImmutableNodeIndex.js';
import type { WorkerBridge } from '../workers/workerBridge.js';
import { serializeAXTreeToMarkdown, type AXNodeInput } from '../core/treeSerializer.js';
import {
  parseSnapshot,
  renderPrunedMarkdown,
  type CaptureSnapshotResult,
  type ParsedSnapshot,
} from '../perception/domSnapshot.js';
import type { NodeGeometry } from '../core/ImmutableNodeIndex.js';

/** Read a puppeteer frame's CDP frame id from its (version-dependent) internals. */
function frameId(frame: any): string | undefined {
  const id = frame._id ?? frame._frameId ?? frame.id;
  return typeof id === 'string' ? id : undefined;
}

export interface SemanticSurfaceResult {
  markdown: string;
  nodeCount: number;
  frameCount: number;
}

// ─── Interactive-candidate capture ──────────────────────────────────────────

/**
 * Capture interactive candidate elements for every frame in a single,
 * non-mutating DOMSnapshot.captureSnapshot call. Replaces the old per-frame
 * sniff that ran querySelectorAll('*') + getComputedStyle per element, wrote
 * temporary data-mcp-sniff attributes, and pulled the whole flattened document
 * — heavy work that also violated the "do no harm / observer effect" promise by
 * mutating the page under inspection.
 *
 * Returns candidates grouped by frameId (before rendered-node filtering). An
 * empty map is returned on any failure so perception degrades gracefully.
 */
async function captureFusedSnapshot(cdpSession: CDPSession): Promise<ParsedSnapshot> {
  try {
    const snapshot = (await cdpSession.send('DOMSnapshot.captureSnapshot', {
      computedStyles: ['cursor'],
      includePaintOrder: false,
      includeDOMRects: false,
    })) as unknown as CaptureSnapshotResult;
    return parseSnapshot(snapshot);
  } catch {
    return { geometryByFrame: new Map(), candidatesByFrame: new Map() };
  }
}

/**
 * Get the semantic surface: the LLM's primary perception of the page.
 * Queries the native AX tree via CDP and serializes it to Markdown inline.
 */
export async function getSemanticSurface(
  page: Page,
  cdpSession: CDPSession,
  nodeIndex: ImmutableNodeIndex,
  options: { semanticOnly?: boolean } = {},
  workerBridge?: WorkerBridge | null,
): Promise<SemanticSurfaceResult> {
  const frames = page.frames();
  let totalNodeCount = 0;
  let frameCount = 0;
  let combinedMarkdown = '';
  const errors: string[] = [];

  // Fetch accessibility trees for all frames concurrently
  const results = await Promise.all(
    frames.map(async (frame) => {
      const isMainFrame = frame === page.mainFrame();
      try {
        const params: Record<string, unknown> = {};
        if (!isMainFrame) {
          const frameId = (frame as any)._id ?? (frame as any)._frameId ?? (frame as any).id;
          if (frameId && typeof frameId === 'string') {
            params.frameId = frameId;
          } else {
            return null;
          }
        }
        const result = await cdpSession.send('Accessibility.getFullAXTree', params);
        return { frame, isMainFrame, result };
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Frame ${isMainFrame ? '(main)' : frame.url()}: ${msg}`);
        return null;
      }
    }),
  );

  // One non-mutating DOMSnapshot for the whole page yields, in a single pass,
  // both the per-node geometry (fused onto the AX spine) and the interactive
  // candidates — replacing the old per-frame page-mutating sniff.
  const fused = await captureFusedSnapshot(cdpSession);

  // Process and serialize them sequentially to preserve order. The build
  // bracket spans all frames so departed nodes are pruned only after every
  // frame has contributed its tree (keeping the index bounded).
  nodeIndex.beginBuild();
  for (const [frameIndex, item] of results.entries()) {
    if (!item) continue;
    const { frame, isMainFrame, result } = item;
    const fid = isMainFrame ? frameId(page.mainFrame()) : frameId(frame);

    try {
      const nodes = result.nodes as AXNodeInput[];

      if (!nodes || nodes.length === 0) {
        errors.push(`Frame ${isMainFrame ? '(main)' : frame.url()}: AX tree returned 0 nodes`);
        continue;
      }

      // Fuse geometry from the snapshot onto this frame's AX nodes.
      const frameGeom = fid ? fused.geometryByFrame.get(fid) : undefined;
      nodeIndex.buildFromAXNodes(
        nodes as any[],
        frameGeom as Map<number, NodeGeometry> | undefined,
      );

      // Serialize, tracking rendered nodes in the set
      const renderedNodeIds = new Set<number>();
      let markdown = '';
      if (workerBridge) {
        try {
          const res = await workerBridge.serializeAXTree(nodes, options.semanticOnly || false);
          markdown = res.markdown;
          for (const id of res.renderedNodeIds) {
            renderedNodeIds.add(id);
          }
        } catch (err) {
          console.error('Worker serialization failed, falling back to main thread:', err);
          markdown = serializeAXTreeToMarkdown(
            nodes,
            options.semanticOnly || false,
            undefined,
            renderedNodeIds,
          );
        }
      } else {
        markdown = serializeAXTreeToMarkdown(
          nodes,
          options.semanticOnly || false,
          undefined,
          renderedNodeIds,
        );
      }

      // Append pruned non-semantic interactive controls for this frame, drawn
      // from the same page-wide DOMSnapshot and filtered to those the AX
      // surface didn't already render.
      const frameCandidates = (fid ? fused.candidatesByFrame.get(fid) : undefined) ?? [];
      const pruned = frameCandidates.filter((c) => !renderedNodeIds.has(c.backendNodeId));
      if (pruned.length > 0) {
        markdown += renderPrunedMarkdown(pruned);
      }

      if (markdown && markdown !== '*(Empty accessibility tree)*') {
        const frameUrl = frame.url();
        if (isMainFrame) {
          combinedMarkdown += markdown + '\n';
        } else {
          // Emit the frames() index so agents know the exact frameIndex arg to
          // pass to atomic_interact / evaluate_in_context when targeting this
          // iframe. `results` is frames.map(...), so this index is aligned with
          // page.frames() — the same list those tools index into.
          combinedMarkdown += `\n--- iframe [frameIndex: ${frameIndex}]: ${frameUrl} ---\n${markdown}\n`;
        }
        totalNodeCount += nodes.length + pruned.length;
        frameCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Frame ${isMainFrame ? '(main)' : frame.url()}: ${msg}`);
    }
  }
  nodeIndex.endBuild();

  // If we got nothing and there were errors, include them in the output
  // so agents can diagnose the problem instead of assuming the page is blank
  if (!combinedMarkdown.trim() && errors.length > 0) {
    return {
      markdown: `*(Empty accessibility tree)*\n\nDiagnostics (${errors.length} frame errors):\n${errors.map((e) => `• ${e}`).join('\n')}`,
      nodeCount: 0,
      frameCount: 0,
    };
  }

  return {
    markdown: combinedMarkdown.trim() || '*(Empty accessibility tree)*',
    nodeCount: totalNodeCount,
    frameCount,
  };
}

export async function getElementTree(
  cdpSession: CDPSession,
  nodeIndex: ImmutableNodeIndex,
  backendNodeId: number,
  options: { semanticOnly?: boolean; frameId?: string } = {},
  workerBridge?: WorkerBridge | null,
): Promise<{ text: string; diagnostics?: string[] }> {
  const semanticOnly = options.semanticOnly !== false;
  const diagnostics: string[] = [];

  let nodes: AXNodeInput[] = [];

  try {
    const params: Record<string, any> = { depth: 100 };
    if (options.frameId) {
      params.frameId = options.frameId;
    }
    const { nodes: axNodes } = await cdpSession.send('Accessibility.getFullAXTree', params);
    nodes = axNodes as AXNodeInput[];
  } catch (err: any) {
    diagnostics.push(`Failed to get AX tree via CDP: ${err.message}`);
    return {
      text: '*(Accessibility tree unavailable. See diagnostics.)*',
      diagnostics,
    };
  }

  // Update immutable node index with this frame's nodes
  nodeIndex.buildFromAXNodes(nodes as any[]);

  let result = '';
  if (workerBridge) {
    try {
      const res = await workerBridge.serializeAXTree(nodes, semanticOnly, backendNodeId);
      result = res.markdown;
    } catch (err) {
      console.error('Worker getElementTree failed, falling back to main thread:', err);
      result = serializeAXTreeToMarkdown(nodes, semanticOnly, backendNodeId);
    }
  } else {
    result = serializeAXTreeToMarkdown(nodes, semanticOnly, backendNodeId);
  }
  return { text: result, diagnostics: diagnostics.length ? diagnostics : undefined };
}
