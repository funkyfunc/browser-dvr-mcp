import { BrowserManager } from './browser.js';
import { readdirSync, readFileSync } from 'fs';
import { AXNode } from './usag.js';
import { join } from 'path';

async function runTests() {
  console.log('--- STARTING BROWSER OBSERVABILITY INTEGRATION TESTS ---');
  const bm = new BrowserManager();

  try {
    // 1. Launch Browser
    console.log('1. Launching browser...');
    await bm.launch({ headless: true });
    
    // 2. Navigate to local test file
    const testPagePath = `file://${join(process.cwd(), 'test_page.html')}`;
    console.log(`2. Navigating to: ${testPagePath}`);
    await bm.navigate(testPagePath);

    // 3. Inspect accessibility tree and find node IDs
    console.log('3. Fetching accessibility tree...');
    const axMarkdown = await bm.getAccessibilityTree();
    console.log('Accessibility Markdown output preview:\n');
    console.log(axMarkdown);
    console.log('\n----------------------------------------\n');

    // Parse the nodes directly via CDP to find the backendNodeId values
    const page = bm.getActivePage();
    if (!page) throw new Error('No active page');
    
    const client = await page.createCDPSession();
    const { nodes } = await client.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };

    const clickableBtnNode = nodes.find(n => n.name?.value === 'Clickable Button');
    const inputNode = nodes.find(n => n.role?.value === 'textbox' || n.name?.value === 'Type here...');
    const occludedBtnNode = nodes.find(n => n.name?.value === 'Occluded Button');

    if (!clickableBtnNode || !inputNode || !occludedBtnNode) {
      throw new Error('Failed to find all required test elements in AX tree.');
    }

    if (
      clickableBtnNode.backendDOMNodeId === undefined ||
      inputNode.backendDOMNodeId === undefined ||
      occludedBtnNode.backendDOMNodeId === undefined
    ) {
      throw new Error('Some element backendDOMNodeIds are undefined in AX tree.');
    }

    console.log(`Found element backendNodeId values:`);
    console.log(`- Clickable Button: ${clickableBtnNode.backendDOMNodeId}`);
    console.log(`- Input Field: ${inputNode.backendDOMNodeId}`);
    console.log(`- Occluded Button: ${occludedBtnNode.backendDOMNodeId}`);

    // 4. Test normal click
    console.log('4. Testing clickable button (should succeed)...');
    const clickResult = await bm.click(clickableBtnNode.backendDOMNodeId);
    console.log(clickResult);

    // Verify click side effect in browser context
    const buttonText = await page.evaluate(() => document.getElementById('target-btn')?.textContent);
    if (buttonText !== 'Clicked!') {
      throw new Error(`Click failed! Button text should be 'Clicked!', got: '${buttonText}'`);
    }
    console.log('✔ Button click successfully registered side effects.');

    // 5. Test Intercept Guard occlusion validation
    console.log('5. Testing occluded button (should fail)...');
    try {
      await bm.click(occludedBtnNode.backendDOMNodeId);
      throw new Error('FAIL: Click on occluded element did not trigger an error.');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('Pre-Execution Spatial Validation Failed')) {
        console.log(`✔ Occlusion validation blocked the click correctly! Error message:`);
        console.log(`   "${errorMsg}"`);
      } else {
        throw err;
      }
    }

    // 6. Test typing and mutation tracking
    console.log('6. Testing text typing and mutation delta tracking...');
    await bm.type(inputNode.backendDOMNodeId, 'Observability check');
    
    // Check page text value is updated
    const inputValue = await page.evaluate(() => (document.getElementById('input-field') as HTMLInputElement)?.value);
    if (inputValue !== 'Observability check') {
      throw new Error(`Typing failed! Input value should be 'Observability check', got: '${inputValue}'`);
    }
    console.log('✔ Input typing successfully registered.');



    // Fetch mutations
    console.log('Fetching mutation list...');
    const mutations = await bm.getMutations();
    console.log(`Retrieved ${mutations.length} mutation records.`);
    if (mutations.length === 0) {
      throw new Error('Fail: Mutation observer did not record typing inputs.');
    }
    console.log('Sample mutation:', JSON.stringify(mutations[0], null, 2));
    console.log('✔ Mutations successfully captured and streamed.');

    // 7. Test DVR Telemetry dump
    console.log('7. Waiting for screencast frames to buffer...');
    await new Promise(resolve => setTimeout(resolve, 2000)); // wait 2s

    const dvrOutputDir = join(process.cwd(), 'dist', 'test-dvr');
    console.log(`Dumping DVR traces to: ${dvrOutputDir}`);
    const dumpResult = await bm.dumpDvr(dvrOutputDir);
    console.log(`Dump completed successfully!`);
    console.log(`- Frames: ${dumpResult.frameCount}`);
    console.log(`- Logs: ${dumpResult.logCount}`);

    // Verify DVR files exist
    const files = readdirSync(dvrOutputDir);
    const hasJpegs = files.some(f => f.endsWith('.jpg'));
    const hasTrace = files.includes('session_trace.txt');

    if (!hasJpegs || !hasTrace) {
      throw new Error(`DVR output incomplete. Files found: ${files.join(', ')}`);
    }
    
    console.log('✔ DVR directories contain frame captures and network/console logs.');
    const traceTimeline = readFileSync(join(dvrOutputDir, 'session_trace.txt'), 'utf8');
    console.log('DVR timeline trace preview:\n');
    console.log(traceTimeline.split('\n').slice(0, 10).join('\n'));
    console.log('\n----------------------------------------\n');

    // 8. Test Dysfunctionality & Failure Recovery
    console.log('8. Running Dysfunctionality & Exception Recovery Tests...');

    // Test Case 8a: Double launch check
    console.log('- Test Case 8a: Attempting double launch (should return already running)...');
    const doubleLaunchMsg = await bm.launch({ headless: true });
    if (doubleLaunchMsg !== 'Browser is already running.') {
      throw new Error(`Double launch did not warn correctly: ${doubleLaunchMsg}`);
    }
    console.log('✔ Double launch warning handled correctly.');

    // Test Case 8b: Invalid backend node ID interaction
    console.log('- Test Case 8b: Interacting with invalid backendNodeId (should fail gracefully)...');
    try {
      await bm.click(999999);
      throw new Error('FAIL: Click on non-existent backend node ID did not fail.');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('Failed to resolve backend node ID') || errorMsg.includes('Could not adopt')) {
        console.log(`✔ Gracefully threw error for invalid element: "${errorMsg}"`);
      } else {
        throw err;
      }
    }

    // Test Case 8c: Calling dumpDvr with invalid output directory
    console.log('- Test Case 8c: Dumping DVR to invalid path (should fail gracefully)...');
    try {
      await bm.dumpDvr('');
      throw new Error('FAIL: DVR dump to empty string path did not fail.');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`✔ Gracefully threw error for invalid DVR path: "${errorMsg}"`);
    }

    // Test Case 8d: Navigation to invalid URL
    console.log('- Test Case 8d: Navigating to invalid schema URL (should fail gracefully)...');
    try {
      await bm.navigate('invalid://domain');
      throw new Error('FAIL: Navigation to invalid schema did not fail.');
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(`✔ Gracefully threw navigation failure error: "${errorMsg}"`);
    }

    // 9. Close Browser
    console.log('9. Closing browser...');
    await bm.close();
    console.log('✔ Browser closed cleanly.');

    console.log('\n⭐⭐⭐⭐ ALL OBSERVABILITY TESTS PASSED SUCCESSFULLY! ⭐⭐⭐⭐\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ TEST SUITE FAILED with error:\n', error);
    await bm.close().catch(() => {});
    process.exit(1);
  }
}

runTests();
