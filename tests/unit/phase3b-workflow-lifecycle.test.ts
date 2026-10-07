/** Completion, stale markers, deciding races and the composer lock under ST's real event order. */
import { test } from 'node:test';
import { sim2, attempts, lastMarker, assert, permissiveJudge, turnScript, GUIDE } from './support/phase3b-workflow.ts';

test('streaming + a slower MESSAGE_RECEIVED listener registered before the Director: completion dropped, judged meters lost', async () => {
  const sim = await sim2({ streaming: true, configure: s => { s.controller.settings.modules.meters = true; } });
  const requests = permissiveJudge(sim.controller, turnScript(GUIDE));
  // e.g. an extension that awaits a save or an LLM call in its MESSAGE_RECEIVED handler
  sim.earlierMessageReceived.push(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('turn 1:', attempts(sim), 'marker:', lastMarker(sim), 'log:', sim.log.slice(-4).join(' | '));
  const turn1Meter = requests.flatMap((r: any) => Object.entries(r.questions)).filter(([id]) => id.startsWith('meter_'));
  requests.length = 0;
  await sim.clickSend('I wait by the gate. "Well?"');
  const turn2Meter = requests.flatMap((r: any) => Object.entries(r.questions)).filter(([id]) => id.startsWith('meter_')).map(([, q]: any) => q.instructions);
  const phrase = (text: string) => (/No level has been judged yet/.test(text) ? 'first assessment again ("No level has been judged yet")' : (/Before the latest exchange [^.]*/.exec(text)?.[0] ?? text.slice(0, 80)));
  console.log('turn 1 meter questions:', turn1Meter.length, '| turn 2 meter question:', phrase(turn2Meter[0] ?? ''));
  const turn1 = sim.host.chat()[3];
  console.log('turn 1 reply marked:', Boolean(turn1.extra?.rpd), '| badge:', Boolean(turn1.extra?.rpdWorkflow));
  assert.doesNotMatch(turn2Meter[0] ?? '', /No level has been judged yet/, 'turn 2 must start from turn 1\'s judged meters');
  assert.ok(turn1.extra?.rpd, 'turn 1 reply must be marked (its completion must not be dropped)');
});

test('control: same flow without the slow listener keeps the marker and the meter baseline', async () => {
  const sim = await sim2({ streaming: true, configure: s => { s.controller.settings.modules.meters = true; } });
  const requests = permissiveJudge(sim.controller, turnScript(GUIDE));
  await sim.clickSend('I nod. "Open the gate, please."');
  requests.length = 0;
  await sim.clickSend('I wait by the gate. "Well?"');
  const turn2Meter = requests.flatMap((r: any) => Object.entries(r.questions)).filter(([id]) => id.startsWith('meter_')).map(([, q]: any) => q.instructions);
  console.log('control turn 2 meter question:', /Before the latest exchange [^.]*/.exec(turn2Meter[0] ?? '')?.[0] ?? turn2Meter[0]);
  assert.ok(sim.host.chat()[3].extra?.rpd);
  assert.doesNotMatch(turn2Meter[0] ?? '', /No level has been judged yet/);
});

test('paused chat: a native swipe of a ruled reply inherits the previous swipe\'s badge and gets its footer appended', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  const ruled = sim.host.chat().at(-1)!;
  assert.ok(ruled.extra?.rpdWorkflow, 'setup: the ruled reply has a badge');
  await sim.controller.setPaused(true);
  await sim.swipeRight();
  await sim.settle();
  const message = sim.host.chat().at(-1)!;
  console.log('new swipe text:', JSON.stringify(message.mes).slice(0, 140));
  console.log('new swipe badge:', JSON.stringify(message.extra?.rpdWorkflow?.results?.map((r: any) => r.outcome)), 'swipe_id', message.swipe_id);
  assert.doesNotMatch(message.mes, /\[RP_DIRECTOR\]/, 'a swipe written while paused must not get the previous swipe\'s ruling footer');
  assert.equal(message.extra?.rpdWorkflow, undefined, 'nor its badge');
});

test('swipe of the previous reply while a new Send is being decided: the Send is dropped silently and the swipe loses its attempt', async () => {
  const sim = await sim2();
  await sim.clickSend('I nod. "Open the gate, please."');
  // Slow judge for the next Send.
  const original = sim.controller.provider.bind(sim.controller);
  sim.controller.provider = () => { const base = original(); return { ...base, evaluate: async (req: any, signal: any) => { await new Promise(r => setTimeout(r, 40)); return base.evaluate(req, signal); } }; };
  sim.host.composerValue = 'I step closer. "Now?"';
  sim.els.get('send_but')!.click();                // Send; the Director is now deciding
  await new Promise(r => setTimeout(r, 5));
  assert.equal(sim.controller.status, 'Deciding');
  sim.writer.push({ text: 'Slow swipe text.', delayMs: 250 }); // the swipe is still streaming when the decision ends
  const swipedMarkerBefore = sim.host.chat().at(-1)!.extra?.rpd?.a;
  const swipe = sim.swipeRight();                  // user swipes the previous reply meanwhile
  await swipe;
  await sim.settle();
  console.log('attempts:', attempts(sim));
  console.log('composer:', JSON.stringify(sim.host.composerValue), '| notices:', sim.host.notices, '| chat length:', sim.host.chat().length);
  const swiped = sim.host.chat().at(-1)!;
  console.log('swiped reply text:', swiped.mes.slice(0, 20), '| marker attempt:', swiped.extra?.rpd?.a, '(before swipe:', swipedMarkerBefore, ')');
  console.log('log:', sim.log.filter(l => /GENERATION_STARTED|aborted|MESSAGE_RECEIVED|GENERATION_ENDED/.test(l)).join(' | '));
  const sent = sim.host.chat().some((m: any) => m.is_user && m.mes === 'I step closer. "Now?"');
  assert.ok(sent, 'the queued Send must go through after the independent swipe finishes');
  assert.notEqual(swiped.extra?.rpd?.a, swipedMarkerBefore, 'the new swipe must be completed with its own attempt');
});

test('item 13: the composer stays read-only for the whole writer generation, not just while deciding', async () => {
  const sim = await sim2();
  let readOnlyDuringWriter: boolean | null = null;
  sim.earlierMessageReceived.push(() => { readOnlyDuringWriter = sim.els.get('send_textarea')!.readOnly; });
  await sim.clickSend('I nod. "Open the gate, please."');
  console.log('readOnly while the reply was being written:', readOnlyDuringWriter, '| after:', sim.els.get('send_textarea')!.readOnly);
  assert.equal(readOnlyDuringWriter, false, 'ST lets the user type the next message while the reply streams');
});
