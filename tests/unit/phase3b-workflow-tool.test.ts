/**
 * NPC tool (W8, item 32) under SillyTavern's real tool loop: every non-stealth
 * tool result is saved as an is_system message and ST recurses with
 * Generate('normal', {depth + 1}) (script.js 5408-5436 / 5541-5559).
 */
import { test } from 'node:test';
import { sim2, attempts, lastMarker, assert } from './support/phase3b-workflow.ts';

const RULING = /\[Director ruling — binding for this reply\]/;
const writerRequests = (sim: any) => sim.envelopes.map((e: any) => `${e.type}@${e.depth}${RULING.test(e.injection) ? ' ruling' : ''}${/turn permit/.test(e.injection) ? ' permit' : ''}${/tool result\]/.test(e.injection) ? ' refusal' : ''}${e.injection ? '' : ' (no injection)'}`);

test('W8 Cancel in the NPC review: ST still writes the follow-up reply, unruled (phase 1 aborted it)', async () => {
  const sim = await sim2({ configure: s => { s.controller.settings.reviewNpcRolls = true; } });
  sim.host.reviewRolls = async () => 'cancel';
  sim.writer.push({ tool: 'auto' });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('writer requests:', writerRequests(sim));
  console.log('log:', sim.log.filter(l => /tool|stop|aborted|GENERATION_STARTED/.test(l)).join(' | '));
  console.log('attempts:', attempts(sim), 'chat tail:', sim.host.chat().slice(-3).map((m: any) => (m.is_system ? '[tool msg]' : m.mes)));
  // Correct: Cancel stops the writer; no reply after the tool message.
  assert.equal(sim.host.chat().at(-1)!.is_system, true, 'Cancel must not let ST write a reply after the cancelled tool call');
});

test('W8 Stop while the NPC review is open: ST still writes the follow-up reply', async () => {
  const sim = await sim2({ configure: s => { s.controller.settings.reviewNpcRolls = true; } });
  sim.host.reviewRolls = async (_p: unknown, _n: unknown, _m: unknown, signal: AbortSignal) => {
    setTimeout(() => sim.stop(), 5); // the user presses Stop while the popup is open
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    return 'cancel';
  };
  sim.writer.push({ tool: 'auto' });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('writer requests:', writerRequests(sim));
  console.log('chat tail:', sim.host.chat().slice(-2).map((m: any) => (m.is_system ? '[tool msg]' : m.mes)));
  assert.equal(sim.host.chat().at(-1)!.is_system, true, 'Stop must not be followed by a new writer reply');
});

test('closed tool call on a wording swipe (tool now always offered): the reply ST writes next is unruled and unmarked', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  const ruledAttempt = lastMarker(sim).a;
  sim.writer.push({ tool: 'auto' }); // the writer calls the offered tool on the swipe
  await sim.swipeRight();
  await sim.settle();
  console.log('writer requests:', writerRequests(sim));
  console.log('attempts:', attempts(sim));
  console.log('chat tail:', sim.host.chat().slice(-3).map((m: any) => (m.is_system ? '[tool msg]' : JSON.stringify(m.mes)) + (m.extra?.rpd ? ' [marked]' : '')));
  const final = sim.envelopes.at(-1) as any;
  assert.ok(ruledAttempt);
  // Whatever request writes the visible reply must carry the frozen ruling.
  assert.match(final.injection, RULING, `the request that writes the swipe's visible reply (${final.type}@${final.depth}) must carry the frozen ruling`);
});

test('a second tool call in the follow-up (depth 1) drops the permit and ruling for the reply ST writes at depth 2', async () => {
  const sim = await sim2();
  sim.writer.push({ tool: 'auto' }, { tool: 'auto' });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('writer requests:', writerRequests(sim));
  console.log('attempts:', attempts(sim));
  const final = sim.envelopes.at(-1) as any;
  assert.match(final.injection, /turn permit/, `the kept NPC permit must still bind the request that writes the reply (${final.type}@${final.depth})`);
  assert.match(final.injection, RULING);
});

test('native regenerate (Ctrl+Enter) of a reply that followed an NPC tool call loses the ruling and permit', async () => {
  const sim = await sim2();
  sim.writer.push({ tool: 'auto' });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('after tool turn:', attempts(sim), sim.host.chat().slice(-3).map((m: any) => (m.is_system ? '[tool msg]' : m.mes)));
  await sim.ctrlEnter();
  console.log('writer requests:', writerRequests(sim));
  console.log('attempts:', attempts(sim));
  const regen = sim.envelopes.at(-1) as any;
  assert.equal(regen.type, 'regenerate');
  assert.match(regen.injection, RULING, 'regenerate must reuse the frozen ruling');
  assert.match(regen.injection, /turn permit/, 'regenerate must reuse the kept NPC permit');
});
