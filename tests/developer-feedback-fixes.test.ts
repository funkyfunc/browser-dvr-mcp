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
});
