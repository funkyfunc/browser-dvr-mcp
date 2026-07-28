// Mock-free unit tests for HAR export.
import { describe, it, expect } from 'vitest';
import { buildHar } from '../../src/telemetry/har.js';
import type { NetworkEvent } from '../../src/core/types.js';

describe('buildHar', () => {
  it('correlates request + response by id into one entry with bodies', () => {
    const events: NetworkEvent[] = [
      {
        id: 'req-1',
        method: 'POST',
        url: 'https://api.example/save',
        eventType: 'request',
        timestamp: 1000,
        requestHeaders: { 'content-type': 'application/json' },
        requestBody: '{"name":"x"}',
      },
      {
        id: 'req-1',
        method: 'POST',
        url: 'https://api.example/save',
        eventType: 'response',
        timestamp: 1200,
        status: 500,
        duration: 200,
        mimeType: 'application/json',
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: '{"error":"boom"}',
      },
    ];
    const har = buildHar(events);
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries.length).toBe(1);
    const e = har.log.entries[0];
    expect(e.request.method).toBe('POST');
    expect(e.request.postData?.text).toBe('{"name":"x"}');
    expect(e.response.status).toBe(500);
    expect(e.response.content.text).toBe('{"error":"boom"}');
    expect(e.time).toBe(200);
    expect(e.startedDateTime).toBe(new Date(1000).toISOString());
  });

  it('emits an entry for a request with no response (hung/failed)', () => {
    const events: NetworkEvent[] = [
      { id: 'req-2', method: 'GET', url: 'https://api/x', eventType: 'request', timestamp: 500 },
    ];
    const har = buildHar(events);
    expect(har.log.entries.length).toBe(1);
    expect(har.log.entries[0].response.status).toBe(0);
  });

  it('marks a failed request and carries its error text', () => {
    const events: NetworkEvent[] = [
      { id: 'req-3', method: 'GET', url: 'https://api/y', eventType: 'request', timestamp: 100 },
      {
        id: 'req-3',
        method: 'GET',
        url: 'https://api/y',
        eventType: 'failed',
        timestamp: 150,
        errorText: 'net::ERR_CONNECTION_REFUSED',
      },
    ];
    const har = buildHar(events);
    const e = har.log.entries[0];
    expect(e.response.statusText).toBe('Failed');
    expect(e.response._error).toBe('net::ERR_CONNECTION_REFUSED');
  });

  it('flags truncated bodies and orders entries chronologically', () => {
    const events: NetworkEvent[] = [
      { id: 'b', method: 'GET', url: '/b', eventType: 'request', timestamp: 2000 },
      {
        id: 'a',
        method: 'GET',
        url: '/a',
        eventType: 'request',
        timestamp: 1000,
        responseBody: 'x',
        bodyTruncated: true,
      },
    ];
    const har = buildHar(events);
    expect(har.log.entries.map((e) => e.request.url)).toEqual(['/a', '/b']);
    expect(har.log.entries[0]._truncated).toBe(true);
  });
});
