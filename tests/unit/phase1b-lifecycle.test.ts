import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import type { Host } from '../../src/host.ts';
import { actorIdFor } from '../../src/identity.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');
const answers = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function ready() {
  const host = new TestHost();
  const controller = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  host.composerValue = 'Open the gate for me.';
  return { host, controller };
}

function holdJudge(controller: Controller) {
  scriptJudge(controller, answers);
  const provider = controller.provider();
  const started = deferred(); const release = deferred();
  let signal: AbortSignal | undefined;
  controller.provider = () => ({ ...provider, evaluate: async (request, requestSignal) => {
    signal = requestSignal;
    started.resolve();
    await release.promise;
    return provider.evaluate(request, requestSignal);
  } });
  return { started: started.promise, release: release.resolve, signal: () => signal };
}

test('review 12: native Send passes through without a Director record or a stable chat key', async t => {
  const host = new TestHost(); let shouldIntercept = () => false;
  (host as Host).interceptNativeSend = predicate => { shouldIntercept = predicate; return () => {}; };
  const controller = new Controller(host); t.after(() => controller.destroy());
  await controller.init();
  assert.equal(shouldIntercept(), true);
  const record = controller.record;
  controller.record = null; assert.equal(shouldIntercept(), false, 'welcome or temporary chat must keep its native Send');
  controller.record = record;
  host.currentChatId = ''; assert.equal(shouldIntercept(), false, 'a stale record cannot claim a chat without an identity');
});

for (const mutation of ['edit', 'delete', 'browse'] as const) {
  test(`review 13: a pending Send keeps its composer locked and survives a prior-reply ${mutation}`, async t => {
    const { host, controller } = await ready(); t.after(() => controller.destroy());
    const textarea = { readOnly: false, value: host.composerValue } as HTMLTextAreaElement;
    host.composer = () => textarea;
    const gate = holdJudge(controller); t.after(gate.release);
    writerReplies(host, controller, 'Guide', 'guide.png', 'The guide answers.');
    const pending = controller.directorSend();
    await gate.started;
    assert.equal(textarea.readOnly, true, 'text is protected throughout the judge wait');
    const submitted = host.composerValue;
    if (mutation === 'edit') { host.chat()[1]!.mes = 'The guide waits beside the gate.'; await host.emit('MESSAGE_EDITED', 1); }
    if (mutation === 'delete') { host.chat().splice(1, 1); await host.emit('MESSAGE_DELETED', 1); }
    if (mutation === 'browse') {
      host.chat()[1]!.swipes!.push('An earlier wording.'); host.chat()[1]!.swipe_id = 1;
      host.chat()[1]!.mes = 'An earlier wording.'; await host.emit('MESSAGE_SWIPED', 1);
    }
    assert.equal(gate.signal()?.aborted, false, 'an unrelated historical message cannot discard this Send');
    gate.release(); await pending;
    assert.equal(textarea.readOnly, false, 'the composer lock is always released');
    assert.equal(host.generated.length, 1);
    assert.equal(host.chat().at(-2)?.mes, submitted);
    assert.equal(Object.values(controller.record!.attempts).at(-1)?.status, 'accepted');
  });
}

test('review 13: editing the user message currently being judged cancels that retry', async t => {
  const { host, controller } = await ready(); t.after(() => controller.destroy());
  host.composerValue = 'Unsent draft.';
  const gate = holdJudge(controller); t.after(gate.release);
  host.chat()[1]!.swipe_id = host.chat()[1]!.swipes!.length;
  const pending = host.emit('MESSAGE_SWIPED', 1);
  await gate.started;
  host.chat()[0]!.mes = 'A different request replaces the old one.';
  await host.emit('MESSAGE_EDITED', 0);
  assert.equal(gate.signal()?.aborted, true, 'a decision for changed user text must never bind');
  gate.release(); await pending;
  assert.equal(host.generated.length, 0);
  assert.equal(controller.record!.pending, null);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  assert.equal(host.composerValue, 'Unsent draft.');
});

test('review 24: a generation starting during metadata persistence prevents a duplicate writer dispatch', async t => {
  const { host, controller } = await ready(); t.after(() => controller.destroy());
  scriptJudge(controller, answers);
  const save = host.writeRecord.bind(host); let generating = false; let raced = false;
  host.isGenerating = () => generating;
  host.writeRecord = async (record, key) => {
    const written = await save(record, key);
    if (controller.status === 'Frozen' && !raced) { raced = true; generating = true; }
    return written;
  };
  await controller.directorSend();
  assert.equal(raced, true);
  assert.equal(host.generated.length, 0, 'the host has already begun generation');
  assert.equal(controller.record!.pending, null);
  assert.notEqual(controller.status, 'Frozen');
  assert.notEqual(controller.status, 'Writing');
});

test('review 24: settings changing during a decision still yields a tracked reply with an unavailable badge', async t => {
  const { host, controller } = await ready(); t.after(() => controller.destroy());
  const gate = holdJudge(controller); t.after(gate.release);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide answers.');
  const pending = controller.directorSend(); await gate.started;
  controller.settings.reactions.enabled = true;
  gate.release(); await pending;
  assert.equal(host.generated.length, 1);
  const attempt = Object.values(controller.record!.attempts).at(-1)!;
  assert.ok(attempt); assert.equal(attempt.status, 'accepted');
  assert.equal(attempt.resolutionId, null);
  const badge = host.readWorkflowBadge(host.chat().length - 1);
  assert.ok(badge); assert.equal(badge.attemptId, attempt.attemptId); assert.equal(badge.unavailable, true);
  assert.equal(badge.retryEligible, true);
});

for (const reset of ['recovery', 'new chat'] as const) test(`review 24: judge-error toasts deduplicate until ${reset}`, async t => {
  const { host, controller } = await ready(); t.after(() => controller.destroy());
  scriptJudge(controller, { move: choice('NONE'), move_count: choice('one') });
  const provider = controller.provider(); let failing = true;
  controller.provider = () => ({ ...provider, evaluate: async (request, signal) => {
    if (failing) throw new Error('network disconnected');
    return provider.evaluate(request, signal);
  } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide answers.');
  const notices = () => host.notices.filter(message => message.includes('Judge unavailable'));
  const send = async () => { host.composerValue = 'Wait beside the gate.'; await controller.directorSend(); };
  await send(); await send();
  assert.equal(notices().length, 1, 'repeated failures of the same type produce one toast');
  if (reset === 'recovery') {
    failing = false; await send();
    assert.equal(host.readWorkflowBadge(host.chat().length - 1)?.unavailable, false);
    failing = true;
  } else {
    host.currentChatId = 'second-chat'; host.context.chatMetadata = {};
    await host.emit('CHAT_CHANGED'); await controller.loadChat(); await controller.setChatPack('default');
  }
  await send();
  assert.equal(notices().length, 2, `${reset} makes a later failure visible`);
});

for (const order of ['received-first', 'ended-first'] as const) test(`review 15: delayed Generate completion preserves a received reply (${order})`, async t => {
  const { host, controller } = await ready(); t.after(() => controller.destroy());
  scriptJudge(controller, answers);
  host.context.generate = async (_type, options) => {
    host.generated.push(options ?? {});
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('writer unexpectedly aborted'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide answers.', swipe_id: 0, swipes: ['The guide answers.'], swipe_info: [{ extra: {} }] });
    if (order === 'ended-first') await host.emit('GENERATION_ENDED');
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
    if (order === 'received-first') await host.emit('GENERATION_ENDED');
    // Native completion events may precede Generate's own asynchronous cleanup.
    await new Promise(resolve => setTimeout(resolve, 30));
  };
  await controller.directorSend();
  const reply = host.chat().length - 1;
  const marker = host.readMarker(reply); const badge = host.readWorkflowBadge(reply);
  assert.ok(marker, 'the delayed writer promise cannot cancel a received reply');
  assert.ok(badge, 'completion metadata is written after the writer settles');
  assert.equal(marker.a, badge.attemptId);
  assert.equal(controller.record!.attempts[marker.a]?.status, 'accepted');
});
