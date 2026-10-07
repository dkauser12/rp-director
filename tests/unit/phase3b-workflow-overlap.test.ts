/** Send while a native swipe of a pre-Director reply is being judged inside MESSAGE_SWIPED (up to the wait budget). */
import { test } from 'node:test';
import { sim2, attempts, assert } from './support/phase3b-workflow.ts';

test('Send during the judged MESSAGE_SWIPED of a pre-Director reply: two decisions overlap', async () => {
  const sim = await sim2();
  const original = sim.controller.provider.bind(sim.controller);
  sim.controller.provider = () => { const base = original(); return { ...base, evaluate: async (req: any, signal: any) => { await new Promise(r => setTimeout(r, 30)); return base.evaluate(req, signal); } }; };
  sim.writer.push({ text: 'Swipe reply.', delayMs: 5 }, { text: 'Send reply.', delayMs: 5 });
  const swipe = sim.swipeRight();                        // the seeded reply predates the Director: judged in MESSAGE_SWIPED
  await new Promise(r => setTimeout(r, 10));
  console.log('status while the swipe is judged:', sim.controller.status, '| composer locked:', sim.els.get('send_textarea')!.readOnly, '| ST generating:', sim.sendPress);
  sim.host.composerValue = 'I step closer. "Now?"';
  sim.els.get('send_but')!.click();                     // intercepted: the Director starts a second decision
  await swipe;
  await sim.settle();
  console.log('attempts:', attempts(sim));
  console.log('chat:', sim.host.chat().map((m: any) => `${m.is_user ? 'U' : 'A'}:${JSON.stringify(m.mes.slice(0, 22))}${m.extra?.rpd ? '*' : ''}`).join(' '));
  console.log('notices:', sim.host.notices, '| composer:', JSON.stringify(sim.host.composerValue));
  console.log('writer requests:', sim.envelopes.map((e: any) => `${e.type}${/Director ruling/.test(e.injection) ? ' ruled' : ''}`));
  const sent = sim.host.chat().some((m: any) => m.is_user && m.mes === 'I step closer. "Now?"');
  assert.ok(sent || sim.host.notices.length > 0, 'the Send must either go through or say why not');
});
