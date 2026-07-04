// ─── State Delta ────────────────────────────────────────────────────────────
// Differential State Streaming. Computes and returns a token-efficient
// mathematical delta of what explicitly changed structurally right after
// the last action.
//
// Makes the agent instantly aware of transient loading states, async toast
// notifications, modals appearing/disappearing, etc.

import type { CDPSession, Page } from 'puppeteer-core';
import { ImmutableNodeIndex } from '../core/ImmutableNodeIndex.js';
import type { StateDelta } from '../core/types.js';

/**
 * Computes the structural delta between the current AX tree state
 * and the state at the last checkpoint.
 *
 * Call pattern:
 * 1. Agent calls get_semantic_surface() → checkpoint is taken
 * 2. Agent performs an action (click, type, etc.)
 * 3. Agent calls get_state_delta() → sees exactly what changed
 */
export async function getStateDelta(
  page: Page,
  cdpSession: CDPSession,
  nodeIndex: ImmutableNodeIndex
): Promise<{
  delta: StateDelta | null;
  message: string;
}> {
  // Refresh the node index with the current AX tree state
  const frames = page.frames();
  for (const frame of frames) {
    const frameId = (frame as any)._id || (frame as any).id;
    try {
      const result = await cdpSession.send('Accessibility.getFullAXTree', { frameId });
      nodeIndex.buildFromAXNodes(result.nodes as any[]);
    } catch {
      // Skip inaccessible frames
    }
  }

  // Compute delta against last checkpoint
  const delta = nodeIndex.computeDelta();

  // Take new checkpoint for next delta
  nodeIndex.checkpoint();

  if (!delta) {
    return {
      delta: null,
      message: 'No structural changes detected since last checkpoint.',
    };
  }

  const summary = [
    delta.added.length > 0 ? `+${delta.added.length} added` : null,
    delta.removed.length > 0 ? `-${delta.removed.length} removed` : null,
    delta.modified.length > 0 ? `~${delta.modified.length} modified` : null,
  ].filter(Boolean).join(', ');

  return {
    delta,
    message: `State delta: ${summary}`,
  };
}
