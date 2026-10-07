/**
 * Item 10 for Send. When the sent message recreates an exchange that already
 * has a frozen decision (directorTurn, controller.ts:717-729: e.g. the reply
 * and the message were deleted and the same text is sent again), no pending
 * attempt is prepared and GENERATION_STARTED('normal') clears the preview
 * (controller.ts:1969). Card fields then read the Director as inactive, while
 * the interceptor reuses the frozen ruling for the prompt.
 */
import test from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

const KEYS = ['active', 'outcome', 'odds', 'roll'];
const snapshot = (controller: any) => Object.fromEntries(KEYS.map(key => [key, controller.getMacro(key)]));

test('review3c: re-sending a deleted exchange publishes its frozen readers before card substitution', async t => {
  const sim = await sim2();
  t.after(() => sim.controller.destroy());
  const text = 'I nod. "Open the gate, please."';
  await sim.clickSend(text);
  const chat = sim.host.chat();
  chat.length -= 2;                                   // delete the reply and the message
  await sim.host.emit('MESSAGE_DELETED', chat.length);
  await sim.settle();

  const cardTime: Record<string, string>[] = [];
  const presetTime: Record<string, string>[] = [];
  const intercept = sim.controller.interceptor.bind(sim.controller);
  sim.controller.interceptor = async (...args: any[]) => {
    cardTime.push(snapshot(sim.controller));
    await intercept(...args);
    presetTime.push(snapshot(sim.controller));
  };
  await sim.clickSend(text);
  assert.equal(presetTime.length, 1, 'sanity: one generation');
  assert.equal(presetTime[0]!.active, 'true', 'sanity: the frozen ruling is reused for the prompt');
  assert.deepEqual(cardTime[0], presetTime[0], 'card-field readers must match the prompt on Send');
});
