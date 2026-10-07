// Phase 1 review repros converted to behavior regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { Controller } = await import(ROOT + 'src/controller.ts');
const { TestHost, choice, noul, harness, scriptJudge, writerReplies } = await import(ROOT + 'tests/unit/support/test-host.ts');

const GUIDE = actorIdFor('Guide', 'guide.png');
const turn = {
  move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE),
  family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45),
};

async function ready(opts: { tools?: boolean } = {}) {
  let host: any; let controller: any;
  if (opts.tools) {
    host = new TestHost();
    host.context.registerFunctionTool = () => {};
    host.context.unregisterFunctionTool = () => {};
    host.context.isToolCallingSupported = () => true;
    host.context.canPerformToolCalls = () => true;
    controller = new Controller(host);
    await controller.init();
  } else ({ host, controller } = await harness());
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  host.composerValue = 'Open the gate for me.';
  return { host, controller };
}

test('R1: stopped tool windows cannot abort later paused generations', async () => {
  const { host, controller } = await ready({ tools: true });
  scriptJudge(controller, turn);
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1); // pre-Director reply: judged, nativeSwipePending
  let aborted = false;
  await controller.interceptor([], 4096, () => { aborted = true; }, 'swipe');
  assert.equal(aborted, false);
  assert.equal(controller.toolWindow?.phase, 'initial', 'tool offered for this swipe');
  await host.emit('GENERATION_STOPPED'); // user presses Stop
  msg.swipe_id = msg.swipes!.length - 1; // ST reverts
  assert.equal(controller.toolWindow, null);
  await controller.setPaused(true);
  const aborts: string[] = [];
  for (const type of ['normal', 'swipe', 'continue', 'quiet', 'impersonate']) {
    await controller.interceptor([], 4096, () => { aborts.push(type); }, type);
  }
  assert.deepEqual(aborts, []);
});

test('R2: native regenerate reuses the user-message ruling after reply deletion', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  assert.ok(Object.keys(controller.record.resolutions).length === 1);
  // ST Generate('regenerate'): GENERATION_STARTED, then removes the reply and emits MESSAGE_DELETED, then interceptors.
  await host.emit('GENERATION_STARTED', 'regenerate', {});
  
  host.chat().pop();
  await host.emit('MESSAGE_DELETED', host.chat().length);
  
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'regenerate');
  assert.match(host.injection, /Director ruling/); assert.ok(controller.currentAttemptId);
});

test('R3: editing a reply then swiping reuses the exact resolution and draw', async () => {
  const { host, controller } = await ready();
  controller.settings.profileOverrides.binding = { resolutionMethod: 'sample' };
  controller.reloadProfile();
  const requests = scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const first = Object.values(controller.record.resolutions)[0] as any;
  const before = requests.length;
  const msg = host.chat().at(-1)!;
  msg.mes = 'The guide speaks, typo fixed.'; msg.swipes![0] = msg.mes;
  await host.emit('MESSAGE_EDITED', host.chat().length - 1);
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const attempt = Object.values(controller.record.attempts).at(-1) as any;
  const now = controller.record.resolutions[attempt.resolutionId];
  assert.equal(requests.length - before, 0); assert.equal(now?.resolutionId, first.resolutionId); assert.equal(now?.draw, first.draw);
});

test('R4: an ignored retry swipe clears preparation and cannot bypass the next swipe', async () => {
  const { host, controller } = await ready();
  const requests = scriptJudge(controller, turn);
  // Pre-Director last reply. /director-reassess (typed in composer) -> retryJudge -> swipeRight ignored by ST (swipesHidden)
  host.swipeRight = async () => { /* ST ignored the swipe */ };
  const ok = await controller.reassess(true);
  assert.equal(controller.pendingForSwipe, false); assert.equal(controller.record.pending, null); assert.notEqual(controller.status, "Frozen");
  const before = requests.length;
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1); // user swipes manually
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  assert.ok(requests.length > before); assert.match(host.injection, /Director ruling/);
});

test('R5: a failed swipe cleans up and cannot mark a later command message', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  await host.emit('GENERATION_ENDED'); // API error: ST unblocks, no MESSAGE_RECEIVED, no GENERATION_STOPPED
  msg.swipe_id = msg.swipes!.length - 1;
  controller.refreshStatus();
  assert.equal(controller.currentAttemptId, null); assert.notEqual(controller.status, "Writing");
  // /sendas posts a narrator/assistant message and emits MESSAGE_RECEIVED(type 'command')
  host.chat().push({ name: 'Narrator', is_user: false, is_system: false, mes: 'Meanwhile, elsewhere.', swipe_id: 0, swipes: ['Meanwhile, elsewhere.'], swipe_info: [{ extra: {} }] });
  await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'command');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(host.readMarker(host.chat().length - 1), null); assert.equal(host.readWorkflowBadge(host.chat().length - 1), null);
});

test('R6: a cancelled swipe cannot inject its ruling into an unrelated continue', async () => {
  const { host, controller } = await ready();
  controller.settings.askWhenSwiping = true;
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  host.swipeResult = async () => 'cancel';
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  let aborted = false;
  await controller.interceptor([], 4096, () => { aborted = true; }, 'swipe');
  msg.swipe_id = msg.swipes!.length - 1;
  assert.equal(aborted, true);
  // /sendas as the character, then Continue on it
  host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'A line added by /sendas.', swipe_id: 0, swipes: ['A line added by /sendas.'], swipe_info: [{ extra: {} }] });
  await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'command');
  await host.emit('GENERATION_STARTED', 'continue', {});
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'continue');
  assert.doesNotMatch(host.injection, /Director ruling/);
});

test('R7: frozen lore arming is independent of a previous judge deadline', async () => {
  const { host, controller } = await ready();
  scriptJudge(controller, turn);
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide speaks.');
  await controller.directorSend();
  const source = Object.values(controller.record.attempts).at(-1) as any;
  controller.settings.modules.lore = true;
  source.frozenLorePlan = { force: ['Book.1'], managed: ['Book'] };
  let armed: unknown = null;
  host.armLore = async (plan: any) => { armed = plan ? { force: [...plan.force], managed: [...plan.managed] } : armed; };
  // Second Send: user edits the composer while the judge decides -> discarded, no bind.
  controller.settings.waitForJudgeSeconds = 0.01;
  const scripted = controller.provider();
  controller.provider = () => ({ ...scripted, evaluate: async (request: any, signal: any) => { host.composerValue = 'Open the gate for me!!'; return scripted.evaluate(request, signal); } });
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  controller.settings.waitForJudgeSeconds = 10;
  await new Promise(r => setTimeout(r, 20));
  const msg = host.chat().at(-1)!;
  msg.swipe_id = msg.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const retry = Object.values(controller.record.attempts).at(-1) as any;
  assert.deepEqual(armed, {force:["Book.1"], managed:["Book"]}); assert.ok(!retry.judgeErrors.includes("timeout"));
});
