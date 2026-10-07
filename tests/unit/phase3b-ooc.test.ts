import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStaged } from '../../src/pipeline/staged.ts';
import { isOutOfCharacterMessage, stripOutOfCharacterSegments } from '../../src/pipeline/spans.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import { actorIdFor } from '../../src/identity.ts';
import { choice, harness, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const mixed = [
  ['OOC: sorry, I was away for a bit.\n\nI draw my sword and charge the guard.', 'I draw my sword and charge the guard.'],
  ['(OOC: time skip to midnight) I pick the lock on the vault door (as quietly as I can)', 'I pick the lock on the vault door (as quietly as I can)'],
  ['[OOC: brb after this] I slip the ring off her finger [sleight of hand]', 'I slip the ring off her finger [sleight of hand]'],
  ['I open the gate. (OOC: back soon (probably)) I step through.', 'I open the gate.   I step through.'],
];

test('3b/2: OOC segments preserve the fictional move and are absent from judge candidates', async () => {
  for (const [text, remaining] of mixed) {
    assert.equal(isOutOfCharacterMessage(text!), false);
    assert.equal(stripOutOfCharacterSegments(text!), remaining);
    let moveAsked = false;
    await runStaged({
      pack: DEFAULT_PACK, playerId: 'player',
      actors: { player: { name: 'Player', control: 'user' }, guide: { name: 'Guide', control: 'npc' } },
      eligibleNpcIds: ['guide'], latestInput: text!, transcript: [],
      modules: { speaker: false, decisions: true, reactions: false }, speakerQuestion: null, reactionQuestions: {}, maxChars: 60000,
    }, { evaluate: async (_stage, questions, state) => {
      moveAsked ||= 'move' in questions;
      assert.doesNotMatch(JSON.stringify({ questions, state }), /OOC:|brb|midnight|sorry|probably/);
      return { requestId: 'r', provider: 'mock', requestedModel: null, returnedModel: null, answers: { move: choice('NONE'), move_count: choice('one') }, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
    } });
    assert.equal(moveAsked, true, text);
  }
});

test('3b/2: only explicit OOC text with no remaining action is wholly OOC', () => {
  for (const text of ['OOC: pause for a moment.', '(OOC: pause)', '[OOC: pause]', '(OOC: pause) [OOC: still paused]']) assert.equal(isOutOfCharacterMessage(text), true);
  assert.equal(isOutOfCharacterMessage('I pause.'), false);
  assert.equal(isOutOfCharacterMessage(''), false);
});

test('3b/2: a wholly OOC Send leaves a manual declaration armed for the next real move', async () => {
  const { controller, host } = await harness();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('default');
  controller.setActionDraft({ templateId: 'influence_negotiate', actingActorId: 'player', targetActorIds: [actorIdFor('Guide', 'guide.png')], attemptedAction: 'Ask the guide to open the gate.', requestedGain: 'The gate opens.', applicability: 'favorable', uncertainConsequential: true, opposed: false, failureStakeKind: 'delay', failureStakeDetail: 'The gate remains shut.', availableEvidence: 'The guide has the key.' });
  const declaration = controller.actionDraft;
  const requests = scriptJudge(controller, {});
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide waits.');
  host.composerValue = '(OOC: pause for a moment)';
  await controller.directorSend();
  assert.equal(requests.length, 0);
  assert.deepEqual(controller.actionDraft, declaration);
  const nextRequests = scriptJudge(controller, { ruling: noul(0.5) });
  host.composerValue = '(OOC: back now) I ask the guide to open the gate.';
  await controller.directorSend();
  assert.deepEqual(nextRequests.map(request => Object.keys(request.questions)), [['ruling']]);
  assert.equal(Object.keys(controller.record!.resolutions).length, 1);
  assert.equal(controller.actionDraft, null);
});
