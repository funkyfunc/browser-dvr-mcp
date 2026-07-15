// Mock-free unit tests for path containment (no live Chrome).
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import { resolveSafePath, outputBaseDir } from '../../src/security/resolvePath.js';

describe('resolveSafePath', () => {
  const savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
    else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
  });

  it('resolves a relative path inside the base dir', () => {
    const base = outputBaseDir();
    const resolved = resolveSafePath('recordings/rec_123');
    expect(resolved).toBe(path.join(base, 'recordings/rec_123'));
    expect(resolved.startsWith(base)).toBe(true);
  });

  it('allows an absolute path that is inside the base dir', () => {
    const base = outputBaseDir();
    expect(resolveSafePath(path.join(base, 'screenshots', 'a.png'))).toBe(
      path.join(base, 'screenshots', 'a.png'),
    );
  });

  it('rejects traversal that escapes the base dir', () => {
    expect(() => resolveSafePath('../../etc/passwd')).toThrow(/output directory/);
    expect(() => resolveSafePath('recordings/../../../../etc/passwd')).toThrow(/output directory/);
  });

  it('rejects an absolute path outside the base dir', () => {
    expect(() => resolveSafePath('/etc/passwd')).toThrow(/output directory/);
  });

  it('honors BROWSER_MCP_OUTPUT_DIR override', () => {
    const override = path.join(path.sep, 'tmp', 'bbmcp-sandbox-test');
    process.env.BROWSER_MCP_OUTPUT_DIR = override;
    expect(outputBaseDir()).toBe(path.resolve(override));
    expect(resolveSafePath('x/y.png')).toBe(path.join(override, 'x/y.png'));
    // A path that was fine under the old base now escapes the override base.
    expect(() => resolveSafePath(path.join(process.cwd(), 'foo.png'))).toThrow(/output directory/);
  });
});
