// ─── State Delta ────────────────────────────────────────────────────────────
// Differential State Streaming. Computes and returns a token-efficient
// mathematical delta of what explicitly changed structurally right after
// the last action.
//
// Makes the agent instantly aware of transient loading states, async toast
// notifications, modals appearing/disappearing, etc.

import type { CDPSession, Page } from 'puppeteer-core';
import { ImmutableNodeIndex } from '../core/ImmutableNodeIndex.js';

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
  text: string;
}> {
  // Refresh the node index with the current AX tree state
  const frames = page.frames();
  for (const frame of frames) {
    const isMainFrame = frame === page.mainFrame();
    try {
      const params: Record<string, unknown> = {};
      if (!isMainFrame) {
        const frameId = (frame as any)._id ?? (frame as any)._frameId ?? (frame as any).id;
        if (frameId && typeof frameId === 'string') {
          params.frameId = frameId;
        } else {
          continue;
        }
      }
      const result = await cdpSession.send('Accessibility.getFullAXTree', params);
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
      text: 'No structural changes detected since last checkpoint.',
    };
  }

  const formatNode = (node: { role: string; name?: string; value?: string; backendNodeId?: number; properties?: {name: string, value: unknown}[] }) => {
    let s = `[${node.role}]`;
    if (node.name) s += ` "${node.name}"`;
    if (node.value !== undefined) s += ` (value: "${node.value}")`;
    const props: string[] = [];
    if (node.properties) {
      for (const p of node.properties) {
        if (p.name === 'level') props.push(`L${p.value}`);
        else if (p.name === 'checked' && p.value) props.push('checked');
        else if (p.name === 'disabled' && p.value) props.push('disabled');
        else if (p.name === 'focused' && p.value) props.push('focused');
        else if (p.name === 'required' && p.value) props.push('required');
        else if (p.name === 'expanded') props.push(p.value ? 'expanded' : 'collapsed');
        else if (p.name === 'selected' && p.value) props.push('selected');
      }
    }
    if (node.backendNodeId !== undefined) props.push(`id: ${node.backendNodeId}`);
    if (props.length > 0) s += ` [${props.join(', ')}]`;
    return s;
  };

  let markdown = '```diff\n';

  if (delta.modified.length > 0) {
    markdown += 'Modified Nodes:\n';
    for (const mod of delta.modified) {
      // Reconstruct previous node state for diff
      const current = nodeIndex.getSnapshot(mod.stableId);
      if (!current) continue;
      
      const prev: any = { role: current.role, name: current.name, value: current.value, backendNodeId: current.backendNodeId, properties: current.properties };
      if (mod.changes['role']) prev.role = mod.changes['role'].previous;
      if (mod.changes['name']) prev.name = mod.changes['name'].previous;
      if (mod.changes['value']) prev.value = mod.changes['value'].previous;
      if (mod.changes['properties']) prev.properties = mod.changes['properties'].previous;
      
      markdown += `- ${formatNode(prev)}\n`;
      markdown += `+ ${formatNode(current)}\n\n`;
    }
  }

  if (delta.added.length > 0) {
    markdown += 'Added Nodes:\n';
    for (const node of delta.added) {
      markdown += `+ ${formatNode(node)}\n`;
    }
    markdown += '\n';
  }

  if (delta.removed.length > 0) {
    markdown += 'Removed Nodes:\n';
    for (const node of delta.removed) {
      const backendNodeId = nodeIndex.getBackendNodeId(node.stableId);
      markdown += `- ${formatNode({ ...node, backendNodeId })}\n`;
    }
    markdown += '\n';
  }

  markdown += '```';

  return { text: markdown.trim() };
}
