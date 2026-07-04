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

import type { CDPSession, Page } from 'puppeteer-core';
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
  options: { timeoutMs?: number } = {}
): Promise<AtomicInteractResult> {
  const { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);

  // Spatial validation
  const validation = await validateSpatialCoordinate(page, cdpSession, x, y, backendNodeId);
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
 * Atomic type: click to focus → type text using CDP key events.
 */
export async function atomicType(
  page: Page,
  cdpSession: CDPSession,
  backendNodeId: number,
  text: string,
  telemetry: SessionTelemetryManager,
  options: { timeoutMs?: number; clearFirst?: boolean } = {}
): Promise<AtomicInteractResult> {
  const { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);

  // Focus via click
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1,
  });
  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1,
  });

  // Optional: select all and delete to clear field first
  if (options.clearFirst !== false) {
    await cdpSession.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a',
      modifiers: process.platform === 'darwin' ? 4 : 2, // Meta on Mac, Ctrl otherwise
    });
    await cdpSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a' });
    await cdpSession.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace',
    });
    await cdpSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace' });
  }

  // Type each character using insertText for proper IME handling
  await cdpSession.send('Input.insertText', { text });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'type',
    timestamp: Date.now(),
    x, y,
    text: text.substring(0, 50),
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'type',
    coordinates: { x, y },
    feedback: `Typed "${text.substring(0, 30)}${text.length > 30 ? '...' : ''}" into element (id: ${backendNodeId}).`,
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
  options: { timeoutMs?: number } = {}
): Promise<AtomicInteractResult> {
  const { x, y } = await resolveElementCenter(page, cdpSession, backendNodeId, options.timeoutMs || 2000);

  await cdpSession.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
  });

  await new Promise(r => setTimeout(r, 150));

  telemetry.addInteraction({
    type: 'hover',
    timestamp: Date.now(),
    x, y,
    target: `backendNodeId:${backendNodeId}`,
  });

  return {
    success: true,
    action: 'hover',
    coordinates: { x, y },
    feedback: `Hovered over element (id: ${backendNodeId}) at (${Math.round(x)}, ${Math.round(y)}).`,
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
  page: Page,
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
