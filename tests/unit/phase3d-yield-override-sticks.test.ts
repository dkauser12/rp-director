/**
 * 3c lets a 1:1 chat honour the speaker override (directorTurn: `&& !explicit`,
 * stagedTurn: `selected: c.explicit ?? ...`), so `/director-speaker yield` (item 14)
 * now yields in 1:1 too. The override is "for the next reply" (U2), but
 * finishTurn() clears it only after preparing a reply (controller.ts ~1262); the
 * yield branch (~1213-1226) returns first. Every later Send yields again until
 * the user resets the speaker by hand.
 */
import { test } from 'node:test';
import { sim2, assert } from './support/phase3b-workflow.ts';

test('a yield override applies to one Send, not every later Send', async t => {
  const sim: any = await sim2();
  t.after(() => sim.controller.destroy());
  sim.controller.setSpeakerByName('yield');
  await sim.clickSend('I nod. "Open the gate, please."');
  assert.ok(sim.host.notices.some((notice: string) => notice.startsWith('Director yields')), 'sanity: the first Send yielded');
  console.log(`speakerOverride after the yield: ${sim.controller.speakerOverride}`);
  assert.equal(sim.controller.speakerOverride, null, 'the one-reply override is used up by the yield');
});
