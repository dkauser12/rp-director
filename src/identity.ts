/**
 * Identities and fingerprints.
 *
 * Cursors fingerprint an accepted transcript prefix from stable inputs only:
 * seed identity, parent cursor, role, durable actor key, canonical text.
 * Timestamps, swipe ids, host array indexes and extension bookkeeping are
 * excluded on purpose (plan §8). Two swipes with identical text produce the
 * same cursor; variant identity is tracked separately.
 */

/** Small, fast, deterministic 53-bit string hash (cyrb53), rendered as hex. */
export function hash53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hi = (h2 >>> 0).toString(16).padStart(8, '0');
  const lo = (h1 >>> 0).toString(16).padStart(8, '0');
  return hi + lo;
}

/** Collapses whitespace and trims so cosmetic edits do not change identity. */
export function canonicalText(text: string): string {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export interface FingerprintMessage {
  role: 'user' | 'assistant' | 'system';
  /** Durable actor key: avatar filename for characters, 'persona' for the player, 'system' otherwise. */
  actorKey: string;
  text: string;
}

/** Cursor for the empty prefix of a chat. */
export function rootCursor(seedId: string): string {
  return 'c_' + hash53('root|' + seedId);
}

/** Extends a cursor by one accepted message. */
export function extendCursor(parent: string, message: FingerprintMessage): string {
  return 'c_' + hash53(`${parent}|${message.role}|${message.actorKey}|${canonicalText(message.text)}`);
}

/** Full chain of cursors: index i is the cursor after the first i messages. */
export function cursorChain(seedId: string, messages: FingerprintMessage[]): string[] {
  const chain: string[] = [rootCursor(seedId)];
  for (const message of messages) {
    chain.push(extendCursor(chain[chain.length - 1]!, message));
  }
  return chain;
}

/** Cursor of the whole prefix. */
export function prefixCursor(seedId: string, messages: FingerprintMessage[]): string {
  const chain = cursorChain(seedId, messages);
  return chain[chain.length - 1]!;
}

let counter = 0;

/** Unique id with a readable prefix. Uses crypto.randomUUID when available. */
export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    return `${prefix}_${c.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Stable actor id from a display name and durable host key; duplicates of a name stay distinct. */
export function actorIdFor(name: string, durableKey: string): string {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'actor';
  return `${slug}-${hash53(durableKey).slice(0, 6)}`;
}

/** Uniform draw in [0,1) from a 32-bit integer, the documented replay mapping. */
export function drawFromUint32(n: number): number {
  return (n >>> 0) / 4294967296;
}

/** Production random source: records a 32-bit integer draw. */
export function randomDraw(): { uint32: number; u: number } {
  const c = globalThis.crypto;
  let uint32: number;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    uint32 = buf[0]!;
  } else {
    uint32 = Math.floor(Math.random() * 4294967296);
  }
  return { uint32, u: drawFromUint32(uint32) };
}
