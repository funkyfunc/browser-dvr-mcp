import { describe, it, expect } from 'vitest';
import puppeteer from 'puppeteer-core';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveAndValidateSpatialCoordinate } from '../src/layer1/spatialValidation.js';
import { findFrameForBackendNodeId } from '../src/layer1/atomicInteract.js';
import { SessionTelemetryManager } from '../src/telemetry/SessionTelemetryManager.js';
import { ScreencastManager } from '../src/layer1/screencast.js';

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

describe('Regressions & New Features Tests', () => {

  it('should calculate correct offsets for deeply nested iframes', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();

    // Main page -> iframe A (offset 100px top) -> iframe B (offset 50px top)
    await page.setContent(`
      <body style="margin: 0; padding: 0;">
        <div style="height: 100px;">Spacer Main</div>
        <iframe id="iframeA" style="margin: 0; padding: 0; width: 500px; height: 500px; border: none;" srcdoc="
          <body style='margin: 0; padding: 0;'>
            <div style='height: 50px;'>Spacer A</div>
            <iframe id='iframeB' style='margin: 0; padding: 0; width: 400px; height: 400px; border: none;' srcdoc='
              <body style=&quot;margin: 0; padding: 0;&quot;>
                <button id=&quot;btn&quot; style=&quot;margin: 0; padding: 0; width: 100px; height: 50px;&quot; onclick=&quot;window.clicked=true;&quot;>Deep Button</button>
              </body>
            '></iframe>
          </body>
        "></iframe>
      </body>
    `);

    // Wait for frames to load
    await new Promise(r => setTimeout(r, 1200));

    const cdp = await page.createCDPSession();
    await cdp.send('DOM.enable');

    const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }) as any;

    let btnBackendNodeId: number | null = null;
    const findTarget = (node: any) => {
      if (node.nodeName === 'BUTTON' && node.attributes && node.attributes.includes('btn')) {
        btnBackendNodeId = node.backendNodeId;
        return;
      }
      if (node.children) {
        for (const child of node.children) findTarget(child);
      }
      if (node.contentDocument) findTarget(node.contentDocument);
    };
    findTarget(doc.root);

    expect(btnBackendNodeId).not.toBeNull();

    const frameB = await findFrameForBackendNodeId(page, btnBackendNodeId!);
    expect(frameB).not.toBeNull();

    const targetCdp = (frameB as any).client || cdp;

    // Resolve element center for Deep Button
    // Expected center: x = 50, y = 100 (Spacer Main) + 50 (Spacer A) + 25 (Button half-height) = 175
    const center = await resolveAndValidateSpatialCoordinate(page, targetCdp, btnBackendNodeId!, 2000, frameB);
    expect(center.valid).toBe(true);
    expect(center.coordinates).toBeDefined();
    expect(center.coordinates!.y).toBeCloseTo(175, 1);
    expect(center.coordinates!.x).toBeCloseTo(50, 1);

    await browser.close();
  });

  it('should capture DOM mutations in telemetry', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();
    const tel = new SessionTelemetryManager('agent');
    tel.attachToPage(page);

    await page.setContent(`
      <body>
        <div id="container">Original Content</div>
      </body>
    `);

    await new Promise(r => setTimeout(r, 500));

    // Modify DOM
    await page.evaluate(() => {
      const container = document.getElementById('container');
      if (container) {
        container.innerHTML = '<button id="new-btn">New Button</button>';
      }
    });

    // Wait a little for MutationObserver
    await new Promise(r => setTimeout(r, 1200));

    const summary = tel.getSummary();
    expect(summary.mutations.total).toBeGreaterThan(0);

    tel.destroy();
    await browser.close();
  });

  it('should record frames and produce MP4 video and manifest', async () => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
    });
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    const screencast = new ScreencastManager(cdp);

    await page.setContent('<body><h1>Recording Test Page</h1></body>');

    const outputDir = join(process.cwd(), 'recordings_test_run');
    const startMsg = await screencast.startRecording(outputDir);
    expect(startMsg).toContain('Recording started');
    expect(screencast.isRecordingActive()).toBe(true);

    // Perform some dummy changes to trigger screen frames
    for (let i = 0; i < 5; i++) {
      await page.evaluate((val) => {
        document.body.style.backgroundColor = val % 2 === 0 ? 'red' : 'blue';
      }, i);
      await new Promise(r => setTimeout(r, 200));
    }

    const stopResult = await screencast.stopRecording();
    expect(stopResult.status).toBe('success');
    expect(stopResult.frameCount).toBeGreaterThan(0);
    expect(stopResult.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(existsSync(stopResult.manifestPath)).toBe(true);

    // Clean up files in outputDir
    try {
      const files = readdirSync(outputDir);
      for (const file of files) {
        const { unlinkSync } = await import('fs');
        unlinkSync(join(outputDir, file));
      }
      const { rmdirSync } = await import('fs');
      rmdirSync(outputDir);
    } catch {
      // ignore cleanup errors
    }

    await screencast.stop();
    await browser.close();
  });
});
