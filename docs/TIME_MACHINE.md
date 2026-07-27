# The Time Machine: A Flight Recorder for Agents

> Status: north-star manifest + living design doc. Captures the product thesis, the
> competitive whitespace, the honest current-state audit, and the architecture we
> are building toward. Companion to [`NORTH_STAR.md`](./NORTH_STAR.md).

---

## 1. The thesis

Every other browser tool in the agentic space is trying to **drive** the browser
better — click, type, wait, navigate. That is a crowded, commoditized race against
Microsoft (`playwright-mcp`) and Google (`chrome-devtools-mcp`), who ship comparable
drivers for free with distribution we cannot match. Driving the browser is the wheel.
It has been invented.

The thing **no one is building** is the other half of how a senior engineer actually
works: they don't just act, they **remember and interrogate**. They scrub the timeline.
They jump to four seconds before the error and ask "what was on screen? what was the
network doing? what was in local storage? what state was the app in?" They treat a
session as a *durable, replayable, multi-modal record* — not a stream of blind pokes.

**Best Browser's real category is not a driver. It is a flight recorder — a Time
Machine — for agent browser sessions.** The agent should be able to:

- **Capture** an entire session across every modality, continuously.
- **Scrub** to any moment and see everything **as it was at that instant** — screen,
  DOM/state, console, network, storage, events, provenance.
- **Replay** any slice, deterministically, and dig deeper.
- **Re-open** a session from hours or days ago and investigate it like a black box.

This is the first framing in the product's history that (a) is a category the
competitors do not occupy and (b) is built directly on our one genuinely
differentiated asset: the **provenance-tagged, unified event timeline**.

---

## 2. Why this is defensible (grounded in competitor source, July 2026)

Read from the actual source of the four leading tools (see
`memory/competitor-source-map-2026`):

- **`chrome-devtools-mcp`** has the deepest *live* network/perf/trace tooling — but it
  is live-only. There is no persisted, agent-scrubbable record of a past session.
- **`browser-use`** records a HAR file to disk but **never surfaces it back to the
  agent** as navigable history; "memory" is an in-run scratchpad that dies with the run.
- **`playwright-mcp`** can emit Playwright traces — but those are artifacts for a
  *human* to open in a desktop viewer, not something an *agent* queries mid-task.
- **`Stagehand`** persists a selector replay-cache, not a session record.

**Nobody ships "agent, jump to the moment before the failure and reconstruct
everything."** That is the unoccupied ground. A flight recorder is also the natural
home for the capabilities we already built — the provenance bus, causal `explain`, the
DVR, replay, and the validation gate are all *recorder* features that were missing
their unifying name.

---

## 3. What a Time Machine requires vs. what exists today (honest audit)

The spine — a provenance-tagged unified timeline — is the hard third, and it exists.
The gap between "a pile of telemetry" and "a Time Machine" is **synchronization** and
**durability**, plus per-modality fidelity.

| Capability | Today | Gap to close |
|---|---|---|
| Unified, provenance-tagged timeline | ✅ `EventBus` (10k ring, trust-tagged) | — |
| Console over time | ✅ ring(2000), on the bus | — |
| Network activity | ⚠️ metadata only (method/url/status/duration) | headers, timings, resourceType, sizes, (bodies) — HAR-grade |
| Events out / mutations | ⚠️ DOM mutations + listeners | broader dispatched-event capture (later) |
| State | ⚠️ `get_state_delta` between calls | periodic state keyframes on the timeline |
| Visual (screen over time) | ⚠️ ~5fps screencast; **10s** rolling DVR; ≤5min video | **durable, timeline-indexed visual keyframes** |
| Local storage over time | ❌ live get/set/clear only | **storage keyframes** (localStorage/sessionStorage/cookies at T) |
| Replay a slice | ⚠️ coordinate-based re-drive (can false-positive) | fidelity + honest coverage reporting |
| **Re-open a past session & scrub** | ❌ timeline is in-memory, dies with process | **durable `SessionArchive` persisted to disk** |
| **"Everything as it was at time T"** | ❌ streams are parallel, not synchronized | **`TimeMachine.reconstructAt(T)`** |

The two capstones, in bold, are what make it a *machine* rather than logs:
**synchronization** (`reconstructAt`) and **durability** (`SessionArchive`).

---

## 4. Architecture

```
                         EventBus (master clock, provenance-tagged)
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 │                       │                        │
          SessionRecorder         keyframe capture          (existing tools)
        (subscribes to bus)   ┌──────────┼──────────┐      explain / replay
                 │            visual    storage    state
                 ▼            keyframe  keyframe   keyframe
          SessionArchive  ◄───────────────┘
        { meta, events[], keyframes[] }
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
 SessionArchiveStore   TimeMachine.reconstructAt(archive, T)
 (durable, per-session   → { screen@T, storage@T, state@T,
  dir on disk)              consoleTail, networkWindow, events, action }
```

### Core types
- **`SessionArchive`** — the durable, re-openable record of one session:
  `{ meta: {id, startedAt, endedAt, startUrl, origin, eventCount}, events: BusEvent[],
  keyframes: Keyframe[] }`.
- **`Keyframe`** — a periodic point-in-time snapshot of a heavy modality, tagged by
  timestamp: a discriminated union of `visual` (frame ref), `storage`
  (localStorage/sessionStorage/cookies), and `state` (url/title/semantic digest).

### `TimeMachine.reconstructAt(archive, t)` — the synchronization capstone (pure)
Given a timestamp, returns the synchronized snapshot: the nearest visual/storage/state
keyframe at or before `t`, the console tail and network window around `t`, the events
in a window, and the nearest action. Pure over the archive — unit-testable without
Chrome. Also supports relative anchors ("N ms before the last error/failed action").

### `SessionArchiveStore` — the durability capstone (I/O)
Persists archives under `outputBaseDir()/.bbmcp/sessions/<id>/`:
- `archive.json` — meta + events + non-visual keyframes, through the **redacting**
  `JsonStore` path (secrets scrubbed as a backstop).
- `frames/frame_<seq>.jpg` — visual keyframes as **binary** files (NOT routed through
  the text-redactor, which would corrupt image bytes). The archive references them by
  path, which is also token-friendly (the agent reads a frame only when it wants it).

### `SessionRecorder` — capture wiring
Process/session-level, subscribes to the active session's `EventBus` (same pattern as
`SiteMemory`). Buffers events; captures keyframes on an interval and on significant
triggers (navigation, action, error). Capture functions (`grabFrame`, `grabStorage`,
`grabState`) are **injected** so the recorder is testable without a live browser.
On `browser_close` / explicit save, distills the buffer into a `SessionArchive` and
persists it. Honors `BROWSER_MCP_NO_MEMORY=1` and a dedicated capture opt-out.

### Tools (the agent-facing surface)
- `browser_save_session({ name? })` — persist the current session as a durable archive.
- `browser_list_sessions()` — enumerate saved archives (id, origin, span, counts).
- `browser_load_session({ id })` — re-open a past session for time travel.
- `browser_timetravel({ at | beforeLastError | seq })` — reconstruct everything as-of a
  moment. The headline verb of the whole product.

---

## 5. Privacy & trust

Trust model is local-dev / own-app, but capture is secret- and PII-dense, so:
- Text payloads (events, storage, network) pass through `redactText` /
  `isSensitiveField` before disk.
- Password/cc/otp field values are never serialized (existing in-page redaction).
- Visual frames can contain anything on screen — capture is opt-out
  (`BROWSER_MCP_NO_MEMORY=1` disables recording; a dedicated flag can disable only
  visual capture) and archives are origin-scoped and contained to the sandbox dir.
- Everything inherits `resolveSafePath` containment.

---

## 6. Roadmap / sequencing

1. **Time Machine core** — `SessionArchive` types + pure `reconstructAt` +
   `SessionArchiveStore`. (Durability + synchronization capstones.)
2. **Capture wiring** — `SessionRecorder`: storage + visual + state keyframes.
3. **Network enrichment** — headers / timings / resourceType (redacted) toward HAR-grade.
4. **Time-travel tools** — save / list / load / `timetravel`.
5. **Later** — body capture (careful redaction), broader dispatched-event capture,
   honest replay-coverage reporting, a visual scrub UI artifact, cross-session diffing.

Every slice keeps `tsc` clean and the full adversarial gauntlet green, lands with
mock-free unit tests plus a real-Chrome integration test, and is committed on its own.
