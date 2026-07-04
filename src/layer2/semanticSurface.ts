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

export interface SemanticSurfaceResult {
  markdown: string;
  nodeCount: number;
  frameCount: number;
}

// ─── AX Tree Serialization (inline) ────────────────────────────────────────

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

function serializeAXTreeToMarkdown(nodes: AXNodeInput[], semanticOnly: boolean, targetBackendNodeId?: number): string {
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
  
  if (targetBackendNodeId !== undefined) {
    // Target specific node
    let targetNode: TreeNode | undefined;
    for (const tNode of nodeMap.values()) {
      if (tNode.node.backendDOMNodeId === targetBackendNodeId) {
        targetNode = tNode;
        break;
      }
    }
    if (targetNode) {
      roots.push(targetNode);
    } else {
      return `*(Node ${targetBackendNodeId} not found in accessibility tree)*`;
    }
  } else {
    for (const tNode of nodeMap.values()) {
      if (!childSet.has(tNode.node.nodeId)) {
        roots.push(tNode);
      }
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
      ['button', 'link', 'textbox', 'checkbox', 'heading', 'menuitem',
       'tab', 'combobox', 'listbox', 'radio', 'switch', 'slider',
       'progressbar', 'img', 'alert'].includes(role);

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
          else if (prop.name === 'expanded') props.push(prop.value.value ? 'expanded' : 'collapsed');
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

// ─── Main Entry Point ──────────────────────────────────────────────────────

/**
 * Get the semantic surface: the LLM's primary perception of the page.
 * Queries the native AX tree via CDP and serializes it to Markdown inline.
 */
export async function getSemanticSurface(
  page: Page,
  cdpSession: CDPSession,
  nodeIndex: ImmutableNodeIndex,
  options: { semanticOnly?: boolean } = {}
): Promise<SemanticSurfaceResult> {
  const frames = page.frames();
  let totalNodeCount = 0;
  let frameCount = 0;
  let combinedMarkdown = '';
  const errors: string[] = [];

  for (const frame of frames) {
    const isMainFrame = frame === page.mainFrame();

    try {
      // For the main frame, omit frameId — CDP defaults to the main frame's tree.
      // For child frames, attempt to extract the CDP frameId from Puppeteer internals.
      const params: Record<string, unknown> = {};
      if (!isMainFrame) {
        const frameId = (frame as any)._id ?? (frame as any)._frameId ?? (frame as any).id;
        if (frameId && typeof frameId === 'string') {
          params.frameId = frameId;
        } else {
          // Cannot resolve frame ID — skip this child frame
          continue;
        }
      }

      const result = await cdpSession.send('Accessibility.getFullAXTree', params);
      const nodes = result.nodes as AXNodeInput[];

      if (!nodes || nodes.length === 0) {
        errors.push(`Frame ${isMainFrame ? '(main)' : frame.url()}: AX tree returned 0 nodes`);
        continue;
      }

      // Update immutable node index with this frame's nodes
      nodeIndex.buildFromAXNodes(nodes as any[]);

      // Serialize inline (previously used worker thread, which broke in production builds)
      const markdown = serializeAXTreeToMarkdown(nodes, options.semanticOnly || false);

      if (markdown && markdown !== '*(Empty accessibility tree)*') {
        const frameUrl = frame.url();
        if (isMainFrame) {
          combinedMarkdown += markdown + '\n';
        } else {
          combinedMarkdown += `\n--- iframe: ${frameUrl} ---\n${markdown}\n`;
        }
        totalNodeCount += nodes.length;
        frameCount++;
      }
    } catch (err) {
      // Log the error instead of silently swallowing — aids debugging
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Frame ${isMainFrame ? '(main)' : frame.url()}: ${msg}`);
    }
  }

  // If we got nothing and there were errors, include them in the output
  // so agents can diagnose the problem instead of assuming the page is blank
  if (!combinedMarkdown.trim() && errors.length > 0) {
    return {
      markdown: `*(Empty accessibility tree)*\n\nDiagnostics (${errors.length} frame errors):\n${errors.map(e => `• ${e}`).join('\n')}`,
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
  options: { semanticOnly?: boolean } = {}
): Promise<{ text: string; diagnostics?: string[] }> {
  const semanticOnly = options.semanticOnly !== false;
  const diagnostics: string[] = [];

  let nodes: AXNodeInput[] = [];

  try {
    const { nodes: axNodes } = await cdpSession.send('Accessibility.getFullAXTree', {
      depth: 100, // Fetch the full tree
    });
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

  const result = serializeAXTreeToMarkdown(nodes, semanticOnly, backendNodeId);
  return { text: result, diagnostics: diagnostics.length ? diagnostics : undefined };
}
