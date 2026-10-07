/**
 * Item 15: outcomes are shown as plain labels (the badge pill and the badge
 * popup replace "_" with " "). The W8 "NPC results" popup (host.ts:1059) still
 * prints the raw id, e.g. "at_a_price · 34% · rolled 52".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../../src/host.ts';

class FakeElement {
  className = ''; textContent = ''; children: FakeElement[] = []; tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...nodes: FakeElement[]) { this.children.push(...nodes); }
  text(): string { return [this.textContent, ...this.children.map(child => child.text())].filter(Boolean).join('\n'); }
}

test('review3c: the NPC results popup shows the plain outcome label', async () => {
  const previous = (globalThis as any).document;
  (globalThis as any).document = { createElement: (tag: string) => new FakeElement(tag) };
  try {
    let shown: FakeElement | null = null;
    const host = new Host();
    (host as any).ctx = () => ({
      name1: 'Player', POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0 },
      callGenericPopup: async (content: FakeElement) => { shown = content; return 1; },
    });
    const permit = { actions: [{ actingActorId: 'guide-1', method: 'forces the gate', outcome: 'at_a_price', instruction: 'It opens, at a cost.',
      methodUsed: 'sample', policyBand: { sampleWeights: { at_a_price: 0.34 } }, draw: 0.52 }] };
    const choice = await host.reviewRolls(permit as any, { 'guide-1': 'Guide', player: 'Player' }, 'sample', new AbortController().signal);
    assert.equal(choice, 'keep');
    const text = (shown as FakeElement | null)?.text() ?? '';
    assert.match(text, /at a price · 34% · rolled 52/);
    assert.doesNotMatch(text, /at_a_price/);
  } finally { (globalThis as any).document = previous; }
});
