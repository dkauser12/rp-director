import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowBadge, isWorkflowBadge, workflowBadgeLabel, WORKFLOW_BADGE_KEY } from '../../src/workflow-badge.ts';
import { freeze } from '../../src/resolver.ts';
import { newRecord } from '../../src/state.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import { Controller } from '../../src/controller.ts';
import { actorIdFor } from '../../src/identity.ts';
import type { GenerationAttempt } from '../../src/types.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

function fixture() {
  const record = newRecord('test', 'profile');
  record.actors.player = { actorId: 'player', avatar: 'persona', name: 'Player', control: 'user' };
  record.actors.guide = { actorId: 'guide', avatar: 'guide.png', name: 'Guide', control: 'npc' };
  record.story.secrets = [{ id: 'secret', text: 'The key is under the mat.', holders: ['player'] }];
  record.story.lore.loreTurn = { at: 1, refs: [{ world: 'Town', uid: 7, title: 'Gatehouse', score: 0.8 }], requests: 1, books: ['Town'], failed: [] };
  const attempt: GenerationAttempt = {
    attemptId: 'attempt', resolutionId: 'ruling', actorId: 'guide', cursorBefore: 'before', status: 'accepted',
    generationType: 'normal', hostMessageRef: 1, hostVariantRef: 0, variantId: 'reply', injectedText: 'Exact writer instruction.',
    epoch: 1, unadjudicated: false, createdAt: 1, loreCursor: 'loreTurn',
    frozenSpeaker: { questionId: null, eligibleActorIds: ['guide'], raw: null, adjusted: null, selected: 'guide', source: 'single', tieBroken: false },
    storyBefore: { at: 0, meters: { guide: { regard: 2 } }, knownBy: { secret: ['player'] } },
    storyAfter: { at: 1, meters: { guide: { regard: 3 } }, knownBy: { secret: ['player', 'guide'] } },
  };
  const resolution = freeze({
    resolutionId: 'ruling', previousResolutionId: null,
    action: { actionId: 'action', templateId: 'influence_negotiate', actingActorId: 'player', playerActorId: 'player', targetActorIds: ['guide'],
      attemptedAction: 'Open the gate for me.', requestedGain: 'The gate opens.', applicability: 'favorable', preconditions: [],
      move: { packId: 'default', packVersion: 4, spanId: 's1', passage: 'Please open the gate.', antecedent: null, route: 'DIRECT_ATTEMPT',
        familyKey: 'influence_negotiate', ownerId: 'player', targetId: 'guide', specification: 'SPECIFIED_HERE', count: 'one' } },
    snapshot: { chatId: 'chat', cursorBefore: 'before', stateRevision: 0, scopeId: 'public', profileRevision: 'profile', catalogRevision: '', actorBindingRevision: '', state: {} },
    assessment: { type: 'noul', noul: 0.8, confidence: null, provenance: 'fixture' }, decisionSource: 'provider', policyRevision: 'profile',
    band: { id: 'table-row', lowerInclusive: 0, upper: 1, upperInclusive: true, thresholdOutcome: 'at a price', sampleWeights: { 'at a price': 0.34, blocked: 0.66 } },
    method: 'sample', draw: 0.52, outcome: 'at a price', cursorBefore: 'before', generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1,
  });
  resolution.outcomeInstruction = 'The gate opens, but the guide asks for a favor.';
  return { attempt, resolution, record, pack: DEFAULT_PACK };
}

test('U3 badge contains the exact move, human route, frozen instruction, state changes and picked lore', () => {
  const input = fixture();
  const original = structuredClone(input);
  const badge = buildWorkflowBadge(input);
  assert.equal(workflowBadgeLabel(badge), 'Director · at a price · 34% · rolled 52');
  assert.equal(badge.move, 'Please open the gate.');
  assert.deepEqual(badge.route, { actorId: 'player', targetActorIds: ['guide'], kind: 'Influence / negotiate' });
  assert.equal(badge.results[0]!.instruction, 'The gate opens, but the guide asks for a favor.');
  assert.equal(badge.writerInstruction, input.attempt.injectedText);
  assert.deepEqual(badge.speaker, { actorId: 'guide', name: 'Guide' });
  assert.equal(badge.actorNames!.player, '{{user}}');
  assert.deepEqual(badge.meterChanges, [{ actorId: 'guide', meter: 'regard', label: 'regard for {{user}}', from: 2, to: 3, fromLabel: 'neutral', toLabel: 'warm' }]);
  assert.deepEqual(badge.reveals, [{ secretId: 'secret', text: 'The key is under the mat.', actorIds: ['guide'] }]);
  assert.deepEqual(badge.lore, [{ world: 'Town', uid: 7, title: 'Gatehouse' }]);
  assert.equal(isWorkflowBadge(badge), true);
  assert.deepEqual(input, original, 'badge construction cannot mutate frozen outcomes or story state');
  badge.route!.targetActorIds.push('another');
  badge.reveals![0]!.actorIds.push('another');
  badge.lore![0]!.title = 'Changed';
  assert.deepEqual(input, original, 'the badge owns its lists independently of the record');
});

test('U3 stored badge details isolate swipes even when the host has no swipe_info yet', () => {
  const input = fixture();
  const host = new TestHost();
  const message = host.chat()[1]!;
  delete message.swipe_info;
  const prose = message.mes;
  host.writeWorkflowBadge(1, buildWorkflowBadge(input));
  assert.ok(message.swipe_info![0]!.extra![WORKFLOW_BADGE_KEY]);
  message.swipes!.push('Another wording.'); message.swipe_id = 1; message.mes = 'Another wording.'; message.extra = {};
  input.attempt.attemptId = 'second'; input.resolution.draw = 0.8;
  host.writeWorkflowBadge(1, buildWorkflowBadge(input));
  assert.equal(host.readWorkflowBadge(1)!.results[0]!.draw, 0.8);
  message.swipe_id = 0; message.mes = prose; message.extra = structuredClone(message.swipe_info![0]!.extra);
  assert.equal(host.readWorkflowBadge(1)!.results[0]!.draw, 0.52);
  assert.equal(host.readWorkflowBadge(1)!.attemptId, 'attempt');
  assert.equal(message.swipes![0], prose);
  assert.doesNotMatch(message.mes, /RP_DIRECTOR/);
});

test('U3 no-ruling badges recover a selected move from successful judge answers and show the speaker', () => {
  const input = fixture();
  input.attempt.resolutionId = null;
  input.attempt.stageRecords = [{ stage: 'move', questions: { move: { type: 'choice', instructions: '', criteria: { s1: 'Guide, you lead the way.', NONE: 'No move.' } } }, state: {},
    result: { requestId: 'move', provider: 'mock', requestedModel: null, returnedModel: null, answers: { move: choice('s1') }, errors: {}, unresolvedQuestionIds: [], inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 } }];
  const badge = buildWorkflowBadge({ ...input, resolution: null });
  assert.equal(badge.move, 'Guide, you lead the way.');
  assert.equal(workflowBadgeLabel(badge), 'Director · Guide takes the lead');
  input.attempt.frozenSpeaker!.selected = 'YIELD';
  assert.equal(buildWorkflowBadge({ ...input, resolution: null }).speaker!.name, '{{user}}');
  input.attempt.reaction = { actorId: 'guide', kind: 'resolve', outcome: 'holds firm', draw: 0.2, instruction: 'Hold firm.' };
  assert.equal(workflowBadgeLabel(buildWorkflowBadge({ ...input, resolution: null })), 'Director · Guide · holds firm');
});

test('U3 unavailable badge keeps successful state and only offers retry for failed decision stages', () => {
  const input = fixture();
  input.attempt.judgeErrors = ['timeout']; input.attempt.judgeFailedStages = ['state'];
  let badge = buildWorkflowBadge(input);
  assert.equal(badge.retryEligible, false);
  assert.equal(badge.unavailable, true);
  assert.equal(badge.results[0]!.draw, 0.52);
  assert.equal(badge.meterChanges!.length, 1);
  input.attempt.judgeFailedStages = ['ruling'];
  badge = buildWorkflowBadge({ ...input, resolution: null });
  assert.equal(badge.retryEligible, true);
  assert.equal(badge.results.length, 0);
  assert.equal(workflowBadgeLabel(badge), 'Director · judge unavailable');
});

test('U3 legacy badges stay readable while malformed new detail fields are rejected', () => {
  const full = buildWorkflowBadge(fixture());
  const legacy = { schemaVersion: 1, attemptId: 'old', unavailable: false, errors: [], results: [], reaction: null };
  assert.equal(isWorkflowBadge(legacy), true);
  for (const changes of [{ actorNames: null }, { actorNames: { player: 4 } }, { move: {} }, { route: { actorId: 'guide', targetActorIds: [3], kind: 'move' } },
    { speaker: {} }, { writerInstruction: [] }, { meterChanges: [{}] }, { reveals: [{ secretId: 's', text: '', actorIds: [4] }] }, { lore: [null] }]) {
    assert.equal(isWorkflowBadge({ ...full, ...changes }), false);
  }
});

test('U3 badge and marker writes cannot mutate an earlier swipe through shared extra objects', () => {
  const host = new TestHost();
  const message = host.chat()[1]!;
  const first = buildWorkflowBadge(fixture());
  host.writeMarker(1, { v: 'first-reply', a: 'attempt', r: 'ruling' });
  host.writeWorkflowBadge(1, first);
  const earlier = structuredClone(message.swipe_info![0]!.extra);
  message.swipes!.push('Second wording.'); message.swipe_id = 1;
  message.extra = message.swipe_info![0]!.extra;
  message.swipe_info![1] = { extra: message.extra };
  host.writeMarker(1, { v: 'second-reply', a: 'second-attempt', r: 'second-ruling' });
  host.writeWorkflowBadge(1, { ...first, attemptId: 'second-attempt' });
  assert.deepEqual(message.swipe_info![0]!.extra, earlier);
  assert.equal(host.readWorkflowBadge(1)!.attemptId, 'second-attempt');
  message.extra = message.swipe_info![0]!.extra;
  host.writeWorkflowBadge(1, null);
  assert.deepEqual(message.swipe_info![0]!.extra, earlier, 'clearing selected data also uses copy-on-write');
  message.extra = message.swipe_info![0]!.extra;
  assert.equal(host.readWorkflowBadge(1), null, 'an empty selected slot cannot borrow the old message extra');
  message.swipe_id = message.swipes!.length;
  assert.equal(host.readWorkflowBadge(1), null, 'a not-yet-written swipe cannot display the prior result');
});

test('U2 explicit reassessment request belongs only to its new swipe, not later wording swipes', async t => {
  const host = new TestHost(); const controller = new Controller(host);
  t.after(() => controller.destroy()); await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  const requests = scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
    family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) });
  const scripted = controller.provider(); controller.provider = () => scripted;
  controller.settings.connection.kind = 'openrouter'; // Count the scripted requests; the fixture still performs no transport.
  writerReplies(host, controller, 'Guide', 'guide.png', 'First reply.');
  host.composerValue = 'Open the gate for me.'; await controller.directorSend();
  const reply = host.chat().at(-1)!;
  const messageId = host.chat().length - 1;
  const savedDetails = { ...host.readWorkflowBadge(messageId)!, meterChanges: [{ actorId: 'guide', meter: 'regard', label: 'regard for {{user}}', from: 2, to: 3, fromLabel: 'neutral', toLabel: 'warm' }],
    reveals: [{ secretId: 'old', text: 'A previously revealed secret.', actorIds: ['guide'] }], lore: [{ world: 'Town', uid: 1, title: 'An earlier lore pick' }] };
  host.writeWorkflowBadge(messageId, savedDetails);
  await controller.setChatPack('romance');
  await controller.loadChat();
  await host.emit('CHARACTER_MESSAGE_RENDERED', messageId);
  assert.deepEqual(host.readWorkflowBadge(messageId), savedDetails, 'later pack and secret changes cannot reinterpret saved badge details');
  host.swipeRight = async () => {
    reply.swipe_id = reply.swipes!.length;
    await host.emit('MESSAGE_SWIPED', messageId);
    await controller.interceptor([], 4096, () => assert.fail('unexpected swipe abort'), 'swipe');
    reply.mes = `Reply ${reply.swipe_id}.`; reply.swipes!.push(reply.mes);
    await host.emit('MESSAGE_RECEIVED', messageId, 'swipe');
    await host.emit('GENERATION_ENDED');
  };
  const callsBefore = requests.length;
  assert.equal(await controller.reassess(true), true);
  const reassessedId = Object.values(controller.record!.attempts).at(-1)!.attemptId;
  const event = controller.record!.inspector.find(entry => entry.kind === 'reroll')!;
  assert.equal(event.attemptId, reassessedId);
  assert.equal(event.networkCalls, 1);
  assert.equal(requests.length, callsBefore + 1);
  await host.swipeRight();
  const wordingId = Object.values(controller.record!.attempts).at(-1)!.attemptId;
  assert.notEqual(wordingId, reassessedId);
  assert.equal(requests.length, callsBefore + 1);
  assert.equal(controller.record!.inspector.filter(entry => entry.attemptId === wordingId).reduce((count, entry) => count + entry.networkCalls, 0), 0);
  assert.equal(controller.record!.inspector.find(entry => entry.id === event.id)!.attemptId, reassessedId);
});
