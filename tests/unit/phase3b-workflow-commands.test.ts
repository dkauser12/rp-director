/** W4 / item 16: /director-reroll and /director-reassess typed in the composer. */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

for (const command of ['director-reroll', 'director-reassess']) {
  test(`/${command} typed in the composer makes a new swipe with a new decision`, async () => {
    const sim = await sim2();
    sim.host.registerDirectorCommands({ pause: (value: boolean) => sim.controller.setPaused(value),
      reroll: () => sim.controller.reroll(true), reassess: () => sim.controller.reassess(true),
      setPack: (id: string) => sim.controller.setChatPack(id), setSpeaker: (name: string) => sim.controller.setSpeakerByName(name),
      get: (key: string) => sim.controller.getMacro(key) });
    await sim.clickSend('I nod. "Open the gate, please."');
    const before = sim.host.chat().at(-1)!;
    const swipesBefore = before.swipes.length;
    const resBefore = before.extra?.rpd?.r;
    await sim.clickSend(`/${command}`);
    const after = sim.host.chat().at(-1)!;
    console.log(command, 'swipes', swipesBefore, '->', after.swipes.length, '| ruling', resBefore, '->', after.extra?.rpd?.r, '|', attempts(sim));
    console.log('log:', sim.log.filter(l => /command|GENERATION_STARTED|aborted/.test(l)).join(' | '));
    assert.equal(after.swipes.length, swipesBefore + 1);
    assert.notEqual(after.extra?.rpd?.r, resBefore);
  });
}
