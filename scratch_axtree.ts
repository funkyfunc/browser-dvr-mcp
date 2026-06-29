import { BrowserManager } from './src/browser.js';
import { join } from 'path';
import puppeteer from 'puppeteer-core';

async function run() {
  const bm = new BrowserManager();
  await bm.launch({ headless: true });
  await bm.navigate(`file://${join(process.cwd(), 'test_page_iframe_parent.html')}`);

  const page = bm.page!;
  const cdp = bm.cdpSession!;

  const iframeHandle = await page.$('#test-iframe');
  const frame = await iframeHandle!.contentFrame();
  
  console.log('Frame internal ID properties:', Object.keys(frame).filter(k => k.toLowerCase().includes('id')));
  
  const frameId = (frame as any)._id || (frame as any).id;
  console.log('Using frameId:', frameId);

  try {
    const result = await cdp.send('Accessibility.getFullAXTree', { frameId });
    console.log(`AX Tree for frame has ${result.nodes.length} nodes.`);
    const roles = result.nodes.map((n: any) => n.role?.value);
    console.log('Roles in iframe:', roles.join(', '));
  } catch (err) {
    console.error('Error fetching AX tree for frameId:', err);
  }

  await bm.close();
}

run();
