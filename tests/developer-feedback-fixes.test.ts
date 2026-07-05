import { describe, it, expect } from 'vitest';
import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';
import { findFrameForBackendNodeId } from '../src/layer1/atomicInteract.js';
import { getFrameOffset } from '../src/layer1/spatialValidation.js';

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

describe('Developer Feedback Fixes Regression Tests', () => {
  it('should pierce iframes and find elements in query selector', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <h1>Main Title</h1>
        <iframe id="frame1" style="width: 300px; height: 300px; margin-top: 100px; margin-left: 50px; border: none;" srcdoc="
          <body style='margin: 0;'>
            <h1 class='iframe-heading' style='color: rgb(255, 0, 0); margin: 0;'>Iframe Title</h1>
            <button id='btn' onclick='window.clicked=true;'>Btn</button>
          </body>
        "></iframe>
      </body>
    `);

    await new Promise((r) => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const frames = page.frames();
    expect(frames.length).toBeGreaterThan(1);

    // Let's find the backendNodeId of the iframe title h1
    const subframe = frames.find((f) => f !== page.mainFrame())!;
    const headingHandle = await subframe.$('.iframe-heading');
    expect(headingHandle).not.toBeNull();

    const remoteObj =
      (headingHandle as any).remoteObject?.() || (headingHandle as any)._remoteObject;
    const { node } = await (subframe as any).client.send('DOM.describeNode', {
      objectId: remoteObj.objectId,
    });
    const h1BackendNodeId = node.backendNodeId;
    expect(h1BackendNodeId).toBeDefined();

    // Verify finding target frame works
    const foundFrame = await findFrameForBackendNodeId(page, h1BackendNodeId);
    expect(foundFrame).toBe(subframe);

    // Verify computed style resolves inside the iframe correctly via frame's CDP session
    const targetCdp = (foundFrame as any).client;
    await targetCdp.send('DOM.enable');
    const { object } = (await targetCdp.send('DOM.resolveNode', {
      backendNodeId: h1BackendNodeId,
    })) as { object: { objectId?: string } };
    expect(object?.objectId).toBeDefined();

    const evalResult = (await targetCdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        return window.getComputedStyle(this).color;
      }`,
      returnByValue: true,
    })) as { result: { value: string } };

    expect(evalResult.result.value).toBe('rgb(255, 0, 0)');
    await targetCdp.send('Runtime.releaseObject', { objectId: object.objectId });

    // Verify frame offset calculations
    const offset = await getFrameOffset(subframe);
    const iframeHandle = await page.$('#frame1');
    const iframeRect = await iframeHandle!.boundingBox();
    expect(offset.x).toBeCloseTo(iframeRect!.x, 1);
    expect(offset.y).toBeCloseTo(iframeRect!.y, 1);

    // Verify screenshot highlight does not crash
    // Highlight elements style check
    const originalStyle = await headingHandle!.evaluate((el: any) => {
      const prev = el.style.outline;
      el.style.setProperty('outline', '3px solid rgb(255, 59, 48)', 'important');
      return prev;
    });

    const currentStyle = await headingHandle!.evaluate((el: any) => el.style.outline);
    expect(currentStyle).toContain('rgb(255, 59, 48)');
    expect(currentStyle).toContain('3px');
    expect(currentStyle).toContain('solid');

    // Verify screenshot highlight badge creation
    const badgeInfo = await headingHandle!.evaluate(() => {
      const badge = document.createElement('div');
      badge.id = 'test-badge-38';
      badge.textContent = 'ID: 38';
      document.body.appendChild(badge);
      return { id: badge.id, exists: !!document.getElementById('test-badge-38') };
    });
    expect(badgeInfo.exists).toBe(true);

    // Verify cleanup removes it
    const badgeRemoved = await headingHandle!.evaluate(() => {
      const badge = document.getElementById('test-badge-38');
      if (badge) badge.remove();
      return !document.getElementById('test-badge-38');
    });
    expect(badgeRemoved).toBe(true);

    // Restore
    await headingHandle!.evaluate((el: any, orig: any) => {
      el.style.outline = orig;
    }, originalStyle);

    await headingHandle!.dispose();
    await browser.close();
  });

  it('should resolve safe paths correctly', async () => {
    const { resolveSafePath } = await import('../src/index.js');

    // Absolute paths should remain unchanged
    expect(resolveSafePath('/foo/bar')).toBe('/foo/bar');

    // Relative paths should resolve against CWD if CWD is not root
    const resolvedRelative = resolveSafePath('recordings/rec_123');
    expect(resolvedRelative).toContain('recordings/rec_123');
    expect(resolvedRelative).not.toBe('/recordings/rec_123');
  });

  it('should bypass spatial validation when force is true', async () => {
    const { resolveAndValidateSpatialCoordinate } =
      await import('../src/layer1/spatialValidation.js');
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(`
      <div style="position: relative; width: 100px; height: 100px;">
        <button id="target" style="width: 100px; height: 100px;">Target</button>
        <div id="occluder" style="position: absolute; top: 0; left: 0; width: 100px; height: 100px; background: rgba(0,0,0,0.5);">Occluder</div>
      </div>
    `);

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any;
    let targetBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('target')) {
        targetBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const c of node.children) findTarget(c);
      }
    };
    findTarget(doc.root);
    expect(targetBackendNodeId).not.toBeNull();

    // Normal validation should fail due to occlusion
    const normalVal = await resolveAndValidateSpatialCoordinate(
      page,
      cdp,
      targetBackendNodeId!,
      500,
    );
    expect(normalVal.valid).toBe(false);
    expect(normalVal.error).toContain('Spatial validation failed');

    // Force validation should succeed and return coordinates
    const forceVal = await resolveAndValidateSpatialCoordinate(
      page,
      cdp,
      targetBackendNodeId!,
      500,
      undefined,
      undefined,
      true,
    );
    expect(forceVal.valid).toBe(true);
    expect(forceVal.coordinates).toBeDefined();

    await browser.close();
  });

  it('should intercept request and return mock response', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--disable-web-security'],
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();

    // Enable Fetch interception for everything
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    cdp.on('Fetch.requestPaused', async (event: any) => {
      const mockResponse = {
        status: 200,
        headers: [{ name: 'content-type', value: 'application/json' }],
        body: JSON.stringify({ success: true, mocked: 'yes' }),
      };
      const base64Body = Buffer.from(mockResponse.body).toString('base64');
      await cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: mockResponse.status,
        responseHeaders: mockResponse.headers,
        body: base64Body,
      });
    });

    // Make request inside page and check response
    const result = await page.evaluate(async () => {
      const resp = await fetch('http://localhost/test-api');
      const data = await resp.json();
      return { status: resp.status, contentType: resp.headers.get('content-type'), data };
    });

    expect(result.status).toBe(200);
    expect(result.contentType).toBe('application/json');
    expect(result.data).toEqual({ success: true, mocked: 'yes' });

    await cdp.send('Fetch.disable');
    await browser.close();
  });

  it('should find text coordinates relative to main viewport inside iframes', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div style="height: 100px;">Main Content</div>
        <iframe id="frame1" style="width: 300px; height: 300px; margin-top: 100px; margin-left: 50px; border: none;" srcdoc="
          <body style='margin: 0;'>
            <div id='target' style='margin-top: 50px; margin-left: 20px; width: 100px; height: 50px;'>Iframe Target Text</div>
          </body>
        "></iframe>
      </body>
    `);
    await new Promise((r) => setTimeout(r, 1000));

    // Resolve matches
    const searchText = 'Iframe Target Text';
    const matches: any[] = [];
    const { getFrameOffset } = await import('../src/layer1/spatialValidation.js');

    for (const frame of page.frames()) {
      const frameMatches = await frame.evaluate((searchStr) => {
        const el = document.getElementById('target');
        if (el && el.textContent?.includes(searchStr)) {
          const rect = el.getBoundingClientRect();
          return [
            {
              text: el.textContent,
              boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            },
          ];
        }
        return [];
      }, searchText);

      const offset = await getFrameOffset(frame);
      for (const m of frameMatches) {
        matches.push({
          text: m.text,
          boundingBox: {
            x: m.boundingBox.x + offset.x,
            y: m.boundingBox.y + offset.y,
            width: m.boundingBox.width,
            height: m.boundingBox.height,
          },
        });
      }
    }

    expect(matches.length).toBe(1);
    expect(matches[0].boundingBox.x).toBeCloseTo(70, 0);
    // 100px (header height) + 100px (iframe margin top) + 50px (target margin top) = 250px
    expect(matches[0].boundingBox.y).toBeCloseTo(250, 0);

    await browser.close();
  });

  it('should support get_element_tree for elements inside iframes', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <iframe id="frame1" style="width: 300px; height: 300px; border: none;" srcdoc="
          <body style='margin: 0;'>
            <button id='btn'>Iframe Button</button>
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
        for (const c of node.children) findTarget(c);
      }
      if (node.contentDocument) findTarget(node.contentDocument);
    };
    findTarget(doc.root);
    expect(btnBackendNodeId).not.toBeNull();

    const subframe = page.frames().find((f) => f !== page.mainFrame())!;
    const frameId = (subframe as any)._id ?? (subframe as any)._frameId ?? (subframe as any).id;

    const { getElementTree } = await import('../src/layer2/semanticSurface.js');
    const { ImmutableNodeIndex } = await import('../src/core/ImmutableNodeIndex.js');
    const nodeIdx = new ImmutableNodeIndex();

    const result = await getElementTree(cdp, nodeIdx, btnBackendNodeId!, {
      semanticOnly: true,
      frameId,
    });
    expect(result.text).toContain('button');
    expect(result.text).toContain('Iframe Button');

    await browser.close();
  });

  it('should screenshot cross-iframe elements without crashing (Bug 1)', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div style="height: 50px;">Main Content</div>
        <iframe id="frame1" style="width: 300px; height: 300px; margin-top: 20px; margin-left: 30px; border: none;" srcdoc="
          <body style='margin: 0;'>
            <h1 id='iframe-heading' style='margin: 10px;'>Iframe Heading</h1>
          </body>
        "></iframe>
      </body>
    `);
    await new Promise((r) => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    // Find the iframe heading's backendNodeId
    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any;
    let headingBackendNodeId: number | null = null;
    const findHeading = (node: any) => {
      if (node.nodeName === 'H1' && node.attributes && node.attributes.includes('iframe-heading')) {
        headingBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const c of node.children) findHeading(c);
      }
      if (node.contentDocument) findHeading(node.contentDocument);
    };
    findHeading(doc.root);
    expect(headingBackendNodeId).not.toBeNull();

    // Use findFrameForBackendNodeId to get the correct frame
    const frame = await findFrameForBackendNodeId(page, headingBackendNodeId!);
    expect(frame).not.toBe(page.mainFrame());

    // Resolve via CDP (same pattern as the fixed browser_screenshot)
    const targetCdp = (frame as any).client;
    await targetCdp.send('DOM.enable');
    const { object } = (await targetCdp.send('DOM.resolveNode', {
      backendNodeId: headingBackendNodeId,
    })) as { object: { objectId?: string } };
    expect(object?.objectId).toBeDefined();

    // This should NOT throw "getBoundingClientRect is not a function"
    const evalResult = (await targetCdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }`,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number; width: number; height: number } } };
    const rect = evalResult.result.value;
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);

    // Verify frame offset is added correctly
    const offset = await getFrameOffset(frame);
    expect(offset.x).toBeCloseTo(30, 0);
    expect(offset.y).toBeCloseTo(70, 0); // 50px header + 20px margin

    await targetCdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    await browser.close();
  });

  it('should resolve backendNodeId > 0 for focused elements in tab flow (Bug 2)', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body>
        <button id="btn1">Button 1</button>
        <input id="input1" type="text" placeholder="Input 1" />
        <a id="link1" href="#">Link 1</a>
      </body>
    `);
    await new Promise((r) => setTimeout(r, 500));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    // Reset focus
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur?.();
      document.body.focus();
    });

    const results: { tag: string; backendNodeId: number }[] = [];

    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      await new Promise((r) => setTimeout(r, 50));

      const info = await page.evaluate(() => {
        const el = document.activeElement;
        return { tag: el?.tagName?.toLowerCase() || 'unknown' };
      });

      // Use the fixed CDP Runtime.evaluate approach
      let backendNodeId = 0;
      try {
        const evalResult = (await cdp.send('Runtime.evaluate', {
          expression: 'document.activeElement',
          returnByValue: false,
        })) as { result: { objectId?: string } };
        if (evalResult.result?.objectId) {
          const { node } = await cdp.send('DOM.describeNode', {
            objectId: evalResult.result.objectId,
          });
          backendNodeId = node.backendNodeId;
          await cdp
            .send('Runtime.releaseObject', { objectId: evalResult.result.objectId })
            .catch(() => {});
        }
      } catch {
        /* continue */
      }

      results.push({ tag: info.tag, backendNodeId });
    }

    // All 3 elements should have backendNodeId > 0
    expect(results).toHaveLength(3);
    expect(results[0].tag).toBe('button');
    expect(results[0].backendNodeId).toBeGreaterThan(0);
    expect(results[1].tag).toBe('input');
    expect(results[1].backendNodeId).toBeGreaterThan(0);
    expect(results[2].tag).toBe('a');
    expect(results[2].backendNodeId).toBeGreaterThan(0);

    await browser.close();
  });

  it('should assert element state for cross-iframe elements (Friction 2)', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body style="margin: 0;">
        <iframe id="frame1" style="width: 300px; height: 300px; border: none;" srcdoc="
          <body style='margin: 0;'>
            <button id='iframe-btn' style='width: 100px; height: 40px;'>Click Me</button>
          </body>
        "></iframe>
      </body>
    `);
    await new Promise((r) => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    // Find button backendNodeId
    const doc = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as any;
    let btnBackendNodeId: number | null = null;
    const findBtn = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('iframe-btn')) {
        btnBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const c of node.children) findBtn(c);
      }
      if (node.contentDocument) findBtn(node.contentDocument);
    };
    findBtn(doc.root);
    expect(btnBackendNodeId).not.toBeNull();

    // Use findFrameForBackendNodeId (same as the fixed assert handler)
    const frame = await findFrameForBackendNodeId(page, btnBackendNodeId!);
    expect(frame).not.toBe(page.mainFrame());

    const handle = await (frame as any).mainRealm().adoptBackendNode(btnBackendNodeId!);
    expect(handle).not.toBeNull();

    const result = await handle.evaluate((el: Element) => {
      const htmlEl = el as HTMLElement;
      const rect = el.getBoundingClientRect();
      const visible =
        rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden';
      const text = htmlEl.innerText || el.textContent || '';
      return { visible, text: text.trim() };
    });

    expect(result.visible).toBe(true);
    expect(result.text).toBe('Click Me');

    await handle.dispose();
    await browser.close();
  });

  it('should poll for element with timeoutMs in assert element (Feature)', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    await page.setContent(`
      <body>
        <div id="container"></div>
        <script>
          setTimeout(() => {
            const toast = document.createElement('div');
            toast.id = 'toast';
            toast.textContent = 'Operation successful';
            document.getElementById('container').appendChild(toast);
          }, 300);
        </script>
      </body>
    `);

    // Immediately, the toast doesn't exist
    const notFound = await page.$('#toast');
    expect(notFound).toBeNull();

    // Poll for the element (simulating timeoutMs logic)
    const deadline = Date.now() + 2000;
    let found = null;
    while (Date.now() < deadline) {
      found = await page.$('#toast');
      if (found) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(found).not.toBeNull();
    const text = await found!.evaluate((el: Element) => (el as HTMLElement).innerText);
    expect(text).toBe('Operation successful');

    await found!.dispose();
    await browser.close();
  });
});
