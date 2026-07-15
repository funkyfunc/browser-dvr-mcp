// ─── ImmutableNodeIndex ──────────────────────────────────────────────────────
// Emulates the rrweb serialization paradigm: maps every active DOM node to a
// unique, immutable integer identifier upon initial render.
//
// This grants the LLM absolute object permanence across conversational turns,
// even if the node's styling, CSS classes, or position change dynamically.
//
// Uses CDP's backendNodeId as the canonical source of truth. backendNodeIds are
// assigned by the browser engine and survive VDOM reconciliation — unlike
// injected data-attributes which React will destroy during re-renders.

import type { NodeSnapshot, StateDelta, BoundingBox } from './types.js';

/** Fused geometry/style for a node, keyed by backendNodeId (from DOMSnapshot). */
export interface NodeGeometry {
  bounds: BoundingBox;
  cursor: string;
  clickable: boolean;
  visible: boolean;
}

/** Coerce a primitive AX value to a stable string for snapshotting/diffing. */
function coerceAXValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return undefined;
  return String(value);
}

interface AXNodeRaw {
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

export class ImmutableNodeIndex {
  // backendNodeId → stableId
  private nodeMap = new Map<number, number>();
  // stableId → backendNodeId
  private reverseMap = new Map<number, number>();
  // stableId → snapshot
  private snapshotMap = new Map<number, NodeSnapshot>();
  // Previous snapshot for delta computation
  private previousSnapshot: Map<number, NodeSnapshot> | null = null;

  private nextStableId = 1;

  // backendNodeIds observed during the current begin/endBuild bracket. Used to
  // prune nodes that have left the DOM so the index stays bounded and removals
  // are detectable.
  private seenThisBuild = new Set<number>();
  private buildActive = false;

  // ─── Build Index from AX Tree ──────────────────────────────────────────

  /**
   * Builds the immutable index from a full accessibility tree.
   * Called after initial page load and after major navigations.
   * Nodes that already have stableIds retain them (permanence).
   *
   * Nodes absent from `nodes` are pruned so that (a) the index cannot grow
   * without bound over a long-lived SPA session, and (b) `computeDelta` can
   * actually detect removals. Stable IDs are still reused for nodes that
   * survive across builds, preserving object permanence while they are mounted.
   *
   * Pruning of departed nodes only happens inside an explicit
   * `beginBuild()` / `endBuild()` bracket, so a multi-frame page can contribute
   * every frame's tree before stale nodes are removed. A bare call (no bracket)
   * stays purely additive — safe for partial/subtree builds like
   * `getElementTree` that must not wipe the rest of the index.
   */
  buildFromAXNodes(nodes: AXNodeRaw[], geometry?: Map<number, NodeGeometry>): void {
    const nodeLookup = new Map<string, AXNodeRaw>(nodes.map((n) => [n.nodeId, n]));

    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;

      const backendId = node.backendDOMNodeId;
      this.seenThisBuild.add(backendId);

      // If this backendNodeId already has a stableId, keep it (permanence)
      if (!this.nodeMap.has(backendId)) {
        const stableId = this.nextStableId++;
        this.nodeMap.set(backendId, stableId);
        this.reverseMap.set(stableId, backendId);
      }

      const stableId = this.nodeMap.get(backendId)!;

      // Update snapshot
      const childStableIds: number[] = [];
      if (node.childIds) {
        for (const childNodeId of node.childIds) {
          const childNode = nodeLookup.get(childNodeId);
          if (childNode?.backendDOMNodeId && this.nodeMap.has(childNode.backendDOMNodeId)) {
            childStableIds.push(this.nodeMap.get(childNode.backendDOMNodeId)!);
          }
        }
      }

      const geom = geometry?.get(backendId);
      this.snapshotMap.set(stableId, {
        stableId,
        backendNodeId: backendId,
        role: node.role?.value || 'generic',
        name: node.name?.value || '',
        // Coerce any primitive AX value (string, number, boolean) to string so
        // a numeric change (e.g. a slider 0 -> 50) still produces a delta. The
        // serializer already renders numeric values, so dropping them here made
        // the semantic surface and the state delta disagree.
        value: coerceAXValue(node.value?.value),
        properties: node.properties
          ? node.properties.map((p) => ({ name: p.name, value: p.value.value }))
          : undefined,
        // Fused geometry/style from the single DOMSnapshot (undefined if the
        // node has no layout box).
        boundingBox: geom?.bounds,
        cursor: geom?.cursor,
        clickable: geom?.clickable,
        visible: geom?.visible,
        childIds: childStableIds,
      });
    }
  }

  /**
   * Opens a build bracket. Subsequent `buildFromAXNodes` calls accumulate their
   * observed backendNodeIds; call `endBuild()` once all frames have contributed
   * to prune nodes that have left the DOM.
   */
  beginBuild(): void {
    this.buildActive = true;
    this.seenThisBuild.clear();
  }

  /**
   * Closes a build bracket and prunes every node not observed since the
   * matching `beginBuild()`, keeping the index bounded and removals detectable.
   * A no-op if no bracket was opened.
   */
  endBuild(): void {
    if (!this.buildActive) return;
    for (const backendId of [...this.nodeMap.keys()]) {
      if (!this.seenThisBuild.has(backendId)) {
        const stableId = this.nodeMap.get(backendId)!;
        this.nodeMap.delete(backendId);
        this.reverseMap.delete(stableId);
        this.snapshotMap.delete(stableId);
      }
    }
    this.buildActive = false;
  }

  // ─── Lookup ────────────────────────────────────────────────────────────

  getStableId(backendNodeId: number): number | undefined {
    return this.nodeMap.get(backendNodeId);
  }

  getBackendNodeId(stableId: number): number | undefined {
    return this.reverseMap.get(stableId);
  }

  getSnapshot(stableId: number): NodeSnapshot | undefined {
    return this.snapshotMap.get(stableId);
  }

  getAllSnapshots(): Map<number, NodeSnapshot> {
    return new Map(this.snapshotMap);
  }

  getPreviousSnapshots(): Map<number, NodeSnapshot> | null {
    return this.previousSnapshot ? new Map(this.previousSnapshot) : null;
  }

  get size(): number {
    return this.nodeMap.size;
  }

  // ─── State Delta ──────────────────────────────────────────────────────

  /**
   * Saves the current snapshot as the baseline for the next delta computation.
   */
  checkpoint(): void {
    this.previousSnapshot = new Map(this.snapshotMap);
  }

  /**
   * Computes the structural delta between the current state and the last checkpoint.
   * Returns only what changed — added, removed, and modified nodes.
   */
  computeDelta(): StateDelta | null {
    if (!this.previousSnapshot) return null;

    const added: NodeSnapshot[] = [];
    const removed: { stableId: number; role: string; name: string }[] = [];
    const modified: {
      stableId: number;
      changes: Record<string, { previous: unknown; current: unknown }>;
    }[] = [];

    // Find added and modified nodes
    for (const [stableId, current] of this.snapshotMap) {
      const previous = this.previousSnapshot.get(stableId);
      if (!previous) {
        added.push(current);
        continue;
      }

      const changes: Record<string, { previous: unknown; current: unknown }> = {};
      if (previous.role !== current.role) {
        changes['role'] = { previous: previous.role, current: current.role };
      }
      if (previous.name !== current.name) {
        changes['name'] = { previous: previous.name, current: current.name };
      }
      if (previous.value !== current.value) {
        changes['value'] = { previous: previous.value, current: current.value };
      }
      if (JSON.stringify(previous.properties) !== JSON.stringify(current.properties)) {
        changes['properties'] = { previous: previous.properties, current: current.properties };
      }
      // Detect structural reparenting/reordering. Kept in sync with the worker's
      // computeStateDelta so both serialization paths produce the same delta.
      if (JSON.stringify(previous.childIds) !== JSON.stringify(current.childIds)) {
        changes['children'] = { previous: previous.childIds, current: current.childIds };
      }

      if (Object.keys(changes).length > 0) {
        modified.push({ stableId, changes });
      }
    }

    // Find removed nodes
    for (const [stableId, previous] of this.previousSnapshot) {
      if (!this.snapshotMap.has(stableId)) {
        removed.push({ stableId, role: previous.role, name: previous.name });
      }
    }

    if (added.length === 0 && removed.length === 0 && modified.length === 0) {
      return null;
    }

    return {
      added,
      removed,
      modified,
      timestamp: Date.now(),
    };
  }

  // ─── Reset ─────────────────────────────────────────────────────────────

  clear(): void {
    this.nodeMap.clear();
    this.reverseMap.clear();
    this.snapshotMap.clear();
    this.previousSnapshot = null;
    this.nextStableId = 1;
    this.seenThisBuild.clear();
    this.buildActive = false;
  }
}
