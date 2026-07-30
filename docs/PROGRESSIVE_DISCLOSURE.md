# Progressive Disclosure & The Black Box Browser

## The Core Problem: The Context Window Firehose
When an AI agent drives a browser, the traditional approach is to dump the entire state of the page (HTML, logs, network requests) into the LLM's context window after every action. This creates two fatal problems:
1. **Token Exhaustion**: The agent drowns in noise and exhausts its context window rapidly.
2. **Loss of Focus**: It becomes impossible for the agent to spot a single failing API request in a sea of 10,000 lines of standard tracking pixel network requests.

Best Browser MCP solves this through a philosophy of **Progressive Disclosure** and treating the browser as a **Stateful Black Box**.

---

## 1. The Browser as a Black Box
Instead of forcing the agent to constantly poll and read everything, Best Browser runs as a black box. 
Whether the browser is being driven by the agent, or a human developer has grabbed the mouse to reproduce a bug in the same window (`browser_begin_handoff`), the server silently records everything:
- Network traffic and failures
- Console logs and exceptions
- DOM mutations
- Structural and attribute state changes (framework-agnostic — captured from the DOM/accessibility layer, not by sniffing React/Redux/Zustand internals)
- Physical human interactions (clicks, keypresses, scrolls)

The agent does not need to watch this happen in real-time. The server acts as a DVR, safely storing the entire timeline within the black box.

## 2. Progressive Disclosure (The Drill-Down Pattern)
When the agent needs to understand what happened in the black box, we use **Progressive Disclosure**. 

The agent is never given the raw logs. Instead, the workflow is:
1. **The High-Level Summary**: The agent calls `get_session_summary`. This returns a highly compressed, token-efficient summary: "3 API calls failed, 1 console error occurred, 15 DOM mutations happened."
2. **The Targeted Drill-Down**: If the agent sees an error in the summary, they ask for specifics using `query_session_telemetry` (e.g., `query_session_telemetry(category: "network", filter: "failed")`).
3. **The Semantic Result**: The agent only spends tokens reading the exact payload of the request that failed, perfectly isolating the bug without reading the 99 successful requests.

This mimics how a human senior engineer works. You don't read the entire network tab line-by-line; you glance at the red indicators and click them to expand.

## 3. Delta Awareness (State Diffing)
Agents struggle to compare large before-and-after states. If you give an agent a 5,000-line React state tree, click a button, and give them another 5,000-line tree, they will struggle to spot the one boolean that flipped.

Best Browser implements **Delta Awareness**.
The `get_state_delta` tool, backed by the Object Permanence node index (stable IDs over `backendNodeId`), doesn't just return the current state. It computes the mathematical diff of the accessibility tree against the *previous* checkpoint and returns exactly what changed — added, removed, and modified nodes:
```diff
Modified Nodes:
- [dialog] "Confirm" [collapsed]
+ [dialog] "Confirm" [expanded]
```
The agent is only notified of the **diff**. By only showing the delta, we eliminate hallucination and drastically reduce token usage. The agent instantly understands the exact consequence of its last action.
