import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { choice, harness, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const answer = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.5) };

async function initial(failed = false) {
  const h = await harness();
  h.controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  h.controller.settings.reactions.enabled = false;
  h.controller.profile.resolutionMethod = 'sample';
  await h.controller.setChatPack('default');
  const answers = { ...answer };
  if (failed) delete (answers as Partial<typeof answers>).ruling;
  scriptJudge(h.controller, answers);
  writerReplies(h.host, h.controller, 'Guide', 'guide.png', 'The guide waits.');
  h.host.composerValue = 'Open the gate for me.';
  await h.controller.directorSend();
  return h;
}

test('3b/23: changing the selected swipe while completion is queued cannot put the new draw on the old swipe', async () => {
  const { controller, host } = await initial();
  const message = host.chat().at(-1)!;
  const originalExtra = structuredClone(message.extra);
  const originalText = message.mes;
  host.swipeRight = async () => {
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
    message.mes = 'The guide opens the gate.';
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: structuredClone(message.extra) });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    message.swipe_id = 0;
    message.mes = originalText;
    message.extra = structuredClone(originalExtra);
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  };
  assert.equal(await controller.reroll(true), true);
  await (controller as unknown as { waitForMessageTasks(): Promise<void> }).waitForMessageTasks();
  assert.deepEqual(message.extra?.rpd, originalExtra?.rpd);
  assert.deepEqual(message.swipe_info![0]!.extra?.rpd, originalExtra?.rpd);
});

test('3b/28: a phase-1 unavailable attempt without failed-stage metadata can retry the judge', async () => {
  const { controller, host } = await initial(true);
  const source = Object.values(controller.record!.attempts).at(-1)!;
  assert.ok(source.judgeErrors?.length);
  assert.equal(source.resolutionId, null);
  delete source.judgeFailedStages;
  const requests = scriptJudge(controller, answer);
  host.swipeRight = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
    message.mes = 'The guide considers the offer.';
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  assert.equal(await controller.retryJudge(), true);
  assert.ok(requests.some(request => 'ruling' in request.questions));
  assert.ok(Object.values(controller.record!.attempts).at(-1)!.resolutionId);
});

test('3b/10: rolling archived dice keeps Reassess unavailable after reload', async t => {
  const { controller, host } = await initial();
  t.after(() => controller.destroy());
  const source = Object.values(controller.record!.attempts).at(-1)!;
  source.replayTrimmed = true;
  const resolution = controller.record!.resolutions[source.resolutionId!]!;
  resolution.replayTrimmed = true;
  resolution.snapshot.state = null;
  const requests = scriptJudge(controller, answer);
  host.swipeRight = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('dice remain available'), 'swipe');
    message.mes = 'The guide gives a different answer.';
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  assert.equal(await controller.reroll(), true);
  await (controller as unknown as { waitForMessageTasks(): Promise<void> }).waitForMessageTasks();
  await controller.loadChat();
  assert.equal(await controller.reassess(), false);
  assert.equal(requests.length, 0, 'trimmed evidence must never be silently recreated');
  assert.ok(host.notices.some(text => text.includes('too old to reassess')));
});
