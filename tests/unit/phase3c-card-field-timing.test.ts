/**
 * C3 timing. SillyTavern's Generate() resolves the character card fields
 * (description, personality, scenario, persona, Character's Note / depth prompt,
 * post-history override) in getCharacterCardFields() at script.js:4470, BEFORE
 * runGenerationInterceptors at script.js:4564. Preset entries and World Info are
 * resolved after it. So a reader's "card time" value is the macro state on entry
 * to the interceptor, and its "preset time" value is the state on exit.
 * Correct behaviour: one generation, one value, wherever SillyTavern evaluates it,
 * and a wording swipe sees the same values as the original Send.
 */
import test from 'node:test';
import { sim2, GUIDE, turnScript, permissiveJudge, assert } from './support/phase3b-workflow.ts';
import { choice } from './support/test-host.ts';

const KEYS = ['active', 'outcome', 'odds', 'roll', 'scene'];
const snapshot = (controller: any) => Object.fromEntries(KEYS.map(key => [key, controller.getMacro(key)]));

async function setup() {
  const sim = await sim2({ configure: s => {
    s.controller.settings.modules = { speaker: true, decisions: true, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  } });
  permissiveJudge(sim.controller, { ...turnScript(GUIDE), scene: choice('conversation'), hand_back: choice('CONTINUE') });
  const cardTime: Record<string, string>[] = [];
  const presetTime: Record<string, string>[] = [];
  const original = sim.controller.interceptor.bind(sim.controller);
  sim.controller.interceptor = async (...args: unknown[]) => {
    cardTime.push(snapshot(sim.controller));
    await (original as any)(...args);
    presetTime.push(snapshot(sim.controller));
  };
  return { sim, cardTime, presetTime };
}

test('C3: a reader in a card field (e.g. the Character\'s Note at depth 0) sees the same frozen values on a wording swipe as on Send', async () => {
  const { sim, cardTime, presetTime } = await setup();
  await sim.clickSend('I nod. "Open the gate, please."');
  assert.equal(presetTime[0]!.active, 'true', 'sanity: Send is ruled');
  assert.notEqual(presetTime[0]!.roll, '', 'sanity: Send has a roll');
  assert.deepEqual(cardTime[0], presetTime[0], 'Send: card-time and preset-time agree (pending attempt is visible before the interceptor)');
  await sim.swipeRight(); await sim.settle();
  assert.deepEqual(presetTime[1], presetTime[0], 'sanity: preset-time readers are frozen on the wording swipe');
  assert.deepEqual(cardTime[1], cardTime[0], 'wording swipe: card-time readers must equal the original Send (frozen)');
});

test('C3: after Roll again, a card-field reader sees the new draw, like preset readers do', async () => {
  const { sim, cardTime, presetTime } = await setup();
  await sim.clickSend('I nod. "Open the gate, please."');
  assert.equal(await sim.controller.reroll(true), true);
  await sim.settle();
  const last = presetTime.length - 1;
  assert.equal(presetTime[last]!.active, 'true');
  assert.deepEqual(cardTime[last], presetTime[last], 'Roll again: card-time readers must show the same (new) values as preset-time readers');
});

for (const type of ['continue', 'regenerate']) for (const choice of ['reuse', 'reroll'] as const) {
  if (type === 'continue' && choice === 'reroll') continue;
  test(`C3: ${type} (${choice}) publishes before card substitution and clears after completion`, async t => {
    const { sim, cardTime, presetTime } = await setup();
    t.after(() => sim.controller.destroy());
    let draw = 0;
    t.mock.method(globalThis.crypto, 'getRandomValues', <T extends ArrayBufferView | null>(buffer: T): T => {
      (buffer as unknown as Uint32Array)[0] = draw;
      return buffer;
    });
    await sim.clickSend('I nod. "Open the gate, please."');
    sim.controller.settings.askWhenSwiping = true;
    let prompts = 0;
    sim.host.swipeResult = async () => { prompts++; return choice; };
    draw = 3865470566;
    await sim.generate(type); await sim.settle();
    assert.deepEqual(cardTime[1], presetTime[1]);
    assert.equal(cardTime[1]!.roll, choice === 'reroll' ? '90/100' : '0/100');
    assert.equal(prompts, type === 'continue' ? 0 : 1);
    assert.equal(sim.controller.getMacro('active'), '');
  });
}

test('C3: automatic rewrite publishes its frozen readers before even starting the swipe', async t => {
  const { rc, score } = await import('./support/phase3c-replycheck.ts');
  let checks = 0;
  const h = await rc({ answers: request => 'speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 1 ? 4 : 0) } : {} });
  t.after(() => h.controller.destroy());
  const swipe = h.host.swipeRight.bind(h.host);
  let before: Record<string, string> | null = null;
  let during: Record<string, string> | null = null;
  h.host.swipeRight = async () => { before = snapshot(h.controller); await swipe(); };
  const intercept = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (...args: any[]) => { await intercept(...args); if (args[3] === 'swipe') during = snapshot(h.controller); };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  assert.ok(before);
  assert.notEqual((before as Record<string, string>).roll, '');
  assert.deepEqual(before, during);
});

test('C3: a reply-check-only correction activates guards before card substitution', async t => {
  const { rc, score } = await import('./support/phase3c-replycheck.ts');
  let checks = 0;
  const h = await rc({ answers: request => 'speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 1 ? 4 : 0) } : {} });
  t.after(() => h.controller.destroy());
  h.controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: false, replyCheck: true };
  const states: string[][] = [];
  const intercept = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (...args: any[]) => {
    if (args[3] === 'swipe') states.push([h.controller.getMacro('active'), h.controller.getMacro('module::replyCheck')]);
    await intercept(...args);
    if (args[3] === 'swipe') states.push([h.controller.getMacro('active'), h.controller.getMacro('module::replyCheck')]);
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  assert.deepEqual(states, [['true', 'true'], ['true', 'true']]);
});
