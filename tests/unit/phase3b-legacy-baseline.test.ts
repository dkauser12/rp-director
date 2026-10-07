/**
 * Repro: a Reassess of a genuine v0.7.1 turn (record produced by the v0.7.1
 * controller itself, see _v071/gen-legacy.ts) starts its meter question from
 * the turn's own POST-judgement level, so the retried turn can step twice.
 *
 * v0.7.1 stored each turn's judged meters at the cursor BEFORE the user
 * message (= the previous reply's cursorAfter). Phase 1b's legacy baseline is
 * snapshotAt(story, chain.slice(0, -1)) where chain now runs THROUGH the user
 * message, i.e. exactly that key: the post-turn state of the turn being retried.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('../../', import.meta.url).href;
const { choice, harness, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-071-meters.json', import.meta.url), 'utf8'));
const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });

test('L1: Reassess of a real 0.7.1 turn asks its meters from the pre-turn level', async () => {
  const { host, controller } = await harness();
  host.context.chat = structuredClone(fixture.chat);
  host.context.chatMetadata = structuredClone(fixture.metadata);
  controller.settings.modules = { speaker: false, decisions: true, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.loadChat();
  // Head state is right: turn 1 judged friendly, turn 2 judged warm.
  assert.equal(controller.characterStateForUi()[0]?.meters[0].level, 'warm');

  const requests = scriptJudge(controller, answers('smitten'));
  const message = host.chat().at(-1);
  host.swipeRight = async () => {
    message.swipe_id = message.swipes.length;
    await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
    await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
    message.mes = 'Retried reply.'; message.swipes.push(message.mes);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'swipe');
  };
  await controller.reassess(true);
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  assert.ok(state, 'the legacy reassessment judged the meters');
  const criteria = Object.keys(state.questions.meter_1_regard.criteria);
  console.log('criteria offered for regard:', criteria, '| instructions:', state.questions.meter_1_regard.instructions.match(/was "[^"]+"/)?.[0]);
  console.log('level shown after the retried swipe:', controller.characterStateForUi()[0]?.meters[0].level);
  // Correct: before turn 2 the guide was "friendly", so smitten (two steps up) is not allowed.
  assert.ok(!criteria.includes('smitten'), 'BUG: the retry starts from the turn\'s own post-judgement level (warm) and allows smitten');
});
