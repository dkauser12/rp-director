/** Repro: delete a Director Next reply and press Next again at the same cursor: a new judge run and a new draw. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');

test('B2: redoing a deleted Next turn at the same cursor reuses its ruling', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  controller.profile.resolutionMethod = 'sample';
  let n = 0;
  host.context.generate = async () => {
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
    const text = `Next reply ${++n}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  // A Next turn whose judge rules the guide's own move (script: owner guide).
  const script = { move: choice('NONE'), move_count: choice('one') };
  scriptJudge(controller, script);
  await controller.directorNext();
  const first = Object.values(controller.record.attempts).at(-1) as any;
  host.chat().pop(); await host.emit('MESSAGE_DELETED');
  const requests = scriptJudge(controller, script);
  await controller.directorNext();
  const second = Object.values(controller.record.attempts).at(-1) as any;
  console.log('same cursor:', first.cursorBefore === second.cursorBefore, '| judge requests on redo:', requests.length, '| same attempt data reused:', second.resolutionId === first.resolutionId && JSON.stringify(second.reaction) === JSON.stringify(first.reaction));
  assert.equal(requests.length, 0, 'BUG: the Next turn at an already-judged cursor was judged again');
});
