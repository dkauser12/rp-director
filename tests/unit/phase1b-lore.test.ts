import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLoreSettings, lorePlan, normalizeLoreSettings } from '../../src/lore/settings.ts';
import { loreSceneAnchor, runLoreStage } from '../../src/lore/stage.ts';
import { buildTree } from '../../src/lore/tree.ts';
import { placeLorePick } from '../../src/lore/apply.ts';
import type { Answer, EvaluationResult } from '../../src/types.ts';

const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' });
const result = (answers: Record<string, Answer>): EvaluationResult => ({ requestId: 'r', provider: 'mock', requestedModel: null, returnedModel: null, answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 1 });
const books = [{ tree: buildTree('Guidebook', [{ world: 'Guidebook', uid: 1, title: 'Harbour', keys: ['harbour'], content: 'Ships arrive at the harbour.', constant: false, disabled: false }], null)!, public: true }];
const refs = [{ world: 'Guidebook', uid: 1, title: 'Harbour', score: 0.9 }];
const beam = { width: 2, maxEntries: 5, maxDepth: 3, minProbability: 0.1 };

test('33/34: continuity stores a bounded public scene anchor', () => {
  const anchor = loreSceneAnchor({ latestInput: 'A'.repeat(10000) + '<details>HIDDEN', recentAcceptedMessages: Array.from({ length: 8 }, () => ({ speaker: 'Guide', role: 'assistant', text: 'B'.repeat(10000) + '<details>HIDDEN' })), irrelevantPrivateField: 'PRIVATE' });
  assert.ok(JSON.stringify(anchor).length < 3400);
  assert.doesNotMatch(JSON.stringify(anchor), /HIDDEN|PRIVATE/);
  assert.equal((anchor as { recentAcceptedMessages: unknown[] }).recentAcceptedMessages.length, 2);
});

test('33: writer lore picks default to near-end placement and preserve an explicit opt-out', () => {
  assert.equal(defaultLoreSettings().placeNearEnd, true);
  assert.equal(normalizeLoreSettings({}).placeNearEnd, true);
  assert.equal(normalizeLoreSettings({ placeNearEnd: false }).placeNearEnd, false);
  assert.equal(lorePlan(refs, () => 'assist', ['Guidebook']).nearEnd, true);
  assert.equal(lorePlan(refs, () => 'assist', ['Guidebook'], [], false).nearEnd, false);
  const authored = { world: 'Guidebook', uid: 1, position: 0, depth: 4, content: 'Harbour lore.' };
  assert.deepEqual(placeLorePick(authored), { ...authored, position: 4, depth: 1 });
  assert.equal(authored.position, 0);
  assert.deepEqual(placeLorePick(authored, false), authored);
});

test('33: same-scene lore keeps the previous picks instead of repeating the tree walk', async () => {
  const questions: string[][] = [];
  const out = await runLoreStage(books, () => async asked => { questions.push(Object.keys(asked)); return result({ lore_scene: choice('SAME') }); }, beam, { previous: { refs, evidenceRefs: refs }, sceneQuestion: { type: 'choice', instructions: 'Did the public scene change?', criteria: { SAME: 'Same', CHANGED: 'Changed' } } });
  assert.deepEqual(questions, [['lore_scene']]);
  assert.deepEqual(out.refs, refs);
  assert.equal(out.evidence[0]?.text, 'Ships arrive at the harbour.');
  assert.equal(out.requests, 1);
});

test('33: a changed scene reselects lore, while a failed scene check preserves valid picks', async () => {
  const questions: string[][] = [];
  const out = await runLoreStage(books, () => async asked => { questions.push(Object.keys(asked)); return result(Object.fromEntries(Object.keys(asked).map(id => [id, choice(id === 'lore_scene' ? 'CHANGED' : 'NONE')]))); }, beam, { previous: { refs, evidenceRefs: refs }, sceneQuestion: { type: 'choice', instructions: 'Did the scene change?', criteria: { SAME: 'Same', CHANGED: 'Changed' } } });
  assert.ok(questions.length > 1);
  assert.deepEqual(out.refs, []);
  const failed = await runLoreStage(books, () => async () => { throw new Error('temporary failure'); }, beam, { previous: { refs, evidenceRefs: refs }, sceneQuestion: { type: 'choice', instructions: 'Did the scene change?', criteria: { SAME: 'Same', CHANGED: 'Changed' } } });
  assert.deepEqual(failed.refs, refs);
});
