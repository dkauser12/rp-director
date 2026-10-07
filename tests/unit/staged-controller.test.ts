import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { choice, harness, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');
const MIRA = actorIdFor('Mira', 'mira.png');

/** Staged pipeline with the default pack pinned and meters off, so each test counts only the move stages. */
async function staged(options: { group?: boolean } = {}) {
  const h = await harness(options);
  h.controller.settings.pipeline = 'staged';
  h.controller.settings.modules.meters = false;
  await h.controller.setChatPack('default');
  return h;
}

const routing = (owner: string, target: string, family: string, spec: string, antecedent = 'NONE') => ({
  owner: choice(owner), target: choice(target), family: choice(family), action_specification: choice(spec), antecedent: choice(antecedent),
});

test('C0: with every module off the Director stands aside: no request, no injection, no attempt', async () => {
  const { host, controller } = await harness({ group: true });
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  host.composerValue = 'I knock on the gate.';
  const requests = scriptJudge(controller, {});
  await controller.directorSend();
  assert.equal(requests.length, 0);
  assert.equal(host.generated.length, 1);
  assert.equal(host.injection, '');
  assert.equal(Object.keys(controller.record!.attempts).length, 0);
});

test('C0: speaker only is one request with nothing injected, and the chosen member writes', async () => {
  const { host, controller } = await harness({ group: true });
  controller.settings.modules = { speaker: true, decisions: false, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  host.composerValue = 'Mira, what do you think?';
  const requests = scriptJudge(controller, { speaker: choice(MIRA) });
  const writer = writerReplies(host, controller, 'Mira', 'mira.png', 'Mira shrugs.');
  await controller.directorSend();
  assert.equal(requests.length, 1);
  assert.deepEqual(Object.keys(requests[0]!.questions), ['speaker']);
  assert.equal(writer.injected(), '', 'nothing injected');
  assert.equal(host.generated[0]!.force_chid, 1, 'Mira (index 1) writes');
});

test('staged: the player\'s own attempt runs A, B and E, freezes on the player\'s words, and swipes reuse it for free', async () => {
  const { host, controller } = await staged();
  host.composerValue = 'I nod. "Open the gate for me, and I will pay double."';
  const requests = scriptJudge(controller, {
    move: choice('s2'), move_count: choice('one'),
    ...routing('player', GUIDE, 'influence_negotiate', 'SPECIFIED_HERE'),
    ruling: noul(0.45),
  });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide weighs the coin.');
  await controller.directorSend();
  assert.deepEqual(requests.map(r => Object.keys(r.questions)[0]), ['move', 'owner', 'ruling']);
  const resolution = Object.values(controller.record!.resolutions)[0]!;
  assert.equal(resolution.action.pipeline, 'staged');
  assert.equal(resolution.action.move!.passage, '"Open the gate for me, and I will pay double."');
  assert.equal(resolution.action.move!.route, 'DIRECT_ATTEMPT');
  assert.equal(resolution.action.actingActorId, 'player');
  assert.deepEqual(resolution.action.targetActorIds, [GUIDE]);
  assert.equal(resolution.action.requestedGain, '"Open the gate for me, and I will pay double."');
  assert.match(JSON.stringify(resolution.snapshot.state), /GUIDE-CARD/, 'the frozen evidence includes the target card');
  assert.match(writer.injected(), /Director ruling/);
  assert.match(writer.injected(), /Open the gate for me/);
  const before = requests.length;
  const message = host.chat().at(-1)!;
  message.swipe_id = message.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('wording reuse aborted'), 'swipe');
  assert.equal(requests.length, before, 'a wording swipe makes no request');
  assert.match(host.injection, /Open the gate for me/);
});

test('staged: a hand-off is not a failed check; the NPC answers it with a frozen initiative reaction', async () => {
  const { host, controller } = await staged();
  for (const key of Object.keys(controller.settings.reactions.weights.initiative)) controller.settings.reactions.weights.initiative[key] = key === 'raises_stakes' ? 1 : 0;
  host.composerValue = 'I lean back. "Go ahead, make me."';
  const requests = scriptJudge(controller, {
    move: choice('s2'), move_count: choice('one'),
    ...routing(GUIDE, 'player', 'UNSUPPORTED', 'UNSPECIFIED_INITIATIVE'),
  });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide raises an eyebrow.');
  await controller.directorSend();
  assert.equal(requests.length, 2, 'no ruling request');
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  const attempt = Object.values(controller.record!.attempts)[0]!;
  assert.equal(attempt.reaction?.kind, 'initiative');
  assert.equal(attempt.reaction?.outcome, 'raises_stakes');
  assert.equal(attempt.reaction?.actorId, GUIDE);
  assert.match(writer.injected(), /initiative → raises_stakes/);
});

test('staged: unresolved routing is explicitly unruled and the writer is not told a ruling', async () => {
  const { host, controller } = await staged();
  host.composerValue = 'Maybe someone should do something about this gate.';
  const requests = scriptJudge(controller, {
    move: choice('s1'), move_count: choice('one'),
    ...routing('UNRESOLVED', 'SCENE', 'overcome_operate', 'SPECIFIED_HERE'),
  });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'The guide waits.');
  await controller.directorSend();
  assert.equal(requests.length, 2);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  assert.doesNotMatch(writer.injected(), /Director ruling/);
  assert.ok(controller.record!.inspector.some(entry => /unruled/i.test(entry.message ?? '') && /owner/.test(entry.message ?? '')));
});

test('staged: under a player-only actor policy an order to an NPC is left unruled, with the reason', async () => {
  const { host, controller } = await staged({ group: true });
  assert.equal(controller.profile.actorPolicy, 'player_attempts');
  host.composerValue = 'Mira, pick that lock.';
  scriptJudge(controller, {
    speaker: choice(GUIDE), move: choice('s1'), move_count: choice('one'),
    ...routing(MIRA, 'SCENE', 'overcome_operate', 'SPECIFIED_HERE'),
    ruling: noul(0.7),
  });
  writerReplies(host, controller, 'Mira', 'mira.png', 'Mira looks at the lock.');
  await controller.directorSend();
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  assert.ok(controller.record!.inspector.some(entry => /unruled.*actor policy/i.test(entry.message ?? '')));
});

test('staged: an order to an NPC is ruled with that NPC acting, and that NPC writes the reply', async () => {
  const { host, controller } = await staged({ group: true });
  controller.settings.profileOverrides.binding = { actorPolicy: 'any_declared_actor' };
  controller.reloadProfile();
  host.composerValue = 'Mira, pick that lock.';
  const requests = scriptJudge(controller, {
    speaker: choice(GUIDE), move: choice('s1'), move_count: choice('one'),
    ...routing(MIRA, 'SCENE', 'overcome_operate', 'SPECIFIED_HERE'),
    ruling: noul(0.7),
  });
  writerReplies(host, controller, 'Mira', 'mira.png', 'Mira kneels at the lock.');
  await controller.directorSend();
  assert.equal(requests.length, 4, 'speaker and A in parallel, then B and E');
  const resolution = Object.values(controller.record!.resolutions)[0]!;
  assert.equal(resolution.action.actingActorId, MIRA);
  assert.equal(resolution.action.move!.route, 'SPECIFIED_NPC_MOVE');
  assert.equal(host.generated[0]!.force_chid, 1, 'the owner, Mira, writes the reply even though the speaker stage chose the guide');
  assert.match(JSON.stringify(resolution.snapshot.state), /MIRA-CARD/, 'overcome/operate reads the owner card');
});

test('staged: Reassess asks only the ruling again, on the frozen evidence', async () => {
  const { host, controller } = await staged();
  host.composerValue = '"Open the gate for me, and I will pay double."';
  const requests = scriptJudge(controller, {
    move: choice('s1'), move_count: choice('one'),
    ...routing('player', GUIDE, 'influence_negotiate', 'SPECIFIED_HERE'),
    ruling: noul(0.45),
  });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide weighs the coin.');
  await controller.directorSend();
  const frozen = Object.values(controller.record!.resolutions)[0]!;
  const before = requests.length;
  const script = scriptJudge(controller, { [controller.profile.drivingQuestionId]: noul(0.8) });
  await controller.reassess();
  assert.equal(requests.length, before);
  assert.equal(script.length, 1, 'one request');
  const question = Object.values(script[0]!.questions)[0]!;
  assert.match(question.instructions, /state\.move\.passage/, 'the staged ruling question, not the legacy one');
  assert.deepEqual(script[0]!.snapshot.state, frozen.snapshot.state, 'the same frozen evidence');
});
