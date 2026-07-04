# Agent Scenario Test Suite (Layer 2)

> **Status**: Design document for future implementation. These scenarios describe
> natural-language instructions an LLM agent would receive, along with success
> criteria and expected tool usage patterns.

## How to Use This Document

Each scenario below is a self-contained task that an agent should be able to
complete using the `best-browser` MCP tools. The agent receives:

1. **The instruction** — a natural-language description of what to accomplish
2. **The testbed URL** — pointing to `adversarial_testbed.html`
3. **Available tools** — the full `best-browser` MCP tool set

Success is measured by:
- Whether the expected success flag element appears in the DOM
- Whether the agent stayed within the tool call budget
- Whether the agent used appropriate strategies (not hardcoded workarounds)

---

## Scenario 1: Shadow DOM Penetration

**Instruction to Agent:**
> Navigate to the Adversarial Testbed and click the "Acknowledge Secure Directive"
> button. It's inside the "Outer Security Perimeter" section. Note that the
> button may not be accessible via standard DOM queries.

**Success Criteria:**
- Element `#shadow-success-flag` appears in the DOM
- Text content includes "Shadow Boundary Penetrated"

**Expected Strategy:**
1. Agent tries `browser_query_selector` first — it returns 0 matches
2. Agent takes a `browser_screenshot` to visually locate the button
3. Agent uses `browser_click` with `coordinate` mode on the button's visual position
4. OR: Agent uses `browser_evaluate` with keyboard navigation (Tab + Enter)

**Tool Call Budget:** 8

---

## Scenario 2: Cross-Origin Iframe Interaction

**Instruction to Agent:**
> On the Adversarial Testbed, find the "Secure Third-Party Payment Simulation"
> section and click the "Authorize Transaction" button inside the embedded iframe.

**Success Criteria:**
- Element `#iframe-success-flag` appears in the parent DOM
- Text content includes "Cross-Origin Transaction Authorized"

**Expected Strategy:**
1. Agent identifies the iframe via `browser_query_selector` for `#data-url-iframe`
2. Agent attempts to query inside the iframe — may fail due to SOP
3. Agent falls back to coordinate-based clicking, calculating the button position
   relative to the iframe's bounding box

**Tool Call Budget:** 8

---

## Scenario 3: Form Registration (Honeypot Avoidance)

**Instruction to Agent:**
> Fill out the registration form on the Adversarial Testbed with username
> "testuser" and password "secure123", then submit the form.

**Success Criteria:**
- Element `#honeypot-success-flag` appears in the DOM
- Element `#honeypot-trap-flag` does NOT appear (agent didn't fill the honeypot)
- Text content includes "Registration Successful"

**Expected Strategy:**
1. Agent uses `browser_query_selector` with `visibleOnly: true` to find form fields
2. Agent identifies visible `input` fields — username and password only
3. Agent recognizes the honeypot field is hidden (via computed styles or visibility)
4. Agent fills only the visible fields and submits

**Tool Call Budget:** 10

---

## Scenario 4: Modal Dismissal → Primary Objective

**Instruction to Agent:**
> Click the "Execute Objective" button on the primary task interface in the
> Adversarial Testbed.

**Success Criteria:**
- Element `#modal-success-flag` appears in the DOM
- Text content includes "Primary Objective Executed Successfully"

**Expected Strategy:**
1. Agent navigates to the testbed
2. Agent tries to click `#primary-objective` — gets occluded by the modal
3. Agent recognizes the spatial validation error or ElementClickIntercepted error
4. Agent identifies the modal (`#interruption-modal`) and finds the dismiss button
5. Agent clicks `#accept-modal-btn` to dismiss the modal
6. Agent retries clicking `#primary-objective` — succeeds

**Tool Call Budget:** 10

---

## Scenario 5: Hydration-Aware Click

**Instruction to Agent:**
> Save the account configuration by clicking the "Save Configuration" button
> on the Adversarial Testbed. Make sure the save actually takes effect.

**Success Criteria:**
- Element `#hydration-success-flag` appears in the DOM
- Text content includes "Configuration Saved Successfully"

**Expected Strategy:**
1. Agent finds the button immediately
2. Agent clicks it — no visible effect (pre-hydration)
3. Agent waits for `[data-hydrated="true"]` attribute to appear
4. Agent clicks again — success
5. Agent verifies the success flag appeared

**Tool Call Budget:** 8

---

## Scenario 6: Virtual Scroll — Find Item #45

**Instruction to Agent:**
> In the Virtualized Data Table section of the testbed, find Dataset Item #45
> and click its "Select" button. The table uses virtual scrolling, so items
> outside the viewport are destroyed.

**Success Criteria:**
- Element `#virtual-scroll-success` appears in the DOM
- Text content includes "Target Item #45 Located and Selected"

**Expected Strategy:**
1. Agent queries for `[data-id="45"]` — 0 matches (not rendered yet)
2. Agent scrolls the `#viewport-container` element programmatically
3. Agent re-queries for `[data-id="45"]` — now visible
4. Agent clicks the Select button for item #45

**Tool Call Budget:** 12

---

## Scenario 7: Canvas Interaction

**Instruction to Agent:**
> On the Data Visualization Interface canvas, click the green circle labeled
> "Target" to activate it.

**Success Criteria:**
- Element `#canvas-success-flag` appears in the DOM
- Text content includes "Canvas Node Targeted Successfully"

**Expected Strategy:**
1. Agent inspects the accessibility tree — canvas appears opaque
2. Agent takes a screenshot to visually identify the "Target" circle
3. Agent calculates the approximate center coordinates of the green circle
4. Agent uses `browser_click` with `coordinate` mode to click the target

**Tool Call Budget:** 6

---

## Scenario 8: SPA Navigation Full Flow

**Instruction to Agent:**
> Navigate to the Dashboard using the "Go to Dashboard" link in the SPA
> Navigation Menu section, then click "Acknowledge Routing" on the dashboard.

**Success Criteria:**
- Element `#spa-success-flag` appears in the DOM
- URL pathname is `/dashboard`

**Expected Strategy:**
1. Agent clicks the SPA link
2. Agent waits for the dashboard content to load (not relying on page load events)
3. Agent finds and clicks the "Acknowledge Routing" button
4. Agent verifies the success flag

**Tool Call Budget:** 8

---

## Evaluation Framework (Future)

To implement automated agent scenario testing, we need:

1. **Agent Harness**: A script that spawns an LLM with the testbed URL and
   available tools, feeds it the instruction, and records all tool calls.

2. **Success Evaluator**: After the agent completes (or exhausts its budget),
   check the DOM for the expected success flag.

3. **Strategy Scorer**: Analyze the tool call trace to evaluate whether the
   agent used the expected strategy or an equally valid alternative.

4. **Budget Enforcer**: Terminate the agent if it exceeds the maximum tool
   call count for the scenario.

5. **Regression Tracker**: Compare results across MCP server versions to
   detect capability regressions.
