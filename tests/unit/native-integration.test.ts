import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { normalizeRecord } from '../../src/state.ts';
import { choice, harness, noul, scriptJudge, writerReplies } from './support/test-host.ts';
import type { EvaluationResult } from '../../src/types.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = {
  move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
};

async function ready(group = false) {
  const h = await harness({ group });
  h.controller.settings.modules = { speaker: group, decisions: true, meters: false, secrets: false, lore: false };
  h.controller.settings.reactions.enabled = false;
  await h.controller.setChatPack('default');
  h.host.composerValue = 'Open the gate for me.';
  return h;
}

function emptyResult(requestId: string): EvaluationResult {
  return { requestId, provider: 'mock', requestedModel: null, returnedModel: null, answers: {},
    unresolvedQuestionIds: [], errors: {}, inputTokens: 0, outputTokens: 0, durationMs: 0, transportAttempts: 1 };
}

for (const status of ['stale', 'unknown', 'provisional', 'observing']) {
  test(`W1/W6: historical ${status} state never blocks Send`, async () => {
    const { host, controller } = await ready();
    const saved = { ...controller.record!, projection: { status }, checkpoints: {},
      variants: { old: { variantId: 'old', attemptId: 'old', acceptance: 'pending', observerStatus: 'failed' } },
      attempts: { old: { attemptId: 'old', variantId: 'old', status, cursorBefore: 'old' } } };
    controller.record = normalizeRecord(saved, 'test', controller.profile.revision);
    scriptJudge(controller, { move: choice('NONE'), move_count: choice('one') });
    writerReplies(host, controller, 'Guide', 'guide.png', 'The guide listens.');
    await controller.directorSend();
    assert.equal(host.generated.length, 1);
    assert.equal('projection' in controller.record!, false);
    assert.equal('checkpoints' in controller.record!, false);
    assert.equal(Object.values(controller.record!.attempts).at(-1)!.status, 'accepted');
  });
}

test('W1/W5: no first-run confirmation, slash composer is passed to the host without a judge', async () => {
  const { host, controller } = await ready();
  host.confirm = async () => assert.fail('No first-use popup');
  const requests = scriptJudge(controller, {});
  host.composerValue = '/echo hello';
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
  assert.equal(requests.length, 0);
  assert.equal('bindingConfirmedAt' in controller.settings, false);
});

test('W1: disabled, per-chat pause, no chat and an active generation do not start Director work', async () => {
  for (const reason of ['disabled', 'paused', 'no_chat', 'generating']) {
    const { host, controller } = await ready();
    const requests = scriptJudge(controller, turn);
    if (reason === 'disabled') controller.settings.enabled = false;
    if (reason === 'paused') await controller.setPaused(true);
    if (reason === 'no_chat') controller.record = null;
    if (reason === 'generating') host.isGenerating = () => true;
    await controller.directorSend();
    assert.equal(requests.length, 0, reason);
    assert.equal(host.generated.length, 0, reason);
  }
});

test('W1: per-chat pause persists and does not pause a different chat', async () => {
  const { host, controller } = await ready();
  await controller.setPaused(true);
  await controller.loadChat();
  assert.equal(controller.record!.paused, true);
  host.currentChatId = 'other';
  host.context.chatMetadata = {};
  await controller.loadChat();
  assert.equal(controller.record!.paused, false);
});

for (const failure of ['network', 'invalid_answers', 'context_budget']) {
  test(`W2: ${failure} proceeds unruled with an unavailable badge`, async () => {
    const { host, controller } = await ready();
    let calls = 0;
    const base = controller.provider();
    controller.provider = () => ({ ...base, evaluate: async request => {
      calls++;
      if (failure === 'network') throw new Error('network disconnected');
      return emptyResult(request.requestId);
    } });
    if (failure === 'context_budget') host.composerValue = 'x'.repeat(100000);
    const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
    await controller.directorSend();
    assert.equal(host.generated.length, 1);
    assert.equal(Object.keys(controller.record!.resolutions).length, 0);
    assert.doesNotMatch(writer.injected(), /Director ruling/);
    const badge = host.readWorkflowBadge(host.chat().length - 1);
    assert.ok(badge);
    assert.match(JSON.stringify(badge), /unavailable/);
    assert.ok(host.notices.some(text => text.endsWith("Your chat isn't affected.")));
    if (failure === 'context_budget') assert.equal(calls, 0);
  });
}

test('W2: only one toast per error type across repeated failed turns', async () => {
  const { host, controller } = await ready();
  const base = controller.provider();
  controller.provider = () => ({ ...base, evaluate: async () => { throw new Error('network disconnected'); } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  await controller.directorSend();
  assert.equal(host.generated.length, 2);
  assert.equal(host.notices.filter(text => text.endsWith("Your chat isn't affected.")).length, 1);
});

test('W2: total budget releases a provider that ignores abort; late results cannot mutate history', async () => {
  const { host, controller } = await ready();
  controller.settings.waitForJudgeSeconds = 0.02;
  let release!: (result: EvaluationResult) => void;
  let requestId = '';
  let signal: AbortSignal | undefined;
  const base = controller.provider();
  controller.provider = () => ({ ...base, evaluate: async (request, abort) => {
    requestId = request.requestId; signal = abort;
    return new Promise(resolve => { release = resolve; });
  } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
  assert.equal(signal?.aborted, true);
  const saved = JSON.stringify(controller.record);
  release({ ...emptyResult(requestId), answers: turn });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(controller.record), saved);
});

test('W2: lore catalog loading is inside the total pre-reply budget', async () => {
  const { host, controller } = await ready();
  controller.settings.waitForJudgeSeconds = 0.02;
  controller.settings.modules.lore = true;
  host.loreCatalog = () => new Promise(() => {});
  scriptJudge(controller, turn);
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
  assert.doesNotMatch(writer.injected(), /Director ruling/);
});

test('W2: failure of speaker selection retains a successful ruling and uses the native speaker', async () => {
  const { host, controller } = await ready(true);
  scriptJudge(controller, turn);
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.equal(Object.keys(controller.record!.resolutions).length, 1);
  assert.match(writer.injected(), /Director ruling/);
  assert.equal(host.generated[0]!.force_chid, undefined);
});

test('W3: wording swipes silently reuse exact ruling, reaction, state and lore identifiers', async () => {
  const { host, controller } = await ready();
  const requests = scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  source.frozenStateBlock = 'FROZEN STATE';
  source.loreCursor = 'FROZEN LORE';
  const before = requests.length;
  const message = host.chat().at(-1)!;
  message.swipe_id = message.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('No swipe abort'), 'swipe');
  const retry = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(requests.length, before);
  assert.equal(retry.resolutionId, source.resolutionId);
  assert.equal(retry.loreCursor, source.loreCursor);
  assert.equal(retry.frozenStateBlock, source.frozenStateBlock);
  assert.deepEqual(retry.reaction, source.reaction);
  assert.doesNotMatch(host.injection, /FROZEN STATE/, 'disabled meters and secrets are not injected');
});

test('W3: a native pre-Director swipe and regenerate judge the user message without a popup', async () => {
  for (const type of ['swipe', 'regenerate']) {
    const { host, controller } = await ready();
    const requests = scriptJudge(controller, turn);
    let prompts = 0;
    host.swipeResult = async () => { prompts++; return 'reuse'; };
    if (type === 'regenerate') { await host.emit('GENERATION_STARTED', type); host.chat().pop(); await host.emit('MESSAGE_DELETED'); }
    else { host.chat().at(-1)!.swipe_id = host.chat().at(-1)!.swipes!.length; await host.emit('MESSAGE_SWIPED', host.chat().length - 1); }
    await controller.interceptor([], 4096, () => assert.fail('generation aborted'), type);
    assert.equal(requests.length, 3);
    assert.equal(prompts, 0);
    assert.match(host.injection, /Director ruling/);
    assert.equal(Object.keys(controller.record!.attempts).length, 1);
  }
});

test('W3: an edited reply retains the ruling for its user message', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'Original reply.');
  await controller.directorSend();
  const message = host.chat().at(-1)!;
  message.mes = 'An edited reply.';
  await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('native generation aborted'), 'swipe');
  assert.match(host.injection, /Director ruling/);
  assert.ok(host.readWorkflowBadge(host.chat().length - 1), 'edited reply retains the exchange badge');
});

test('W4: explicit dice reroll makes a new swipe and draw, retaining the original variant', async () => {
  const { host, controller } = await ready();
  controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
  controller.reloadProfile();
  const requests = scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  const previous = controller.record!.resolutions[source.resolutionId!]!;
  const original = structuredClone(previous);
  const calls = requests.length;
  let swipes = 0;
  host.swipeRight = async () => { swipes++; await controller.interceptor([], 4096, () => assert.fail('retry abort'), 'swipe'); };
  assert.equal(await controller.reroll(), true);
  assert.equal(swipes, 1);
  assert.equal(requests.length, calls);
  const retry = Object.values(controller.record!.attempts).at(-1)!;
  const next = controller.record!.resolutions[retry.resolutionId!]!;
  assert.notEqual(next.resolutionId, previous.resolutionId);
  assert.notEqual(next.draw, previous.draw);
  assert.equal(next.previousResolutionId, previous.resolutionId);
  assert.deepEqual(controller.record!.resolutions[previous.resolutionId], original);
});

test('W4: Reassess reuses saved evidence and can change a Dice ruling', async () => {
  const { host, controller } = await ready();
  controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
  controller.reloadProfile();
  const requests = scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const previous = Object.values(controller.record!.resolutions)[0]!;
  assert.equal(await controller.reassess(false), true);
  assert.deepEqual(requests.at(-1)!.snapshot, previous.snapshot);
  assert.deepEqual(Object.keys(requests.at(-1)!.questions), ['ruling']);
  assert.equal(Object.keys(controller.record!.resolutions).length, 2);
});

for (const choice of ['reuse', 'reroll', 'cancel'] as const) {
  test(`W3: ruled swipe asks before generation and honors ${choice}`, async () => {
    const { host, controller } = await ready();
    controller.settings.askWhenSwiping = true;
    controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
    controller.reloadProfile();
    const requests = scriptJudge(controller, turn);
    writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
    await controller.directorSend();
    const source = Object.values(controller.record!.attempts).at(-1)!;
    let prompts = 0;
    host.swipeResult = async () => { prompts++; return choice; };
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    const calls = requests.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    assert.equal(prompts, 1);
    assert.equal(host.generated.length, 1, 'swipe event prepares; host has not generated');
    let aborted = false;
    await controller.interceptor([], 4096, () => { aborted = true; }, 'swipe');
    assert.equal(aborted, choice === 'cancel');
    if (choice !== 'cancel') {
      const retry = Object.values(controller.record!.attempts).at(-1)!;
      if (choice === 'reuse') assert.equal(retry.resolutionId, source.resolutionId);
      else assert.notEqual(retry.resolutionId, source.resolutionId);
    }
    assert.equal(requests.length, calls, 'even Roll again uses saved dice assessment');
  });
}

test('W3: pending swipe choice cannot apply to a changed chat', async () => {
  const { host, controller } = await ready();
  controller.settings.askWhenSwiping = true;
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  let choose!: (choice: 'reuse') => void;
  host.swipeResult = () => new Promise(resolve => { choose = resolve; });
  host.chat().at(-1)!.swipe_id = host.chat().at(-1)!.swipes!.length;
  const waiting = host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await Promise.resolve();
  host.currentChatId = 'new';
  host.context.chatMetadata = {};
  await host.emit('CHAT_CHANGED');
  choose('reuse');
  await waiting;
  let aborted = false;
  await controller.interceptor([], 4096, () => { aborted = true; }, 'swipe');
  assert.equal(aborted, true);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
});

test('W3: a new swipe of a pre-Director reply judges its user message without posting it again', async () => {
  const { host, controller } = await ready();
  host.composerValue = 'Unsent draft must stay here.';
  const requests = scriptJudge(controller, turn);
  host.chat().at(-1)!.swipe_id = host.chat().at(-1)!.swipes!.length;
  let prompts = 0;
  host.swipeResult = async () => { prompts++; return 'reuse'; };
  const oldText = host.chat()[0]!.mes;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  assert.equal(requests.length, 3);
  assert.equal(prompts, 0);
  assert.equal(host.generated.length, 0);
  assert.equal(host.composerValue, 'Unsent draft must stay here.');
  assert.equal(host.chat()[0]!.mes, oldText);
  assert.match(JSON.stringify(requests[0]!.snapshot.state), /We reach the gate/);
  await controller.interceptor([], 4096, () => assert.fail('native swipe judging aborted'), 'swipe');
  assert.match(host.injection, /Director ruling/);
  const attempt = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(attempt.cursorBefore, controller.record!.resolutions[attempt.resolutionId!]!.cursorBefore);
});

test('W2: Try the judge again replaces an unavailable turn on a new swipe', async () => {
  const { host, controller } = await ready();
  const base = controller.provider();
  controller.provider = () => ({ ...base, evaluate: async () => { throw new Error('network disconnected'); } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.ok(host.readWorkflowBadge(host.chat().length - 1)!.unavailable);
  const source = Object.values(controller.record!.attempts).at(-1)!;
  const requests = scriptJudge(controller, turn);
  let swipes = 0;
  host.swipeRight = async () => {
    swipes++;
    await controller.interceptor([], 4096, () => assert.fail('retry aborted'), 'swipe');
  };
  assert.equal(await controller.retryJudge(), true);
  assert.equal(swipes, 1);
  assert.equal(requests.length, 3);
  const retried = Object.values(controller.record!.attempts).at(-1)!;
  assert.ok(retried.resolutionId);
  assert.equal(source.resolutionId, null);
});

test('W3: switching Lore off suppresses frozen picks on a wording swipe', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  source.frozenLorePlan = { force: ['Book.1'], managed: ['Book'] };
  controller.settings.modules.lore = false;
  controller.settings.lore.books.Book = { mode: 'off', public: false };
  let armed: unknown = null;
  host.armLore = async plan => { if (plan) armed = { force: [...plan.force], managed: [...plan.managed] }; };
  await controller.interceptor([], 4096, () => assert.fail('swipe aborted'), 'swipe');
  assert.equal(armed, null);
});

test('18: frozen lore arming has no judge deadline', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  source.frozenLorePlan = { force: ['Book.1'], managed: ['Book'] };
  controller.settings.modules.lore = true;
  controller.settings.waitForJudgeSeconds = 0.02;
  host.sortedEntries = async () => { await new Promise(resolve => setTimeout(resolve, 40)); return [{ world: 'Book', uid: 1 }]; };
  await controller.interceptor([], 4096, () => assert.fail('swipe aborted'), 'swipe');
  assert.deepEqual([...host.armedLore()!.force], ['Book.1']);
  assert.ok(!host.notices.some(message => /Lore unavailable/.test(message)));
  assert.match(host.injection, /Director ruling/);
});

test('W7: a manual attempt uses the staged ruling and its declared result', async () => {
  const { host, controller } = await ready();
  controller.setActionDraft({ templateId: 'influence_negotiate', actingActorId: 'player', targetActorIds: [GUIDE],
    attemptedAction: 'Offer a silver coin', requestedGain: 'the guide opens the gate', applicability: 'favorable',
    uncertainConsequential: true, opposed: false,
    failureStakeKind: 'delay', failureStakeDetail: 'the gate stays closed', availableEvidence: '' });
  const requests = scriptJudge(controller, { ruling: noul(0.7) });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.deepEqual(requests.map(r => Object.keys(r.questions)[0]), ['ruling']);
  const resolution = Object.values(controller.record!.resolutions)[0]!;
  assert.equal(resolution.action.pipeline, 'staged');
  assert.equal(resolution.action.requestedGain, 'the guide opens the gate');
  assert.match(writer.injected(), /the guide opens the gate/);
  assert.equal(controller.actionDraft, null);
});

test('W2: the wait budget is total across sequential stages rather than reset per request', async () => {
  const { host, controller } = await ready();
  controller.settings.waitForJudgeSeconds = 0.02;
  const requests = scriptJudge(controller, turn);
  const scripted = controller.provider();
  controller.provider = () => ({ ...scripted, evaluate: async (request, signal) => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return scripted.evaluate(request, signal);
  } });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  assert.ok(host.readWorkflowBadge(host.chat().length - 1)!.errors.includes('timeout'));
  assert.ok(requests.length < 3, 'no late third-stage ruling request');
});

test('W2: changing settings during a decision discards it and lets the native reply proceed', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  const scripted = controller.provider();
  let changed = false;
  controller.provider = () => ({ ...scripted, evaluate: async (request, signal) => {
    if (!changed) { changed = true; controller.settings.reactions.enabled = true; }
    return scripted.evaluate(request, signal);
  } });
  await controller.directorSend();
  assert.equal(host.generated.length, 1);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
});

test('the public firewall strips hidden details from speaker question prose, not only state', async () => {
  const { host, controller } = await ready(true);
  host.composerValue = 'Hello. <details><summary>Hidden</summary>QUESTION-CANARY</details>';
  const requests = scriptJudge(controller, { speaker: choice(GUIDE), move: choice('NONE'), move_count: choice('one') });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.ok(requests.some(request => request.questions.speaker));
  assert.doesNotMatch(JSON.stringify(requests), /QUESTION-CANARY/);
});
