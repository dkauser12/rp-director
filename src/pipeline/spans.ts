/**
 * Verbatim passages of a message (staged stage A).
 *
 * Code enumerates candidates and the judge only selects one, so the ruled
 * proposition is always the player's own words, never a paraphrase. Every span
 * is an exact slice of the source: `source.slice(start, end) === text`.
 */

export interface Span {
  id: string;
  kind: 'sentence' | 'pair' | 'whole';
  start: number;
  end: number;
  text: string;
}

/** A Choice allows 255 options; two are reserved for ROUTINE and NONE. */
export const MAX_SPAN_OPTIONS = 253;

const BOUNDARY = /[.!?…]+["'”’)\]]*(?=\s)|\n+/g;

function trimmed(source: string, start: number, end: number): { start: number; end: number } | null {
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

/** Sentences (and line-separated passages) in order, with exact offsets. */
export function sentenceSpans(source: string): Span[] {
  const text = String(source ?? '');
  const spans: Span[] = [];
  let from = 0;
  const push = (to: number) => {
    const range = trimmed(text, from, to);
    if (range) spans.push({ id: `s${spans.length + 1}`, kind: 'sentence', ...range, text: text.slice(range.start, range.end) });
    from = to;
  };
  for (const match of text.matchAll(BOUNDARY)) push(match.index! + match[0].length);
  push(text.length);
  return spans;
}

/**
 * Selection candidates for one message: every sentence, every adjacent pair,
 * and the whole message. Pairs are dropped first when the Choice would exceed
 * its option limit; beyond that only the leading sentences are kept.
 */
export function candidateSpans(source: string, maxOptions = MAX_SPAN_OPTIONS): Span[] {
  const text = String(source ?? '');
  let sentences = sentenceSpans(text);
  if (sentences.length === 0) return [];
  const whole = (): Span | null => {
    if (sentences.length < 2) return null;
    const range = trimmed(text, 0, text.length)!;
    return { id: 'all', kind: 'whole', ...range, text: text.slice(range.start, range.end) };
  };
  const pairs: Span[] = sentences.slice(1).map((next, i) => {
    const first = sentences[i]!;
    return { id: `p${i + 1}`, kind: 'pair', start: first.start, end: next.end, text: text.slice(first.start, next.end) };
  });
  const all = whole();
  const full = [...sentences, ...pairs, ...(all ? [all] : [])];
  if (full.length <= maxOptions) return full;
  const withoutPairs = [...sentences, ...(all ? [all] : [])];
  if (withoutPairs.length <= maxOptions) return withoutPairs;
  sentences = sentences.slice(0, maxOptions - 1);
  return [...sentences, ...(all ? [all] : [])];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/**
 * What a reader of the chat sees by default: collapsed <details> blocks (often
 * private trackers and inner thoughts), comments, scripts and styles are
 * removed; block breaks become line breaks; remaining markup is stripped.
 */
export function visibleText(html: string): string {
  let text = String(html ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  // Remove innermost <details> first so nested blocks disappear whole.
  for (let guard = 0; guard < 50 && /<details\b/i.test(text); guard++) {
    const next = text.replace(/<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/gi, ' ');
    if (next === text) break;
    text = next;
  }
  text = text.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n').replace(/<[^>]+>/g, ' ');
  text = text.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, key: string) => ENTITIES[key] ?? '');
  return text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}
