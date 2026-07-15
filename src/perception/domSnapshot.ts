// ─── DOMSnapshot interactive-candidate parser ───────────────────────────────
// Replaces the old page-mutating sniff (querySelectorAll('*') + per-element
// getComputedStyle + DOM.getFlattenedDocument + writing data-mcp-sniff
// attributes) with a single, non-mutating DOMSnapshot.captureSnapshot call.
//
// This module is a pure function over the snapshot payload so it can be
// unit-tested with a canned fixture — no live Chrome required.

export interface PrunedElement {
  backendNodeId: number;
  tag: string;
  id: string;
  className: string;
  cursor: string;
  text: string;
}

// Cursor values that imply an interactive control (matches the previous sniff).
const INTERACTIVE_CURSORS = new Set([
  'pointer',
  'grab',
  'grabbing',
  'move',
  'col-resize',
  'row-resize',
  'nesw-resize',
  'nwse-resize',
  'nw-resize',
  'ne-resize',
  'se-resize',
  'sw-resize',
]);

const INLINE_HANDLER_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown'];
const NAME_HINTS = ['btn', 'button', 'handle', 'resize', 'clickable'];
const STANDARD_SEMANTIC_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);

// ─── Raw CDP shapes (subset we use) ─────────────────────────────────────────

interface RareBooleanData {
  index?: number[];
}
interface DocumentSnapshot {
  frameId?: number; // string-table index
  nodes: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[]; // string-table indices
    nodeValue?: number[]; // string-table indices
    backendNodeId?: number[];
    attributes?: number[][]; // per node: alternating name/value string indices
    isClickable?: RareBooleanData;
  };
  layout: {
    nodeIndex: number[]; // node index for each layout node
    styles: number[][]; // per layout node: computed-style value string indices (order = requested)
    bounds: number[][]; // per layout node: [x, y, width, height]
    text?: number[]; // per layout node: string-table index or -1
  };
}
export interface CaptureSnapshotResult {
  documents: DocumentSnapshot[];
  strings: string[];
}

function str(strings: string[], idx: number | undefined): string {
  if (idx === undefined || idx < 0) return '';
  return strings[idx] ?? '';
}

/** Fused geometry + style + interactivity for a single node, keyed by backendNodeId. */
export interface NodeGeom {
  bounds: { x: number; y: number; width: number; height: number };
  cursor: string;
  clickable: boolean;
  visible: boolean;
}

export interface ParsedSnapshot {
  /** frameId -> (backendNodeId -> geometry) for every laid-out element node. */
  geometryByFrame: Map<string, Map<number, NodeGeom>>;
  /** frameId -> interactive candidates (unfiltered by rendered state). */
  candidatesByFrame: Map<string, PrunedElement[]>;
}

/**
 * Single-pass parse of a DOMSnapshot.captureSnapshot result (requested with
 * computedStyles: ['cursor']). Produces BOTH the per-node geometry map (fused
 * onto the AX spine) and the interactive-candidate list, grouped by frameId.
 */
export function parseSnapshot(snapshot: CaptureSnapshotResult): ParsedSnapshot {
  const { strings } = snapshot;
  const geometryByFrame = new Map<string, Map<number, NodeGeom>>();
  const candidatesByFrame = new Map<string, PrunedElement[]>();

  for (const doc of snapshot.documents) {
    const frameId = str(strings, doc.frameId);
    const nodes = doc.nodes;
    const backendIds = nodes.backendNodeId ?? [];
    const nodeNames = nodes.nodeName ?? [];
    const nodeValues = nodes.nodeValue ?? [];
    const nodeTypes = nodes.nodeType ?? [];
    const parents = nodes.parentIndex ?? [];
    const attributes = nodes.attributes ?? [];
    const clickableSet = new Set<number>(nodes.isClickable?.index ?? []);

    // node index -> layout index (first layout box for that node)
    const layoutByNode = new Map<number, number>();
    for (let li = 0; li < doc.layout.nodeIndex.length; li++) {
      const ni = doc.layout.nodeIndex[li];
      if (!layoutByNode.has(ni)) layoutByNode.set(ni, li);
    }

    // parent -> child node indices, for gathering direct text
    const childrenByParent = new Map<number, number[]>();
    for (let ni = 0; ni < parents.length; ni++) {
      const p = parents[ni];
      if (p === undefined || p < 0) continue;
      const arr = childrenByParent.get(p);
      if (arr) arr.push(ni);
      else childrenByParent.set(p, [ni]);
    }

    const directText = (ni: number): string => {
      const kids = childrenByParent.get(ni) ?? [];
      let out = '';
      for (const k of kids) {
        if (nodeTypes[k] === 3) out += str(strings, nodeValues[k]); // TEXT_NODE
      }
      return out.trim().substring(0, 30);
    };

    const attrMap = (ni: number): Map<string, string> => {
      const m = new Map<string, string>();
      const flat = attributes[ni];
      if (!flat) return m;
      for (let i = 0; i + 1 < flat.length; i += 2) {
        m.set(str(strings, flat[i]).toLowerCase(), str(strings, flat[i + 1]));
      }
      return m;
    };

    const geom = new Map<number, NodeGeom>();
    const candidates: PrunedElement[] = [];

    for (let ni = 0; ni < backendIds.length; ni++) {
      if (nodeTypes[ni] !== 1) continue; // ELEMENT_NODE only
      const li = layoutByNode.get(ni);
      if (li === undefined) continue; // no layout box at all
      const b = doc.layout.bounds[li];
      if (!b) continue;

      const backendNodeId = backendIds[ni];
      if (backendNodeId === undefined) continue;

      const cursor = str(strings, doc.layout.styles[li]?.[0]).toLowerCase();
      const attrs = attrMap(ni);
      const tag = str(strings, nodeNames[ni]).toLowerCase();
      const id = attrs.get('id') ?? '';
      const className = attrs.get('class') ?? '';

      const visible = b[2] > 0 && b[3] > 0;
      const hasInteractiveCursor = INTERACTIVE_CURSORS.has(cursor);
      const hasInlineHandler = INLINE_HANDLER_ATTRS.some((a) => attrs.has(a));
      const clickable = clickableSet.has(ni) || hasInteractiveCursor || hasInlineHandler;

      geom.set(backendNodeId, {
        bounds: { x: b[0], y: b[1], width: b[2], height: b[3] },
        cursor,
        clickable,
        visible,
      });

      const hintHaystack = `${className} ${id}`.toLowerCase();
      const hasInteractiveName = NAME_HINTS.some((h) => hintHaystack.includes(h));
      const isStandardSemantic = STANDARD_SEMANTIC_TAGS.has(tag);

      if (
        visible &&
        (hasInteractiveCursor || hasInlineHandler || (hasInteractiveName && !isStandardSemantic))
      ) {
        candidates.push({ backendNodeId, tag, id, className, cursor, text: directText(ni) });
      }
    }

    if (geom.size > 0) geometryByFrame.set(frameId, geom);
    if (candidates.length > 0) candidatesByFrame.set(frameId, candidates);
  }

  return { geometryByFrame, candidatesByFrame };
}

/**
 * Interactive candidate elements grouped by frameId, with `renderedNodeIds`
 * (already shown in the semantic surface) excluded so only *pruned*
 * (non-semantic) controls remain.
 */
export function parseInteractiveCandidates(
  snapshot: CaptureSnapshotResult,
  renderedNodeIds: Set<number>,
): Map<string, PrunedElement[]> {
  const { candidatesByFrame } = parseSnapshot(snapshot);
  if (renderedNodeIds.size === 0) return candidatesByFrame;
  const out = new Map<string, PrunedElement[]>();
  for (const [frameId, list] of candidatesByFrame) {
    const filtered = list.filter((c) => !renderedNodeIds.has(c.backendNodeId));
    if (filtered.length > 0) out.set(frameId, filtered);
  }
  return out;
}

/** Render pruned elements to the exact Markdown block the surface appends. */
export function renderPrunedMarkdown(pruned: PrunedElement[]): string {
  let md = '\n\n### Pruned Potential Interactive Elements (Non-Semantic)\n';
  for (const el of pruned) {
    const classStr = el.className ? `, class: "${el.className}"` : '';
    const idStr = el.id ? `, id: "${el.id}"` : '';
    const textStr = el.text ? ` "${el.text}"` : '';
    md += `- [${el.tag}]${textStr} (cursor: "${el.cursor}"${classStr}${idStr}) [id: ${el.backendNodeId}]\n`;
  }
  return md;
}
