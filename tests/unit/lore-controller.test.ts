import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { Controller } from '../../src/controller.ts';
import type { LoreCatalog, HostChatMessage } from '../../src/host.ts';
import type { LorePlan } from '../../src/lore/settings.ts';
import type { TunnelVisionNode } from '../../src/lore/tree.ts';
import type { Answer } from '../../src/types.ts';
import { TestHost, choice, noul, scriptJudge } from './support/test-host.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');

const pick = (probabilities: Record<string, number>): Answer => ({
  type: 'choice', choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0], probabilities, confidence: null, provenance: 'fixture',
} as Answer);

/** A 1:1 chat with the guide's private book and a public atlas. */
class LoreHost extends TestHost {
  catalogCalls = 0;
  failCatalog = false;
  roots: Record<string, TunnelVisionNode> = {};
  catalog: LoreCatalog = {
    books: [
      { world: 'Atlas', source: 'global', owner: null },
      { world: 'Gatehouse', source: 'character', owner: 'guide.png' },
    ],
    entries: [
      { world: 'Atlas', uid: 0, title: 'North road', keys: ['road'], content: 'The north road runs past the gate. ATLAS-TEXT', constant: false, disabled: false },
      { world: 'Atlas', uid: 1, title: 'Weather', keys: ['rain'], content: 'It rains in spring.', constant: false, disabled: false },
      { world: 'Gatehouse', uid: 0, title: 'Night toll', keys: ['toll'], content: 'The night toll is double. GATE-SECRET', constant: false, disabled: false },
      { world: 'Gatehouse', uid: 1, title: 'Guide past', keys: ['past'], content: 'The guide was a smuggler.', constant: false, disabled: false },
      { world: 'Gatehouse', uid: 2, title: 'Always', keys: [], content: 'Constant text.', constant: true, disabled: false },
    ],
  };
  override async loreCatalog(): Promise<LoreCatalog> {
    this.catalogCalls += 1;
    if (this.failCatalog) throw new Error('world info unavailable');
    return structuredClone(this.catalog);
  }
  override tunnelVisionRoots(): Record<string, TunnelVisionNode> { return this.roots; }
  /** SillyTavern's processed entries: what a forced activation must carry. */
  override async sortedEntries(): Promise<Record<string, unknown>[]> {
    return this.catalog.entries.map(e => ({ world: e.world, uid: e.uid, content: e.content, decorators: [], hash: 1000 + e.uid }));
  }
}

async function loreHarness() {
  const host = new LoreHost();
  const controller = new Controller(host);
  await controller.init();
  controller.settings.pipeline = 'staged';
  controller.settings.modules.meters = false;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  return { host, controller };
}

/** Writer stand-in that records what the World Info scan would be armed with. */
function writer(host: LoreHost, controller: Controller, prose: string) {
  const seen: { plan: LorePlan | null; injected: string }[] = [];
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    seen.push({ plan: host.armedLore(), injected: host.injection });
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] } as HostChatMessage);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
    await host.emit('GENERATION_ENDED');
  };
  return seen;
}

const route = (family: string) => ({
  move: choice('s1'), move_count: choice('one'),
  owner: choice('player'), target: choice(GUIDE), family: choice(family), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
  ruling: noul(0.4),
  lore_public_1_1: pick({ n1: 0.8, n2: 0.1, NONE: 0.1 }),
  lore_1_1: pick({ n1: 0.7, n2: 0.2, NONE: 0.1 }),
  lore_1_2: pick({ n1: 0.7, n2: 0.2, NONE: 0.1 }),
});

/** The inspector entry of the Director turn itself (later entries belong to the observer). */
const turnEntry = (controller: Controller) => [...controller.record!.inspector].reverse().find(e => e.kind === "director_send")!;

test('lore: a staged turn walks public and private books in their own requests, feeds the ruling, and arms the writer', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const requests = scriptJudge(controller, route('influence_negotiate'));
  const seen = writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();

  const loreRequests = requests.filter(r => Object.keys(r.questions).some(id => id.startsWith('lore')));
  assert.equal(loreRequests.length, 2, 'one public, one private');
  const publicRequest = loreRequests.find(r => 'lore_public_1_1' in r.questions)!;
  assert.doesNotMatch(JSON.stringify(publicRequest), /Night toll|GATE-SECRET/, 'no private candidate in the public request');
  assert.match(JSON.stringify(publicRequest.snapshot.state), /pay the toll/, 'the lore question reads the latest input');

  const ruling = requests.find(r => 'ruling' in r.questions)!;
  const lore = (ruling.snapshot.state as { lore?: { book: string; title: string }[] }).lore;
  assert.deepEqual(lore?.map(l => `${l.book}.${l.title}`), ['Atlas.North road', 'Gatehouse.Night toll']);

  const record = Object.values(controller.record!.story.lore);
  assert.equal(record.length, 1);
  assert.deepEqual(record[0]!.refs.map(r => `${r.world}.${r.uid}`), ['Atlas.0', 'Gatehouse.0']);
  assert.deepEqual(record[0]!.books, ['Atlas', 'Gatehouse']);

  assert.equal(seen.length, 1);
  assert.deepEqual([...seen[0]!.plan!.force].sort(), ['Atlas.0', 'Gatehouse.0'], 'assist mode activates the chosen entries for the writer');
  assert.equal(seen[0]!.plan!.managed.size, 0);
  assert.equal(host.armedLore(), null, 'disarmed when the generation ends');
  const inspector = turnEntry(controller);
  assert.match(inspector.message, /Lore: Atlas › North road; Gatehouse › Night toll \(2 requests\)/);
  assert.ok(inspector.questions && 'lore_1_1' in inspector.questions, 'lore questions are auditable in the inspector');
});

test('lore: swipes and continues re-arm the same entries with no new request', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const requests = scriptJudge(controller, route('influence_negotiate'));
  writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  const before = requests.length;
  const catalogBefore = host.catalogCalls;
  const message = host.chat().at(-1)!;
  message.swipe_id = message.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('swipe aborted'), 'swipe');
  assert.deepEqual([...host.armedLore()!.force].sort(), ['Atlas.0', 'Gatehouse.0']);
  await host.emit('GENERATION_ENDED');
  await controller.interceptor([], 4096, () => assert.fail('continue aborted'), 'continue');
  assert.deepEqual([...host.armedLore()!.force].sort(), ['Atlas.0', 'Gatehouse.0']);
  assert.equal(requests.length, before, 'no judge request');
  assert.equal(host.catalogCalls, catalogBefore, 'no lore work at all');
});

test('lore: a discovery ruling reads only public books', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  host.composerValue = 'I study the guide to see whether he is lying about the toll.';
  const requests = scriptJudge(controller, route('detect_discover'));
  writer(host, controller, 'The guide holds still.');
  await controller.directorSend();
  const ruling = requests.find(r => 'ruling' in r.questions)!;
  const state = JSON.stringify(ruling.snapshot.state);
  assert.match(state, /ATLAS-TEXT/);
  assert.doesNotMatch(state, /GATE-SECRET|Night toll/, 'private lore stays out of discovery');
});

test('lore: managed books lose keyword activation; off books are never offered; judge books are never activated', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Gatehouse = { mode: 'managed', public: false };
  controller.settings.lore.books.Atlas = { mode: 'judge', public: false };
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const requests = scriptJudge(controller, route('influence_negotiate'));
  const seen = writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  assert.deepEqual([...seen[0]!.plan!.force], ['Gatehouse.0'], 'judge-only Atlas is read by the ruling but never activated');
  assert.deepEqual([...seen[0]!.plan!.managed], ['Gatehouse']);

  const off = await loreHarness();
  off.controller.settings.lore.books.Gatehouse = { mode: 'off', public: false };
  off.host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const offRequests = scriptJudge(off.controller, route('influence_negotiate'));
  writer(off.host, off.controller, 'The guide names the night price.');
  await off.controller.directorSend();
  assert.doesNotMatch(JSON.stringify(offRequests), /Night toll/, 'an off book is never shown to the judge');
  assert.ok(requests.length > 0);
});

test('lore: a small book is offered entry by entry even when it has an index (labels can hide where an entry lives)', async () => {
  const { host, controller } = await loreHarness();
  host.catalog.books = [{ world: 'Gatehouse', source: 'character', owner: 'guide.png' }];
  host.roots = { Gatehouse: { label: 'Root', entryUids: [], children: [
    { label: 'Rules', summary: 'Tolls and hours.', entryUids: [1], children: [] },
    { label: 'People', summary: 'Who works the gate.', entryUids: [0], children: [] },
  ] } };
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const requests = scriptJudge(controller, { ...route('influence_negotiate'), lore_1_1: pick({ n1: 0.9, n2: 0.05, NONE: 0.05 }) });
  writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  const loreRequest = requests.find(r => 'lore_1_1' in r.questions)!;
  const criteria = (loreRequest.questions.lore_1_1 as { criteria: Record<string, string> }).criteria;
  assert.match(criteria.n1!, /^Night toll: The night toll is double/);
  assert.match(criteria.n2!, /^Guide past/);
  assert.deepEqual(Object.values(controller.record!.story.lore)[0]!.refs.map(r => r.title), ['Night toll']);
});

test('lore: a failed lore stage never blocks the turn and leaves keyword lore in charge', async () => {
  const { host, controller } = await loreHarness();
  host.failCatalog = true;
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const requests = scriptJudge(controller, route('influence_negotiate'));
  const seen = writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  assert.ok(requests.some(r => 'ruling' in r.questions), 'the ruling still ran');
  assert.equal(seen[0]!.plan, null, 'nothing armed');
  assert.match(turnEntry(controller).message, /Lore selection failed \(world info unavailable\)/);
  assert.deepEqual(controller.record!.story.lore, {});
});

test('lore hook: SillyTavern\'s loaded lists are pruned and the chosen objects are force-activated', async () => {
  const host = new LoreHost();
  const emitted: { name: string; args: unknown[] }[] = [];
  host.context.eventTypes = { ...host.context.eventTypes, WORLDINFO_ENTRIES_LOADED: 'wi_loaded', WORLDINFO_FORCE_ACTIVATE: 'wi_force', WORLD_INFO_ACTIVATED: 'wi_activated' };
  host.context.eventSource.emit = async (name: string, ...args: unknown[]) => { emitted.push({ name, args }); };
  const controller = new Controller(host);
  await controller.init();
  assert.equal(controller.loreHooked, true);
  const keyword = { world: 'Gatehouse', uid: 1, constant: false };
  const chosen = { world: 'Gatehouse', uid: 0, constant: false };
  const characterLore = [keyword, chosen];
  await host.armLore({ force: new Set(['Gatehouse.0']), managed: new Set(['Gatehouse']) });
  await host.emit('wi_loaded', { globalLore: [], characterLore, chatLore: [], personaLore: [] });
  assert.deepEqual(characterLore, [chosen], 'the chosen entry stays listed so the scan can activate it');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.name, 'wi_force');
  assert.deepEqual(emitted[0]!.args[0], [{ world: 'Gatehouse', uid: 0, content: 'The night toll is double. GATE-SECRET', decorators: [], hash: 1000, position: 4, depth: 1 }], 'the processed entry retains its hash and moves to chat depth 1');
  await host.emit('wi_loaded', { globalLore: [], characterLore: [keyword, chosen], chatLore: [], personaLore: [] });
  assert.equal(emitted.length, 2, 're-emitted on every scan, since each scan resets external activations');
  await host.emit('wi_activated', [{ world: 'Gatehouse', uid: 0, content: 'The night toll is double.' }, { world: 'Atlas', uid: 5, content: 'x'.repeat(400) }]);
  const activation = controller.loreActivationForUi()!;
  assert.deepEqual(activation.books.Gatehouse, { entries: 1, chars: 25, picked: 1 });
  assert.deepEqual(activation.books.Atlas, { entries: 1, chars: 400, picked: 0 });
  await host.armLore(null);
  const untouched = [keyword];
  await host.emit('wi_loaded', { globalLore: [], characterLore: untouched, chatLore: [], personaLore: [] });
  assert.deepEqual(untouched, [keyword], 'disarmed: SillyTavern behaves as without the Director');
  controller.destroy();
});

test('33: lore continuity asks only about the public scene and resets after visibility changes', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue });
    host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = 'The guide answers.';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
    await host.emit('GENERATION_ENDED');
  };
  scriptJudge(controller, route('influence_negotiate'));
  host.composerValue = 'Open the gate and I will pay.';
  await controller.directorSend();
  const first = Object.values(controller.record!.story.lore).at(-1)!;
  assert.ok(first.scene);
  assert.ok(first.evidenceRefs!.length);
  const repeated = scriptJudge(controller, { ...route('influence_negotiate'), lore_scene: choice('SAME') });
  host.composerValue = 'I repeat the same offer.';
  await controller.directorSend();
  const loreRequests = repeated.filter(request => Object.keys(request.questions).some(id => id.startsWith('lore')));
  assert.deepEqual(loreRequests.map(request => Object.keys(request.questions)), [['lore_scene']]);
  assert.doesNotMatch(JSON.stringify(loreRequests), /Night toll|GATE-SECRET/, 'the continuity gate never sees private pick labels or content');
  assert.deepEqual(Object.values(controller.record!.story.lore).at(-1)!.refs, first.refs);
  controller.settings.lore.books.Gatehouse = { mode: 'assist', public: true };
  const reclassified = scriptJudge(controller, route('influence_negotiate'));
  host.composerValue = 'The scene continues.';
  await controller.directorSend();
  assert.ok(reclassified.some(request => 'lore_public_1_1' in request.questions));
  assert.ok(!reclassified.some(request => 'lore_scene' in request.questions), 'a visibility change requires independent public selection');
});

test('5: retrying a failed ruling retains successful lore picks and meter answers with no extra requests', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.modules.meters = true;
  controller.settings.lore.books.Atlas = { mode: 'assist', public: true };
  const firstAnswers: Record<string, Answer> = { ...route('influence_negotiate'), meter_1_regard: choice('warm') };
  delete firstAnswers.ruling;
  scriptJudge(controller, firstAnswers);
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue });
    host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = 'The guide answers.';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
    await host.emit('GENERATION_ENDED');
  };
  host.composerValue = 'Open the gate and I will pay.';
  await controller.directorSend();
  const first = Object.values(controller.record!.attempts).at(-1)!;
  const frozen = structuredClone(controller.record!.story.lore[first.loreCursor!]!);
  const meters = structuredClone(first.storyAfter!.meters);
  const message = host.chat().at(-1)!;
  host.swipeRight = async () => {
    message.swipe_id = message.swipes!.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
    message.mes = 'The guide opens the gate.';
    message.swipes!.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
    await host.emit('GENERATION_ENDED');
  };
  const retried = scriptJudge(controller, { ruling: noul(0.5) });
  await controller.retryJudge();
  assert.deepEqual(retried.map(request => Object.keys(request.questions)), [['ruling']]);
  const latest = Object.values(controller.record!.attempts).at(-1)!;
  assert.deepEqual(latest.storyAfter!.meters, meters);
  assert.deepEqual(controller.record!.story.lore[latest.loreCursor!]!.refs, frozen.refs);
  assert.deepEqual(controller.record!.story.lore[latest.loreCursor!]!.evidenceRefs, frozen.evidenceRefs);
});

test('lore binds to the attempt: later generations never re-arm an earlier turn\'s picks', async () => {
  const { host, controller } = await loreHarness();
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  scriptJudge(controller, route('influence_negotiate'));
  const seen = writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  assert.ok(seen[0]!.plan?.force.size);
  // A generation the Director did not start (group auto-mode, another member) right after the turn.
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
  assert.equal(host.armedLore(), null, 'a native generation is written without the turn\'s picks');
  await host.emit('GENERATION_ENDED');
  controller.settings.modules.lore = false;
  host.composerValue = 'I count out the coins.';
  await controller.directorSend();
  assert.equal(seen[1]!.plan, null, 'a turn without lore is written without the old picks');
  controller.settings.modules.lore = true;
  host.failCatalog = true;
  host.composerValue = 'I step through the gate.';
  await controller.directorSend();
  assert.equal(seen[2]!.plan, null, 'nor after a failed lore stage');
});

test('lore binds to the attempt: the writer\'s tool follow-up generation keeps the turn\'s picks', async () => {
  const { host, controller } = await loreHarness();
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  scriptJudge(controller, route('influence_negotiate'));
  const plans: (LorePlan | null)[] = [];
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    plans.push(host.armedLore());
    // SillyTavern keeps an assistant message with text before a tool call, then a tool message, then recurses.
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'Let me think.', swipe_id: 0, swipes: ['Let me think.'], swipe_info: [{ extra: {} }] } as HostChatMessage);
    host.chat().push({ name: 'Guide', is_user: false, is_system: true, mes: 'tool result', extra: {} } as HostChatMessage);
    const window = (controller as unknown as { toolWindow: { phase: string; attemptId: string } | null });
    const attemptId = (controller as unknown as { currentAttemptId: string }).currentAttemptId;
    window.toolWindow = { ...(window.toolWindow ?? { attemptId, permit: null, error: null }), phase: 'followup_pending' } as never;
    await host.emit('GENERATION_ENDED');
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    plans.push(host.armedLore());
  };
  await controller.directorSend();
  assert.deepEqual([...plans[0]!.force].sort(), ['Atlas.0', 'Gatehouse.0']);
  assert.deepEqual([...(plans[1]?.force ?? [])].sort(), ['Atlas.0', 'Gatehouse.0'], 'the follow-up is armed with the same picks');
});

test('lore: an unanswered book stays under keyword lore even when managed', async () => {
  const { host, controller } = await loreHarness();
  controller.settings.lore.books.Gatehouse = { mode: 'managed', public: false };
  host.composerValue = 'Open the gate tonight and I will pay the toll.';
  const script = route('influence_negotiate') as Record<string, Answer>;
  delete script.lore_1_2;
  scriptJudge(controller, script);
  const seen = writer(host, controller, 'The guide names the night price.');
  await controller.directorSend();
  const stored = Object.values(controller.record!.story.lore)[0]!;
  assert.deepEqual(stored.failed, ['Gatehouse']);
  assert.equal(seen[0]!.plan?.managed.size ?? 0, 0, 'no suppression for a book the judge did not answer');
  assert.match(turnEntry(controller).message, /No valid answer for Gatehouse; keyword lore stays on there/);
});
