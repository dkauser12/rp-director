/** Repro: editing the FIRST user message wipes every later snapshot from the head; the next turn is a free first judgement (any level). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { choice, harness, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

test('E3: editing an early user message keeps the judged meters bounded', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  let n = 0;
  host.context.generate = async () => {
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    const text = `Reply ${++n}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  scriptJudge(controller, answers('guarded')); host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('friendly')); host.composerValue = 'I sit down.'; await controller.directorSend();
  console.log('head before edit:', controller.characterStateForUi()[0]?.meters[0]?.level);
  host.chat()[0].mes = 'We reach the gate at dusk.';            // typo-level edit of the very first user message
  await host.emit('MESSAGE_EDITED', 0);
  console.log('head after edit:', JSON.stringify(controller.characterStateForUi()));
  const requests = scriptJudge(controller, answers('smitten'));
  host.composerValue = 'I take her hand.'; await controller.directorSend();
  const q = requests.find((r: any) => 'meter_1_regard' in r.questions)!.questions.meter_1_regard;
  console.log('next turn allowed levels:', Object.keys(q.criteria), '| head now:', controller.characterStateForUi()[0]?.meters[0]?.level);
  assert.ok(!Object.keys(q.criteria).includes('smitten'), 'BUG: the edit reset the meters to unjudged; the next turn jumps friendly -> smitten');
});
