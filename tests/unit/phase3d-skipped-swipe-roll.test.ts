/**
 * Phase 3d follow-up: an explicit Roll again chosen in the swipe question (W3)
 * when SillyTavern then skips that swipe's generation. animateSwipe() calls
 * Generate('swipe') only when !is_send_press (script.js 10315-10320); here
 * another reply started while the question was open.
 *
 * The reroll recorded a new resolution for that exchange, but no attempt ever
 * carried it. attemptAt() prefers the cursor's newest ruling only through an
 * attempt that holds it, so the next swipe and the next regenerate reuse the
 * reply's own ruling. Compaction then drops the unused draw at the next save.
 * The notice "Another reply started, so the new roll was not used." is true.
 */
import test from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

test('phase3d: a Roll again whose swipe SillyTavern skipped is reported and never used later', async t => {
  let draw = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', <T extends ArrayBufferView | null>(buffer: T): T => {
    (buffer as unknown as Uint32Array)[0] = draw;
    return buffer;
  });
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  await sim.clickSend('I nod. "Open the gate, please."'); // first draw: 0/100
  const first = Object.values<any>(sim.controller.record.attempts)[0];
  assert.ok(first.resolutionId, 'sanity: ruled with dice');
  sim.controller.settings.askWhenSwiping = true;

  draw = 3865470566; // a Roll again now rolls 90/100
  // Another reply starts while the question is open, so SillyTavern skips the swipe's generation.
  sim.host.swipeResult = async () => { sim.sendPress = true; return 'reroll'; };
  await sim.swipeRight(); await sim.settle();
  sim.sendPress = false;
  const rolled = sim.controller.record.inspector.filter((entry: any) => entry.kind === 'reroll').map((entry: any) => entry.resolutionId);
  assert.equal(rolled.length, 1, 'sanity: the Roll again drew once');
  assert.equal(sim.host.chat().at(-1).swipes.length, 1, 'sanity: no swipe was generated');
  assert.ok(sim.host.notices.includes('Another reply started, so the new roll was not used.'), sim.host.notices.join(' | '));

  sim.host.swipeResult = async () => 'reuse'; // the next swipe keeps the result
  await sim.swipeRight(); await sim.settle();
  const swiped = Object.values<any>(sim.controller.record.attempts).at(-1);
  assert.equal(swiped.generationType, 'swipe');
  assert.equal(swiped.resolutionId, first.resolutionId, "the next swipe keeps the reply's own ruling");

  await sim.ctrlEnter(); // a native Regenerate, Keep
  const regenerated = Object.values<any>(sim.controller.record.attempts).at(-1);
  assert.equal(regenerated.generationType, 'regenerate');
  assert.equal(regenerated.resolutionId, first.resolutionId, 'so does the next regenerate');
  assert.equal(sim.controller.record.resolutions[rolled[0]], undefined, 'the unused draw was dropped at the next save');
});
