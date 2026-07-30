# Architecture: Best Browser MCP

*A Dual-Layer Perceptive Middleware for Autonomous AI Agents*

---

## Why This Architecture Exists

### The Blindfold Problem

AI coding agents interact with the web like they are exploring a dark room with a stick. They poke the DOM (via Puppeteer), wait to see if it pokes back, and take a static polaroid of the aftermath. When a transient bug flashes, or a modal invisibly blocks a button, the agent is confused, hallucinating reasons for why its action failed.

The core insight is that **browsers are not documents — they are temporal, spatial, interactive systems.** HTML is designed for rendering engines, not for Large Language Models. Forcing an LLM to read raw HTML is a waste of tokens, context, and reasoning capacity.

Best Browser MCP exists to solve this. It is not another browser driver — it is an **optic nerve** for AI agents. It translates the chaotic, visual, temporal reality of the modern web into pure, token-efficient semantic truth.

### Why We Rebuilt from Scratch

The previous architecture was a 2,239-line monolithic `BrowserManager` class that accumulated debt over four development phases:

1. **Framework-specific macros** (React Fiber walking, Redux DevTools sniffing) made the server opinionated — the opposite of an atomic primitive toolkit.
2. **Injected `data-mcp-id` attributes** were destroyed by React's VDOM reconciliation, causing stale reference errors across conversational turns.
3. **Blocking screenshots** and main-thread AX tree serialization choked the JSON-RPC transport during heavy pages.
4. **Duplicate telemetry buffers** (console/network arrays on BrowserManager AND on Session) led to inconsistent state.
5. **CI/CD patterns** (responsive layout testing, paint flash toggles) violated the core promise: "Not a CI/CD testing framework."

The new architecture addresses every one of these anti-patterns.

---

## The Four Promises

Every technical decision in this codebase must serve one of these promises:

### 1. Absolute Truth (No Silent Failures)
We never let the agent lie to itself. Before a click is dispatched, we mathematically verify via CDP geometric APIs that the target is actually clickable. If a transparent overlay is blocking it, the action is halted with a descriptive error identifying the exact obstructing node.

### 2. Time is a First-Class Citizen
The web is a movie, not a picture. Bugs happen in temporal gaps between snapshots. Through the `SessionTelemetryManager`, we capture a continuous timeline of DOM mutations, network failures, and console errors — not as raw dumps, but as **progressive disclosure summaries** that respect the agent's token budget.

### 3. Semantic Empathy
We never send raw HTML to an LLM. The `get_semantic_surface` tool queries the browser's native Accessibility Object Model — which natively resolves closed shadow roots, computes accessible names, and pierces iframes — and serializes it to a hyper-compressed Markdown graph on a worker thread.

### 4. The Observer Effect (Do No Harm)
Our telemetry gathering happens silently via passive CDP event listeners. We never block the main thread. We never inject scripts that could interfere with the application. The agent sees the page exactly as it behaves in the wild.

---

## Architectural Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│                     MCP Tool Interface (index.ts)                     │
│          Hyper-descriptive schemas for autonomous agent usage         │
├───────────────────────────────┬───────────────────────────────────────┤
│    Layer 1: Action            │    Layer 2: Perception                │
│    Primitives                 │    & Telemetry                        │
│                               │                                       │
│  • atomic_interact            │  • get_semantic_surface               │
│  • evaluate_in_context        │  • get_session_summary                │
│  • browser_navigate           │  • query_session_telemetry            │
│  • browser_wait_for           │  • get_state_delta                    │
│  • stream_screencast          │  • browser_get_timeline               │
│  • browser_screenshot         │                                       │
├───────────────────────────────┴───────────────────────────────────────┤
│                    Core Infrastructure                                │
│                                                                       │
│  CDPConnectionManager ─── ImmutableNodeIndex ─── SessionTelemetry     │
│  (browser lifecycle)       (rrweb-style IDs)      (flight recorder)   │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│              Worker Thread (serializationWorker.ts)                    │
│                                                                       │
│  • AX Tree → Markdown serialization (CPU-intensive string ops)        │
│  • State delta computation (deep structural comparison)               │
│  • DVR frame buffering (binary data management)                       │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Module Reference

### Core (`src/core/`)

| Module | Purpose |
|---|---|
| **CDPConnectionManager** | Owns the browser lifecycle: launch, connect, close. The ONLY module that imports `puppeteer-core`. Enables `Target.setAutoAttach` for automatic OOPIF discovery. |
| **ImmutableNodeIndex** | Emulates the `rrweb` serialization paradigm: maps every active DOM node to a unique, immutable integer identifier (`backendNodeId → stableId`). These IDs survive VDOM reconciliation — unlike injected `data-mcp-id` attributes which React destroys during re-renders. Supports checkpoint/delta for state diffing. |
| **types.ts** | All shared TypeScript interfaces. Lives here to prevent circular dependencies. Includes the `RingBuffer<T>` utility for capped telemetry storage. |

### Telemetry (`src/telemetry/`)

| Module | Purpose |
|---|---|
| **SessionTelemetryManager** | The "Black Box" flight recorder. Uses low-overhead passive CDP event listeners to silently capture network traffic, console exceptions, and DOM mutations into capped `RingBuffer` structures (network: 5000, console: 2000, mutations: 5000). Implements progressive disclosure via `getSummary()` (token-efficient overview) and `drillDown(category, filter)` (surgical extraction). |

### Workers (`src/workers/`)

| Module | Purpose |
|---|---|
| **serializationWorker** | Runs in a dedicated `worker_thread` to offload CPU-intensive operations: AX tree → Markdown conversion, state delta computation, and DVR frame buffering. Prevents these operations from blocking the JSON-RPC transport on the main Node.js event loop. |
| **workerBridge** | Type-safe RPC bridge between the main thread and the worker. Uses a pending promise map to correlate async request/response pairs over the `MessagePort` channel. |

### Layer 1: Action Primitives (`src/layer1/`)

| Module | Purpose |
|---|---|
| **atomicInteract** | Combines element location and action into a single, uninterruptible browser engine tick using direct CDP `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`. Eliminates VDOM detachment race conditions. |
| **spatialValidation** | Pre-execution safety net. Before a click is dispatched, verifies via CDP `DOM.getBoxModel` and `DOM.getNodeForLocation` that no overlay is occluding the target. |
| **evaluateInContext** | Execute JavaScript in any frame context, including OOPIFs. Uses `Target.setAutoAttach` to discover all execution contexts. Replaces opinionated framework macros. |
| **screencast** | Non-blocking visual streaming via async `Page.startScreencast`. Returns compressed JPEG frames without blocking the page's main thread. |

### Layer 2: Perception (`src/layer2/`)

| Module | Purpose |
|---|---|
| **semanticSurface** | The core perception primitive. Queries `Accessibility.getFullAXTree` via CDP, sends raw nodes to the worker thread for Markdown serialization. Each node includes a stable `backendNodeId` tag for direct interaction targeting. |
| **stateDelta** | Differential state streaming. Computes the structural delta between the current AX tree state and the state at the last checkpoint. Returns only what changed — added, removed, modified nodes. |
| **humanRecording** | Human developer takeover mode. Opens a visible browser, records all physical interactions, console logs, and network traffic. On stop, returns a synchronized semantic timeline. |

---

## Key Design Decisions

### 1. `backendNodeId` Over Injected Attributes

**Problem:** The old architecture injected `data-mcp-id` attributes into the live DOM via `MutationObserver`. These attributes were destroyed by React's VDOM reconciliation on every re-render, causing stale reference errors.

**Solution:** We use CDP's `backendNodeId` — an integer assigned by the browser engine itself. It is:
- **Immutable** — survives VDOM reconciliation
- **Cross-frame** — works across OOPIF boundaries
- **Native** — no JavaScript injection required

The `ImmutableNodeIndex` maps these to stable integer IDs that persist across the agent's conversational turns.

### 2. Worker Thread Serialization

**Problem:** AX tree → Markdown conversion involves heavy string manipulation (iterating thousands of nodes, building hierarchical indentation). Running this on the main thread blocks the JSON-RPC transport, causing tool call timeouts on large pages.

**Solution:** All serialization runs in a dedicated `worker_thread` via `workerBridge.ts`. The main thread posts raw AX node arrays to the worker via structured clone transfer and receives the finished Markdown string back asynchronously.

### 3. Progressive Disclosure (Never a Firehose)

**Problem:** Dumping raw console logs, network requests, and mutation events directly into the LLM's context window wastes tokens and drowns the signal in noise.

**Solution:** The two-step progressive disclosure pattern:
1. `get_session_summary()` → Compressed counts + auto-generated alerts ("3 API calls failed, 1 console error")
2. `query_session_telemetry(category, filter)` → Surgical extraction ("show me only the failed network requests")

This mirrors how a human senior engineer debugs: glance at the red indicators, then click to expand.

### 4. Direct CDP Over Puppeteer Abstractions

**Problem:** Puppeteer's `page.mouse.click()` and `page.keyboard.type()` are high-level abstractions that hide critical engine state. They add async gaps between locate and dispatch, creating windows where VDOM reconciliation can invalidate the target.

**Solution:** Layer 1 actions use direct CDP `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` commands. The locate → validate → dispatch sequence runs in a single engine tick, eliminating race conditions.

**Exception:** We still use `puppeteer-core` for browser lifecycle management (launch, connect, close) because reimplementing the Chrome process management and WebSocket connection logic would be wasteful.

### 5. RingBuffer for Bounded Memory

**Problem:** Unlimited `Array.push()` for telemetry events leads to unbounded memory growth on long-running sessions.

**Solution:** All telemetry buffers use `RingBuffer<T>` — a fixed-capacity circular buffer with O(1) push and bounded memory. When the buffer is full, the oldest events are silently overwritten. Capacities: network (5,000), console (2,000), mutations (5,000).

### 6. Hyper-Descriptive Schemas

**Problem:** Agents using MCP tools need to understand not just *what* a tool does, but *when* to use it, *how* to chain it with other tools, and *what* the output means.

**Solution:** Every tool's `description` field in `index.ts` includes:
- **WORKFLOW** instructions (what to call first, what to call after)
- **USE CASES** with concrete examples
- **IMPORTANT** notes on common mistakes
- **LOCATOR STRATEGY** guidance (prefer `backendNodeId` over CSS selectors)

The schema is the agent's only documentation. It must be complete.

---

## Tool Interaction Patterns

### Perception → Action → Verification Loop

```
1. get_semantic_surface()          ← Perceive the page structure
2. [Read backendNodeId from output]
3. atomic_interact(click, id=NNN)  ← Act on a specific element
4. get_state_delta()               ← See what changed
5. get_session_summary()           ← Check for errors/alerts
6. [If alerts] query_session_telemetry(category, filter)  ← Drill down
```

### Error Recovery Pattern

```
1. atomic_interact(click, id=NNN)
   → "Spatial validation failed: div#cookie-banner is occluding target"
2. get_semantic_surface()          ← Find the dismiss button
3. atomic_interact(click, id=MMM)  ← Dismiss the banner
4. atomic_interact(click, id=NNN)  ← Retry original action
```

### Human Handoff Pattern

```
1. browser_begin_handoff(note)     ← Hand control to a human (visible window)
2. [Human reproduces the issue in the same window]
3. browser_end_handoff()           ← Return control; their actions are recorded
4. browser_timetravel(...)         ← Scrub exactly what the human did
5. [Agent replicates or learns from the human's workflow]
```

---

## What Best Browser Is NOT

- **Not a CI/CD testing framework.** Cypress and Playwright assert that known elements exist in deterministic environments. Best Browser explores, perceives, and debugs unknown, chaotic environments.
- **Not a dumb scraper.** We never dump `document.body.innerHTML` into an LLM prompt. If a tool doesn't intelligently compress or translate the context, it doesn't belong.
- **Not a closed box.** We embrace the standard Chrome DevTools Protocol. We don't hide the underlying mechanics; we orchestrate them into something an agent can understand.
- **Not framework-specific.** We do not hardcode React Fiber tree walking, Redux DevTools integration, or Zustand store sniffing. The `evaluate_in_context` tool lets agents write the exact JS introspection they need.

---

## Building Principles

For anyone contributing to this architecture:

- **Tokens are Sacred.** Every piece of telemetry sent to the LLM must justify its existence. Compress, filter, and translate.
- **Graceful Interception.** Errors are not crashes; they are context. When an interaction fails, we catch it, analyze the geometry or network state, and return an actionable diagnostic.
- **Native over Injected.** Whenever possible, rely on the browser's native C++ engine (via CDP) rather than injecting JavaScript evaluation loops into the page.
- **Atomic over Sequential.** Combine locate + act into single engine ticks to prevent race conditions with dynamic UIs.
- **Progressive over Exhaustive.** Never dump the full firehose when a summary + drill-down will do.
