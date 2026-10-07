/** Regenerate paths (items 3, 17, 20; W3): menu click, Ctrl+Enter (jQuery trigger), /regen. */
import { test } from 'node:test';
import { sim2, attempts, lastMarker, assert } from './support/phase3b-workflow.ts';

const RULING = /\[Director ruling — binding for this reply\]/;

test('W3: Ctrl+Enter (native regenerate) of a ruled reply asks AFTER ST deleted it; Cancel loses the reply and all its swipes', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  await sim.swipeRight(); // a second wording swipe exists
  await sim.settle();
  const before = structuredClone(sim.host.chat().at(-1));
  assert.equal(before.swipes.length, 2);
  sim.controller.settings.askWhenSwiping = true;
  let asked = 0;
  sim.host.swipeResult = async () => { asked += 1; return 'cancel'; };
  await sim.ctrlEnter();
  console.log('asked', asked, 'log tail:', sim.log.slice(-4).join(' | '));
  console.log('chat tail:', sim.host.chat().slice(-2).map((m: any) => `${m.is_user ? 'USER' : 'AI'}: ${m.mes.slice(0, 30)}`));
  assert.equal(asked, 1, 'the W3 question was asked');
  assert.equal(sim.host.chat().at(-1)!.is_user, false, 'Cancel must leave the reply (and its swipes) in place');
});

test('menu Regenerate when the chat ends with the user message (failed writer): intercepted, swipes the user message, nothing is generated', async () => {
  const sim = await sim2();
  sim.writer.push({ fail: 'HTTP 502 from the writer API' });
  await sim.clickSend('I nod. "Open the gate, please."');
  assert.equal(sim.host.chat().at(-1)!.is_user, true, 'setup: the failed writer left the user message last');
  const generations = sim.host.generated.length;
  await sim.menuRegenerate();
  console.log('log tail:', sim.log.slice(-3).join(' | '), '| generated since:', sim.host.generated.slice(generations));
  assert.ok(sim.host.generated.length > generations, 'Regenerate must generate a reply for the user message (native ST does)');
});

test('/regen when the chat ends with the user message: intercepted, nothing is generated', async () => {
  const sim = await sim2();
  sim.writer.push({ fail: 'HTTP 502 from the writer API' });
  await sim.clickSend('I nod. "Open the gate, please."');
  const generations = sim.host.generated.length;
  await sim.slashRegen({ await: 'true' });
  console.log('log tail:', sim.log.slice(-3).join(' | '), '| generated since:', sim.host.generated.slice(generations));
  assert.ok(sim.host.generated.length > generations, '/regen must generate a reply for the user message');
});

test('control: Ctrl+Enter (native) after the failed writer regenerates and reuses the frozen ruling', async () => {
  const sim = await sim2();
  sim.writer.push({ fail: 'HTTP 502 from the writer API' });
  await sim.clickSend('I nod. "Open the gate, please."');
  await sim.ctrlEnter();
  const last = sim.envelopes.at(-1) as any;
  console.log(attempts(sim), last.type, RULING.test(last.injection));
  assert.equal(last.type, 'regenerate');
  assert.match(last.injection, RULING);
  assert.ok(lastMarker(sim));
});
