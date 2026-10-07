/**
 * Item 12: "fallback dice apply exactly when the judge could not rule".
 * decisionsApplied (controller.ts:1234) only counts a resolution, a kept permit
 * or a NONE/ROUTINE move answer. A judged hand-off (the player gives a
 * character the initiative: route HANDOFF, no dice by design) and an OOC-only
 * message (no move question is needed) are successful decisions too, but read
 * as module::decisions "" and would switch a preset's fallback dice on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, scriptJudge, choice } from './support/test-host.ts';
import { actorIdFor } from '../../src/identity.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');

async function sendAndRead(script: Record<string, any>, text: string) {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, script);
  let during: Record<string, string> = {};
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('unexpected abort'), 'normal');
    during = { decisions: controller.getMacro('module::decisions'), failed: String(controller.record!.attempts[(controller as any).currentAttemptId]?.judgeFailedStages ?? '') };
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide considers it.', swipe_id: 0, swipes: ['The guide considers it.'], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  host.composerValue = text;
  await controller.directorSend();
  controller.destroy();
  return during;
}

test('review3c: a judged hand-off keeps module::decisions true (the judge ruled: no dice)', async () => {
  const during = await sendAndRead({
    move: choice('s2'), move_count: choice('one'),
    owner: choice(GUIDE), target: choice('UNRESOLVED'), family: choice('influence_negotiate'),
    action_specification: choice('UNSPECIFIED_INITIATIVE'), antecedent: choice('NONE'),
  }, 'I nod. "Guide, your call."');
  assert.equal(during.failed, '', 'sanity: no judge stage failed');
  assert.equal(during.decisions, 'true');
});

test('review3c: an OOC-only message keeps module::decisions true (nothing to rule, nothing failed)', async () => {
  const during = await sendAndRead({}, '(OOC: short break, back in a minute.)');
  assert.equal(during.failed, '', 'sanity: no judge stage failed');
  assert.equal(during.decisions, 'true');
});
