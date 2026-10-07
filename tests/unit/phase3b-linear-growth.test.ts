/** Measurement: record size of a LINEAR 0.8 chat (every turn live) after compaction, per turn. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
const ROOT = new URL('../../', import.meta.url).href;
const { actorIdFor } = await import(ROOT + 'src/identity.ts');
const { normalizeRecord } = await import(ROOT + 'src/state.ts');
const { choice, harness, noul, scriptJudge } = await import(ROOT + 'tests/unit/support/test-host.ts');
const GUIDE = actorIdFor('Guide', 'guide.png');
test('straight-line chat metadata grows below 3 KB per turn after the replay window fills', async t => {
const TURNS = 100;
const { host, controller } = await harness();
controller.settings.modules = { speaker: false, decisions: true, meters: true, secrets: false, lore: false } as any;
controller.settings.reactions.enabled = false;
await controller.setChatPack('romance');
let n = 0;
const prose = 'The guide weighs the request, glances at the gate and the guards, and answers at some length. '.repeat(12);
host.context.generate = async () => {
  if (host.composerValue) { host.chat().push({ name: 'Player', is_user: true, is_system: false, mes: host.composerValue }); host.composerValue = ''; }
  await controller.interceptor([], 4096, () => assert.fail('abort'), 'normal');
  const text = `Reply ${++n}. ${prose}`;
  host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }] });
  await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
};
const levels = ['guarded', 'friendly', 'warm', 'friendly'];
const sizes: number[] = [];
for (let i = 0; i < TURNS; i++) {
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(GUIDE), family: choice('ask'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45), meter_1_regard: choice(levels[i % 4]!), meter_1_nerve: choice('steady') });
  host.composerValue = `Turn ${i + 1}: please let me through the gate, I have urgent business with the steward tonight.`;
  await controller.directorSend();
  await new Promise(r => setTimeout(r, 0));
  if ((i + 1) % 25 === 0) sizes.push(Buffer.byteLength(JSON.stringify(host.context.chatMetadata.rpDirector), 'utf8'));
}
t.diagnostic('record bytes after 25/50/75/100 turns: ' + sizes.join(' / '));
assert.ok((sizes[3]! - sizes[1]!) / 50 < 3000, 'steady state metadata must grow below 3 KB per turn');
const restored = normalizeRecord(JSON.parse(JSON.stringify(host.context.chatMetadata.rpDirector)), 'unused', controller.profile.revision);
assert.deepEqual(JSON.parse(JSON.stringify(restored)), JSON.parse(JSON.stringify(controller.record)), 'all kept rulings, state and writer text survive the actual persisted format');
});
