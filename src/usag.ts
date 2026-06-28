export interface AXProperty {
  name: string;
  value: {
    type: string;
    value: unknown;
  };
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: unknown };
  childIds?: string[];
  backendDOMNodeId?: number;
  properties?: AXProperty[];
}

export interface AXTree {
  nodes: AXNode[];
}

interface TreeNode {
  node: AXNode;
  children: TreeNode[];
  parent: TreeNode | null;
}

/**
 * Parses a flat list of AXNodes into a tree structure and formats it as Markdown.
 */
export function formatAccessibilityTree(nodes: AXNode[]): string {
  if (!nodes || nodes.length === 0) {
    return '*(Empty accessibility tree)*';
  }

  // Create node map
  const nodeMap = new Map<string, TreeNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, {
      node,
      children: [],
      parent: null,
    });
  }

  // Build relationships
  const childSet = new Set<string>();
  for (const tNode of nodeMap.values()) {
    const childIds = tNode.node.childIds || [];
    for (const childId of childIds) {
      const child = nodeMap.get(childId);
      if (child) {
        tNode.children.push(child);
        child.parent = tNode;
        childSet.add(childId);
      }
    }
  }

  // Root nodes are those that are not children of any other node
  const roots: TreeNode[] = [];
  for (const tNode of nodeMap.values()) {
    if (!childSet.has(tNode.node.nodeId)) {
      roots.push(tNode);
    }
  }

  let markdown = '';

  function renderNode(tNode: TreeNode, depth: number) {
    const { node, children } = tNode;

    if (node.ignored) {
      // For ignored nodes, skip rendering themselves but render their children
      for (const child of children) {
        renderNode(child, depth);
      }
      return;
    }

    const role = node.role?.value || 'generic';
    
    // Skip noisy generic structural containers with no names/values/descriptions
    const hasContent = 
      node.name?.value || 
      node.description?.value || 
      node.value?.value !== undefined || 
      role === 'button' || 
      role === 'link' || 
      role === 'input' || 
      role === 'checkbox' ||
      role === 'heading';

    let renderThis = hasContent;
    
    // If it's a structural container but has interactive children, keep it
    if (!renderThis && children.length > 0) {
      // Check if children render anything
      renderThis = true; // We can still group them
    }

    const indent = '  '.repeat(depth);

    if (renderThis) {
      let nodeStr = `${indent}- `;
      
      // Role prefix
      nodeStr += `[${role}]`;

      // Name / label
      if (node.name?.value) {
        nodeStr += ` "${node.name.value}"`;
      }

      // Value (e.g. for inputs, progressbars)
      if (node.value?.value !== undefined) {
        nodeStr += ` (value: "${node.value.value}")`;
      }

      // Description
      if (node.description?.value) {
        nodeStr += ` - *${node.description.value}*`;
      }

      // Properties like level (for headings), checked, disabled, focused
      const props: string[] = [];
      if (node.properties) {
        for (const prop of node.properties) {
          if (prop.name === 'level') {
            props.push(`L${prop.value.value}`);
          } else if (prop.name === 'checked' && prop.value.value) {
            props.push('checked');
          } else if (prop.name === 'disabled' && prop.value.value) {
            props.push('disabled');
          } else if (prop.name === 'focused' && prop.value.value) {
            props.push('focused');
          }
        }
      }

      // Backend DOM node ID mapping
      if (node.backendDOMNodeId !== undefined) {
        props.push(`id: ${node.backendDOMNodeId}`);
      }

      if (props.length > 0) {
        nodeStr += ` [${props.join(', ')}]`;
      }

      markdown += nodeStr + '\n';
      
      // Render children with increased depth
      for (const child of children) {
        renderNode(child, depth + 1);
      }
    } else {
      // Just render children at same depth if this node was skipped
      for (const child of children) {
        renderNode(child, depth);
      }
    }
  }

  // Render all root branches
  for (const root of roots) {
    renderNode(root, 0);
  }

  return markdown.trim();
}
