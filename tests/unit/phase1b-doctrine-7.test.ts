import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { choice, harness, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

test('T16: controller wording swipes share the original judged snapshots', async () => {
  const { host, controller } = await harness() as any;
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
  scriptJudge(controller, { move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice('friendly'), meter_1_nerve: choice('steady') });
  for (const text of ['A.', 'B.', 'C.']) { host.composerValue = text; await controller.directorSend(); }
  const afterTurns = Object.keys(controller.record.story.history).length;
  const message = host.chat().at(-1);
  for (let i = 0; i < 3; i++) {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    message.mes = `Swipe ${i}.`; message.swipes.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe'); await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(afterTurns, 3);
  assert.equal(Object.keys(controller.record.story.history).length, 3);
  assert.equal(Object.keys(controller.record.story.historyAliases ?? {}).length, 3);
});
