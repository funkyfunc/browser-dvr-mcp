// Mock-free unit tests for the redaction pass.
import { describe, it, expect } from 'vitest';
import {
  redactUrl,
  redactHeaders,
  redactText,
  isSensitiveField,
  REDACTED,
} from '../../src/security/redaction.js';

describe('redactUrl', () => {
  it('redacts sensitive query params but keeps benign ones', () => {
    const out = redactUrl('https://api.example.com/v1/users?id=42&access_token=abc.def&page=2');
    expect(out).toContain('id=42');
    expect(out).toContain('page=2');
    expect(out).toContain(`access_token=${REDACTED}`);
    expect(out).not.toContain('abc.def');
  });

  it('strips user:pass@ userinfo', () => {
    const out = redactUrl('https://user:s3cr3t@example.com/path');
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('user:');
  });

  it('passes through non-sensitive URLs unchanged', () => {
    const url = 'http://localhost:5173/app/page?tab=network';
    expect(redactUrl(url)).toBe(url);
  });

  it('leaves file:// and short data: URLs alone', () => {
    expect(redactUrl('file:///tmp/testbed.html')).toBe('file:///tmp/testbed.html');
    const data = 'data:text/html;base64,PGh0bWw+';
    expect(redactUrl(data)).toBe(data);
  });

  it('truncates large data: URI blobs but keeps the media-type header', () => {
    const blob = 'A'.repeat(50_000);
    const out = redactUrl(`data:image/png;base64,${blob}`);
    expect(out.startsWith('data:image/png;base64,')).toBe(true);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('chars omitted');
    expect(out).not.toContain('A'.repeat(200));
  });

  it('scrubs sensitive params in non-parseable strings via regex fallback', () => {
    const out = redactUrl('weird::/thing?api_key=SUPERSECRET&ok=1');
    expect(out).toContain(`api_key=${REDACTED}`);
    expect(out).toContain('ok=1');
    expect(out).not.toContain('SUPERSECRET');
  });
});

describe('redactHeaders', () => {
  it('scrubs credential-bearing headers, keeps the rest', () => {
    const out = redactHeaders({
      'Content-Type': 'application/json',
      Authorization: 'Bearer abc',
      Cookie: 'session=xyz',
    });
    expect(out['Content-Type']).toBe('application/json');
    expect(out['Authorization']).toBe(REDACTED);
    expect(out['Cookie']).toBe(REDACTED);
  });
});

describe('redactText', () => {
  it('redacts bearer tokens and JWTs', () => {
    expect(redactText('Authorization: Bearer sk-abc123def456ghi')).toContain(`Bearer ${REDACTED}`);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(redactText(`token is ${jwt}`)).not.toContain(jwt);
  });

  it('redacts sensitive key=value pairs', () => {
    expect(redactText('password=hunter2 and user=bob')).toContain(`password=${REDACTED}`);
    expect(redactText('password=hunter2 and user=bob')).toContain('user=bob');
    expect(redactText('{"api_key":"XYZ123"}')).not.toContain('XYZ123');
  });

  it('leaves ordinary text unchanged', () => {
    const t = 'Navigated to the dashboard and clicked Submit.';
    expect(redactText(t)).toBe(t);
  });
});

describe('isSensitiveField', () => {
  it('flags password inputs, cc autocomplete, and name hints', () => {
    expect(isSensitiveField({ type: 'password' })).toBe(true);
    expect(isSensitiveField({ autocomplete: 'cc-number' })).toBe(true);
    expect(isSensitiveField({ autocomplete: 'one-time-code' })).toBe(true);
    expect(isSensitiveField({ name: 'user_ssn' })).toBe(true);
    expect(isSensitiveField({ id: 'cardCvv' })).toBe(true);
  });

  it('does not flag ordinary fields', () => {
    expect(isSensitiveField({ type: 'text', name: 'email' })).toBe(false);
    expect(isSensitiveField({ type: 'search', id: 'q' })).toBe(false);
  });
});
