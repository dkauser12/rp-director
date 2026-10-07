/**
 * Repro: phase 1b records a turn's judged meters/reveals only when its reply
 * completes (storyAfter at cursorAfter). A stopped reply never completes, so
 * if the user keeps the partial reply and sends the next message, that turn's
 * judged step is lost: the next turn is judged from the turn-before-last and
 * the writer is told the older level again. Phase 1 wrote the judgement at
 * judge time; item 6 removed that write without a replacement for Stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../../', import.meta.url).href;
const { choice, harness, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');

test('C1: keeping a stopped reply keeps that turn\'s judged meters', async () => {
  const { host, controller } = await harness();
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.setChatPack('romance');
  const answers = (regard: string) => ({ move: choice('NONE'), move_count: choice('one'), meter_1_regard: choice(regard), meter_1_nerve: choice('steady') });
  let stop = false;
  let n = 0;
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    const text = stop ? 'She leans in and' : `Reply ${++n}.`;
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} });
    if (stop) await host.emit('GENERATION_STOPPED');  // ST: Stop, then the partial reply is finalized
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  scriptJudge(controller, answers('friendly'));
  host.composerValue = 'Hello.'; await controller.directorSend();
  scriptJudge(controller, answers('warm'));
  stop = true;
  host.composerValue = 'I lean closer.'; await controller.directorSend();
  stop = false;
  console.log('writer was told for the stopped turn:', host.injection || '(cleared)');
  const shown = controller.characterStateForUi()[0]?.meters[0].level;
  const requests = scriptJudge(controller, answers('warm'));
  host.composerValue = 'I kiss her.'; await controller.directorSend();
  const state = requests.find((r: any) => 'meter_1_regard' in r.questions);
  console.log('head after keeping the stopped reply:', shown, '| next turn judged from:', state.questions.meter_1_regard.instructions.match(/was "[^"]+"/)?.[0]);
  assert.equal(shown, 'warm', 'BUG: the stopped turn\'s judged meter step is lost');
});
