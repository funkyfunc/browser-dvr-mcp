# browser-dvr-mcp

### A DVR for your AI browser agent — record every session, then rewind to the exact moment it broke.

[![CI](https://github.com/funkyfunc/browser-dvr-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/funkyfunc/browser-dvr-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/browser-dvr-mcp)](https://www.npmjs.com/package/browser-dvr-mcp)
[![node](https://img.shields.io/node/v/browser-dvr-mcp)](https://www.npmjs.com/package/browser-dvr-mcp)
[![license](https://img.shields.io/npm/l/browser-dvr-mcp)](./LICENSE)

An MCP server that lets an agent drive Chrome **and** records the whole session as a durable, scrubbable flight recorder — screen, DOM, network (with bodies), console, storage, and its own actions, every event tagged with where it came from. When something goes wrong, the agent doesn't guess. It rewinds to four seconds before the failure and asks: *what was on screen? what did the API return? what changed in state?*

Most browser tools help an agent **drive** the page. This one also helps it **remember** — and that's the half that turns "the script failed, I'll try again" into "the `POST /checkout` returned a 500 right after the modal opened; here's the root cause."

## Why a DVR?

A coding agent driving a browser is flying blind between tool calls. It clicks, takes a screenshot of the aftermath, and hallucinates reasons when things break. A transient error flashes and is gone. A modal invisibly blocks a button. The network 500s in the millisecond gaps between snapshots.

A DVR changes that. It's always recording, so nothing is lost — and you can go **back in time**.

| Just driving the browser | browser-dvr-mcp |
|---|---|
| A screenshot of the **aftermath** — the transient error already vanished | Continuous recording: rewind to any moment and see the screen, DOM, network, console, and storage **as they were then** |
| "The click failed" | **Causal explain**: *why* it failed (occluded by a modal, 2 requests 500'd, DOM re-rendered) and **what to do about it** |
| Status codes only — the actual API error body is invisible | **Network bodies + HAR export**: read the real failing payload |
| Page text is fed to the model as trusted input (prompt-injection risk) | Every event is **provenance-tagged** (`chrome-native` / `page-controlled` / `tool-output` / `user`) so injected page text is never mistaken for instructions |
| Each session starts from scratch | **Validated site memory**: learned flows are admitted only after passing a regression gate |
| The agent is stuck when it can't reproduce a bug | **Human handoff**: a person takes over the same window, reproduces it, and their actions land in the same recording |

## Install

Requires **Node ≥ 18** and a local **Google Chrome / Chromium**.

Add it to your MCP client (e.g. Claude Code, `~/.claude/mcp.json` or the project `.mcp.json`):

```json
{
  "mcpServers": {
    "browser-dvr": {
      "command": "npx",
      "args": ["-y", "browser-dvr-mcp"]
    }
  }
}
```

Or run it directly:

```bash
npx -y browser-dvr-mcp
```

Every agent session starts with `browser_launch` (add `headless: false` for a visible window or human handoff).

## The killer loop

```
browser_launch → drive the flow → it breaks
        │
        ├─ browser_analyze_run                     → the FIRST point of failure across the whole run, categorized
        ├─ browser_timetravel({ beforeLastError }) → screen + storage + state + console + network AS OF that moment
        ├─ browser_export_har                      → the actual failing request/response bodies
        ├─ browser_when_changed                    → when did this URL / storage key / DOM region last change, and to what?
        ├─ browser_state_diff(a, b)                → what changed between when it worked and when it broke
        └─ browser_explain_last_action             → WHY it failed + a prescriptive fix
```

Every `browser_timetravel` returns an **anchor** — an opaque handle to that moment you pass straight into `state_diff` / `when_changed`, so the whole debugging surface composes.

## Tools

**Perceive** — `get_semantic_surface` (fused accessibility tree + geometry, one non-mutating capture), `get_element_tree`, `get_state_delta`, `browser_screenshot`, `stream_screencast`.

**Drive** — `atomic_interact` (locate + act in one uninterruptible tick; click/type/hover/scroll/drag by stable `backendNodeId` or coordinate), `coordinate_click`, `browser_navigate`, `browser_wait_for`, `browser_new_tab` / `switch_tab` / `list_tabs` / `close_tab`.

**Record & time-travel (the DVR)** — `browser_save_session`, `browser_list_sessions`, `browser_load_session`, **`browser_timetravel`** (reconstruct everything as of any moment; anchor by time, event, or `beforeLastError`), `browser_get_timeline` (the provenance-tagged event stream).

**Debug the recording** — `browser_analyze_run` (whole-run first-point-of-failure + error taxonomy), `browser_explain_last_action` (causal + prescriptive), `browser_export_har` (request/response bodies), `browser_query_timeline` (trace-as-database), `browser_when_changed` (backward data-breakpoint), `browser_state_diff` (Redux-style moment diff), `browser_verify` (assert + record a checkpoint).

**Observe** — `browser_intercept_request` (delay / fail / **mock** responses), `browser_throttle_network`, `browser_set_offline`, `browser_get_performance_metrics`, `query_session_telemetry`, `browser_dump_dvr` (visual buffer), `browser_start_recording` / `stop_recording`.

**Human handoff** — `browser_begin_handoff` / `browser_end_handoff` (a human reproduces in the same window; their actions record as `user` provenance; they can signal done with Ctrl/Cmd+Shift+Enter).

**Learn (validated memory)** — `browser_recall_site`, `browser_propose_skill` → `browser_validate_skill` (a learned flow enters trusted memory only after its probe passes against the live site), `browser_save_scenario` / `browser_run_scenario` (record → replay → assert regression tests).

**Replay** — `browser_export_repro`, `browser_replay`.

## Architecture

- **[puppeteer-core](https://pptr.dev/) over the Chrome DevTools Protocol** — direct CDP, not high-level abstractions, so interactions are a single browser-engine tick that sidesteps Virtual-DOM detachment races.
- **Fused perception** — the accessibility tree (semantic spine, closed-shadow-piercing, accessible names) is fused with `DOMSnapshot` geometry in one non-mutating capture, so every node carries role + name + bounds + clickability.
- **Provenance-tagged EventBus** — one ordered, trust-tagged timeline that both perception and actions flow onto; it's the spine the recorder, causal explain, and time-travel all read from.
- **Durable session archives** — the timeline plus periodic visual/storage/state keyframes are persisted per session under a sandboxed output directory, so a session can be re-opened and scrubbed later.

## Privacy & safety

Designed for local development against apps you own. Capture is secret- and PII-aware:

- Network headers/bodies, storage values, and console text are redacted (auth tokens, cookies, password/cc/otp fields) before anything touches disk.
- Everything is origin-scoped and contained to the output directory.
- All recording is opt-out.

| Env var | Effect |
|---|---|
| `BROWSER_MCP_OUTPUT_DIR` | Sandbox directory for all recordings, archives, and memory (default: cwd) |
| `BROWSER_MCP_NO_MEMORY=1` | Disable durable site memory + session recording |
| `BROWSER_MCP_NO_VISUAL=1` | Keep the timeline + storage/state, but skip screen-frame capture |
| `BROWSER_MCP_NO_BODIES=1` | Disable network request/response body capture |
| `BROWSER_MCP_NO_SANDBOX=1` | Launch Chrome without the sandbox (for containers) |

## Development

```bash
npm ci
npm run typecheck      # tsc, both configs
npm run test:unit      # the Chrome-free unit suite (what CI runs)
npm test               # the full suite incl. the real-Chrome adversarial gauntlet
npm run build          # bundle to dist/
```

The full suite drives a real Chrome through an adversarial testbed (occluding modals, shadow DOM, iframes, races) and stays green as a hard gate. CI runs the Chrome-free unit suite; the browser e2e runs locally.

## License

[MIT](./LICENSE) © funkyfunc
