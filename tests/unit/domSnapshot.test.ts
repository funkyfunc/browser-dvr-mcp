// Mock-free unit tests for the DOMSnapshot interactive-candidate parser.
import { describe, it, expect } from 'vitest';
import {
  parseInteractiveCandidates,
  parseSnapshot,
  renderPrunedMarkdown,
  type CaptureSnapshotResult,
} from '../../src/perception/domSnapshot.js';

// String table. Indices referenced below.
const strings = [
  'main-frame', // 0 frameId
  'DIV', // 1 nodeName
  'grab', // 2 cursor
  'id', // 3 attr name
  'pruned-control', // 4 attr value
  'BUTTON', // 5 nodeName
  'auto', // 6 cursor
  'class', // 7 attr name
  'btn primary', // 8 attr value
  'SPAN', // 9 nodeName
  'pointer', // 10 cursor
  'Click me', // 11 text value
];

// Build a snapshot with:
//  node0: DIV cursor:grab id=pruned-control (50x50)  -> candidate
//  node1: BUTTON cursor:auto (already rendered -> excluded)
//  node2: SPAN cursor:pointer, zero-size (excluded: no box)
//  node3: SPAN cursor:pointer class=btn primary with text -> candidate
const snapshot: CaptureSnapshotResult = {
  strings,
  documents: [
    {
      frameId: 0,
      nodes: {
        nodeType: [1, 1, 1, 1, 3],
        nodeName: [1, 5, 9, 9, -1],
        nodeValue: [-1, -1, -1, -1, 11],
        backendNodeId: [100, 101, 102, 103, 104],
        parentIndex: [-1, -1, -1, -1, 3],
        attributes: [
          [3, 4], // id=pruned-control
          [],
          [],
          [7, 8], // class="btn primary"
          [],
        ],
      },
      layout: {
        // node0 -> layout0, node1 -> layout1, node2 -> layout2, node3 -> layout3
        nodeIndex: [0, 1, 2, 3],
        styles: [[2], [6], [10], [10]], // cursor: grab, auto, pointer, pointer
        bounds: [
          [0, 0, 50, 50],
          [0, 60, 120, 30],
          [0, 100, 0, 0], // zero-size span
          [0, 140, 80, 20],
        ],
        text: [-1, -1, -1, -1],
      },
    },
  ],
};

describe('parseInteractiveCandidates', () => {
  it('finds pruned interactive controls and excludes rendered / zero-size ones', () => {
    const rendered = new Set<number>([101]); // BUTTON already in the AX surface
    const byFrame = parseInteractiveCandidates(snapshot, rendered);
    const list = byFrame.get('main-frame') ?? [];

    const ids = list.map((c) => c.backendNodeId).sort();
    expect(ids).toEqual([100, 103]); // grab div + btn span; 101 rendered, 102 zero-size

    const grab = list.find((c) => c.backendNodeId === 100)!;
    expect(grab).toMatchObject({ tag: 'div', cursor: 'grab', id: 'pruned-control', className: '' });

    const span = list.find((c) => c.backendNodeId === 103)!;
    expect(span).toMatchObject({
      tag: 'span',
      cursor: 'pointer',
      className: 'btn primary',
      text: 'Click me',
    });
  });

  it('renders the exact gauntlet markdown format', () => {
    const byFrame = parseInteractiveCandidates(snapshot, new Set([101, 103]));
    const md = renderPrunedMarkdown(byFrame.get('main-frame') ?? []);
    expect(md).toContain('### Pruned Potential Interactive Elements (Non-Semantic)');
    expect(md).toContain('[div] (cursor: "grab", id: "pruned-control") [id: 100]');
  });

  it('returns no frame entry when nothing qualifies', () => {
    const byFrame = parseInteractiveCandidates(snapshot, new Set([100, 101, 102, 103]));
    expect(byFrame.size).toBe(0);
  });
});

describe('parseSnapshot (fused geometry)', () => {
  it('produces geometry for every laid-out element, marking visibility & clickability', () => {
    const { geometryByFrame } = parseSnapshot(snapshot);
    const geom = geometryByFrame.get('main-frame')!;

    // grab div
    expect(geom.get(100)).toMatchObject({
      bounds: { x: 0, y: 0, width: 50, height: 50 },
      cursor: 'grab',
      clickable: true,
      visible: true,
    });
    // zero-size span is present but marked not visible
    expect(geom.get(102)).toMatchObject({ visible: false });
    expect(geom.get(102)!.bounds.width).toBe(0);
    // plain button (cursor auto) is not clickable-by-cursor
    expect(geom.get(101)!.clickable).toBe(false);
  });
});
