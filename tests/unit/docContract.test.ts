// Contract test: every tool name referenced in the product docs must actually
// be registered in src/index.ts. Guards against the doc-vs-code drift where
// docs advertised tools (browser_session_summary, browser_sniff_framework_state,
// ...) that never existed. Runs without a live browser.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

// Tool-name shape used across this codebase (snake_case verbs like atomic_,
// browser_, get_, query_, start_/stop_, coordinate_, evaluate_, validate_,
// stream_). Kept deliberately specific so prose words don't match.
const TOOL_NAME_RE =
  /\b(?:browser|atomic|get|query|start|stop|coordinate|evaluate|validate|stream)_[a-z_]+\b/g;

function registeredTools(): Set<string> {
  const src = readFileSync(path.join(repoRoot, 'src', 'index.ts'), 'utf8');
  const names = new Set<string>();
  const re = /server\.registerTool\(\s*\n?\s*'([a-z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

// Docs that describe the shipped tool surface. Research/aspirational docs under
// docs/research are intentionally excluded — they explore ideas, not the API.
const CONTRACT_DOCS = ['docs/PROGRESSIVE_DISCLOSURE.md', 'ARCHITECTURE.md', 'GEMINI.md'];

describe('doc/code tool-name contract', () => {
  it('registers a plausible number of tools', () => {
    expect(registeredTools().size).toBeGreaterThan(20);
  });

  for (const relDoc of CONTRACT_DOCS) {
    it(`${relDoc} only references tools that exist`, () => {
      const tools = registeredTools();
      const text = readFileSync(path.join(repoRoot, relDoc), 'utf8');
      const referenced = new Set(text.match(TOOL_NAME_RE) ?? []);
      const missing = [...referenced].filter((name) => !tools.has(name));
      expect(missing, `${relDoc} references unregistered tools: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the contract docs actually exist', () => {
    const present = new Set(readdirSync(repoRoot));
    expect(present.has('ARCHITECTURE.md')).toBe(true);
  });
});
