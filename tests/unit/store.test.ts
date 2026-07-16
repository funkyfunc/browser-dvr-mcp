// Mock-free unit tests for the local JSON persistence substrate.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { JsonStore, originKey } from '../../src/persistence/store.js';

// Point the sandbox at a temp dir so tests never touch the project tree.
const SANDBOX = path.join(os.tmpdir(), `bbmcp-store-test-${process.pid}`);
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.BROWSER_MCP_OUTPUT_DIR;
  process.env.BROWSER_MCP_OUTPUT_DIR = SANDBOX;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BROWSER_MCP_OUTPUT_DIR;
  else process.env.BROWSER_MCP_OUTPUT_DIR = savedEnv;
  if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
});

describe('originKey', () => {
  it('keys http(s) origins by protocol+host', () => {
    expect(originKey('https://app.example.com:8443/checkout?token=x')).toBe(
      'https_app.example.com_8443',
    );
    expect(originKey('http://localhost:5173/a/b')).toBe('http_localhost_5173');
  });
  it('keys file:// by directory, about: as about', () => {
    expect(originKey('file:///Users/x/proj/testbed.html')).toMatch(/^file_/);
    expect(originKey('about:blank')).toBe('about');
  });
});

describe('JsonStore', () => {
  it('round-trips a value and returns undefined for missing keys', async () => {
    const store = new JsonStore<{ n: number }>('site-memory');
    expect(await store.read('missing')).toBeUndefined();
    await store.write('http_localhost_5173', { n: 42 });
    expect(await store.read('http_localhost_5173')).toEqual({ n: 42 });
  });

  it('merges read-modify-write', async () => {
    const store = new JsonStore<{ count: number }>('site-memory');
    await store.merge('k', (e) => ({ count: (e?.count ?? 0) + 1 }));
    const merged = await store.merge('k', (e) => ({ count: (e?.count ?? 0) + 1 }));
    expect(merged.count).toBe(2);
    expect((await store.read('k'))!.count).toBe(2);
  });

  it('redacts secret-shaped payloads on write (backstop)', async () => {
    const store = new JsonStore<{ note: string }>('site-memory');
    await store.write('k', { note: 'password=hunter2 and api_key=SUPERSECRET' });
    const onDisk = await store.read('k');
    // Values are scrubbed by redactText before hitting disk.
    expect(JSON.stringify(onDisk)).not.toContain('hunter2');
    expect(JSON.stringify(onDisk)).not.toContain('SUPERSECRET');
  });

  it('lists keys in a namespace', async () => {
    const store = new JsonStore<{ x: number }>('scenarios');
    await store.write('login-flow', { x: 1 });
    await store.write('checkout', { x: 2 });
    const keys = await store.keys();
    expect(keys.sort()).toEqual(['checkout', 'login-flow']);
  });
});
