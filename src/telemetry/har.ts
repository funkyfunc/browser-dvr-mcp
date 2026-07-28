// ─── HAR export ─────────────────────────────────────────────────────────────
// Build a standard HAR 1.2 archive from the captured NetworkEvent stream so an
// agent (or a human it hands off to) can inspect the actual request/response
// payloads — the API error body, the malformed JSON — that plain status codes
// hide. Pure over the event list; unit-tested without a browser. Everything here
// was already redacted at capture time (headers, bodies, urls).

import type { NetworkEvent } from '../core/types.js';

interface HarHeader {
  name: string;
  value: string;
}
interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarHeader[];
    cookies: [];
    headersSize: number;
    bodySize: number;
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: [];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    _error?: string;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _truncated?: boolean;
}

export interface Har {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

function toHeaders(h?: Record<string, string>): HarHeader[] {
  return h ? Object.entries(h).map(([name, value]) => ({ name, value })) : [];
}

/**
 * Correlate request/response/failed events by id into HAR entries. A request
 * without a response still produces an entry (status 0) so hung/failed calls
 * are visible.
 */
export function buildHar(
  events: NetworkEvent[],
  creator = { name: 'best-browser-mcp', version: '2.0' },
): Har {
  const byId = new Map<string, { request?: NetworkEvent; response?: NetworkEvent }>();
  for (const e of events) {
    const slot = byId.get(e.id) ?? {};
    if (e.eventType === 'request') slot.request = e;
    else slot.response = e; // 'response' or 'failed'
    byId.set(e.id, slot);
  }

  const entries: HarEntry[] = [];
  for (const { request, response } of byId.values()) {
    const req = request ?? response!;
    const startTs = request?.timestamp ?? response?.timestamp ?? 0;
    const duration = response?.duration ?? 0;
    const truncated = Boolean(request?.bodyTruncated || response?.bodyTruncated);

    entries.push({
      startedDateTime: new Date(startTs).toISOString(),
      time: duration,
      request: {
        method: req.method,
        url: req.url,
        httpVersion: 'HTTP/1.1',
        headers: toHeaders(request?.requestHeaders),
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: request?.requestBody ? request.requestBody.length : 0,
        postData: request?.requestBody
          ? {
              mimeType: request.requestHeaders?.['content-type'] ?? 'application/octet-stream',
              text: request.requestBody,
            }
          : undefined,
      },
      response: {
        status: response?.status ?? 0,
        statusText: response?.eventType === 'failed' ? 'Failed' : '',
        httpVersion: 'HTTP/1.1',
        headers: toHeaders(response?.responseHeaders),
        cookies: [],
        content: {
          size: response?.size ?? response?.responseBody?.length ?? 0,
          mimeType: response?.mimeType ?? '',
          text: response?.responseBody,
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: response?.responseBody ? response.responseBody.length : 0,
        _error: response?.errorText,
      },
      cache: {},
      timings: { send: -1, wait: duration, receive: -1 },
      _truncated: truncated || undefined,
    });
  }

  // Order entries chronologically for a readable archive.
  entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));

  return { log: { version: '1.2', creator, entries } };
}
