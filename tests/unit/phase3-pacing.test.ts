import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freezePacing, pacingBlock, pacingQuestions, SCENE_TYPES } from '../../src/pacing.ts';
import type { PacingOptions } from '../../src/pacing.ts';
import { runStaged } from '../../src/pipeline/staged.ts';
import type { StagedInput, StageId } from '../../src/pipeline/staged.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import { DEFAULT_PACING_TEXTS, normalizeUiPreferences } from '../../src/ui-preferences.ts';
import type { Answer, EvaluationResult, Json, Question } from '../../src/types.ts';
import { harness, scriptJudge, writerReplies } from './support/test-host.ts';

const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' });
const options = (changes: Partial<PacingOptions> = {}): PacingOptions => ({ texts: structuredClone(DEFAULT_PACING_TEXTS), handBack: true, dynamicResponse: false, playerName: 'Player', ...changes });
const input = (changes: Partial<StagedInput> = {}): StagedInput => ({
  pack: DEFAULT_PACK, playerId: 'player',
  actors: { player: { name: 'Player', control: 'user' }, guide: { name: 'Guide', control: 'npc', card: 'PRIVATE-CARD' } },
  eligibleNpcIds: ['guide'], latestInput: 'I wait for the guide. <details>HIDDEN-INPUT</details>',
  transcript: [{ actorId: 'guide', role: 'assistant', text: 'The guide checks the gate. <details>HIDDEN-TRANSCRIPT</details>' }],
  modules: { decisions: true, speaker: true, reactions: true }, speakerQuestion: null, reactionQuestions: {}, maxChars: 60000,
  pacing: options(), ...changes,
});
const result = (answers: Record<string, Answer>): EvaluationResult => ({ requestId: 'test', provider: 'mock', requestedModel: null, returnedModel: null, answers, errors: {}, unresolvedQuestionIds: [], inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 1 });
function fixture(answers: Record<string, Answer>) {
  const calls: { stage: StageId; questions: Record<string, Question>; state: Json }[] = [];
  return { calls, env: { async evaluate(stage: StageId, questions: Record<string, Question>, state: Json) {
    calls.push({ stage, questions, state });
    return result(Object.fromEntries(Object.keys(questions).filter(id => answers[id]).map(id => [id, answers[id]!])));
  } } };
}

test('C1/C5: scene and hand-back share the speaker request without widening a full move request', async () => {
  const reaction: Question = { type: 'choice', instructions: 'Choose a reaction.', criteria: { none: 'None' } };
  const reactions = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`npc${i}`, reaction]));
  const answers: Record<string, Answer> = { speaker: choice('guide'), scene: choice('conversation'), hand_back: choice('HAND_BACK'), move: choice('NONE'), move_count: choice('one') };
  for (let i = 1; i <= 14; i++) answers[`npc_reaction_${i}`] = choice('none');
  const run = fixture(answers);
  const out = await runStaged(input({ reactionQuestions: reactions, speakerQuestion: { type: 'choice', instructions: 'Choose a speaker.', criteria: { guide: 'Guide' } } }), run.env);
  assert.equal(out.pacing?.scene, 'conversation');
  assert.equal(out.pacing?.handBack, 'HAND_BACK');
  assert.deepEqual(run.calls.map(call => [call.stage, Object.keys(call.questions).length]), [['speaker', 3], ['move', 16]]);
  assert.deepEqual(Object.keys(run.calls[0]!.questions), ['speaker', 'scene', 'hand_back']);
  assert.doesNotMatch(JSON.stringify(run.calls), /PRIVATE-CARD|HIDDEN-INPUT|HIDDEN-TRANSCRIPT/);
});

test('C1/C5: pacing works alone and all modules off make zero requests', async () => {
  const run = fixture({ scene: choice('travel'), hand_back: choice('CONTINUE') });
  const source = input({ modules: { decisions: false, speaker: false, reactions: false } });
  const out = await runStaged(source, run.env);
  assert.equal(out.outcome, 'no_move');
  assert.equal(out.pacing?.scene, 'travel');
  assert.deepEqual(run.calls.map(call => [call.stage, Object.keys(call.questions)]), [['pacing', ['scene', 'hand_back']]]);
  const off = fixture({});
  assert.equal((await runStaged({ ...source, pacing: undefined }, off.env)).pacing, null);
  assert.equal(off.calls.length, 0);
});

test('C1: the public pacing request starts in parallel with move selection', async () => {
  const started: StageId[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const pending = runStaged(input(), { async evaluate(stage) {
    started.push(stage);
    if (stage === 'pacing') { await held; return result({ scene: choice('combat'), hand_back: choice('CONTINUE') }); }
    return result({ move: choice('NONE'), move_count: choice('one') });
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['pacing', 'move']);
  release();
  assert.equal((await pending).pacing?.scene, 'combat');
});

test('C1/C5: hand-back off asks only the scene question and failure preserves independent answers', async () => {
  const off = fixture({ scene: choice('downtime') });
  const out = await runStaged(input({ pacing: options({ handBack: false }) }), off.env);
  assert.equal(out.pacing?.handBack, null);
  assert.deepEqual(Object.keys(off.calls[0]!.questions), ['scene']);
  assert.equal(pacingBlock(out.pacing), '');
  const partial = fixture({ speaker: choice('guide'), scene: choice('invalid'), hand_back: choice('HAND_BACK'), move: choice('NONE'), move_count: choice('one') });
  const mixed = await runStaged(input({ speakerQuestion: { type: 'choice', instructions: 'Choose.', criteria: { guide: 'Guide' } } }), partial.env);
  assert.equal(mixed.outcome, 'no_move');
  assert.equal(mixed.speakerAnswer?.type, 'choice');
  assert.equal(mixed.pacing?.scene, null);
  assert.equal(mixed.pacing?.handBack, 'HAND_BACK');
  assert.match(mixed.errors[0]!.message, /scene/);
});

test('C1/C5: pacing transport failure fails open without changing the move decision', async () => {
  const out = await runStaged(input(), { async evaluate(stage) {
    if (stage === 'pacing') throw new Error('Connection lost.');
    return result({ move: choice('NONE'), move_count: choice('one') });
  } });
  assert.equal(out.outcome, 'no_move');
  assert.equal(out.pacing, null);
  assert.equal(out.errors[0]?.type, 'network');
});

test('C1: editable scene instructions freeze their original text and preserve anti-skip defaults', () => {
  const preferences = options();
  preferences.texts.travel = 'Stop when {{user}} reaches the next decision.';
  const frozen = freezePacing({ scene: choice('travel'), hand_back: choice('CONTINUE') }, preferences)!;
  preferences.texts.travel = 'Later edited text.';
  assert.match(pacingBlock(frozen), /Stop when Player reaches the next decision/);
  assert.doesNotMatch(pacingBlock(frozen), /Later edited|\{\{user\}\}/);
  assert.match(pacingBlock(frozen), /Do not skip time/);
  assert.match(DEFAULT_PACING_TEXTS.conversation, /scene’s own systems/);
  for (const scene of SCENE_TYPES.filter(value => value !== 'downtime')) {
    const text = pacingBlock(freezePacing({ scene: choice(scene) }, options({ handBack: false })));
    assert.match(text, /Do not skip time/);
  }
  assert.equal(pacingBlock(freezePacing({ scene: choice('downtime') }, options({ handBack: false }))), '');
  assert.deepEqual(Object.keys(pacingQuestions(false)), ['scene']);
});

test('C5: Dynamic Response only emits the tag instruction for a frozen HAND_BACK', () => {
  const answers = { scene: choice('conversation'), hand_back: choice('HAND_BACK') };
  const present = freezePacing(answers, options({ dynamicResponse: true }))!;
  const absent = freezePacing(answers, options({ dynamicResponse: false }))!;
  assert.match(pacingBlock(present, true, true), /<dynamic_response>a brief in-fiction cue<\/dynamic_response>/);
  assert.match(pacingBlock(present, true, true), /on its own line at the very end/);
  assert.match(pacingBlock(absent), /first beat where Player must respond or act/);
  assert.doesNotMatch(pacingBlock(absent), /dynamic_response/);
  assert.doesNotMatch(pacingBlock(present, false, true), /hand-back|dynamic_response/);
  assert.doesNotMatch(pacingBlock(freezePacing({ ...answers, hand_back: choice('CONTINUE') }, options({ dynamicResponse: true }))), /dynamic_response/);
  assert.equal(freezePacing({}, options()), null);
});

test('C5: hand-back switch defaults on and preserves saved false', () => {
  assert.equal(normalizeUiPreferences().handBackBeats, true);
  assert.equal(normalizeUiPreferences({ handBackBeats: false }).handBackBeats, false);
});

test('C1/C5: a wording swipe freezes scene and edited text while checking live Dynamic Response presence without new requests', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false, pacing: true, replyCheck: false };
  controller.settings.reactions.enabled = false;
  controller.settings.pacingTexts.conversation = 'Answer Player with a small action.';
  host.context.extensionSettings.dynamic_response = { enabled: true };
  await controller.setChatPack('default');
  const requests = scriptJudge(controller, { scene: choice('conversation'), hand_back: choice('HAND_BACK') });
  const writer = writerReplies(host, controller, 'Guide', 'guide.png', 'Which path will you take?');
  host.composerValue = 'Show me the paths.';
  await controller.directorSend();
  const source = Object.values(controller.record!.attempts).at(-1)!;
  const frozen = structuredClone(source.frozenPacing);
  assert.equal(frozen?.scene, 'conversation');
  assert.equal(frozen?.handBack, 'HAND_BACK');
  assert.match(writer.injected(), /Answer Player with a small action/);
  assert.match(writer.injected(), /dynamic_response/);
  const before = requests.length;
  controller.settings.pacingTexts.conversation = 'LATER EDIT';
  host.context.extensionSettings.dynamic_response = { enabled: false };
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(requests.length, before);
  assert.deepEqual(Object.values(controller.record!.attempts).at(-1)!.frozenPacing, frozen);
  assert.match(host.injection, /Answer Player with a small action/);
  assert.doesNotMatch(host.injection, /dynamic_response/);
  assert.doesNotMatch(host.injection, /LATER EDIT/);
  await host.emit('GENERATION_ENDED');
  controller.settings.handBackBeats = false;
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.match(host.injection, /Director pacing/);
  assert.doesNotMatch(host.injection, /Director hand-back|dynamic_response/);
  await host.emit('GENERATION_ENDED');
  controller.settings.modules.pacing = false;
  await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'swipe');
  assert.equal(host.injection, '');
  assert.equal(requests.length, before);
});
