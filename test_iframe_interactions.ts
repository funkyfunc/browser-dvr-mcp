import { BrowserManager } from './src/browser.js';
import { join } from 'path';

async function runTests() {
  console.log('--- STARTING IFRAME OBSERVABILITY TESTS ---');
  const bm = new BrowserManager();

  try {
    // 1. Launch Browser
    console.log('1. Launching browser...');
    await bm.launch({ headless: true });
    
    // 2. Navigate to local test file
    const testPagePath = `file://${join(process.cwd(), 'test_page_iframe_parent.html')}`;
    console.log(`2. Navigating to: ${testPagePath}`);
    await bm.navigate(testPagePath);

    // 3. Try to query selector in parent
    console.log('3. Querying parent button...');
    const parentQuery = await bm.querySelector('#parent-btn');
    console.log('Parent button matches:', JSON.stringify(parentQuery, null, 2));

    // 4. Try to query selector in iframe
    console.log('4. Querying child button inside iframe...');
    const childQuery = await bm.querySelector('#child-btn', '#test-iframe');
    console.log('Child button matches:', JSON.stringify(childQuery, null, 2));

    // 5. Interact with child button
    if (childQuery.matches.length > 0) {
      console.log('5. Clicking child button via mcpId...');
      const clickResult = await bm.click({ mcpId: childQuery.matches[0].mcpId });
      console.log('Click result:', clickResult);
      
      const childInput = await bm.querySelector('#child-input', '#test-iframe');
      if (childInput.matches.length > 0) {
        console.log('6. Typing into child input via coordinates...');
        const typeResult = await bm.type({
          coordinate: [childInput.matches[0].boundingBox.x + 5, childInput.matches[0].boundingBox.y + 5],
          text: 'Hello from MCP!'
        });
        console.log('Type result:', typeResult);
      }
    }

    // 7. Get Accessibility Tree
    console.log('7. Fetching accessibility tree...');
    const axMarkdown = await bm.getAccessibilityTree();
    console.log('Accessibility Markdown output preview:\n');
    console.log(axMarkdown);
    console.log('\n----------------------------------------\n');

  } catch (err) {
    console.error('Test Failed:', err);
  } finally {
    await bm.close();
  }
}

runTests();
