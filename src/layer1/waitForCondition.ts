// ─── Wait-for-Condition ─────────────────────────────────────────────────────
// Temporal awareness primitive. Blocks until a declarative condition is met
// or a timeout elapses, replacing fragile sleep-then-poll patterns.
//
// Used by:
// 1. The standalone `browser_wait_for` tool (wait without acting)
// 2. The `waitFor` parameter on `atomic_interact` (act then wait)
//
// Supported condition types:
// - selector          Wait for a CSS selector to match a visible element
// - selector_hidden   Wait for a selector to stop matching visible elements
// - text              Wait for text content to appear on the page
// - text_hidden       Wait for text to disappear from the page
// - url               Wait for the page URL to contain a substring
// - network_idle      Wait for no pending network requests for N ms
// - predicate         Wait for a custom JS expression to return truthy

import type { Page, CDPSession } from 'puppeteer-core';
import type { SessionTelemetryManager } from '../telemetry/SessionTelemetryManager.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WaitCondition {
  type:
    'selector' | 'selector_hidden' | 'text' | 'text_hidden' | 'url' | 'network_idle' | 'predicate';
  /** CSS selector, text substring, URL substring, or JS expression (depending on type) */
  value?: string;
  /** For network_idle: how long (ms) the network must stay quiet to count as idle (default: 500) */
  durationMs?: number;
}

export interface WaitResult {
  /** Whether the condition was met before the timeout */
  met: boolean;
  /** How long we waited in milliseconds */
  elapsedMs: number;
  /** Human-readable description of what happened */
  details: string;
}

// ─── Polling interval ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 100;

// ─── Condition resolvers ────────────────────────────────────────────────────

async function checkSelector(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }, selector);
  } catch {
    return false;
  }
}

async function checkSelectorHidden(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return true; // Element doesn't exist → hidden
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return true;
      const style = window.getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden';
    }, selector);
  } catch {
    return false;
  }
}

async function checkText(page: Page, text: string): Promise<boolean> {
  try {
    return await page.evaluate((searchText) => {
      const body = document.body;
      if (!body) return false;
      return body.innerText.toLowerCase().includes(searchText.toLowerCase());
    }, text);
  } catch {
    return false;
  }
}

async function checkTextHidden(page: Page, text: string): Promise<boolean> {
  try {
    return await page.evaluate((searchText) => {
      const body = document.body;
      if (!body) return true;
      return !body.innerText.toLowerCase().includes(searchText.toLowerCase());
    }, text);
  } catch {
    return false;
  }
}

async function checkUrl(page: Page, urlSubstring: string): Promise<boolean> {
  try {
    const currentUrl = page.url();
    return currentUrl.includes(urlSubstring);
  } catch {
    return false;
  }
}

async function checkPredicate(page: Page, expression: string): Promise<boolean> {
  try {
    const result = await page.evaluate(expression);
    return !!result;
  } catch {
    return false;
  }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Wait until a declarative condition is met, or timeout fires.
 *
 * @param page      - The Puppeteer Page instance
 * @param cdp       - The CDP session (unused currently, reserved for future condition types)
 * @param telemetry - The session telemetry manager (used for network_idle)
 * @param condition - The condition to wait for
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
 * @returns A WaitResult describing what happened
 */
export async function waitForCondition(
  page: Page,
  _cdp: CDPSession,
  telemetry: SessionTelemetryManager | null,
  condition: WaitCondition,
  timeoutMs: number = 5000,
): Promise<WaitResult> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // Validate inputs
  if (condition.type !== 'network_idle' && (!condition.value || condition.value.trim() === '')) {
    return {
      met: false,
      elapsedMs: 0,
      details: `Condition type "${condition.type}" requires a "value" parameter.`,
    };
  }

  // network_idle has special logic: the network must be idle for a sustained duration
  if (condition.type === 'network_idle') {
    const requiredQuietMs = condition.durationMs ?? 500;
    let lastBusyTime = Date.now();

    while (Date.now() < deadline) {
      const pendingCount = telemetry ? telemetry.getPendingRequestCount() : 0;

      if (pendingCount > 0) {
        lastBusyTime = Date.now();
      } else {
        const quietDuration = Date.now() - lastBusyTime;
        if (quietDuration >= requiredQuietMs) {
          const elapsed = Date.now() - startTime;
          return {
            met: true,
            elapsedMs: elapsed,
            details: `Network idle for ${requiredQuietMs}ms (waited ${elapsed}ms total).`,
          };
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const elapsed = Date.now() - startTime;
    const pendingCount = telemetry ? telemetry.getPendingRequestCount() : 0;
    return {
      met: false,
      elapsedMs: elapsed,
      details: `Timed out after ${elapsed}ms waiting for network idle. ${pendingCount} request(s) still pending.`,
    };
  }

  // All other conditions: simple poll loop
  const value = condition.value!;

  while (Date.now() < deadline) {
    let conditionMet = false;

    switch (condition.type) {
      case 'selector':
        conditionMet = await checkSelector(page, value);
        break;
      case 'selector_hidden':
        conditionMet = await checkSelectorHidden(page, value);
        break;
      case 'text':
        conditionMet = await checkText(page, value);
        break;
      case 'text_hidden':
        conditionMet = await checkTextHidden(page, value);
        break;
      case 'url':
        conditionMet = await checkUrl(page, value);
        break;
      case 'predicate':
        conditionMet = await checkPredicate(page, value);
        break;
    }

    if (conditionMet) {
      const elapsed = Date.now() - startTime;
      return {
        met: true,
        elapsedMs: elapsed,
        details: describeSuccess(condition, elapsed),
      };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const elapsed = Date.now() - startTime;
  return {
    met: false,
    elapsedMs: elapsed,
    details: describeTimeout(condition, elapsed),
  };
}

// ─── Human-readable descriptions ────────────────────────────────────────────

function describeSuccess(condition: WaitCondition, elapsedMs: number): string {
  const value = condition.value || '';
  switch (condition.type) {
    case 'selector':
      return `Element matching "${value}" appeared after ${elapsedMs}ms.`;
    case 'selector_hidden':
      return `Element matching "${value}" disappeared after ${elapsedMs}ms.`;
    case 'text':
      return `Text "${value}" appeared after ${elapsedMs}ms.`;
    case 'text_hidden':
      return `Text "${value}" disappeared after ${elapsedMs}ms.`;
    case 'url':
      return `URL now contains "${value}" after ${elapsedMs}ms.`;
    case 'predicate':
      return `Predicate returned truthy after ${elapsedMs}ms.`;
    default:
      return `Condition met after ${elapsedMs}ms.`;
  }
}

function describeTimeout(condition: WaitCondition, elapsedMs: number): string {
  const value = condition.value || '';
  switch (condition.type) {
    case 'selector':
      return `Timed out after ${elapsedMs}ms waiting for element matching "${value}" to appear.`;
    case 'selector_hidden':
      return `Timed out after ${elapsedMs}ms waiting for element matching "${value}" to disappear.`;
    case 'text':
      return `Timed out after ${elapsedMs}ms waiting for text "${value}" to appear.`;
    case 'text_hidden':
      return `Timed out after ${elapsedMs}ms waiting for text "${value}" to disappear.`;
    case 'url':
      return `Timed out after ${elapsedMs}ms waiting for URL to contain "${value}". Current URL: unknown.`;
    case 'predicate':
      return `Timed out after ${elapsedMs}ms waiting for predicate to return truthy.`;
    default:
      return `Timed out after ${elapsedMs}ms.`;
  }
}
