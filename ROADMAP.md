# Roadmap: Agentic Browser Observability MCP

This roadmap outlines the phases of development for the Agentic Browser Observability Model Context Protocol (MCP) server, designed to serve as a temporally and spatially aware sensory debugging proxy for AI agents.

---

## Phase 1: Core Perception & Spatial Validation (Complete)
- [x] **Unified Semantic Accessibility Graph (USAG)**
  - Flatten DOMs, Shadow DOMs, and Out-of-Process Iframes (OOPIFs) into an LLM-optimized Markdown format using CDP `Accessibility.getFullAXTree`.
- [x] **Pre-Execution Spatial Validation (Intercept Guard)**
  - Validate mathematically that a target node is not occluded by a modal, overlay, or sticky header using CDP geometric APIs before dispatching a click/interaction event.
- [x] **Object Permanence & Differential Streaming**
  - Assign immutable integer IDs to DOM nodes upon serialization (emulating `rrweb`) to stream highly compressed JSON deltas of DOM mutations instead of raw massive HTML dumps.

## Phase 2: Temporal Observability & Telemetry (Complete)
- [x] **The DVR Telemetry Loop**
  - Maintain a rolling 10-second buffer of compressed viewport frames, network states, and console logs utilizing background Node.js `worker_threads` and CDP asynchronous `Page.startScreencast`.
- [x] **Human-to-Agent Session Handoff**
  - Expose the local browser profile so a human can manually reproduce a physical interaction bug, with the server packaging the resulting telemetry trace for the AI.
- [x] **Intelligent Context Compression**
  - Filter raw browser telemetry (e.g., hundreds of mousemove events) into semantic text narratives.

## Phase 3: Advanced Rendering & State Diagnostics (Complete)
- [x] **Interactive Layer & Listener Mapping**
  - Expose all active JavaScript event listeners attached to DOM nodes.
- [x] **GPU Paint & Compositor Profiler**
  - Surface Chromium's internal rendering metrics (paint flash overlays, compositing reasons) to debug visual lag.
- [x] **Framework State History Sniffer**
  - Hook into React/Zustand/Redux to output state tree diffs before and after actions.
- [x] **Automatic Visual Anomaly Detector**
  - Flag frame-to-frame Cumulative Layout Shifts (CLS) or sudden color brightness spikes.
- [x] **Heap Allocation & Memory Leak Inspector**
  - Take browser heap snapshots to return reference retention paths for detached DOM nodes.

## Phase 4: Environment & Network Control (Complete)
- [x] **Deterministic Network & Time-Warp Controller**
  - Artificially throttle, delay, or reorder individual network requests and step through browser execution time frame-by-frame to force race conditions.
- [x] **Cache & Service Worker Sandbox**
  - Dynamically mock network dropouts (offline state) and manipulate LocalStorage/IndexedDB.
- [x] **Multi-Engine Responsive Tester**
  - Run single user flows across parallel layout engines and viewport sizes.
