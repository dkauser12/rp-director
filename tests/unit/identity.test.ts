import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash53, canonicalText, rootCursor, extendCursor, cursorChain, prefixCursor, actorIdFor, drawFromUint32, newId } from '../../src/identity.ts';
import { buildState, checkBatch, speakerQuestion, gainNoulQuestion } from '../../src/questions.ts';
import { bindingBlock, advisoryBlock, combinedBlock } from '../../src/prompts.ts';

test('hash is deterministic and sensitive', () => {
  assert.equal(hash53('a'), hash53('a'));
  assert.notEqual(hash53('a'), hash53('b'));
  assert.equal(hash53('x').length, 16);
});

test('cursors ignore timestamps and cosmetic whitespace but not text or actor identity', () => {
  const seed = 'seed';
  const a = prefixCursor(seed, [{ role: 'user', actorKey: 'persona', text: 'Oren, let me through.' }, { role: 'assistant', actorKey: 'oren.png', text: 'Show your permit.' }]);
  const b = prefixCursor(seed, [{ role: 'user', actorKey: 'persona', text: 'Oren,  let me through. ' }, { role: 'assistant', actorKey: 'oren.png', text: 'Show your permit.\r\n' }]);
  assert.equal(a, b);
  const c = prefixCursor(seed, [{ role: 'user', actorKey: 'persona', text: 'Oren, let me through.' }, { role: 'assistant', actorKey: 'oren2.png', text: 'Show your permit.' }]);
  assert.notEqual(a, c, 'M1-10: same display text from a different durable actor is a different prefix');
  const d = prefixCursor(seed, [{ role: 'user', actorKey: 'persona', text: 'Oren, let me through.' }, { role: 'assistant', actorKey: 'oren.png', text: 'Show your permit!' }]);
  assert.notEqual(a, d);
  assert.notEqual(prefixCursor('other', []), rootCursor(seed));
});

test('cursor chain has one entry per prefix and extends incrementally', () => {
  const msgs = [{ role: 'user' as const, actorKey: 'persona', text: 'hi' }, { role: 'assistant' as const, actorKey: 'a.png', text: 'hello' }];
  const chain = cursorChain('s', msgs);
  assert.equal(chain.length, 3);
  assert.equal(chain[0], rootCursor('s'));
  assert.equal(chain[1], extendCursor(chain[0]!, msgs[0]!));
  assert.equal(chain[2], prefixCursor('s', msgs));
  assert.equal(canonicalText('  a \t b\n\n\n\nc '), 'a b\n\nc');
});

test('actor ids stay distinct for duplicate display names', () => {
  assert.notEqual(actorIdFor('Oren', 'oren.png'), actorIdFor('Oren', 'oren (1).png'));
  assert.equal(actorIdFor('Oren', 'oren.png'), actorIdFor('Oren', 'oren.png'));
  assert.match(actorIdFor('Guard Ören!', 'x'), /^guard-ren-[0-9a-f]{6}$/);
});

test('draw mapping and ids', () => {
  assert.equal(drawFromUint32(0), 0);
  assert.ok(drawFromUint32(0xffffffff) < 1);
  assert.notEqual(newId('a'), newId('a'));
  assert.match(newId('att'), /^att_/);
});

test('buildState never truncates the newest input and drops oldest messages first', () => {
  const recent = Array.from({ length: 10 }, (_, i) => ({ actorId: 'oren', role: 'assistant' as const, text: `message ${i} ` + 'x'.repeat(200) }));
  const built = buildState({
    scopeId: 'shared-public', actors: { player: { actorId: 'player', avatar: 'persona', name: 'Dom', control: 'user' }, oren: { actorId: 'oren', avatar: 'oren.png', name: 'Oren', control: 'npc' } },
    eligibleActorIds: ['oren'], publicCards: { oren: 'Gate guard.' }, facts: { permitPresented: false }, action: null, latestInput: 'NEWEST',
    recentMessages: recent, sceneId: 1, acceptedReplyCount: 3, maxRecentMessages: 6, maxSerializedCharacters: 900,
  });
  const state = built.state as any;
  assert.equal(state.latestInput, 'NEWEST');
  assert.ok(state.recentAcceptedMessages.length < 6);
  assert.equal(state.recentAcceptedMessages.at(-1).text.startsWith('message 9'), true);
  assert.ok(built.exclusions.length >= 1);
  assert.equal(built.overBudget, false);
  assert.equal(state.actors.oren.authorialCharacterContext, 'Gate guard.');
});

test('detection snapshots omit raw card descriptions and carry only declared observer-visible cues', async () => {
  const { declareAction } = await import('../../src/templates.ts');
  const action = declareAction({ actionId: 'a', templateId: 'detect_discover', actingActorId: 'player', playerActorId: 'player', targetActorIds: ['oren'], attemptedAction: 'watches Oren', requestedGain: 'Oren is hiding a key', applicability: 'favorable', availableEvidence: 'Oren repeatedly touches one coat pocket' })!;
  const built = buildState({
    scopeId: 'shared-public', actors: { player: { actorId: 'player', avatar: 'persona', name: 'Dom', control: 'user' }, oren: { actorId: 'oren', avatar: 'oren.png', name: 'Oren', control: 'npc' } },
    eligibleActorIds: ['oren'], publicCards: { oren: 'SECRET: the key is in his coat.' }, facts: {}, action, latestInput: 'I watch him.', recentMessages: [], sceneId: 1, acceptedReplyCount: 0, maxRecentMessages: 6, maxSerializedCharacters: 900,
  });
  const state = built.state as any;
  assert.equal(state.actors.oren.authorialCharacterContext, undefined);
  assert.equal(state.action.availableEvidence, 'Oren repeatedly touches one coat pocket');
  assert.ok(built.exclusions.some(x => /detection/.test(x)));
});

test('M3-19: dependent questions and mixed private scopes are rejected from one batch', () => {
  const q = { speaker: speakerQuestion(['oren'], { oren: 'Oren' }, true, null), gain_noul: gainNoulQuestion() };
  assert.equal(checkBatch(q, 48, ['shared-public', 'shared-public']).ok, true);
  assert.equal(checkBatch(q, 48, ['shared-public', 'private-oren']).ok, false);
  const dependent = { ...q, follow: { type: 'noul' as const, instructions: 'Given answers.speaker, is the chosen actor hostile to the player right now?' } };
  assert.equal(checkBatch(dependent, 48, ['shared-public']).ok, false);
  assert.equal(checkBatch(q, 1, ['shared-public']).ok, false);
});

test('binding and advisory blocks stay separate; zero influence removes only advisory text', () => {
  const action = { actionId: 'a1', templateId: 'obtain_access', playerActorId: 'player', targetActorIds: ['oren'], attemptedAction: 'asks for passage', requestedGain: 'passage now', applicability: 'favorable' as const, preconditions: [], outcomeText: { deferred: { required: ['Oren does not let the player through.'], forbidden: ['Passage granted.'] }, progress_only: { required: [], forbidden: [] }, achieved: { required: [], forbidden: [] } }, effectsByOutcome: { deferred: [], progress_only: [], achieved: [] } };
  const binding = bindingBlock({ action, outcome: 'deferred', instruction: '{{target}} does not give {{gain}} to {{player}}. Forbidden: passage granted.', speakerName: 'Oren', playerName: 'Dom', targetNames: ['Oren'] });
  assert.match(binding, /Ruling: deferred\./);
  assert.match(binding, /Do not roll dice or run another check/);
  assert.match(binding, /Oren does not give passage now to Dom\. Forbidden: passage granted\./);
  assert.equal(advisoryBlock({ influence: 0, notes: ['linger'] }), '');
  assert.match(advisoryBlock({ influence: 0.5, notes: ['linger'] }), /advisory/);
  assert.equal(combinedBlock(binding, ''), binding);
  assert.match(combinedBlock(binding, advisoryBlock({ influence: 1, notes: ['n'] })), /binding[\s\S]*advisory/);
});
