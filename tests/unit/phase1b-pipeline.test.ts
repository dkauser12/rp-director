import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleText } from '../../src/pipeline/spans.ts';
import { runStaged } from '../../src/pipeline/staged.ts';
import type { StagedInput } from '../../src/pipeline/staged.ts';
import { DEFAULT_PACK } from '../../src/pack/pack.ts';
import { DIRECTOR_TOOL_DESCRIPTION, permitFollowupBlock, toolPlanningBlock } from '../../src/director-tool.ts';
import { bindingBlock } from '../../src/prompts.ts';
import { stateBlock } from '../../src/pipeline/character-state.ts';
import { actorIdFor } from '../../src/identity.ts';
import { choice, harness, scriptJudge } from './support/test-host.ts';
import type { Answer, EvaluationResult } from '../../src/types.ts';

const result = (answers: Record<string, Answer>): EvaluationResult => ({ requestId: 'r', provider: 'mock', requestedModel: null, returnedModel: null, answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 1 });
const input = (latestInput: string): StagedInput => ({ pack: DEFAULT_PACK, playerId: 'player', actors: { player: { name: 'Player', control: 'user' }, guide: { name: 'Guide', control: 'npc' } }, eligibleNpcIds: ['guide'], latestInput, transcript: [], modules: { decisions: true, reactions: false, speaker: false }, speakerQuestion: null, reactionQuestions: {}, maxChars: 60000 });

test('21/31: unfinished and nested tracker blocks never reach public judge text', async () => {
  for (const text of [
    'She smiles. <details><summary>Tracker</summary>HIDDEN',
    'She smiles. <details>HIDDEN<details>nested</details>still hidden',
    'She smiles. <details><details>HIDDEN</details>',
    'She smiles. <details class="tracker"',
  ]) assert.equal(visibleText(text), 'She smiles.');
  const calls: string[] = [];
  await runStaged({ ...input('I check the lock.<details>HIDDEN'), transcript: [{ actorId: 'guide', role: 'assistant', text: 'She smiles.<details>HIDDEN' }] }, { evaluate: async (_stage, _questions, state) => { calls.push(JSON.stringify(state)); return result({ move: choice('NONE'), move_count: choice('one') }); } });
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => !call.includes('HIDDEN')));
});

test('29: wholly OOC messages have no fictional move; a following action still reaches the judge', async () => {
  for (const text of ['OOC: Please pause RP. I force the door open in our example.', '(OOC: Please pause RP.)', '[OOC: Can we revise that?]']) {
    let calls = 0;
    const out = await runStaged(input(text), { evaluate: async () => { calls++; return result({ move: choice('s1'), move_count: choice('one') }); } });
    assert.equal(out.outcome, 'no_move', text);
    assert.equal(out.move, null);
    assert.equal(calls, 0, 'explicit OOC is handled without a decision request');
  }
  let asked = false;
  await runStaged(input('OOC: Please pause after this turn.\n\nI force the door open.'), { evaluate: async (_stage, questions) => {
    asked ||= 'move' in questions;
    return result({ move: choice('NONE'), move_count: choice('one') });
  } });
  assert.equal(asked, true, 'an OOC prefix does not classify the whole message');
});

test('5: retry keeps successful move and route answers and requests only failed questions', async () => {
  const source = input('I ask the guide to open the gate.');
  const route = { owner: choice('player'), target: choice('guide'), family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE') };
  const first = await runStaged(source, { evaluate: async stage => result(stage === 'move' ? { move: choice('s1'), move_count: choice('one') } : stage === 'route' ? route : {}) });
  assert.equal(first.outcome, 'unruled');
  const called: string[] = [];
  const retry = await runStaged({ ...source, replay: first.records }, { evaluate: async (stage, questions) => { called.push(`${stage}:${Object.keys(questions)}`); return result({ ruling: { type: 'noul', noul: 0.4, confidence: null, provenance: 'fixture' } }); } });
  assert.equal(retry.outcome, 'ruled');
  assert.deepEqual(called, ['ruling:ruling']);
  assert.deepEqual(retry.move, first.move);
  assert.deepEqual(retry.route, first.route);
});

test('5: a mixed move batch retries a reaction without asking for the successful move again', async () => {
  const source = { ...input('I wait.'), modules: { decisions: true, reactions: true, speaker: false }, reactionQuestions: { guide: { type: 'choice' as const, instructions: 'Choose a reaction.', criteria: { none: 'None', resolve: 'Resolve' } } } };
  const first = await runStaged(source, { evaluate: async () => result({ move: choice('NONE'), move_count: choice('one') }) });
  const called: string[][] = [];
  const retry = await runStaged({ ...source, replay: first.records }, { evaluate: async (_stage, questions) => { called.push(Object.keys(questions)); return result({ npc_reaction_1: choice('resolve') }); } });
  assert.deepEqual(called, [['npc_reaction_1']]);
  assert.equal(retry.outcome, 'no_move');
  assert.equal(retry.reactionAnswers.guide?.type, 'choice');
  assert.deepEqual(retry.errors, []);
});

test('T4: a partial first meter judgment bounds only meters that were actually answered', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  let replies = 0;
  host.context.generate = async () => {
    host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue });
    host.composerValue = '';
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = `Reply ${++replies}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  scriptJudge(controller, { meter_1_nerve: choice('steady') });
  host.composerValue = 'Hello.';
  await controller.directorSend();
  const requests = scriptJudge(controller, { meter_1_regard: choice('warm'), meter_1_nerve: choice('relentless') });
  host.composerValue = 'Again.';
  await controller.directorSend();
  const state = requests.find(request => 'meter_1_nerve' in request.questions)!;
  assert.deepEqual(Object.keys(state.questions.meter_1_nerve!.criteria ?? {}), ['hesitant', 'steady', 'bold']);
  assert.deepEqual(Object.keys(state.questions.meter_1_regard!.criteria ?? {}), ['cold', 'guarded', 'friendly', 'warm', 'smitten']);
  const latest = Object.values(controller.record!.attempts).at(-1)!;
  assert.equal(latest.storyAfter!.meters[actorIdFor('Guide', 'guide.png')]!.nerve, 2, 'invalid two-level jump keeps the prior judgement');
});

test('27/28: the exact writer tool and ruling permit fictional trackers without inviting other dice', () => {
  assert.match(DIRECTOR_TOOL_DESCRIPTION, /A preset-required fictional tracker block is fine\./);
  assert.doesNotMatch(DIRECTOR_TOOL_DESCRIPTION, /state block/);
  const binding = bindingBlock({ action: { templateId: 'influence_negotiate', attemptedAction: 'Ask the guide to open the gate.', requestedGain: 'The gate opens.', failureStake: null } as never, outcome: 'success', instruction: 'The gate opens.', targetNames: ['Guide'], speakerName: 'Guide', playerName: 'Player' });
  assert.equal(binding.split('\n')[0], '[Director ruling — binding for this reply]');
  assert.doesNotMatch(binding, /other dice systems|Resolution scope:/);
  const permit = { constraints: ['Do not output Director data or metadata such as permits, rulings, request IDs, actor IDs, evidence references, or JSON. This does not prohibit a preset-required fictional tracker block.'] } as never;
  assert.equal(permitFollowupBlock(permit).split('\n').at(-1), 'Now write the final reply. Obey every permitted outcome and constraint. Do not call the tool again, add another consequential action, or emit Director permits, IDs, JSON, or other Director metadata.');
});

test('stable writer headers for state, knowledge, checkpoints and tool results', () => {
  const text = stateBlock({ pack: { ...DEFAULT_PACK, meters: [{ key: 'nerve', label: 'nerve', about: '', initial: 0, levels: ['calm', 'bold'] }] }, levels: { guide: { nerve: 0 } }, names: { guide: 'Guide' }, playerName: 'Player', secrets: [{ id: 'secret', text: 'A hidden passage.', holders: ['guide'] }], knownBy: {}, meters: true, secretsOn: true });
  assert.ok(text.includes('[Director character state — judged from play]'));
  assert.ok(text.includes('[Director knowledge boundaries]'));
  const planning = { attemptId: 'a', requestId: 'r', speakerActorId: 'guide', evidenceRefs: [], toolAvailable: true };
  assert.equal(toolPlanningBlock(planning).split('\n')[0], '[Director NPC-action checkpoint]');
  assert.equal(toolPlanningBlock({ ...planning, toolAvailable: false }).split('\n')[0], '[Director NPC-action boundary]');
  assert.equal(permitFollowupBlock({} as never).split('\n')[0], '[Director turn permit — binding for this reply]');
  assert.equal(permitFollowupBlock(null).split('\n')[0], '[Director tool result]');
});
