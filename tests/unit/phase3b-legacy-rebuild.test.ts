/**
 * Repro: item 25 rebuilds a 0.7 attempt's writer state from
 * snapshotAt(story, [variant.cursorAfter]). In a genuine 0.7.1 record that key
 * holds the NEXT turn's judged state (0.7.1 saved turn N+1's judgement at the
 * cursor before U(N+1), which is reply N's cursorAfter). So a wording swipe of
 * reply N, after the following exchange was deleted, tells the writer the
 * deleted turn's meters. 0.7.1 itself reused the stored injection (turn N's own state).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('../../', import.meta.url).href;
const { harness } = await import(ROOT + 'tests/unit/support/test-host.ts');

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-071-meters.json', import.meta.url), 'utf8'));

test('L2: a wording swipe of a 0.7.1 reply injects that turn\'s own judged meters', async () => {
  const { host, controller } = await harness();
  host.context.chat = structuredClone(fixture.chat);
  host.context.chatMetadata = structuredClone(fixture.metadata);
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  controller.settings.reactions.enabled = false;
  await controller.loadChat();
  const turn1 = Object.values(controller.record.attempts).find((a: any) => a.hostMessageRef === 3) as any;
  console.log('0.7.1 stored injection for turn 1:', JSON.stringify(turn1.injectedText.match(/regard for Player \w+/)?.[0]));
  // Delete the last exchange (U2, R2), then swipe reply 1.
  host.chat().splice(4, 2);
  await host.emit('MESSAGE_DELETED');
  const message = host.chat().at(-1);
  message.swipe_id = message.swipes.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'swipe');
  const told = host.injection.match(/regard for Player \w+/)?.[0];
  console.log('rebuilt injection now tells the writer:', JSON.stringify(told));
  assert.equal(told, 'regard for Player friendly', 'BUG: the deleted turn 2 judgement (warm) is injected into turn 1\'s wording swipe');
});
