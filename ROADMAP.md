# Roadmap: Best Browser MCP

This roadmap outlines the phases of development for the Best Browser MCP server, designed to serve as a temporally and spatially aware sensory debugging proxy for AI agents.

---

## Phase 1: Core Perception & Spatial Validation ✅

- [x] **Unified Semantic Accessibility Graph (USAG)**
  - Flatten DOMs, Shadow DOMs, and Out-of-Process Iframes (OOPIFs) into an LLM-optimized Markdown format using CDP `Accessibility.getFullAXTree`.
- [x] **Pre-Execution Spatial Validation (Intercept Guard)**
  - Validate mathematically that a target node is not occluded by a modal, overlay, or sticky header using CDP geometric APIs before dispatching a click/interaction event.
- [x] **Object Permanence & Differential Streaming**
  - Assign immutable integer IDs to DOM nodes upon serialization (emulating `rrweb`) to stream highly compressed JSON deltas of DOM mutations instead of raw massive HTML dumps.

## Phase 2: Temporal Observability & Telemetry ✅

- [x] **The DVR Telemetry Loop**
  - Maintain a rolling 10-second buffer of compressed viewport frames, network states, and console logs utilizing background Node.js `worker_threads` and CDP asynchronous `Page.startScreencast`.
- [x] **Human-to-Agent Session Handoff**
  - Expose the local browser profile so a human can manually reproduce a physical interaction bug, with the server packaging the resulting telemetry trace for the AI.
- [x] **Intelligent Context Compression**
  - Filter raw browser telemetry (e.g., hundreds of mousemove events) into semantic text narratives.

## Phase 3: Advanced Rendering & State Diagnostics ✅

- [x] **Interactive Layer & Listener Mapping**
  - Expose all active JavaScript event listeners attached to DOM nodes.
- [x] **GPU Paint & Compositor Profiler**
  - Surface Chromium's internal rendering metrics (paint flash overlays, compositing reasons) to debug visual lag.
- [x] **Automatic Visual Anomaly Detector**
  - Flag frame-to-frame Cumulative Layout Shifts (CLS) or sudden color brightness spikes.

## Phase 4: Environment & Network Control ✅

- [x] **Deterministic Network & Time-Warp Controller**
  - Artificially throttle, delay, or reorder individual network requests and step through browser execution time frame-by-frame to force race conditions.
- [x] **Cache & Service Worker Sandbox**
  - Dynamically mock network dropouts (offline state) and manipulate LocalStorage/IndexedDB.

## Phase 5: Temporal Awareness & Wait Primitives ✅

- [x] **Wait-for-Condition Primitive**
  - Declarative blocking wait for conditions (element visible/hidden, text appears/disappears, URL change, network idle, custom JS predicate). Eliminates brittle sleep-then-poll patterns.
  - Available both as a standalone `browser_wait_for` tool and as a `waitFor` parameter on `atomic_interact` for atomic act-then-wait in a single MCP round-trip.

---

## Phase 6: Multi-Session Architecture (Planned)

- [ ] **Multi-Tab / Multi-Page Session Support**
  - Refactor `CDPConnectionManager` from a single-page singleton to a session registry (`Map<string, { page, cdpSession, telemetry }>`).
  - Enable agents to open, switch between, and close multiple tabs within a single browser instance.
  - Unlock critical workflows currently impossible: OAuth popup flows, payment redirect handling, cross-tab state verification, and reference page comparison.
  - All existing tools accept an optional `tabId` parameter; omit to target the "active" tab (backward compatible).

- [ ] **Attach-to-Existing-Browser Mode**
  - Add `puppeteer.connect({ browserWSEndpoint })` path alongside the existing `puppeteer.launch()` in `CDPConnectionManager`.
  - Enable agents to connect to a developer's already-open browser with existing auth state, cookies, extensions, and open tabs.
  - Support connecting to remote/containerized browsers via `--remote-debugging-port`.
  - Support session reattachment after disconnects.
  - New `browser_connect` tool (or `browserWSEndpoint` / `debuggingPort` params on `browser_launch`).
