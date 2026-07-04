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

import type { NodeSnapshot, StateDelta } from './types.js';

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

  // ─── Build Index from AX Tree ──────────────────────────────────────────

  /**
   * Builds the immutable index from a full accessibility tree.
   * Called after initial page load and after major navigations.
   * Nodes that already have stableIds retain them (permanence).
   */
  buildFromAXNodes(nodes: AXNodeRaw[]): void {
    const currentBackendIds = new Set<number>();

    for (const node of nodes) {
      if (node.ignored || !node.backendDOMNodeId) continue;

      const backendId = node.backendDOMNodeId;
      currentBackendIds.add(backendId);

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
          const childNode = nodes.find((n) => n.nodeId === childNodeId);
          if (childNode?.backendDOMNodeId && this.nodeMap.has(childNode.backendDOMNodeId)) {
            childStableIds.push(this.nodeMap.get(childNode.backendDOMNodeId)!);
          }
        }
      }

      this.snapshotMap.set(stableId, {
        stableId,
        backendNodeId: backendId,
        role: node.role?.value || 'generic',
        name: node.name?.value || '',
        value: typeof node.value?.value === 'string' ? node.value.value : undefined,
        properties: node.properties
          ? node.properties.map((p) => ({ name: p.name, value: p.value.value }))
          : undefined,
        childIds: childStableIds,
      });
    }
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
  }
}
