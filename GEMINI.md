# **Best Browser MCP Developer Guidelines & Agent Rules**

To ensure high reliability of autonomous browser automation and avoid regressions, all developers and coding agents modifying the `best-browser` MCP server must adhere strictly to the following architectural design principles.

---

## **1. Unified Viewport Coordinate Space Principle**

All tools that return visual coordinates, bounding boxes, or click targets must return them normalized to the **main viewport pixel space**. 

* **The Rule:** No tool should ever return raw layout-relative or iframe-local coordinates. All calculations must resolve the target frame offsets using the helper `getFrameOffset(frame)` and add them to the coordinates before outputting values to the agent.
* **Impact:** This ensures that coordinate finder outputs (e.g. `browser_find_text_coordinates`) are immediately compatible with interaction tools (e.g. `coordinate_click` and `atomic_interact`), preventing coordinate shift deadlocks.

---

## **2. Universal Subframe/Iframe Support**

Enterprise web applications and design canvases utilize nested, scaled, same-origin, and cross-origin iframes. All perception and inspection tools must pierce these boundaries.

* **The Rule:** Any tool querying element properties, structures, styles, or listeners (e.g., `browser_get_computed_style`, `browser_get_listeners`, `browser_get_outer_html`, `get_element_tree`) must support frame context switching.
* **Protocol Targeting:** Use `findFrameForBackendNodeId` to locate the target subframe CDP session, and pass the target `frameId` explicitly to CDP calls (such as `Accessibility.getFullAXTree`) to avoid falling back to the main document context.

---

## **3. Atomic "Locate-and-Act" Operations**

To eliminate Virtual DOM element detachment and stale references, keep interaction operations atomic.

* **The Rule:** Never cache backend element handles across agent reasoning cycles. Prefer the `atomic_interact` tool, which locates the node (using `backendNodeId`) and dispatches native browser events in the exact same execution tick.

---

## **4. Mandatory Test Bed Integration Checks**

Every feature addition or bug fix that affects element resolution or spatial mapping must be verified against the **Adversarial Web Agent Testbed** suite. Ensure you:
1. Extend `tests/fixtures/adversarial_testbed.html` with relevant layout wrappers (e.g. scaled containers, nested iframes) if introducing new coordinate/structural capabilities.
2. Add end-to-end regression tests to `tests/developer-feedback-fixes.test.ts` to assert correct behavior.
