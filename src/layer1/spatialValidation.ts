// ─── Spatial Validation ─────────────────────────────────────────────────────
// Predictive spatial safety net. Before a click/hover is dispatched, this module
// verifies via native geometric point APIs (CDP) that no overlay, hidden
// honeypot, or layout shift is occluding the target.
//
// If blocked, execution is halted and a descriptive error traces the exact
// obstructing DOM node.

import type { CDPSession, Page, Frame } from 'puppeteer-core';
import type { SpatialValidationResult, BoundingBox } from '../core/types.js';

/**
 * Validates that coordinates (x, y) actually hit the intended target.
 * Uses CDP to resolve the element at the point and check containment.
 */
export async function validateSpatialCoordinate(
  page: Page,
  cdpSession: CDPSession,
  x: number,
  y: number,
  targetBackendNodeId?: number,
  frame?: Frame
): Promise<SpatialValidationResult> {
  // First: verify coordinates are within viewport
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    return {
      valid: false,
      coordinates: { x, y },
      occluded: false,
      occluder: `Out of viewport bounds (${viewport.width}×${viewport.height})`,
    };
  }

  // If no target specified, just validate bounds
  if (targetBackendNodeId === undefined) {
    return { valid: true, coordinates: { x, y } };
  }

  const targetFrame = frame || page.mainFrame();

  // Resolve target element box via the frame-specific cdpSession
  try {
    const result = await cdpSession.send('DOM.getBoxModel', {
      backendNodeId: targetBackendNodeId,
    }) as { model: { content: number[] } };

    const q = result.model.content;
    const targetRect: BoundingBox = {
      x: Math.min(q[0], q[2], q[4], q[6]),
      y: Math.min(q[1], q[3], q[5], q[7]),
      width: Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
      height: Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]),
    };

    if (targetRect.width === 0 || targetRect.height === 0) {
      return {
        valid: false,
        coordinates: { x, y },
        occluded: false,
        occluder: 'Target element has zero dimensions (invisible)',
        targetRect,
      };
    }

    const centerX = x;
    const centerY = y;

    // Map global centerX, centerY to frame-local coordinates if inside iframe
    let localX = centerX;
    let localY = centerY;
    if (targetFrame !== page.mainFrame()) {
      const iframeHandle = await targetFrame.frameElement();
      if (iframeHandle) {
        const box = await iframeHandle.boundingBox();
        if (box) {
          localX = centerX - box.x;
          localY = centerY - box.y;
        }
      }
    }

    // Check what's actually at the center of the target (within targetFrame's context using local coords)
    const hitTest = await targetFrame.evaluate((cx, cy) => {
      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl) return { found: false };

      return {
        found: true,
        tag: topEl.tagName.toLowerCase(),
        id: topEl.id || undefined,
        className: typeof topEl.className === 'string' ? topEl.className.trim().split(/\s+/).slice(0, 2).join('.') : undefined,
      };
    }, localX, localY);

    if (!hitTest.found) {
      return {
        valid: false,
        coordinates: { x: centerX, y: centerY },
        occluded: true,
        occluder: 'No element found at target coordinates',
        targetRect,
      };
    }

    // Verify the hit element is the target or contains/is contained by target
    const containsCheck = await targetFrame.evaluate((cx, cy) => {
      const topEl = document.elementFromPoint(cx, cy);
      if (!topEl) return { occluded: true, occluder: 'null' };

      const rect = topEl.getBoundingClientRect();
      const occluderSelector = `${topEl.tagName.toLowerCase()}${topEl.id ? '#' + topEl.id : ''}${topEl.className && typeof topEl.className === 'string' ? '.' + topEl.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
      return {
        occluded: false,
        occluder: occluderSelector,
        occluderRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }, localX, localY);

    // Verify via CDP (using the target frame's session) that the topmost node at point matches our target
    try {
      const nodeAtPoint = await cdpSession.send('DOM.getNodeForLocation', {
        x: Math.round(localX),
        y: Math.round(localY),
        includeUserAgentShadowDOM: false,
      }) as { backendNodeId: number; frameId?: string; nodeId?: number };

      if (nodeAtPoint.backendNodeId === targetBackendNodeId) {
        return { valid: true, coordinates: { x: centerX, y: centerY }, targetRect };
      }

      // Check if the node at point is a descendant of our target or vice-versa
      try {
        const { object: targetObj } = await cdpSession.send('DOM.resolveNode', {
          backendNodeId: targetBackendNodeId,
        }) as { object: { objectId?: string } };

        const { object: hitObj } = await cdpSession.send('DOM.resolveNode', {
          backendNodeId: nodeAtPoint.backendNodeId,
        }) as { object: { objectId?: string } };

        if (targetObj.objectId && hitObj.objectId) {
          const check = await cdpSession.send('Runtime.callFunctionOn', {
            functionDeclaration: 'function(target) { return this === target || target.contains(this); }',
            objectId: hitObj.objectId,
            arguments: [{ objectId: targetObj.objectId }],
            returnByValue: true
          }) as { result: { value: boolean } };

          // Clean up remote objects
          await cdpSession.send('Runtime.releaseObject', { objectId: targetObj.objectId }).catch(() => {});
          await cdpSession.send('Runtime.releaseObject', { objectId: hitObj.objectId }).catch(() => {});

          if (check.result && check.result.value === true) {
            return { valid: true, coordinates: { x: centerX, y: centerY }, targetRect };
          }
        }
      } catch {
        // Safe fallback
      }

      return {
        valid: false,
        coordinates: { x: centerX, y: centerY },
        occluded: true,
        occluder: `Interaction hit element <${containsCheck.occluder}> instead of target. The element may be clipped, covered, or hidden by layout/CSS constraints.`,
        occluderRect: containsCheck.occluderRect as BoundingBox,
        targetRect,
      };
    } catch (err: any) {
      return {
        valid: false,
        coordinates: { x: centerX, y: centerY },
        occluded: true,
        occluder: `Interaction hit element <${containsCheck.occluder}> instead of target. (CDP location resolution error: ${err.message})`,
        occluderRect: containsCheck.occluderRect as BoundingBox,
        targetRect,
      };
    }
  } catch (err) {
    return {
      valid: false,
      coordinates: { x, y },
      occluded: false,
      occluder: `Failed to resolve target node: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Resolves a backendNodeId to its center coordinates, accounting for iframe offsets.
 * Uses CDP DOM.getBoxModel for precise geometric positioning.
 */
export async function resolveElementCenter(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  timeoutMs: number = 2000
): Promise<{ x: number; y: number }> {
  const startTime = Date.now();

  while (true) {
    try {
      const result = await cdpSession.send('DOM.getBoxModel', {
        backendNodeId,
      }) as { model: { content: number[] } };

      const q = result.model.content;
      const x = Math.min(q[0], q[2], q[4], q[6]);
      const y = Math.min(q[1], q[3], q[5], q[7]);
      const width = Math.max(q[0], q[2], q[4], q[6]) - x;
      const height = Math.max(q[1], q[3], q[5], q[7]) - y;

      if (width === 0 || height === 0) {
        throw new Error(`Element (backendNodeId: ${backendNodeId}) has zero dimensions.`);
      }

      // Clamp to viewport
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const clampedX = Math.max(0, Math.min(x + width / 2, viewport.width));
      const clampedY = Math.max(0, Math.min(y + height / 2, viewport.height));

      return { x: clampedX, y: clampedY };
    } catch (err) {
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(
          `Failed to resolve element center for backendNodeId ${backendNodeId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await new Promise(r => setTimeout(r, 200));
    }
  }
}
