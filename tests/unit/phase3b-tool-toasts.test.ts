import { test } from 'node:test';
import { assert, sim2 } from './support/phase3b-workflow.ts';

test('3b/28: repeated writer proposal rejections show one toast until a successful turn', async t => {
  const sim = await sim2();
  t.after(() => sim.controller.destroy());
  const reject = async (text: string) => {
    sim.writer.push({ tool: 'auto', prose: 'The guide reaches toward the latch.' });
    await sim.clickSend(text);
  };
  const notices = () => sim.host.notices.filter((message: string) => message.includes("writer's move"));
  await reject('Please open the gate.');
  await reject('Please try the other gate.');
  assert.equal(notices().length, 1);
  await sim.clickSend('I nod. "Thank you."');
  await reject('Please open the side door.');
  assert.equal(notices().length, 2);
});
