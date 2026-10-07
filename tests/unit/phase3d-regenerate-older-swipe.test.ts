/**
 * Item 10 for Regenerate. Ctrl+Enter (RossAscends-mods.js: $('#option_regenerate')
 * .trigger('click')) bypasses the Director's capture listener, so SillyTavern
 * runs Generate('regenerate'). onGenerationStarted (controller.ts:1961) picks
 * the preview source by the SELECTED swipe's marker; SillyTavern then deletes
 * the reply (script.js:4407-4412) before getCharacterCardFields, and the
 * interceptor (controller.ts:1795) can only look the exchange up by cursor,
 * which returns the newest attempt with the ACTIVE (latest) resolution.
 * After Roll again and a swipe back to the first result, card-field readers
 * show the first draw while the writer is bound to the second.
 */
import test from 'node:test';
import { rc, assert } from './support/phase3c-replycheck.ts';

const KEYS = ['active', 'outcome', 'odds', 'roll'];
const snapshot = (controller: any) => Object.fromEntries(KEYS.map(key => [key, controller.getMacro(key)]));

test('review3c: Regenerate of an older-ruling swipe: card-field readers equal interceptor readers', async t => {
  let draw = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', <T extends ArrayBufferView | null>(buffer: T): T => {
    (buffer as unknown as Uint32Array)[0] = draw;
    return buffer;
  });
  const h = await rc({ askWhenSwiping: false });
  t.after(() => h.controller.destroy());
  h.controller.settings.modules.replyCheck = false;
  await h.sim.clickSend('I nod. "Open the gate, please."');          // swipe 0: first draw (0/100)
  draw = 3865470566;
  assert.equal(await h.controller.reroll(true), true);               // swipe 1: Roll again (90/100)
  await h.sim.settle();
  await h.sim.swipeLeft(); await h.sim.settle();                     // back to swipe 0
  assert.equal(h.last().swipe_id, 0, 'sanity: the first result is selected');

  const cardTime: Record<string, string>[] = [];
  const presetTime: Record<string, string>[] = [];
  const intercept = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (...args: any[]) => {
    if (args[3] === 'regenerate') cardTime.push(snapshot(h.controller));
    await intercept(...args);
    if (args[3] === 'regenerate') presetTime.push(snapshot(h.controller));
  };
  h.controller.settings.askWhenSwiping = true;
  h.host.swipeResult = async () => 'reuse';                          // "Keep the result"
  await h.sim.ctrlEnter();
  assert.equal(presetTime.length, 1, 'sanity: one regenerate reached the interceptor');
  assert.equal(presetTime[0]!.active, 'true', 'sanity: the regenerate is ruled');
  assert.deepEqual(cardTime[0], presetTime[0], 'one generation, one value: card fields and preset entries must agree');
});
