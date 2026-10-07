/** Repro: editing a 0.7.1 reply that has a following turn "recovers" the FOLLOWING turn's snapshot as its own storyAfter (persisted). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('../../', import.meta.url).href;
const { harness } = await import(ROOT + 'tests/unit/support/test-host.ts');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-071-meters.json', import.meta.url), 'utf8'));

test('L3: editing a 0.7.1 reply keeps that turn\'s own meters', async () => {
  const { host, controller } = await harness();
  host.context.chat = structuredClone(fixture.chat);
  host.context.chatMetadata = structuredClone(fixture.metadata);
  controller.settings.modules = { speaker: false, decisions: false, meters: true, secrets: false, lore: false } as any;
  await controller.loadChat();
  const r1 = host.chat()[3];
  r1.mes = 'Reply 1, typo fixed.'; r1.swipes[0] = r1.mes;
  await host.emit('MESSAGE_EDITED', 3);
  const turn1 = controller.record.attempts[r1.extra.rpd.a];
  const levels = ['cold', 'guarded', 'friendly', 'warm', 'smitten'];
  const recovered = levels[(Object.values(turn1.storyAfter?.meters ?? {})[0] as { regard: number } | undefined)?.regard ?? -1];
  console.log('turn 1 judged "friendly"; its recovered storyAfter says:', recovered);
  assert.equal(recovered, 'friendly', 'BUG: turn 2\'s judgement was stored as turn 1\'s frozen state');
});
