import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, defaultSettings } from '../../src/host.ts';
import type { StContext } from '../../src/host.ts';
import type { TurnPermit } from '../../src/types.ts';

class ElementStub {
  children: (ElementStub | string)[] = [];
  textContent = '';
  className = '';
  checked = false;
  type = '';
  append(...children: (ElementStub | string)[]) { this.children.push(...children); }
  text(): string { return [this.textContent, ...this.children.map(child => typeof child === 'string' ? child : child.text())].join(' '); }
}

function dom() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => new ElementStub(), createTextNode: (text: string) => text,
  } });
  return () => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); };
}

class ReviewHost extends Host {
  popupText = '';
  popupOptions: Record<string, unknown> = {};
  override ctx(): StContext {
    return { name1: 'Example player', POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0 },
      callGenericPopup: async (content: ElementStub, _type: number, _input: string, options: Record<string, unknown>) => {
        this.popupText = content.text(); this.popupOptions = options; return 1;
      },
    } as unknown as StContext;
  }
}

test('phase 2: a swipe without dice does not suggest an unavailable Roll again action', async () => {
  const close = dom();
  try {
    const host = new ReviewHost();
    assert.equal(await host.chooseSwipeAction('ruled', false, undefined, defaultSettings()), 'reuse');
    assert.match(host.popupText, /Keep the result while the writer gives it new wording/);
    assert.doesNotMatch(host.popupText, /roll again/i);
    assert.deepEqual(host.popupOptions.customButtons, []);
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, defaultSettings()), 'reuse');
    assert.match(host.popupText, /roll again before the new reply/);
  } finally { close(); }
});

test('phase 2: NPC result review uses {{user}} without changing saved moves or writer instructions', async () => {
  const close = dom();
  try {
    const host = new ReviewHost();
    const permit = { actions: [{ actingActorId: 'guide', method: 'The guide asks Example player for the map.',
      outcome: 'success', methodUsed: 'sample', policyBand: { sampleWeights: { success: 0.35 } }, draw: 0.52,
      instruction: 'Example player receives the map, without deciding Example player’s response.',
    }] } as unknown as TurnPermit;
    const original = structuredClone(permit);
    assert.equal(await host.reviewRolls(permit, { guide: 'Guide', player: 'Example player' }, 'sample', new AbortController().signal), 'keep');
    assert.match(host.popupText, /asks \{\{user\}\} for the map/);
    assert.match(host.popupText, /\{\{user\}\} receives the map/);
    assert.doesNotMatch(host.popupText, /Example player/);
    assert.match(host.popupText, /35%.*rolled 52/);
    assert.deepEqual(permit, original);
  } finally { close(); }
});
