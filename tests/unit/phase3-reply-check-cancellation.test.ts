import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { actorIdFor } from '../../src/identity.ts';
import type { Answer, DirectorChatRecord, EvaluationRequest } from '../../src/types.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const score = (value: number): Answer => ({ type: 'score', score: value, legend: {}, probabilities: null, confidence: null, provenance: 'fixture' });
const answers = (writesForPlayer = 4) => ({ speaks_for_user: score(writesForPlayer), responds: score(2), repeats: score(0) });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Flush the completion timer, the check timer, and any persistence continuations. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'the expected asynchronous reply-check result must arrive');
}

async function ready(group = false) {
  const host = new TestHost({ group });
  let composerInput = () => {};
  host.onComposerInput = callback => { composerInput = callback; return () => { composerInput = () => {}; }; };
  const controller = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: false, replyCheck: true };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  writerReplies(host, controller, 'Guide', 'guide.png', 'Player nods and opens the gate.');
  const send = async (text = 'Show me the gate.') => { host.composerValue = text; await controller.directorSend(); };
  return { host, controller, send, type: (text: string) => { host.composerValue = text; composerInput(); } };
}

function holdCheck(controller: Controller) {
  const requests = scriptJudge(controller, answers());
  const provider = controller.provider();
  const started = deferred(), release = deferred(), returned = deferred();
  let signal: AbortSignal | undefined;
  controller.provider = () => ({ ...provider, evaluate: async (request, requestSignal) => {
    signal = requestSignal;
    started.resolve();
    // Deliberately ignore cancellation so a late provider result exercises the
    // controller's stale-result guard as well as its transport abort signal.
    await release.promise;
    try { return await provider.evaluate(request, requestSignal); }
    finally { returned.resolve(); }
  } });
  return { requests, started: started.promise, release: release.resolve, returned: returned.promise, signal: () => signal };
}

for (const action of ['typing', 'swipe', 'edit', 'chat', 'disabled', 'paused'] as const) {
  test(`C2: ${action} cancels a pending check and discards a late result`, async t => {
    const setup = await ready();
    const { host, controller, send } = setup;
    t.after(() => controller.destroy());
    const held = holdCheck(controller);
    t.after(held.release);
    let swipes = 0;
    host.swipeRight = async () => { swipes++; };
    await send();
    await held.started;
    const attempt = Object.values(controller.record!.attempts).at(-1)!;
    const messageId = host.chat().length - 1;
    if (action === 'typing') setup.type('An unfinished next reply.');
    if (action === 'swipe') {
      const message = host.chat()[messageId]!;
      message.swipes!.push('A saved alternative.');
      message.swipe_id = 1;
      message.mes = message.swipes![1]!;
      await host.emit('MESSAGE_SWIPED', messageId);
    }
    if (action === 'edit') {
      host.chat()[messageId]!.mes = 'The guide waits for Player to choose.';
      await host.emit('MESSAGE_EDITED', messageId);
    }
    if (action === 'chat') {
      host.currentChatId = 'another-chat';
      host.context.chatMetadata = {};
      host.context.chat = [];
      await host.emit('CHAT_CHANGED');
    }
    if (action === 'disabled') controller.setEnabled(false);
    if (action === 'paused') await controller.setPaused(true);
    assert.equal(held.signal()?.aborted, true, 'the active check receives cancellation');
    held.release();
    await held.returned;
    await settle();
    assert.equal(swipes, 0);
    assert.equal(attempt.replyCheck, undefined, 'the stale judgement cannot change the completed turn');
    assert.equal(held.requests.length, 1);
    assert.equal(host.notices.length, 0, 'normal cancellation does not report a judge failure');
  });
}

for (const action of ['typing', 'edit'] as const) {
  test(`C2: ${action} after automatic swipe dispatch aborts before a replacement binds`, async t => {
    const setup = await ready();
    const { host, controller, send } = setup;
    t.after(() => controller.destroy());
    scriptJudge(controller, answers());
    const entered = deferred(), release = deferred(), finished = deferred();
    t.after(release.resolve);
    let aborted = false;
    let attemptsBefore = 0;
    host.swipeRight = async () => {
      attemptsBefore = Object.keys(controller.record!.attempts).length;
      entered.resolve();
      await release.promise;
      try {
        const messageId = host.chat().length - 1;
        const message = host.chat()[messageId]!;
        message.swipe_id = message.swipes!.length;
        await host.emit('MESSAGE_SWIPED', messageId);
        await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => { aborted = true; }, 'swipe');
      } finally { finished.resolve(); }
    };
    await send();
    await entered.promise;
    if (action === 'typing') setup.type('I am answering now.');
    else {
      host.chat().at(-1)!.mes = 'The guide leaves the choice open.';
      await host.emit('MESSAGE_EDITED', host.chat().length - 1);
    }
    release.resolve();
    await finished.promise;
    await settle();
    assert.equal(aborted, true, 'native preparation must abort the cancelled automatic swipe');
    assert.equal(Object.keys(controller.record!.attempts).length, attemptsBefore, 'cancellation cannot bind an uncorrected replacement attempt');
  });
}

for (const guard of ['group', 'swipes disabled'] as const) {
  test(`C2: ${guard} records one check but never automatically rerolls`, async t => {
    const { host, controller, send } = await ready(guard === 'group');
    t.after(() => controller.destroy());
    if (guard === 'swipes disabled') host.swipesEnabled = () => false;
    const requests = scriptJudge(controller, answers());
    let swipes = 0;
    host.swipeRight = async () => { swipes++; };
    await send();
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(Object.values(controller.record!.attempts).at(-1)?.replyCheck?.reason, 'writes for {{user}}');
    assert.equal(swipes, 0);
  });
}

test('C2: Reply check off makes no check request', async t => {
  const { host, controller, send } = await ready();
  t.after(() => controller.destroy());
  controller.settings.modules.replyCheck = false;
  const requests = scriptJudge(controller, answers());
  await send();
  await settle();
  assert.equal(host.generated.length, 1);
  assert.equal(requests.length, 0);
});

test('C2: each completed Director reply gets one request and duplicate render events add none', async t => {
  const { host, controller, send } = await ready();
  t.after(() => controller.destroy());
  const requests: EvaluationRequest[] = scriptJudge(controller, answers(0));
  for (let turn = 1; turn <= 2; turn++) {
    await send(`Show me route ${turn}.`);
    await settle();
    assert.equal(requests.length, turn);
    const messageId = host.chat().length - 1;
    await host.emit('CHARACTER_MESSAGE_RENDERED', messageId);
    await host.emit('CHARACTER_MESSAGE_RENDERED', messageId);
    await host.emit('MESSAGE_RECEIVED', messageId, 'normal');
    await settle();
    assert.equal(requests.length, turn);
    assert.deepEqual(Object.keys(requests.at(-1)!.questions), ['speaks_for_user', 'responds', 'repeats']);
    assert.ok(Object.values(controller.record!.attempts).at(-1)?.replyCheck);
  }
});

test('C2: switching Reply check off discards an already requested result without rerolling', async t => {
  const { host, controller, send } = await ready();
  t.after(() => controller.destroy());
  const held = holdCheck(controller);
  t.after(held.release);
  let swipes = 0;
  host.swipeRight = async () => { swipes++; };
  await send();
  await held.started;
  controller.settings.modules.replyCheck = false;
  held.release();
  await held.returned;
  await settle();
  assert.equal(swipes, 0);
  assert.equal(held.requests.length, 1);
  assert.equal(Object.values(controller.record!.attempts).at(-1)?.replyCheck, undefined);
  assert.equal(host.notices.length, 0);
});

for (const failure of ['provider rejection', 'invalid answers', 'timeout'] as const) {
  test(`C2: ${failure} fails open and leaves the original reply intact`, async t => {
    const { host, controller, send } = await ready();
    t.after(() => controller.destroy());
    scriptJudge(controller, failure === 'invalid answers' ? { speaks_for_user: score(5), responds: score(5), repeats: score(5) } : answers());
    const provider = controller.provider();
    const release = deferred();
    t.after(release.resolve);
    let requestCount = 0;
    let signal: AbortSignal | undefined;
    controller.provider = () => ({ ...provider, evaluate: async (request, requestSignal) => {
      requestCount++;
      signal = requestSignal;
      if (failure === 'provider rejection') throw new Error('The provider refused this request.');
      if (failure === 'timeout') await release.promise;
      return provider.evaluate(request, requestSignal);
    } });
    if (failure === 'timeout') controller.settings.waitForJudgeSeconds = 0.01;
    let swipes = 0;
    host.swipeRight = async () => { swipes++; };
    await send();
    const text = host.chat().at(-1)!.mes;
    await until(() => host.notices.length > 0);
    if (failure === 'timeout') assert.equal(signal?.aborted, true);
    release.resolve();
    await settle();
    assert.equal(requestCount, 1);
    assert.equal(swipes, 0);
    assert.equal(host.chat().at(-1)!.mes, text);
    assert.equal(host.chat().at(-1)!.swipes!.length, 1);
    assert.equal(Object.values(controller.record!.attempts).at(-1)?.status, 'accepted');
    assert.equal(Object.values(controller.record!.attempts).at(-1)?.replyCheck, undefined);
    assert.equal(host.notices.length, 1);
    assert.match(host.notices[0]!, /Your chat isn't affected\.$/);
  });
}

test('C2: a new user message restores one automatic reroll allowance', async t => {
  const { host, controller, send } = await ready();
  t.after(() => controller.destroy());
  const requests = scriptJudge(controller, answers());
  let swipes = 0;
  host.context.swipe.right = async () => {
    swipes++;
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => assert.fail('unexpected abort'), 'swipe');
    message.mes = `The guide gives another answer ${swipes}.`;
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('GENERATION_ENDED');
  };
  for (let turn = 1; turn <= 2; turn++) {
    await send(`Show me route ${turn}.`);
    await until(() => Object.values(controller.record!.attempts).filter(attempt => attempt.replyCheck).length === turn * 2);
    await settle();
    assert.equal(swipes, turn, 'each new user turn allows exactly one replacement');
    assert.equal(requests.length, turn * 2, 'original and replacement are each checked once');
    assert.equal(controller.record!.replyCheckRerolls!.length, turn);
  }
});

test('C2: cancelling a bound automatic writer stops once even when Stop synchronously emits its event', async t => {
  const setup = await ready();
  const { host, controller, send } = setup;
  t.after(() => controller.destroy());
  controller.settings.modules.decisions = true;
  scriptJudge(controller, { ...answers(), follows_ruling: noul(1), move: choice('s1'), move_count: choice('one'),
    owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')), family: choice('influence_negotiate'),
    action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.6) });
  const bound = deferred(), release = deferred(), finished = deferred();
  t.after(release.resolve);
  let stops = 0;
  host.stopGeneration = () => { stops++; assert.equal(stops, 1, 'Stop must not recursively dispatch itself'); void host.emit('GENERATION_STOPPED'); };
  host.context.swipe.right = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => assert.fail('unexpected abort'), 'swipe');
    bound.resolve();
    await release.promise;
    finished.resolve();
  };
  await send('I ask the guide to open the gate.');
  await bound.promise;
  const resolutions = structuredClone(controller.record!.resolutions);
  assert.equal(Object.keys(resolutions).length, 1);
  const automatic = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(automatic.status, 'writing');
  assert.equal(automatic.rerolledByCheck, 'writes for {{user}}');
  setup.type('I am answering now.');
  await settle();
  assert.equal(stops, 1);
  assert.equal(controller.record!.attempts[automatic.attemptId]!.status, 'cancelled');
  assert.equal(host.injection, '');
  assert.deepEqual(controller.record!.resolutions, resolutions, 'cancelling the writer cannot change the frozen ruling');
  release.resolve();
  await finished.promise;
});


test('C2: cancellation during interceptor persistence aborts before a writer request escapes', async t => {
  const setup = await ready();
  const { host, controller, send } = setup;
  t.after(() => controller.destroy());
  scriptJudge(controller, answers());
  const waiting = deferred(), release = deferred(), finished = deferred();
  t.after(release.resolve);
  const write = host.writeRecord.bind(host);
  let held = false, aborted = false;
  host.writeRecord = async (record, key) => {
    if (!held && Object.values((record as DirectorChatRecord).attempts).some(attempt => attempt.rerolledByCheck && attempt.status === 'writing')) {
      held = true; waiting.resolve(); await release.promise;
    }
    return write(record, key);
  };
  host.context.swipe.right = async () => {
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor(structuredClone(host.chat().slice(0, -1)), 4096, () => { aborted = true; }, 'swipe');
    finished.resolve();
  };
  await send(); await waiting.promise;
  setup.type('A new choice.'); release.resolve(); await finished.promise;
  assert.equal(aborted, true);
  assert.equal(host.injection, '');
  assert.equal(Object.values(controller.record!.attempts).at(-1)!.status, 'cancelled');
});
