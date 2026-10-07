import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerollPermit } from '../../src/roll-review.ts';
import { adjudicateTurnProposal, DIRECTOR_TOOL_DESCRIPTION, writerPermit } from '../../src/director-tool.ts';
import { profileById } from '../../src/profiles.ts';
import { createMockProvider } from '../../src/providers.ts';
import type { TurnPermit } from '../../src/types.ts';

async function permit(): Promise<TurnPermit> {
  const profile = profileById('binding-dice')!;
  const provider = createMockProvider({ scenario: 'test', scenarios: { test: { answers: { planned_1: 0.8 } } } });
  return (await adjudicateTurnProposal({
    proposal: { schemaVersion: 1, requestId: 'req', attemptId: 'a1', speakerActorId: 'npc', actions: [{
      proposalId: 'push', actingActorId: 'npc', targetActorIds: ['player'], family: 'contest_impose',
      method: 'pushes the door', boundedResult: 'the door opens', failureStake: { kind: 'delay', detail: 'the door stays closed' }, opposed: true, evidenceRefs: [],
    }] }, provider, profile, actorNames: { npc: 'Nia', player: 'Player' }, playerName: 'Player', signal: new AbortController().signal,
    snapshot: { chatId: 'chat', cursorBefore: 'c0', stateRevision: 0, scopeId: 'public', profileRevision: profile.revision, catalogRevision: '', actorBindingRevision: '', state: { sceneId: 1 } },
  })).permit;
}

test('explicit NPC dice reroll preserves the assessment and original permit', async () => {
  const initial = await permit();
  const original = structuredClone(initial);
  const next = rerollPermit(initial, initial.profile!, { npc: 'Nia', player: 'Player' }, 'Player', () => 0.99);
  assert.equal(next.actions[0]!.draw, 0.99);
  assert.deepEqual(next.actions[0]!.assessment, initial.actions[0]!.assessment);
  assert.notEqual(next.permitId, initial.permitId);
  assert.equal(next.previousPermitId, initial.permitId);
  assert.deepEqual(initial, original);
});

test('writer gets final values but never stored snapshots, table or rejected roll history', async () => {
  const initial = await permit();
  initial.reviewHistory = [{ permitId: 'old', actions: [], choice: 'reroll', at: 1 }];
  const result = writerPermit(initial);
  assert.ok(result.actions[0]?.assessment);
  assert.equal('profile' in result, false);
  assert.equal('snapshot' in result, false);
  assert.equal('reviewHistory' in result, false);
  assert.match(DIRECTOR_TOOL_DESCRIPTION, /reasoning/);
  assert.match(DIRECTOR_TOOL_DESCRIPTION, /may show its results for review/);
  assert.doesNotMatch(DIRECTOR_TOOL_DESCRIPTION, /pauses for the user/);
});
