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
 * Recursively calculates the absolute coordinate offset of a frame relative to the main viewport.
 * Uses a cycle guard (Set<Frame>) and loop depth limit to prevent infinite loops.
 */
export async function getFrameOffset(frame: Frame): Promise<{ x: number; y: number }> {
  let offsetX = 0;
  let offsetY = 0;
  let currentFrame: Frame | null = frame;
  const visited = new Set<Frame>();
  let depth = 0;
  const MAX_DEPTH = 15;

  while (currentFrame && currentFrame.parentFrame()) {
    if (visited.has(currentFrame) || depth >= MAX_DEPTH) {
      break;
    }
    visited.add(currentFrame);
    depth++;

    const frameElement = await currentFrame.frameElement();
    if (frameElement) {
      const rect = await frameElement.evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y };
      }).catch(() => null);
      if (rect) {
        offsetX += rect.x;
        offsetY += rect.y;
      }
    }
    currentFrame = currentFrame.parentFrame();
  }
  return { x: offsetX, y: offsetY };
}

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
      const offset = await getFrameOffset(targetFrame);
      localX = centerX - offset.x;
      localY = centerY - offset.y;
    }

    // Verify via CDP (using the target frame's session) that the topmost node at point matches our target
    try {
      // Determine what coordinates to pass to CDP DOM.getNodeForLocation.
      // If cdpSession is a subframe-specific session (OOPIF target), we pass frame-local coordinates.
      // Otherwise, cdpSession is the main page session, so we pass global coordinates.
      const isSubframeSession = targetFrame !== page.mainFrame() &&
                                (cdpSession as any).target()?.type() === 'iframe';
      const cdpX = isSubframeSession ? localX : centerX;
      const cdpY = isSubframeSession ? localY : centerY;

      const nodeAtPoint = await cdpSession.send('DOM.getNodeForLocation', {
        x: Math.round(cdpX),
        y: Math.round(cdpY),
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

      // If we got here, it's actually occluded or the hit node doesn't match!
      // ONLY NOW do we run the JS checks to get the descriptive error message, or if that fails, a fallback message.
      let occluderName = 'unknown element';
      let occluderRect: BoundingBox | undefined = undefined;

      try {
        const containsCheck = await targetFrame.evaluate((cx, cy) => {
          const topEl = document.elementFromPoint(cx, cy);
          if (!topEl) return null;
          const rect = topEl.getBoundingClientRect();
          const selector = `${topEl.tagName.toLowerCase()}${topEl.id ? '#' + topEl.id : ''}${topEl.className && typeof topEl.className === 'string' ? '.' + topEl.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''}`;
          return { selector, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        }, localX, localY);

        if (containsCheck) {
          occluderName = containsCheck.selector;
          occluderRect = containsCheck.rect;
        }
      } catch {
        // Fallback if local coordinates are weird or out of frame bounds
      }

      return {
        valid: false,
        coordinates: { x: centerX, y: centerY },
        occluded: true,
        occluder: `Interaction hit element <${occluderName}> instead of target. The element may be clipped, covered, or hidden by layout/CSS constraints.`,
        occluderRect: occluderRect || targetRect,
        targetRect,
      };

    } catch (err: any) {
      return {
        valid: false,
        coordinates: { x: centerX, y: centerY },
        occluded: false,
        occluder: `Failed to perform native spatial validation: ${err.message}`,
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
  timeoutMs: number = 2000,
  frame?: Frame
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

      let centerX = x + width / 2;
      let centerY = y + height / 2;

      // If cdpSession is a subframe-specific session (OOPIF target), the coordinates are subframe-local,
      // so we must add the frame's offset to make them global.
      const isSubframeSession = frame &&
                                frame !== page.mainFrame() &&
                                (cdpSession as any).target()?.type() === 'iframe';
      if (isSubframeSession) {
        const offset = await getFrameOffset(frame);
        centerX += offset.x;
        centerY += offset.y;
      }

      // Clamp to viewport
      const viewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }));

      const clampedX = Math.max(0, Math.min(centerX, viewport.width));
      const clampedY = Math.max(0, Math.min(centerY, viewport.height));

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

/**
 * Resolves element center and validates spatial coordinates with retry/polling.
 * Re-resolves coordinates if the element moves during the retry sequence.
 */
export async function resolveAndValidateSpatialCoordinate(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  timeoutMs: number = 2000,
  frame?: Frame,
  offset?: [number, number],
  force?: boolean
): Promise<{ valid: boolean; coordinates?: { x: number; y: number }; error?: string }> {
  const startTime = Date.now();
  let lastError = 'Unknown error';

  while (true) {
    try {
      // Resolve element center using 500ms inner timeout to prevent single check blocking too long
      let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, 500, frame);
      if (offset) {
        x += offset[0];
        y += offset[1];
      }

      if (force) {
        return { valid: true, coordinates: { x, y } };
      }

      // Check occlusion
      const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, frame);
      if (validation.valid) {
        return { valid: true, coordinates: validation.coordinates };
      }

      lastError = `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`;
    } catch (err: any) {
      lastError = err.message || String(err);
    }

    if (Date.now() - startTime >= timeoutMs) {
      return { valid: false, error: lastError };
    }

    await new Promise(r => setTimeout(r, 100));
  }
}
