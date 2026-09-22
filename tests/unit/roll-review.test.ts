import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPermit, rerollPermit } from '../../src/roll-review.ts';
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

test('tool result remains pending until user keeps the roll; resampling preserves the assessment and old permit', async () => {
  const initial = await permit();
  const original = structuredClone(initial);
  let choose!: (value: 'keep' | 'reroll' | 'cancel') => void;
  let resolved = false;
  let reviews = 0;
  const held = reviewPermit({ initial, method: 'sample', signal: new AbortController().signal, isCurrent: () => true,
    choose: async () => { reviews++; return new Promise(resolve => { choose = resolve; }); },
    reroll: async value => rerollPermit(value, initial.profile!, { npc: 'Nia', player: 'Player' }, 'Player', () => 0.99),
  }).then(value => { resolved = true; return value; });
  await Promise.resolve();
  assert.equal(resolved, false);
  choose('reroll');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reviews, 2);
  assert.equal(resolved, false);
  choose('keep');
  const kept = await held;
  assert.ok(kept);
  assert.equal(kept.actions[0]!.draw, 0.99);
  assert.deepEqual(kept.actions[0]!.assessment, initial.actions[0]!.assessment);
  assert.equal(kept.reviewHistory!.length, 1);
  assert.deepEqual(initial, original);
});

test('Cancel, Stop and stale context cannot return a permit to the recursive writer', async () => {
  const initial = await permit();
  for (const reason of ['cancel', 'abort', 'stale']) {
    const abort = new AbortController();
    let current = true;
    const result = await reviewPermit({ initial, method: 'sample', signal: abort.signal, isCurrent: () => current,
      choose: async () => { if (reason === 'abort') abort.abort(); if (reason === 'stale') current = false; return reason === 'cancel' ? 'cancel' : 'keep'; },
      reroll: async () => { throw new Error('should not reroll'); },
    });
    assert.equal(result, null, reason);
  }
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
  assert.match(DIRECTOR_TOOL_DESCRIPTION, /pauses for the user/);
});
