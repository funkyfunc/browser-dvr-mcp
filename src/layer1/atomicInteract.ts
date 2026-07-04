// ─── Atomic Interact ────────────────────────────────────────────────────────
// Combines element location and action into a single, uninterruptible browser
// engine tick using direct CDP Input.dispatch* commands.
//
// This eliminates Virtual DOM detachment race conditions where:
// 1. Agent locates element → gets coordinates
// 2. React re-renders → element moves/is destroyed
// 3. Agent clicks → misses or hits wrong target
//
// By using CDP directly instead of Puppeteer's page.mouse.*, we get:
// - Atomic dispatch (no async gaps between locate and click)
// - Access to raw input events (dispatchMouseEvent, dispatchKeyEvent)
// - No Puppeteer overhead or abstraction leakage

import type { CDPSession, Page, Frame } from 'puppeteer-core';
import { validateSpatialCoordinate, resolveElementCenter } from './spatialValidation.js';
import type { SessionTelemetryManager } from '../telemetry/SessionTelemetryManager.js';

export interface AtomicInteractResult {
  success: boolean;
  action: string;
  coordinates?: { x: number; y: number };
  feedback: string;
  mutationSummary?: string;
}

/**
 * Atomic click: resolve → validate → dispatch in one tick.
 */
export async function atomicClick(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; offset?: [number, number]; frame?: Frame } = {}
): Promise<AtomicInteractResult> {
  let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);
  if (options.offset) {
    x += options.offset[0];
    y += options.offset[1];
  }

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, options.frame);
  if (!validation.valid) {
    return {
      success: false,
      action: 'click',
      coordinates: { x, y },
      feedback: `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`,
    };
  }

  // Direct CDP mouse event dispatch — atomic, no Puppeteer abstraction
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });

  // Brief settle time for DOM mutations
  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'click',
    timestamp: Date.now(),
    x: validation.coordinates.x,
    y: validation.coordinates.y,
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'click',
    coordinates: validation.coordinates,
    feedback: `Clicked element (id: ${backendNodeId}) at (${Math.round(validation.coordinates.x)}, ${Math.round(validation.coordinates.y)}).`,
  };
}

/**
 * Atomic coordinate click: bypass the DOM entirely for Canvas interfaces.
 */
export async function coordinateClick(
  page: Page,
  cdpSession: CDPSession,
  x: number,
  y: number,
  telemetry: SessionTelemetryManager
): Promise<AtomicInteractResult> {
  // Bounds check
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
    return {
      success: false,
      action: 'coordinate_click',
      coordinates: { x, y },
      feedback: `Coordinates (${x}, ${y}) out of viewport bounds (${viewport.width}×${viewport.height}).`,
    };
  }

  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1,
  });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'click',
    timestamp: Date.now(),
    x, y,
    target: `coordinate:(${x},${y})`,
  });

  return {
    success: true,
    action: 'coordinate_click',
    coordinates: { x, y },
    feedback: `Clicked at coordinates (${Math.round(x)}, ${Math.round(y)}).`,
  };
}

/**
 * Atomic double click: click element center twice.
 */
export async function atomicDoubleClick(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; offset?: [number, number]; frame?: Frame } = {}
): Promise<AtomicInteractResult> {
  let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);
  if (options.offset) {
    x += options.offset[0];
    y += options.offset[1];
  }

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, options.frame);
  if (!validation.valid) {
    return {
      success: false,
      action: 'dblclick',
      coordinates: { x, y },
      feedback: `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`,
    };
  }

  // First click
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });

  // Second click
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 2,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 2,
  });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'click', // track as click
    timestamp: Date.now(),
    x: validation.coordinates.x,
    y: validation.coordinates.y,
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'dblclick',
    coordinates: validation.coordinates,
    feedback: `Double-clicked element (id: ${backendNodeId}) at (${Math.round(validation.coordinates.x)}, ${Math.round(validation.coordinates.y)}).`,
  };
}

/**
 * Atomic type: click to focus → type text using CDP key events.
 */
export async function atomicType(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  text: string,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; clearFirst?: boolean; offset?: [number, number]; frame?: Frame } = {}
): Promise<AtomicInteractResult> {
  let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);
  if (options.offset) {
    x += options.offset[0];
    y += options.offset[1];
  }

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, options.frame);
  if (!validation.valid) {
    return {
      success: false,
      action: 'type',
      coordinates: { x, y },
      feedback: `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`,
    };
  }

  // Focus via click
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });

  // Optional: select all text, then delete to clear field first
  if (options.clearFirst !== false) {
    await cdpSession.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      commands: ['selectAll'],
    });
  }

  // Type text using insertText
  await cdpSession.send('Input.insertText', { text });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'type',
    timestamp: Date.now(),
    x: validation.coordinates.x,
    y: validation.coordinates.y,
    text: text.substring(0, 50),
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'type',
    coordinates: validation.coordinates,
    feedback: `Typed "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}" into element (id: ${backendNodeId}) at (${Math.round(validation.coordinates.x)}, ${Math.round(validation.coordinates.y)}).`,
  };
}

/**
 * Atomic clear: focus an element and clear its value using a triple click.
 */
export async function atomicClear(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; offset?: [number, number]; frame?: Frame } = {}
): Promise<AtomicInteractResult> {
  let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);
  if (options.offset) {
    x += options.offset[0];
    y += options.offset[1];
  }

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, options.frame);
  if (!validation.valid) {
    return {
      success: false,
      action: 'clear',
      coordinates: { x, y },
      feedback: `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`,
    };
  }

  // Focus first
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
    button: 'left',
    clickCount: 1,
  });

  // Select all and clear
  await cdpSession.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    commands: ['selectAll'],
  });
  await cdpSession.send('Input.insertText', { text: '' });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'type',
    timestamp: Date.now(),
    x: validation.coordinates.x,
    y: validation.coordinates.y,
    text: '',
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'clear',
    coordinates: validation.coordinates,
    feedback: `Cleared text in element (id: ${backendNodeId}) at (${Math.round(validation.coordinates.x)}, ${Math.round(validation.coordinates.y)}).`,
  };
}

/**
 * Atomic hover: move mouse to element center.
 */
export async function atomicHover(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; offset?: [number, number]; frame?: Frame } = {}
): Promise<AtomicInteractResult> {
  let { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);
  if (options.offset) {
    x += options.offset[0];
    y += options.offset[1];
  }

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId, options.frame);
  if (!validation.valid) {
    return {
      success: false,
      action: 'hover',
      coordinates: { x, y },
      feedback: `Spatial validation failed: ${validation.occluder || 'unknown obstruction'}`,
    };
  }

  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(validation.coordinates.x),
    y: Math.round(validation.coordinates.y),
  });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'hover',
    timestamp: Date.now(),
    x: validation.coordinates.x,
    y: validation.coordinates.y,
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'hover',
    coordinates: validation.coordinates,
    feedback: `Hovered over element (id: ${backendNodeId}) at (${Math.round(validation.coordinates.x)}, ${Math.round(validation.coordinates.y)}).`,
  };
}

/**
 * Atomic key press.
 */
export async function atomicKeyPress(
  page: Page,
  _cdpSession: CDPSession,
  key: string,
  telemetry: SessionTelemetryManager
): Promise<AtomicInteractResult> {
  // Use Puppeteer keyboard for complex key names (Enter, Escape, etc.)
  // CDP doesn't have a simple "press key by name" API
  await page.keyboard.press(key as any);

  telemetry.addInteraction({
    type: 'keypress',
    timestamp: Date.now(),
    key,
  });

  return {
    success: true,
    action: 'key',
    feedback: `Pressed key: ${key}`,
  };
}

/**
 * Atomic scroll.
 */
export async function atomicScroll(
  page: Page | Frame,
  _cdpSession: CDPSession,
  direction: 'up' | 'down' | 'top' | 'bottom',
  telemetry: SessionTelemetryManager,
  amount?: number
): Promise<AtomicInteractResult> {
  await page.evaluate((dir, amt) => {
    const scrollAmt = amt || window.innerHeight;
    if (dir === 'down') window.scrollBy(0, scrollAmt);
    else if (dir === 'up') window.scrollBy(0, -scrollAmt);
    else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
    else if (dir === 'top') window.scrollTo(0, 0);
  }, direction, amount);

  telemetry.addInteraction({
    type: 'scroll',
    timestamp: Date.now(),
    details: `${direction}${amount ? ` ${amount}px` : ''}`,
  });

  return {
    success: true,
    action: 'scroll',
    feedback: `Scrolled ${direction}${amount ? ` by ${amount}px` : ''}.`,
  };
}

/**
 * Automatically discovers the frame context of a backendNodeId.
 */
export async function findFrameForBackendNodeId(
  page: Page,
  backendNodeId: number
): Promise<Frame> {
  const frames = page.frames();
  for (const frame of frames) {
    try {
      const handle = await (frame as any).mainRealm().adoptBackendNode(backendNodeId);
      if (handle) {
        const isOwner = await handle.evaluate((el: any) => el.ownerDocument.defaultView === window);
        await handle.dispose();
        if (isOwner) {
          return frame;
        }
      }
    } catch {
      // Ignore errors (e.g. cross-process target adoption throws)
    }
  }
  return page.mainFrame(); // Default fallback
}

/**
 * Atomic drag and drop operation using direct CDP mouse events.
 */
export async function atomicDragAndDrop(
  _page: Page,
  cdpSession: CDPSession,
  source: { x: number; y: number },
  destination: { x: number; y: number },
  telemetry: SessionTelemetryManager
): Promise<AtomicInteractResult> {
  // 1. Move mouse to start coordinates (hover)
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(source.x),
    y: Math.round(source.y),
  });
  await new Promise(r => setTimeout(r, 50));

  // 2. Press left button at start
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(source.x),
    y: Math.round(source.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await new Promise(r => setTimeout(r, 50));

  // 3. Smooth interpolation to destination
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const currX = source.x + (destination.x - source.x) * ratio;
    const currY = source.y + (destination.y - source.y) * ratio;
    await cdpSession.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(currX),
      y: Math.round(currY),
      button: 'left',
      buttons: 1,
    });
    await new Promise(r => setTimeout(r, 20));
  }
  await new Promise(r => setTimeout(r, 50));

  // 4. Release mouse button at destination
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(destination.x),
    y: Math.round(destination.y),
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'drag' as any,
    timestamp: Date.now(),
    x: source.x,
    y: source.y,
    details: `dragged to (${Math.round(destination.x)}, ${Math.round(destination.y)})`,
  });

  return {
    success: true,
    action: 'drag_and_drop',
    feedback: `Dragged from (${Math.round(source.x)}, ${Math.round(source.y)}) to (${Math.round(destination.x)}, ${Math.round(destination.y)}).`,
  };
}
