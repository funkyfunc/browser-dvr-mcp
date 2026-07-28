// ─── Anchors ────────────────────────────────────────────────────────────────
// An Anchor is a portable, opaque reference to a MOMENT in a recorded session —
// our analog of Replay's "execution points." Moment-producing tools (timetravel,
// when_changed) hand back an anchor; moment-consuming tools (state_diff,
// when_changed, query_timeline) accept one, so the debugging surface composes:
// "diff the state between these two anchors", "what changed before this anchor".
//
// The token is opaque to the agent (treat as a handle), but is just a base64url
// of {session, ts, seq} so it can be resolved without external state.

export interface Anchor {
  session: string;
  ts: number;
  seq?: number;
}

export function encodeAnchor(a: Anchor): string {
  const json = JSON.stringify({ s: a.session, t: a.ts, q: a.seq });
  return 'anc_' + Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeAnchor(token: string): Anchor | null {
  if (typeof token !== 'string' || !token.startsWith('anc_')) return null;
  try {
    const json = Buffer.from(token.slice(4), 'base64url').toString('utf8');
    const o = JSON.parse(json) as { s?: unknown; t?: unknown; q?: unknown };
    if (typeof o.s !== 'string' || typeof o.t !== 'number') return null;
    return { session: o.s, ts: o.t, seq: typeof o.q === 'number' ? o.q : undefined };
  } catch {
    return null;
  }
}

/** Is this string a well-formed anchor token? */
export function isAnchor(token: string): boolean {
  return decodeAnchor(token) !== null;
}
