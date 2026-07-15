// Mock-free unit tests for ImmutableNodeIndex — in particular the prune bug
// fix (A1): removed nodes must be detected and the index must stay bounded.
import { describe, it, expect } from 'vitest';
import { ImmutableNodeIndex } from '../../src/core/ImmutableNodeIndex.js';

interface RawNodeOpts {
  role?: string;
  name?: string;
  value?: unknown;
  childIds?: string[];
  properties?: { name: string; value: unknown }[];
}

// Build a CDP-AX-shaped node. nodeId doubles as the backendDOMNodeId source.
function axNode(id: number, opts: RawNodeOpts = {}) {
  return {
    nodeId: String(id),
    ignored: false,
    backendDOMNodeId: id,
    role: { value: opts.role ?? 'generic' },
    name: opts.name !== undefined ? { value: opts.name } : undefined,
    value: opts.value !== undefined ? { value: opts.value } : undefined,
    childIds: opts.childIds,
    properties: opts.properties?.map((p) => ({
      name: p.name,
      value: { type: 'x', value: p.value },
    })),
  };
}

function build(index: ImmutableNodeIndex, nodes: ReturnType<typeof axNode>[]) {
  index.beginBuild();
  index.buildFromAXNodes(nodes as any[]);
  index.endBuild();
}

describe('ImmutableNodeIndex', () => {
  it('detects a node removed from the DOM across incremental builds (A1 regression)', () => {
    const idx = new ImmutableNodeIndex();
    build(idx, [
      axNode(1, { role: 'button', name: 'A' }),
      axNode(2, { role: 'button', name: 'B' }),
    ]);
    const stable2 = idx.getStableId(2); // capture before node 2 is pruned
    idx.checkpoint();

    // Second build: node 2 is gone.
    build(idx, [axNode(1, { role: 'button', name: 'A' })]);
    const delta = idx.computeDelta();

    expect(delta).not.toBeNull();
    expect(delta!.removed.map((r) => r.stableId)).toContain(stable2);
    // Before the fix, node 2 lingered in the index and was never reported removed.
    expect(delta!.removed.length).toBe(1);
    expect(delta!.removed[0].name).toBe('B');
    // And it is genuinely gone from the index now.
    expect(idx.getStableId(2)).toBeUndefined();
  });

  it('keeps the index bounded — pruned nodes leave the maps', () => {
    const idx = new ImmutableNodeIndex();
    build(idx, [axNode(1), axNode(2), axNode(3)]);
    expect(idx.size).toBe(3);

    build(idx, [axNode(1)]);
    expect(idx.size).toBe(1);
    expect(idx.getStableId(2)).toBeUndefined();
    expect(idx.getStableId(3)).toBeUndefined();
  });

  it('preserves stable IDs for nodes that survive a rebuild (object permanence)', () => {
    const idx = new ImmutableNodeIndex();
    build(idx, [axNode(1, { role: 'button' }), axNode(2)]);
    const stable1 = idx.getStableId(1);
    build(idx, [axNode(1, { role: 'button', name: 'now labeled' })]);
    expect(idx.getStableId(1)).toBe(stable1);
  });

  it('bare builds (no begin/endBuild bracket) stay additive and do not prune', () => {
    const idx = new ImmutableNodeIndex();
    idx.buildFromAXNodes([axNode(1)] as any[]);
    idx.buildFromAXNodes([axNode(2)] as any[]);
    // No bracket => no prune; both nodes remain (safe for subtree/getElementTree).
    expect(idx.size).toBe(2);
    expect(idx.getStableId(1)).toBeDefined();
    expect(idx.getStableId(2)).toBeDefined();
  });

  it('detects a numeric value change (value is not narrowed away)', () => {
    const idx = new ImmutableNodeIndex();
    build(idx, [axNode(1, { role: 'slider', value: 0 })]);
    idx.checkpoint();
    build(idx, [axNode(1, { role: 'slider', value: 50 })]);
    const delta = idx.computeDelta();

    expect(delta).not.toBeNull();
    const mod = delta!.modified.find((m) => m.stableId === idx.getStableId(1));
    expect(mod).toBeDefined();
    expect(mod!.changes['value']).toEqual({ previous: '0', current: '50' });
  });

  it('detects structural reparenting via childIds', () => {
    const idx = new ImmutableNodeIndex();
    build(idx, [axNode(1, { role: 'list', childIds: ['2', '3'] }), axNode(2), axNode(3)]);
    idx.checkpoint();
    build(idx, [axNode(1, { role: 'list', childIds: ['2'] }), axNode(2), axNode(3)]);
    const delta = idx.computeDelta();
    const mod = delta!.modified.find((m) => m.stableId === idx.getStableId(1));
    expect(mod?.changes['children']).toBeDefined();
  });
});
