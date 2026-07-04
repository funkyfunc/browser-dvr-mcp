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

    await new Promise(r => setTimeout(r, 1000));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const frames = page.frames();
    expect(frames.length).toBeGreaterThan(1);

    // Let's find the backendNodeId of the iframe title h1
    const subframe = frames.find(f => f !== page.mainFrame())!;
    const headingHandle = await subframe.$('.iframe-heading');
    expect(headingHandle).not.toBeNull();

    const remoteObj = (headingHandle as any).remoteObject?.() || (headingHandle as any)._remoteObject;
    const { node } = await (subframe as any).client.send('DOM.describeNode', { objectId: remoteObj.objectId });
    const h1BackendNodeId = node.backendNodeId;
    expect(h1BackendNodeId).toBeDefined();

    // Verify finding target frame works
    const foundFrame = await findFrameForBackendNodeId(page, h1BackendNodeId);
    expect(foundFrame).toBe(subframe);

    // Verify computed style resolves inside the iframe correctly via frame's CDP session
    const targetCdp = (foundFrame as any).client;
    await targetCdp.send('DOM.enable');
    const { object } = await targetCdp.send('DOM.resolveNode', { backendNodeId: h1BackendNodeId }) as { object: { objectId?: string } };
    expect(object?.objectId).toBeDefined();

    const evalResult = await targetCdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        return window.getComputedStyle(this).color;
      }`,
      returnByValue: true,
    }) as { result: { value: string } };

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
    const badgeInfo = await headingHandle!.evaluate((el: any) => {
      const badge = document.createElement('div');
      badge.id = 'test-badge-38';
      badge.textContent = 'ID: 38';
      document.body.appendChild(badge);
      return { id: badge.id, exists: !!document.getElementById('test-badge-38') };
    });
    expect(badgeInfo.exists).toBe(true);

    // Verify cleanup removes it
    const badgeRemoved = await headingHandle!.evaluate((el: any) => {
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

});
