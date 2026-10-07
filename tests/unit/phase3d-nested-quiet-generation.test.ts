/**
 * Item 10 vs. overlapping generations. macroSuppressed and
 * macroUpcomingAttemptId are single controller-wide values, not scoped to a
 * generation. SillyTavern awaits every GENERATION_STARTED /
 * GENERATION_AFTER_COMMANDS / MESSAGE_SENT listener before it substitutes the
 * card fields (script.js:4299-4470); a listener that awaits a quiet generation
 * (generateQuietPrompt -> Generate('quiet')) emits GENERATION_STARTED('quiet')
 * (controller.ts:1937 sets macroSuppressed) and, when its stop button hides,
 * GENERATION_ENDED (controller.ts:2015 clears the preview). Nothing restores
 * either before getCharacterCardFields of the outer Continue.
 */
import test from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

const KEYS = ['active', 'outcome', 'odds', 'roll'];
const snapshot = (controller: any) => Object.fromEntries(KEYS.map(key => [key, controller.getMacro(key)]));

test('review3c: a quiet generation awaited by another extension before card substitution does not blank the outer readers', async t => {
  const sim = await sim2();
  t.after(() => sim.controller.destroy());
  await sim.clickSend('I nod. "Open the gate, please."');
  // Another extension, loaded after the Director, summarises before each generation.
  let nested = false;
  sim.host.context.eventSource.on('GENERATION_STARTED', async (type: string, _options: unknown, dryRun: boolean) => {
    if (dryRun || type === 'quiet' || nested) return;
    nested = true;
    await sim.host.emit('GENERATION_STARTED', 'quiet', { quiet_prompt: 'Summarize the scene.' }, false);
    await sim.host.emit('GENERATION_ENDED', sim.host.chat().length);
  });
  const cardTime: Record<string, string>[] = [];
  const presetTime: Record<string, string>[] = [];
  const intercept = sim.controller.interceptor.bind(sim.controller);
  sim.controller.interceptor = async (...args: any[]) => {
    cardTime.push(snapshot(sim.controller));
    await intercept(...args);
    presetTime.push(snapshot(sim.controller));
  };
  await sim.generate('continue'); await sim.settle();
  assert.equal(presetTime[0]!.active, 'true', 'sanity: the continue reuses the frozen ruling');
  assert.deepEqual(cardTime[0], presetTime[0], 'card-field readers of the Continue must match its prompt');
});
