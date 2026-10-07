/** The ruling check receives the filled instruction and bounded move sent to the writer. */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';
import { presetById } from '../../src/presets.ts';

for (const table of ['standard', 'adventure'] as const) test(`follows_ruling (${table} table) names the move and fills the outcome placeholders`, async () => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(0) } : {}) });
  const preset = presetById(table)!;
  h.controller.settings.profileOverrides['binding-dice'] = { outcomes: structuredClone(preset.outcomes), bands: structuredClone(preset.bands) };
  h.controller.reloadProfile();
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'the reply check');
  const writer = (h.sim.envelopes.at(-1) as any).injection as string;
  assert.match(writer, /Bounded intended result: "Open the gate, please\."/, 'the writer was told the move');
  const question = h.checks()[0].questions.follows_ruling;
  assert.ok(question, 'a frozen ruling is checked');
  assert.doesNotMatch(question.instructions, /\{\{\s*(gain|target|player|action|speaker)\s*\}\}/, 'no unfilled outcome placeholders reach the judge');
  assert.match(question.instructions, /Open the gate, please/, 'the proposition names the ruled move');
  const binding = writer.split('\n\n')[0]!;
  assert.ok(question.instructions.includes(binding), 'the proposition includes the same complete binding block as the writer');
});
