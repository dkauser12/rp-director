import { test } from 'node:test';
import { assert, rc, score, until } from './support/phase3c-replycheck.ts';
import { compactRecord, newRecord } from '../../src/state.ts';

const puppet = (request: any) => 'speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {};

test('a dry-run generation leaves a pending reply check alive', async t => {
  const h = await rc({ answers: puppet });
  t.after(() => h.controller.destroy());
  const provider = h.controller.provider.bind(h.controller);
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  h.controller.provider = () => {
    const base = provider();
    return { ...base, evaluate: async (request: any, signal: AbortSignal) => {
      if ('speaks_for_user' in request.questions && !entered) { entered = true; await held; }
      return base.evaluate(request, signal);
    } };
  };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => entered, 'pending check');
  const pending = h.controller.replyCheckAbort;
  await h.host.emit('GENERATION_STARTED', 'normal', {}, true);
  await h.host.emit('GENERATE_AFTER_DATA', {}, true);
  assert.equal(pending.signal.aborted, false);
  release();
  await until(() => h.checks().length === 2, 'original and rewritten checks');
  await h.sim.settle();
  assert.equal(h.last().swipes.length, 2);
});

test('a dry run during the rewrite neither cancels it nor receives its correction', async t => {
  const h = await rc({ answers: puppet });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { text: 'The guide waits.', delayMs: 150 }];
  const send = h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.controller.currentAttemptId && h.controller.record.attempts[h.controller.currentAttemptId].rerolledByCheck, 'rewrite starts');
  const id = h.controller.currentAttemptId;
  const originalInjection = h.host.injection;
  assert.match(originalInjection, /\(OOC: Rewrite/);
  await h.host.emit('GENERATION_STARTED', 'normal', {}, true);
  assert.equal(h.controller.record.attempts[id].status, 'writing');
  assert.doesNotMatch(h.host.injection, /\(OOC:/, 'dry run does not consume the automatic correction');
  await h.host.emit('GENERATE_AFTER_DATA', {}, true);
  assert.equal(h.host.injection, originalInjection, 'live rewrite keeps its injection after the preview');
  await send; await h.sim.settle();
  assert.equal(h.controller.record.attempts[id].status, 'accepted');
});

test('Stop removes the unfinished automatic fragment without a badge or another check', async t => {
  const h = await rc({ streaming: true, outMs: 5, answers: puppet });
  t.after(() => h.controller.destroy());
  const original = 'Player agrees to follow the guide.';
  h.sim.writer = [{ text: original }, { text: 'The guide sta', delayMs: 300 }];
  const send = h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.last().mes === '...', 'streaming rewrite');
  await h.host.emit('CHARACTER_MESSAGE_RENDERED', h.host.chat().length - 1, 'swipe');
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1), null, 'unfinished wording never inherits the original badge');
  h.sim.stop();
  await send; await h.sim.settle();
  assert.equal(h.last().mes, original);
  assert.deepEqual(h.last().swipes, [original]);
  assert.equal(h.last().swipe_id, 0);
  assert.equal(h.checks().length, 1);
  const rewrite = Object.values<any>(h.controller.record.attempts).find(attempt => attempt.rerolledByCheck)!;
  assert.equal(rewrite.status, 'cancelled');
  assert.equal(h.host.readWorkflowBadge(h.host.chat().length - 1)!.rerolledByCheck, undefined);
});

test('typing after the rewrite finishes while the native swipe still saves preserves its complete text', async t => {
  const h = await rc({ streaming: true, saveLatencyMs: 80, answers: puppet });
  t.after(() => h.controller.destroy());
  const rewritten = 'The guide waits beside the gate.';
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { text: rewritten }];
  let typed = false;
  h.sim.earlierMessageReceived.push(async (_id: number, type: string) => {
    if (type !== 'swipe') return;
    setTimeout(() => { typed = true; h.type('I answer.'); }, 5);
  });
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => typed, 'typing after completed rewrite');
  await h.sim.settle();
  assert.equal(h.last().mes, rewritten);
  assert.equal(h.last().swipes.length, 2);
  assert.equal(h.stops(), 0);
});

test('failure to dispatch a rewrite identifies the rewrite stage and preserves the completed check', async t => {
  const h = await rc({ answers: puppet });
  t.after(() => h.controller.destroy());
  h.host.swipeRight = async () => { throw new Error('native swipe rejected'); };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.host.notices.some((notice: string) => notice.includes('rewrite could not start')), 'rewrite dispatch failure');
  assert.equal(h.host.notices.some((notice: string) => notice.includes('Reply check unavailable')), false);
  assert.ok(h.host.readWorkflowBadge(h.host.chat().length - 1)!.replyCheck);
  assert.equal(h.last().swipes.length, 1);
});

test('allowance compaction removes unreachable keys while retaining a live user turn', () => {
  const record = newRecord('seed', 'profile');
  record.replyCheckRerolls = ['live-turn', ...Array.from({ length: 500 }, (_, i) => `unreachable-${i}`)];
  const kept = compactRecord(record, { liveCursors: ['root', 'live-turn'], liveVariantIds: [] });
  assert.deepEqual(kept.replyCheckRerolls, ['live-turn']);
});

test('editing a stopped fragment before native save finishes preserves the user edit', async t => {
  const h = await rc({ streaming: true, saveLatencyMs: 60, answers: puppet });
  t.after(() => h.controller.destroy());
  h.sim.writer = [{ text: 'Player agrees to follow the guide.' }, { text: 'The guide sta', delayMs: 300 }];
  let edited = false;
  h.sim.earlierMessageReceived.push(async (id: number, type: string) => {
    if (type !== 'swipe') return;
    h.last().mes = 'The user rewrites this wording.';
    h.last().swipes[h.last().swipe_id] = h.last().mes;
    edited = true;
    await h.host.emit('MESSAGE_EDITED', id);
  });
  const send = h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.last().mes === '...', 'streaming rewrite');
  h.sim.stop();
  await send; await h.sim.settle();
  assert.equal(edited, true);
  assert.equal(h.last().mes, 'The user rewrites this wording.');
  assert.equal(h.last().swipes.length, 2);
});
