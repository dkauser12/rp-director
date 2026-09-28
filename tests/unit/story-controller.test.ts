import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorIdFor } from '../../src/identity.ts';
import { choice, harness, noul, scriptJudge, writerReplies } from './support/test-host.ts';
import type { Answer, EvaluationRequest, EvaluationResult } from '../../src/types.ts';
import type { Controller } from '../../src/controller.ts';

const GUIDE = actorIdFor('Guide', 'guide.png');

const routing = (owner: string, target: string, family: string, spec: string) => ({
  owner: choice(owner), target: choice(target), family: choice(family), action_specification: choice(spec), antecedent: choice('NONE'),
});

async function stagedChat() {
  const h = await harness();
  h.controller.settings.pipeline = 'staged';
  return h;
}

/** Sends one message through a scripted judge and a fake writer; returns the requests and injection. */
async function turn(h: Awaited<ReturnType<typeof stagedChat>>, text: string, script: Record<string, Answer>, reply = 'The guide answers.') {
  h.host.composerValue = text;
  const requests = scriptJudge(h.controller, script);
  const writer = writerReplies(h.host, h.controller, 'Guide', 'guide.png', reply);
  await h.controller.directorSend();
  return { requests, injected: writer.injected() };
}

const keysOf = (requests: EvaluationRequest[]) => requests.map(r => Object.keys(r.questions));

test('on Auto the judge picks the chat\'s pack once, and it is kept', async () => {
  const h = await stagedChat();
  h.controller.settings.modules.meters = false;
  const first = await turn(h, 'Hello there.', { pack: choice('adventure'), move: choice('NONE'), move_count: choice('one') });
  assert.deepEqual(keysOf(first.requests)[0], ['pack']);
  assert.equal(h.controller.record!.story.packId, 'adventure');
  assert.equal(h.controller.record!.story.packSource, 'judge');
  const second = await turn(h, 'And again.', { move: choice('NONE'), move_count: choice('one') });
  assert.ok(!keysOf(second.requests).some(keys => keys.includes('pack')), 'never asked again');
  assert.equal(h.controller.chatPackInfo()!.label, 'Adventure & kingdom');
});

test('meters are judged by the model, saved at this point of the chat, shown to the writer, and bounded next turn', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  const first = await turn(h, 'I sit down next to him.', { move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice('warm'), meter_1_nerve: choice('bold') });
  const stateRequest = first.requests.find(r => 'meter_1_regard' in r.questions)!;
  assert.deepEqual(Object.keys(stateRequest.questions.meter_1_regard!.criteria as Record<string, string>), ['cold', 'guarded', 'friendly', 'warm', 'smitten'], 'first judgement may use any level');
  assert.match(JSON.stringify(stateRequest.snapshot.state), /GUIDE-CARD/, 'the state request reads the character card');
  assert.match(first.injected, /\[Director character state/);
  assert.match(first.injected, /Guide: regard for Player warm \(4 of 5\); nerve bold \(4 of 5\)/);
  assert.deepEqual(h.controller.characterStateForUi(), [{ name: 'Guide', meters: [{ label: 'regard for {{user}}', level: 'warm', rank: '4 of 5' }, { label: 'nerve', level: 'bold', rank: '4 of 5' }] }]);
  const second = await turn(h, 'I lean closer.', { move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice('smitten'), meter_1_nerve: choice('relentless') });
  const bounded = second.requests.find(r => 'meter_1_regard' in r.questions)!;
  assert.deepEqual(Object.keys(bounded.questions.meter_1_regard!.criteria as Record<string, string>), ['friendly', 'warm', 'smitten']);
  assert.match(second.injected, /smitten \(5 of 5\); nerve relentless \(5 of 5\)/);
});

test('the UI names the player {{user}}, never the persona, while the writer still gets the persona name', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  const first = await turn(h, 'I sit down next to him.', { move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice('warm'), meter_1_nerve: choice('bold') });
  const player = h.controller.actionActorsForUi().find(a => a.actorId === 'player');
  assert.equal(player?.name, '{{user}}');
  assert.ok(h.controller.actionActorsForUi().every(a => a.name !== 'Player'), 'no option carries the persona name');
  assert.equal(h.controller.characterStateForUi()[0]!.meters[0]!.label, 'regard for {{user}}');
  assert.match(first.injected, /regard for Player warm/, 'the writer reads the persona name the transcript uses');
});

test('a wording swipe reuses the judged state with no request', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  const { requests } = await turn(h, 'I sit down next to him.', { move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice('warm'), meter_1_nerve: choice('bold') });
  const before = requests.length;
  const message = h.host.chat().at(-1)!;
  message.swipe_id = message.swipes!.length;
  await h.host.emit('MESSAGE_SWIPED', h.host.chat().length - 1);
  await h.controller.interceptor([], 4096, () => assert.fail('aborted'), 'swipe');
  assert.equal(requests.length, before);
  assert.match(h.host.injection, /regard for Player warm \(4 of 5\)/);
});

test('secrets: the knowledge boundary reaches the writer and a reveal is recorded', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  h.controller.settings.modules.meters = false;
  await h.controller.addSecret('The gate key is in the guide\'s boot.', [GUIDE]);
  const first = await turn(h, 'Where is the key?', { move: choice('NONE'), move_count: choice('one'), reveal_1: choice('KEEP') });
  assert.match(first.injected, /Known only to Guide: The gate key is in the guide's boot\./);
  const stateRequest = first.requests.find(r => 'reveal_1' in r.questions)!;
  assert.ok(first.requests.filter(r => 'move' in r.questions).every(r => !JSON.stringify(r).includes('boot')), 'the secret never reaches move selection');
  assert.match(JSON.stringify(stateRequest.snapshot.state), /boot/);
  const second = await turn(h, 'Show me your boots.', { move: choice('NONE'), move_count: choice('one'), reveal_1: choice('player') });
  assert.match(second.injected, /Known only to Guide and Player/);
  assert.deepEqual(h.controller.secretsForUi()[0]!.knownBy, [GUIDE, 'player']);
});

test('the ruling reads the freshly judged meters of the character it concerns', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  const { requests } = await turn(h, 'Please let me through the gate.', {
    move: choice('s1'), move_count: choice('one'), meter_1_regard: choice('smitten'), meter_1_nerve: choice('steady'),
    ...routing('player', GUIDE, 'ask', 'SPECIFIED_HERE'), ruling: noul(0.4),
  });
  const ruling = requests.find(r => 'ruling' in r.questions)!;
  assert.match(JSON.stringify(ruling.snapshot.state), /smitten \(5 of 5\)/);
});

test('a failed state request keeps the previous state and does not block the turn', async () => {
  const h = await stagedChat();
  await h.controller.setChatPack('romance');
  const requests: EvaluationRequest[] = [];
  const original = h.controller.provider.bind(h.controller) as Controller['provider'];
  h.controller.provider = () => ({
    ...original(),
    evaluate: async (request: EvaluationRequest): Promise<EvaluationResult> => {
      requests.push(request);
      if ('meter_1_regard' in request.questions) throw new Error('judge down');
      return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: null, answers: { move: choice('NONE'), move_count: choice('one') }, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
    },
  });
  h.host.composerValue = 'Hello.';
  writerReplies(h.host, h.controller, 'Guide', 'guide.png', 'Hi.');
  await h.controller.directorSend();
  assert.equal(h.host.generated.length, 1, 'the reply was still written');
  assert.ok(h.controller.record!.inspector.some(e => /Character state kept from before/.test(e.message ?? '')));
  assert.deepEqual(h.controller.characterStateForUi(), []);
});
