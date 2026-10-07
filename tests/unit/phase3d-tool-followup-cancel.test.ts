/**
 * Race (a): the automatic rewrite's writer calls the (closed) Director tool.
 *
 * SillyTavern saves the tool-calling swipe as an intermediary and emits
 * MESSAGE_RECEIVED(id, 'swipe') for it BEFORE invoking the tool (script.js
 * 5410-5416 streaming, 5532-5545 non-streaming), then saves the tool result and
 * starts Generate('normal', { depth + 1 }).
 *
 * queueMessageReceived() sets automaticReply.finished on that intermediary event
 * (controller.ts ~2041), so every later cancelReplyCheck() skips the rewrite
 * (`!automatic.finished`, ~2164): typing or Stop after the tool call no longer
 * cancels it. C2: "It is cancelled if the user types, swipes, edits or changes chat",
 * and fix-list item 3: a stopped rewrite fragment is never accepted, badged or checked.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

const puppet = (request: any) => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {});
const original = 'Player agrees to follow the guide.';
const followUp = 'The guide waits for an answer.';
const lastReply = (h: any) => h.host.chat().findLast((m: any) => !m.is_user && !m.is_system);
const rewriteAttempt = (h: any) => Object.values<any>(h.controller.record.attempts).find(attempt => attempt.rerolledByCheck);

test('typing after the rewrite calls the closed tool cancels it before its follow-up is written', async t => {
  const h = await rc({ streaming: true, answers: puppet });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: original }, { tool: 'auto' }, { text: followUp }];
  const tool = h.sim.tool;
  const action = tool.action;
  let typed = false;
  // The user starts answering right after the tool returns, before ST starts the follow-up generation.
  tool.action = async (args: unknown) => {
    const result = await action(args);
    if (!typed) { typed = true; h.type('I answer the guide.'); }
    return result;
  };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => typed, 'the rewrite called the tool');
  await h.sim.settle();
  console.log(h.sim.log.join(' | '));
  assert.ok(rewriteAttempt(h), 'sanity: the automatic rewrite ran');
  assert.equal(h.host.chat().some((m: any) => m.mes === followUp), false, 'the cancelled rewrite never writes its follow-up');
  assert.equal(rewriteAttempt(h).status, 'cancelled', 'the rewrite attempt is cancelled, not accepted');
  assert.equal(lastReply(h).mes, original, 'the user is answering the original reply');
  assert.equal(h.checks().length, 1, 'no paid check of a cancelled rewrite');
});

test('Stop during the rewrite\'s tool follow-up never accepts, badges or checks the stopped fragment', async t => {
  const h = await rc({ streaming: true, answers: puppet });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: original }, { tool: 'auto' }, { text: 'The guide sta', delayMs: 300 }];
  const send = h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.sim.log.some((line: string) => line.startsWith('tool result')) && lastReply(h)?.mes === '...', 'follow-up streaming');
  h.sim.stop();
  await send; await h.sim.settle();
  console.log(h.sim.log.join(' | '));
  const rewrite = rewriteAttempt(h);
  assert.ok(rewrite, 'sanity: the automatic rewrite ran');
  assert.equal(rewrite.status, 'cancelled', 'a stopped rewrite is not accepted');
  assert.equal(h.checks().length, 1, 'no paid check of the stopped fragment');
  const index = h.host.chat().indexOf(lastReply(h));
  assert.equal(h.host.readWorkflowBadge(index)?.rerolledByCheck, undefined, 'the fragment is not badged "rerolled"');
});

/**
 * Phase 3d, item 2: `finished` is set when the rewrite's real text is received
 * (an empty, '...' or tool intermediary never counts), not only after the
 * deferred acceptance. Non-streaming, saveReply() emits MESSAGE_RECEIVED before
 * saveChatConditional() and unblockGeneration() (script.js 5530-5575), so the
 * acceptance waits for GENERATION_ENDED. Typing in that window answers the
 * complete rewrite the user already sees; it must not cancel and discard it.
 */
test('non-streaming: typing while SillyTavern still saves a complete rewrite keeps it', async t => {
  const h = await rc({ streaming: false, answers: puppet });
  t.after(() => h.controller.destroy());
  const rewritten = 'The guide waits beside the gate.';
  h.sim.writer = [{ text: original }, { text: rewritten }];
  const emit = h.host.emit.bind(h.host);
  let typed = false;
  h.host.emit = async (name: string, ...args: unknown[]) => {
    await emit(name, ...args);
    if (name === 'MESSAGE_RECEIVED' && args[1] === 'swipe' && !typed) { typed = true; h.type('I answer.'); }
  };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => typed, 'typing after the complete rewrite arrived');
  await h.sim.settle();
  assert.equal(h.stops(), 0, 'the complete rewrite is not stopped');
  assert.equal(h.last().mes, rewritten);
  assert.equal(h.last().swipes.length, 2);
  assert.equal(rewriteAttempt(h).status, 'accepted');
});
