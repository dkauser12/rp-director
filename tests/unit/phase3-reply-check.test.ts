import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import type { HostFunctionTool } from '../../src/host.ts';
import type { Answer } from '../../src/types.ts';
import { actorIdFor } from '../../src/identity.ts';
import { assessReply, replyCheckQuestions } from '../../src/reply-check.ts';
import { summarizeUsage } from '../../src/usage.ts';
import { defaultSettings } from '../../src/host.ts';
import { TestHost, choice, noul, scriptJudge } from './support/test-host.ts';

const score = (value: number): Answer => ({ type: 'score', score: value, probabilities: null, legend: {}, confidence: null, provenance: 'fixture' });
async function until(predicate: () => boolean) {
  for (let index = 0; index < 200 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'expected asynchronous reply-check boundary');
}

async function runtime(reason: 'puppet' | 'ruling' = 'puppet', reportedUsage = false) {
  const host = new TestHost();
  let tool: HostFunctionTool | null = null;
  host.context.unregisterFunctionTool = () => {};
  host.context.registerFunctionTool = value => { tool = value; };
  host.context.isToolCallingSupported = () => true;
  host.context.canPerformToolCalls = () => true;
  const controller = new Controller(host);
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false, pacing: false, replyCheck: true };
  controller.settings.reactions.enabled = false;
  controller.settings.askWhenSwiping = true;
  host.swipeResult = async () => assert.fail('automatic correction must not open a choice');
  controller.profile.resolutionMethod = 'sample';
  await controller.setChatPack('default');
  const answers: Record<string, Answer> = { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
    family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
    speaks_for_user: score(reason === 'puppet' ? 4 : 0), responds: score(2), repeats: score(0), follows_ruling: noul(reason === 'ruling' ? 0.1 : 1) };
  const requests = scriptJudge(controller, answers);
  if (reportedUsage) {
    const scripted = controller.provider();
    controller.provider = () => ({ ...scripted, evaluate: async (request, signal) => ({ ...await scripted.evaluate(request, signal), costUsd: 0.002, inputTokens: 10, outputTokens: 2 }) });
    controller.settings.connection.kind = 'openrouter'; // All calls remain in-memory.
  }
  const prompts: { messages: unknown[]; tools: unknown; injection: string }[] = [];
  const capture = async (type: string) => {
    const prefix = type === 'swipe' ? host.chat().slice(0, -1) : host.chat();
    const messages = structuredClone(prefix);
    await controller.interceptor(messages, 4096, () => assert.fail('unexpected abort'), type);
    const current = tool as HostFunctionTool | null;
    const tools = current?.shouldRegister?.() ? { tools: [{ type: 'function', function: { name: current.name, description: current.description, parameters: current.parameters } }], tool_choice: 'auto' } : {};
    prompts.push({ messages: structuredClone(messages), tools: structuredClone(tools), injection: host.injection });
  };
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue });
    host.composerValue = '';
    await capture('normal');
    const text = 'The guide considers the offer. <details>PRIVATE TRACKER</details>';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  let swipes = 0;
  host.context.swipe.right = async () => {
    swipes++;
    const message = host.chat().at(-1)!;
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await capture('swipe');
    message.mes = `Replacement ${swipes}.`;
    message.swipes!.push(message.mes);
    message.swipe_info!.push({ extra: {} });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('GENERATION_ENDED');
  };
  host.composerValue = 'I offer the guide a fair payment to open the gate.';
  await controller.directorSend();
  return { host, controller, requests, prompts, answers, swipes: () => swipes };
}

for (const reason of ['puppet', 'ruling'] as const) test(`C2 ${reason}: one automatic wording retry preserves the draw, prompt prefix and tool envelope`, async t => {
  const h = await runtime(reason);
  t.after(() => h.controller.destroy());
  await until(() => h.requests.filter(request => 'speaks_for_user' in request.questions).length === 2);
  await until(() => Object.values(h.controller.record!.attempts).filter(attempt => attempt.replyCheck).length === 2);
  assert.equal(h.swipes(), 1, 'even another failing check cannot spend a second automatic reroll');
  assert.equal(Object.keys(h.controller.record!.resolutions).length, 1);
  const [original, retry] = h.prompts;
  assert.ok(original && retry);
  assert.deepEqual(retry.tools, original.tools, 'registered tool schema and tool_choice remain byte-identical');
  assert.ok(JSON.stringify(original.tools).includes('RPDirector_AdjudicateTurn'));
  const first = original.messages as { mes: string; is_user: boolean }[];
  const second = retry.messages as { mes: string; is_user: boolean }[];
  assert.deepEqual(second, first, 'every chat message stays identical');
  assert.doesNotMatch(JSON.stringify(h.host.chat().map(message => [message.mes, message.swipes])), /\(OOC:/, 'stored text and swipe texts contain no correction');
  assert.match(retry.injection, /\(OOC: Rewrite the reply/, 'the correction stays in the unscanned depth-0 block');
  const binding = (text: string) => text.split('\n\n')[0]!;
  // The NPC checkpoint policy may close on a wording retry; the ruled outcome and draw do not change.
  assert.ok(binding(retry.injection).includes('Ruling:'));
  const attempts = Object.values(h.controller.record!.attempts);
  assert.equal(attempts[0]!.resolutionId, attempts[1]!.resolutionId);
  const checks = h.requests.filter(request => 'speaks_for_user' in request.questions);
  assert.deepEqual(Object.keys(checks[0]!.questions), ['speaks_for_user', 'responds', 'repeats', 'follows_ruling']);
  assert.doesNotMatch(JSON.stringify(checks), /PRIVATE TRACKER|GUIDE-CARD/);
  const badge = h.host.readWorkflowBadge(h.host.chat().length - 1)!;
  assert.equal(badge.rerolledByCheck, reason === 'puppet' ? 'writes for {{user}}' : 'broken ruling');
  assert.ok(badge.replyCheck);
  const originalBadge = h.host.chat().at(-1)!.swipe_info![0]!.extra!.rpdWorkflow as typeof badge;
  assert.ok(originalBadge.replyCheck, 'original swipe also retains its completed check');
  assert.equal(h.controller.record!.replyCheckRerolls!.length, 1);
  // Selecting the original or reloading metadata cannot reset the per-user-turn allowance.
  const saved = structuredClone(h.controller.record);
  h.host.context.chatMetadata.rpDirector = saved;
  await h.controller.loadChat();
  assert.equal(h.controller.record!.replyCheckRerolls!.length, 1);
});

test('C2 thresholds: strict bounds, one request, optional ruling, and four of six repetition nudges', () => {
  const thresholds = defaultSettings().replyCheckThresholds;
  assert.equal(Object.keys(replyCheckQuestions('Player', '')).length, 3);
  assert.equal(Object.keys(replyCheckQuestions('Player', 'at a price')).length, 4);
  const boundary = assessReply({ speaks_for_user: score(2.85), follows_ruling: noul(0.35), responds: score(0.4), repeats: score(3) }, thresholds, []);
  assert.equal(boundary.reason, null); assert.equal(boundary.nudge, '');
  const repeats = assessReply({ repeats: score(4) }, thresholds, []);
  assert.equal(assessReply({ repeats: score(4) }, thresholds, [repeats, repeats]).nudge, '');
  assert.match(assessReply({ repeats: score(4) }, thresholds, [repeats, repeats, boundary, boundary, repeats]).nudge, /fresh actions/);
  assert.match(assessReply({ responds: score(0) }, thresholds, []).nudge, /Respond directly/);
  assert.equal(assessReply({ speaks_for_user: score(3) }, { ...thresholds, speaksForUser: 4 }, []).reason, null);
  assert.equal(assessReply({ speaks_for_user: score(NaN), follows_ruling: noul(Infinity) }, thresholds, []).reason, null);
});

test('C2 ignored input nudges the next turn at the tail, without an automatic reroll', async t => {
  const host = new TestHost();
  const controller = new Controller(host); await controller.init();
  t.after(() => controller.destroy());
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, replyCheck: true };
  controller.settings.reactions.enabled = false;
  scriptJudge(controller, { speaks_for_user: score(0), responds: score(0), repeats: score(0) });
  const injections: string[] = [];
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = '';
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail(), 'normal');
    injections.push(host.injection);
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide looks away.', swipe_id: 0, swipes: ['The guide looks away.'], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  let swipes = 0; host.context.swipe.right = async () => { swipes++; };
  host.composerValue = 'Can you help?'; await controller.directorSend();
  await until(() => Boolean(Object.values(controller.record!.attempts)[0]?.replyCheck));
  host.composerValue = 'I ask again.'; await controller.directorSend();
  assert.equal(injections[0], '');
  assert.match(injections[1]!, /Respond directly/);
  assert.equal(swipes, 0);
});


test('C2/C4 automatic correction adds exactly its two reply-check receipts to turn and session totals', async t => {
  const h = await runtime('puppet', true); t.after(() => h.controller.destroy());
  await until(() => Object.values(h.controller.record!.attempts).filter(attempt => attempt.replyCheck).length === 2);
  const badge = h.host.readWorkflowBadge(h.host.chat().length - 1)!;
  assert.equal(badge.requestUsage!.length, 5, 'three pre-pass calls plus two checks');
  assert.equal(badge.requestUsage!.filter(receipt => receipt.stage === 'reply_check').length, 2);
  assert.equal(h.controller.sessionUsage.length, 5, 'the frozen pre-pass is not charged again');
  assert.equal(summarizeUsage(badge.requestUsage!).costUsd, 0.01);
  assert.equal(summarizeUsage(h.controller.sessionUsage).inputTokens, 50);
});
