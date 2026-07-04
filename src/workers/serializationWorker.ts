// ─── Serialization Worker ────────────────────────────────────────────────────
// Runs in a dedicated worker_thread to offload CPU-intensive operations:
// 1. AX tree → Markdown serialization (string manipulation)
// 2. State delta computation (deep comparison)
// 3. DVR frame buffering (binary data management)
//
// This prevents heavy serialization from choking the main Node.js event loop
// and blocking the JSON-RPC transport.

import { parentPort } from 'worker_threads';

// ─── AX Tree Serialization ──────────────────────────────────────────────────

interface AXNodeInput {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  properties?: { name: string; value: { type: string; value: unknown } }[];
}

interface TreeNode {
  node: AXNodeInput;
  children: TreeNode[];
}

function serializeAXTreeToMarkdown(nodes: AXNodeInput[], semanticOnly: boolean): string {
  if (!nodes || nodes.length === 0) return '*(Empty accessibility tree)*';

  // Build tree structure
  const nodeMap = new Map<string, TreeNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, { node, children: [] });
  }

  const childSet = new Set<string>();
  for (const tNode of nodeMap.values()) {
    const childIds = tNode.node.childIds || [];
    for (const childId of childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        tNode.children.push(child);
        childSet.add(childId);
      }
    }
  }

  // Find roots (nodes that are not children of any other node)
  const roots: TreeNode[] = [];
  for (const tNode of nodeMap.values()) {
    if (!childSet.has(tNode.node.nodeId)) {
      roots.push(tNode);
    }
  }

  let markdown = '';

  function renderNode(tNode: TreeNode, depth: number): void {
    const { node, children } = tNode;

    if (node.ignored) {
      for (const child of children) renderNode(child, depth);
      return;
    }

    const role = node.role?.value || 'generic';
    const hasContent =
      node.name?.value ||
      node.description?.value ||
      node.value?.value !== undefined ||
      [
        'button',
        'link',
        'textbox',
        'checkbox',
        'heading',
        'menuitem',
        'tab',
        'combobox',
        'listbox',
        'radio',
        'switch',
        'slider',
        'progressbar',
        'img',
        'alert',
      ].includes(role);

    let renderThis = hasContent;

    // Keep structural containers that have interactive children
    if (!renderThis && children.length > 0) renderThis = true;

    // Aggressively prune deeply nested generic pass-through nodes
    if (role === 'generic' && !hasContent && children.length === 1) renderThis = false;

    if (semanticOnly && role === 'generic' && !hasContent) renderThis = false;

    const indent = '  '.repeat(depth);

    if (renderThis) {
      let nodeStr = `${indent}- [${role}]`;

      if (node.name?.value) nodeStr += ` "${node.name.value}"`;
      if (node.value?.value !== undefined) nodeStr += ` (value: "${node.value.value}")`;
      if (node.description?.value) nodeStr += ` — *${node.description.value}*`;

      // Properties
      const props: string[] = [];
      if (node.properties) {
        for (const prop of node.properties) {
          if (prop.name === 'level') props.push(`L${prop.value.value}`);
          else if (prop.name === 'checked' && prop.value.value) props.push('checked');
          else if (prop.name === 'disabled' && prop.value.value) props.push('disabled');
          else if (prop.name === 'focused' && prop.value.value) props.push('focused');
          else if (prop.name === 'required' && prop.value.value) props.push('required');
          else if (prop.name === 'expanded')
            props.push(prop.value.value ? 'expanded' : 'collapsed');
          else if (prop.name === 'selected' && prop.value.value) props.push('selected');
        }
      }

      // Stable backend node ID for interaction targeting
      if (node.backendDOMNodeId !== undefined) {
        props.push(`id: ${node.backendDOMNodeId}`);
      }

      if (props.length > 0) nodeStr += ` [${props.join(', ')}]`;

      markdown += nodeStr + '\n';
      for (const child of children) renderNode(child, depth + 1);
    } else {
      for (const child of children) renderNode(child, depth);
    }
  }

  for (const root of roots) renderNode(root, 0);

  return markdown.trim();
}

// ─── State Delta Computation ────────────────────────────────────────────────

interface SnapshotNode {
  stableId: number;
  backendNodeId: number;
  role: string;
  name: string;
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

// ─── DVR Frame Buffering ────────────────────────────────────────────────────

interface Frame {
  data: string;
  timestamp: number;
}

let frames: Frame[] = [];

setInterval(() => {
  const cutoff = Date.now() - 10000; // 10-second rolling window
  frames = frames.filter((f) => f.timestamp >= cutoff);
}, 1000);

// ─── Message Handler ────────────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message.type === 'serializeAXTree') {
      const markdown = serializeAXTreeToMarkdown(message.nodes, message.semanticOnly);
      parentPort!.postMessage({
        type: 'serializeAXTree',
        id: message.id,
        markdown,
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
      frames = [];
    } else if (message.type === 'dump') {
      // Minimal frame dump — legacy support
      const { outputPath } = message;
      try {
        const { mkdirSync, writeFileSync } = require('fs');
        const { join } = require('path');
        mkdirSync(outputPath, { recursive: true });
        frames.forEach((frame, idx) => {
          const filename = `frame_${String(idx).padStart(4, '0')}_${frame.timestamp}.jpg`;
          writeFileSync(join(outputPath, filename), Buffer.from(frame.data, 'base64'));
        });
        parentPort!.postMessage({
          type: 'dump_complete',
          success: true,
          frameCount: frames.length,
          logCount: 0,
          outputPath,
        });
      } catch (err: unknown) {
        parentPort!.postMessage({
          type: 'dump_complete',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
