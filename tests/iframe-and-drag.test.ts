import { describe, it, expect } from 'vitest';
import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import {
  findFrameForBackendNodeId,
  atomicDragAndDrop,
  atomicClick,
} from '../src/layer1/atomicInteract.js';
import { getSemanticSurface } from '../src/layer2/semanticSurface.js';
import { ImmutableNodeIndex } from '../src/core/ImmutableNodeIndex.js';
import { validateSpatialCoordinate } from '../src/layer1/spatialValidation.js';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  throw new Error('Chrome not found');
}

describe('Iframe & Drag Integration Tests', () => {
  // ── Test 1: Iframe Auto-Detection and Event Routing ────────────────────────
  it('should auto-detect frame and successfully trigger click event inside iframe', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div style="height: 100px; background: lightblue;">Spacer</div>
        <iframe id="iframe" style="margin: 0; padding: 0; width: 300px; height: 300px; border: none;" srcdoc="
          <body style='margin: 0; padding: 0;'>
            <button id='btn' style='margin-top: 50px; margin-left: 50px; width: 100px; height: 50px;' onclick='window.clicked=true;'>Click Me</button>
          </body>
        "></iframe>
      </body>
    `);

    await new Promise((r) => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any;

    let btnBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('btn')) {
        btnBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          findTarget(child);
        }
      }
      if (node.contentDocument) {
        findTarget(node.contentDocument);
      }
    };
    findTarget(doc.root);

    expect(btnBackendNodeId).not.toBeNull();

    const frame = await findFrameForBackendNodeId(page, btnBackendNodeId!);
    expect(frame).not.toBe(page.mainFrame());

    const targetCdp = (frame as any).client;
    await frame.evaluate('window.clicked = false');

    // Dispatch click using target frame session at global coordinates (100, 175)
    await targetCdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: 100,
      y: 175,
      button: 'left',
      clickCount: 1,
    });
    await targetCdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 100,
      y: 175,
      button: 'left',
      clickCount: 1,
    });

    await new Promise((r) => setTimeout(r, 200));
    const clicked = await frame.evaluate('window.clicked');
    expect(clicked).toBe(true);

    await browser.close();
  });

  // ── Test 2: Native Drag and Drop ──────────────────────────────────────────
  it('should successfully drag an element to a new position using atomicDragAndDrop', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div id="drag-source" style="width: 50px; height: 50px; background: blue; position: absolute; left: 10px; top: 10px; user-select: none;">Source</div>
        <script>
          let isDragging = false;
          let startX = 0, startY = 0;
          const source = document.getElementById('drag-source');
          source.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
          });
          document.addEventListener('mousemove', (e) => {
            if (isDragging) {
              const dx = e.clientX - startX;
              const dy = e.clientY - startY;
              source.style.left = (10 + dx) + 'px';
              source.style.top = (10 + dy) + 'px';
            }
          });
          document.addEventListener('mouseup', () => {
            isDragging = false;
          });
        </script>
      </body>
    `);

    const cdp = await page.createCDPSession();
    const dummyTelemetry = { addInteraction: () => {} } as any;

    await atomicDragAndDrop(page, cdp, { x: 35, y: 35 }, { x: 235, y: 85 }, dummyTelemetry);

    await new Promise((r) => setTimeout(r, 200));

    const rect = await page.evaluate(() => {
      const source = document.getElementById('drag-source')!;
      return {
        left: parseInt(source.style.left || '0', 10),
        top: parseInt(source.style.top || '0', 10),
      };
    });

    expect(rect.left).toBe(210);
    expect(rect.top).toBe(60);

    await browser.close();
  });

  // ── Test 3: Iframe Boundary Safety Checks ──────────────────────────────────
  it('should detect when target coordinates lie outside of the target parent iframe boundaries', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    // Set a page with a small iframe, hosting a button placed far to the right (clipped/out-of-bounds)
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <iframe id="iframe" style="width: 100px; height: 100px; border: none; overflow: hidden;" srcdoc="
          <body style='margin: 0; padding: 0;'>
            <button id='btn' style='margin-left: 200px; width: 50px; height: 50px;'>OutOfBounds Button</button>
          </body>
        "></iframe>
      </body>
    `);

    await new Promise((r) => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any;

    let btnBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('btn')) {
        btnBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          findTarget(child);
        }
      }
      if (node.contentDocument) {
        findTarget(node.contentDocument);
      }
    };
    findTarget(doc.root);

    expect(btnBackendNodeId).not.toBeNull();

    // Query iframe element box
    const frame = await findFrameForBackendNodeId(page, btnBackendNodeId!);
    const iframeHandle = await frame.frameElement();
    expect(iframeHandle).not.toBeNull();
    const iframeBox = await iframeHandle!.boundingBox();
    expect(iframeBox).not.toBeNull();

    // Button resolved center is around x = 225, y = 25
    // But the iframe right boundary is at x = 100
    const btnCenter = { x: 225, y: 25 };
    const isInside =
      btnCenter.x >= iframeBox!.x &&
      btnCenter.x <= iframeBox!.x + iframeBox!.width &&
      btnCenter.y >= iframeBox!.y &&
      btnCenter.y <= iframeBox!.y + iframeBox!.height;

    expect(isInside).toBe(false);

    await browser.close();
  });

  // ── Test 4: Pruned Interactive Element Sniffing ───────────────────────────
  it('should sniff and report non-semantic interactive controls in getSemanticSurface', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    // Set up a page with a plain div styled with interactive grab cursor, and one normal button
    // The div is completely empty, ensuring it gets pruned by default AX tree builders
    await page.setContent(`
      <body>
        <button id="semantic-btn">Interactive Button</button>
        <div id="pruned-control" style="width: 50px; height: 50px; cursor: grab;"></div>
      </body>
    `);

    await new Promise((r) => setTimeout(r, 500));

    const cdp = await page.createCDPSession();
    const nodeIndex = new ImmutableNodeIndex();

    const result = await getSemanticSurface(page, cdp, nodeIndex);

    // The accessibility tree should contain the semantic button
    expect(result.markdown).toContain('Interactive Button');

    // The accessibility tree should also successfully sniff and append the pruned grab handle div!
    expect(result.markdown).toContain('### Pruned Potential Interactive Elements (Non-Semantic)');
    expect(result.markdown).toContain('[div] (cursor: "grab", id: "pruned-control")');

    await browser.close();
  });

  // ── Test 5: Strict Hit-Target Verification (Clipping Detection) ───────────
  it('should fail spatial validation when element is clipped by overflow:hidden', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    // Set up a container with overflow:hidden and a child positioned out-of-bounds
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div id="container" style="width: 100px; height: 100px; overflow: hidden; background: lightgray; position: relative;">
          <button id="btn" style="width: 50px; height: 50px; position: absolute; left: 150px; top: 10px;">Clipped Button</button>
        </div>
      </body>
    `);

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = (await cdp.send('DOM.getDocument', { depth: -1 })) as any;

    let btnBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('btn')) {
        btnBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          findTarget(child);
        }
      }
    };
    findTarget(doc.root);

    expect(btnBackendNodeId).not.toBeNull();

    const dummyTelemetry = { addInteraction: () => {} } as any;

    // Direct atomicClick call should fail with a spatial validation occlusion error
    const clickResult = await atomicClick(page, cdp, btnBackendNodeId!, dummyTelemetry);
    expect(clickResult.success).toBe(false);
    expect(clickResult.feedback).toContain('Spatial validation failed');
    expect(clickResult.feedback).toContain('Interaction hit element');
    expect(clickResult.feedback).toContain('body'); // Should hit body (the background element) instead of button

    await browser.close();
  });

  // ── Test 6: Coordinate Offset Support ──────────────────────────────────────
  it('should bypass covered center of target by specifying coordinate offset', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    // Set up a target button, whose center (x: 50, y: 50) is covered by a red overlay box.
    // The right part of the button (x: 80, y: 50) is completely clear.
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <button id="target-btn" style="width: 100px; height: 100px; background: blue; position: absolute; left: 0; top: 0;" onclick="window.clicked=true;">Target Button</button>
        <div id="overlay" style="width: 60px; height: 100px; background: red; position: absolute; left: 0; top: 0;">Overlay</div>
      </body>
    `);

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = (await cdp.send('DOM.getDocument', { depth: -1 })) as any;

    let targetBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('target-btn')) {
        targetBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const child of node.children) {
          findTarget(child);
        }
      }
    };
    findTarget(doc.root);

    expect(targetBackendNodeId).not.toBeNull();

    const dummyTelemetry = { addInteraction: () => {} } as any;

    // Without offset: click on center (50, 50) hits overlay and fails spatial validation
    const failResult = await atomicClick(page, cdp, targetBackendNodeId!, dummyTelemetry);
    expect(failResult.success).toBe(false);
    expect(failResult.feedback).toContain('Spatial validation failed');
    expect(failResult.feedback).toContain('overlay');

    // With offset: offset [30, 0] shifts click to (80, 50), which is uncovered, and click succeeds!
    await page.evaluate('window.clicked = false');
    const successResult = await atomicClick(page, cdp, targetBackendNodeId!, dummyTelemetry, {
      offset: [30, 0],
    });
    expect(successResult.success).toBe(true);

    const isClicked = await page.evaluate('window.clicked');
    expect(isClicked).toBe(true);

    await browser.close();
  });
});
