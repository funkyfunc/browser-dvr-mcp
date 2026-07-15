// Mock-free unit tests for the AX-tree -> Markdown serializer, including the
// depth/cycle guard (A7c).
import { describe, it, expect } from 'vitest';
import { serializeAXTreeToMarkdown, type AXNodeInput } from '../../src/core/treeSerializer.js';

function node(
  id: number,
  opts: Partial<{ role: string; name: string; childIds: string[] }> = {},
): AXNodeInput {
  return {
    nodeId: String(id),
    ignored: false,
    backendDOMNodeId: id,
    role: { value: opts.role ?? 'generic' },
    name: opts.name !== undefined ? { value: opts.name } : undefined,
    childIds: opts.childIds,
  };
}

describe('serializeAXTreeToMarkdown', () => {
  it('returns a placeholder for an empty tree', () => {
    expect(serializeAXTreeToMarkdown([], false)).toBe('*(Empty accessibility tree)*');
  });

  it('serializes roles, names, and backend ids', () => {
    const md = serializeAXTreeToMarkdown([node(1, { role: 'button', name: 'Submit' })], false);
    expect(md).toContain('[button]');
    expect(md).toContain('"Submit"');
    expect(md).toContain('id: 1');
  });

  it('renders a targeted subtree when targetBackendNodeId is given', () => {
    const nodes = [
      node(1, { role: 'main', childIds: ['2'] }),
      node(2, { role: 'button', name: 'Inner' }),
    ];
    const md = serializeAXTreeToMarkdown(nodes, false, 2);
    expect(md).toContain('"Inner"');
  });

  it('terminates on cyclic child references without overflowing the stack', () => {
    // root(0) -> 1 -> 2 -> 1 (cycle back into the subtree)
    const nodes = [
      node(0, { role: 'main', name: 'root', childIds: ['1'] }),
      node(1, { role: 'a', name: 'one', childIds: ['2'] }),
      node(2, { role: 'b', name: 'two', childIds: ['1'] }),
    ];
    let md = '';
    expect(() => {
      md = serializeAXTreeToMarkdown(nodes, false);
    }).not.toThrow();
    // Each node rendered at most once despite the cycle.
    expect(md.match(/"one"/g)?.length).toBe(1);
    expect(md.match(/"two"/g)?.length).toBe(1);
  });

  it('does not render a node twice when it is listed under two parents', () => {
    const nodes = [
      node(1, { role: 'root', childIds: ['3'] }),
      node(2, { role: 'root2', childIds: ['3'] }),
      node(3, { role: 'button', name: 'shared' }),
    ];
    const md = serializeAXTreeToMarkdown(nodes, false);
    expect(md.match(/"shared"/g)?.length).toBe(1);
  });
});
