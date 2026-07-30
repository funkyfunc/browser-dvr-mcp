// ─── Redaction ──────────────────────────────────────────────────────────────
// Scrubs secrets from data that crosses out of the browser toward the agent's
// context window or the local disk (telemetry, crash dumps, session history).
//
// Threat model note: this is a local-dev tool, but a localhost app still loads
// third-party scripts, and URLs / headers / typed values routinely carry
// tokens. None of that should be persisted unredacted or handed to the model.
//
// Pure functions — unit-tested without a live browser.

export const REDACTED = '[REDACTED]';

// Query-string keys whose values are secrets. Matched case-insensitively; a key
// qualifies if it contains any of these fragments (so `x-api-key`, `access_token`
// both match).
const SENSITIVE_QUERY_FRAGMENTS = [
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'session',
  'sig',
  'signature',
  'code', // oauth authorization code
  'key',
];

// Request/response headers that carry credentials.
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-session-token',
]);

function keyIsSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_QUERY_FRAGMENTS.some((frag) => k.includes(frag));
}

/**
 * Redact a URL: drop any `user:pass@` userinfo and replace the values of
 * sensitive query parameters. Falls back to a regex scrub for non-parseable
 * strings. Non-sensitive URLs (e.g. file://, data:, plain http) pass through
 * unchanged.
 */
/**
 * data: URIs (inline base64 images/fonts) can be hundreds of KB of blob that
 * flood the timeline and eat tokens. Keep the informative header (media type +
 * encoding) and drop the payload with a length marker.
 */
const DATA_URI_KEEP = 48;
function truncateDataUri(url: string): string {
  const comma = url.indexOf(',');
  if (comma === -1) {
    return url.length > 128 ? `${url.slice(0, 128)}…[${url.length} chars]` : url;
  }
  const header = url.slice(0, comma + 1); // e.g. "data:image/png;base64,"
  const payload = url.slice(comma + 1);
  if (payload.length <= DATA_URI_KEEP) return url;
  return `${header}${payload.slice(0, DATA_URI_KEEP)}…[${payload.length} chars omitted]`;
}

export function redactUrl(url: string): string {
  if (typeof url === 'string' && url.startsWith('data:')) {
    return truncateDataUri(url);
  }
  try {
    const u = new URL(url);
    let changed = false;
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
      changed = true;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (keyIsSensitive(key)) {
        u.searchParams.set(key, REDACTED);
        changed = true;
      }
    }
    if (!changed) return url;
    // Avoid percent-encoding the placeholder brackets in the output.
    return u.toString().replace(/%5BREDACTED%5D/gi, REDACTED);
  } catch {
    // Not a standard URL (or a data: blob) — do a best-effort query scrub.
    return url.replace(
      /([?&#])([^=&#]*(?:token|secret|password|passwd|pwd|api[_-]?key|auth|session|sig|signature|code|key)[^=&#]*)=([^&#\s]+)/gi,
      (_m, sep, key) => `${sep}${key}=${REDACTED}`,
    );
  }
}

/** Redact credential-bearing headers. Accepts either a record or name/value pairs. */
export function redactHeaders<T extends Record<string, string>>(headers: T): T {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out as T;
}

/**
 * Best-effort scrub of secrets embedded in free text (console output, crash
 * arguments, stack traces). Conservative — targets well-known token shapes so
 * it does not mangle ordinary text.
 */
export function redactText(text: string): string {
  if (!text) return text;
  return (
    text
      // Authorization: Bearer <token>
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ' + REDACTED)
      // JWTs: three base64url segments
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED)
      // key=value / "key": "value" for sensitive keys
      .replace(
        /("?\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|session)\b"?\s*[:=]\s*"?)([^\s"',}&]+)/gi,
        (_m, prefix) => `${prefix}${REDACTED}`,
      )
  );
}

/**
 * Decide whether a form field's typed value is sensitive and must not be
 * captured. Mirrored by the in-page trackers (which can't import this module);
 * kept here for Node-side use and unit coverage.
 */
export function isSensitiveField(opts: {
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
}): boolean {
  const type = (opts.type || '').toLowerCase();
  if (type === 'password') return true;
  const ac = (opts.autocomplete || '').toLowerCase();
  if (
    ac.includes('cc-') ||
    ac === 'current-password' ||
    ac === 'new-password' ||
    ac === 'one-time-code'
  ) {
    return true;
  }
  const hay = `${opts.name || ''} ${opts.id || ''}`.toLowerCase();
  return /pass|passwd|pwd|card|cvv|cvc|ssn|secret|otp|token/.test(hay);
}
