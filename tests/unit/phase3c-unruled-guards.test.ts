/** Guards reflect successful output delivered to this generation, including partial fail-open. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, choice } from './support/test-host.ts';

for (const pacing of [true, false]) test(`C3: failed decisions allow fallback dice while pacing=${pacing} reflects delivered output`, async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  // Only pacing is answered; the move stage gets no valid answer -> the judge failed.
  scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('CONTINUE') });
  let during: Record<string, string> | null = null;
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    during = Object.fromEntries(['active', 'module::decisions', 'outcome', 'scene'].map(key => [key, controller.getMacro(key)]));
    const text = 'The guide shrugs.';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.composerValue = 'I nod. "Open the gate, please."';
  await controller.directorSend();
  const attempt = Object.values(controller.record!.attempts).at(-1)!;
  assert.ok(attempt.judgeFailedStages?.includes('move'), 'sanity: the move stage failed (unruled turn)');
  assert.equal(during!.outcome, '', 'sanity');
  assert.deepEqual({ active: during!.active, decisions: during!['module::decisions'] }, { active: pacing ? 'true' : '', decisions: '' });
  assert.equal(during!.scene, pacing ? 'conversation' : '');
});

test('C3: a judged no-move remains an active decisions output on Send and wording swipe', async t => {
  const { host, controller } = await harness();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  const requests = scriptJudge(controller, { move: choice('NONE'), move_count: choice('one') });
  let during = '';
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    during = controller.getMacro('module::decisions');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide nods.', swipe_id: 0, swipes: ['The guide nods.'] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.composerValue = 'I greet the guide.';
  await controller.directorSend();
  assert.equal(during, 'true');
  const calls = requests.length;
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(controller.getMacro('active'), 'true');
  assert.equal(controller.getMacro('module::decisions'), 'true');
  assert.equal(controller.getMacro('outcome'), '');
  assert.equal(requests.length, calls);
});
