import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { actorIdFor } from '../../src/identity.ts';
import { mergeRequestUsage, summarizeUsage } from '../../src/usage.ts';
import { ProviderError } from '../../src/providers.ts';
import type { EvaluationRequest, EvaluationResult } from '../../src/types.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

async function costHarness() {
  const host = new TestHost();
  const controller = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
    family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) });
  const scripted = controller.provider();
  const calls: EvaluationRequest[] = [];
  let failStage = '';
  controller.provider = () => ({ ...scripted, evaluate: async (request, signal) => {
    calls.push(request);
    if (failStage && request.questions[failStage]) throw new ProviderError('timeout', 'Example judge timeout');
    const result = await scripted.evaluate(request, signal);
    return { ...result, inputTokens: 20, outputTokens: 4, costUsd: 0.0012 };
  } });
  controller.settings.connection.kind = 'openrouter'; // Dispatch stays entirely in the scripted provider.
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide opens the gate with a condition.');
  host.swipeRight = async () => {
    const messageId = host.chat().length - 1, reply = host.chat()[messageId]!;
    reply.swipe_id = reply.swipes!.length;
    (reply.swipe_info ??= [])[reply.swipe_id] = { extra: {} };
    reply.extra = {};
    await host.emit('MESSAGE_SWIPED', messageId);
    await controller.interceptor([], 4096, () => assert.fail('unexpected swipe cancellation'), 'swipe');
    reply.mes = `The guide repeats the answer in wording ${reply.swipe_id}.`; reply.swipes!.push(reply.mes);
    await host.emit('MESSAGE_RECEIVED', messageId, 'swipe');
    await host.emit('GENERATION_ENDED');
    for (let tick = 0; tick < 20 && !host.readWorkflowBadge(messageId); tick++) await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { host, controller, calls, fail: (stage: string) => { failStage = stage; },
    async send() { host.composerValue = 'Open the gate for me.'; await controller.directorSend(); },
    allReceipts() { return mergeRequestUsage(...controller.record!.inspector.map(entry => entry.requestUsage)); } };
}

test('C4 controller accounts for every staged request and keeps a wording swipe free', async t => {
  const h = await costHarness(); t.after(() => h.controller.destroy());
  await h.send();
  assert.equal(h.calls.length, 3);
  assert.equal(h.allReceipts().length, 3);
  assert.equal(summarizeUsage(h.allReceipts()).inputTokens, 60);
  const firstBadge = h.host.readWorkflowBadge(h.host.chat().length - 1)!;
  assert.equal(firstBadge.requestUsage!.length, 3);
  assert.ok(Math.abs(summarizeUsage(firstBadge.requestUsage!).costUsd! - 0.0036) < 1e-12);
  await h.host.swipeRight();
  assert.equal(h.calls.length, 3);
  assert.equal(h.allReceipts().length, 3);
  const nextBadge = h.host.readWorkflowBadge(h.host.chat().length - 1)!;
  assert.deepEqual(nextBadge.requestUsage, firstBadge.requestUsage);
  assert.equal(h.controller.record!.inspector.filter(entry => entry.attemptId === nextBadge.attemptId).reduce((sum, entry) => sum + entry.networkCalls, 0), 0);
  assert.equal(await h.controller.reassess(true), true);
  assert.equal(h.calls.length, 4);
  assert.equal(h.allReceipts().length, 4);
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)!.requestUsage!.length, 4);
});

test('C4 failed requests stay unknown and selective retry charges only new transport calls', async t => {
  const h = await costHarness(); t.after(() => h.controller.destroy());
  h.fail('owner'); await h.send();
  assert.equal(h.calls.length, 2);
  assert.equal(h.allReceipts().length, 2);
  assert.equal(summarizeUsage(h.allReceipts()).unreportedCostRequests, 1);
  h.fail('');
  assert.equal(await h.controller.retryJudge(), true);
  assert.equal(h.calls.length, 4, 'retry replays the successful move and requests only route/ruling');
  assert.equal(h.allReceipts().length, 4);
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)!.requestUsage!.length, 4);
  assert.equal(summarizeUsage(h.allReceipts()).unreportedCostRequests, 1);
});

test('C4 failed reassessment and connection tests retain their own request receipts', async t => {
  const h = await costHarness(); t.after(() => h.controller.destroy());
  await h.send(); h.fail('ruling');
  assert.equal(await h.controller.reassess(true), false);
  assert.equal(h.calls.length, 4);
  assert.equal(h.allReceipts().length, 4);
  assert.equal(summarizeUsage(h.allReceipts()).unreportedCostRequests, 1);
  h.fail('');
  await h.controller.testTable({ outcomes: h.controller.profile.outcomes, bands: h.controller.profile.bands }, 'threshold');
  assert.equal(h.allReceipts().length, 5);
  assert.equal(h.allReceipts().at(-1)!.stage, 'table_test');
  assert.equal(h.allReceipts().at(-1)!.costUsd, 0.0012);
});

test('C4 a cancelled request and its late usage remain in the session after changing chats', async t => {
  const h = await costHarness(); t.after(() => h.controller.destroy());
  const base = h.controller.provider();
  let request: EvaluationRequest | null = null;
  let finish!: (result: EvaluationResult) => void;
  h.controller.provider = () => ({ ...base, evaluate: async input => {
    request = input;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = h.send();
  for (let tick = 0; tick < 20 && !request; tick++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(request);
  assert.equal(h.controller.sessionUsage.length, 1, 'dispatch is counted before a response arrives');
  assert.equal(h.controller.sessionUsage[0]!.costUsd, null);
  h.host.currentChatId = 'another-chat'; h.host.context.chatMetadata = {};
  await h.host.emit('CHAT_CHANGED');
  await pending;
  finish({ requestId: (request as EvaluationRequest).requestId, provider: 'jev', requestedModel: 'example', returnedModel: 'example', answers: { move: choice('NONE') },
    errors: {}, unresolvedQuestionIds: [], inputTokens: 31, outputTokens: 5, costUsd: 0.002, durationMs: 1, transportAttempts: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.controller.sessionUsage.length, 1);
  assert.equal(h.controller.sessionUsage[0]!.costUsd, 0.002, 'reported billing survives cancellation of the turn');
  assert.equal(Object.keys(h.controller.record!.attempts).length, 0, 'late usage cannot create a turn in the new chat');
});
