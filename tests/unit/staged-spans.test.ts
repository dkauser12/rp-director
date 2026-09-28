import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateSpans, sentenceSpans, visibleText } from '../../src/pipeline/spans.ts';

function assertVerbatim(source: string, spans: { start: number; end: number; text: string }[]): void {
  for (const span of spans) assert.equal(source.slice(span.start, span.end), span.text, `span ${JSON.stringify(span.text)} keeps its exact offsets`);
}

test('sentences are verbatim slices with exact offsets', () => {
  const text = 'While she brushes her teeth, I get up.  I then jump into her bed.';
  const spans = sentenceSpans(text);
  assert.deepEqual(spans.map(s => s.text), ['While she brushes her teeth, I get up.', 'I then jump into her bed.']);
  assertVerbatim(text, spans);
});

test('closing quotes stay with their sentence and questions end sentences', () => {
  const text = '"Oh yeah? And what happens if I don\'t feel like moving?" I ask, keeping my eyes closed.';
  const spans = sentenceSpans(text);
  assert.deepEqual(spans.map(s => s.text), ['"Oh yeah?', 'And what happens if I don\'t feel like moving?"', 'I ask, keeping my eyes closed.']);
  assertVerbatim(text, spans);
});

test('line breaks separate passages', () => {
  const text = 'I open the door\n\n"Anyone home?"';
  assert.deepEqual(sentenceSpans(text).map(s => s.text), ['I open the door', '"Anyone home?"']);
});

test('candidates are sentences, adjacent pairs and the whole message, all verbatim', () => {
  const text = 'I sit. I wait. "Go ahead, make me."';
  const spans = candidateSpans(text);
  assert.deepEqual(spans.map(s => s.id), ['s1', 's2', 's3', 'p1', 'p2', 'all']);
  assert.equal(spans.find(s => s.id === 'p2')!.text, 'I wait. "Go ahead, make me."');
  assert.equal(spans.find(s => s.id === 'all')!.text, text);
  assertVerbatim(text, spans);
});

test('a one-sentence message is a single candidate', () => {
  assert.deepEqual(candidateSpans('I push her foot away.').map(s => s.id), ['s1']);
});

test('very long messages stay within one Choice (253 options plus ROUTINE and NONE)', () => {
  const text = Array.from({ length: 300 }, (_, i) => `Sentence ${i + 1}.`).join(' ');
  const spans = candidateSpans(text);
  assert.ok(spans.length <= 253, String(spans.length));
  assert.equal(spans[0]!.text, 'Sentence 1.');
  assert.ok(spans.every(s => s.kind === 'sentence' || s.kind === 'whole'), 'pairs are dropped first');
  assertVerbatim(text, spans);
});

test('visible text drops collapsed details, comments and markup but keeps the prose', () => {
  const html = '<p>She laughs.</p><details><summary>Thoughts</summary>Internal: the secret plan.</details><!-- hidden --> "Your move, cousin." &amp; done';
  const visible = visibleText(html);
  assert.ok(!visible.includes('secret'), visible);
  assert.ok(!visible.includes('<'), visible);
  assert.match(visible, /She laughs\./);
  assert.match(visible, /"Your move, cousin\." & done/);
});

test('nested details are removed whole', () => {
  const html = 'Before. <details><summary>A</summary>outer <details><summary>B</summary>inner</details> tail</details> After.';
  assert.equal(visibleText(html), 'Before. After.');
});
