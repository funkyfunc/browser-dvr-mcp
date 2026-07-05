// ─── Shared AX Tree Serialization Utility ───────────────────────────────────

export interface AXNodeInput {
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

export interface TreeNode {
  node: AXNodeInput;
  children: TreeNode[];
}

export function serializeAXTreeToMarkdown(
  nodes: AXNodeInput[],
  semanticOnly: boolean,
  targetBackendNodeId?: number,
  renderedNodeIds?: Set<number> | number[],
): string {
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
        if (renderedNodeIds) {
          if (Array.isArray(renderedNodeIds)) {
            renderedNodeIds.push(node.backendDOMNodeId);
          } else {
            renderedNodeIds.add(node.backendDOMNodeId);
          }
        }
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
