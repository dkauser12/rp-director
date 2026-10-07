import { test } from 'node:test';
import assert from 'node:assert/strict';

test('3b/3: load and deletion refresh 800 reply badges within a linear hash budget', async t => {
const ROOT = new URL('../../', import.meta.url).href;
const { harness } = await import(ROOT + 'tests/unit/support/test-host.ts');
const N = 800;
const CHARS = 2500;
const { host, controller } = await harness();
controller.settings.modules = { speaker: false, decisions: false, meters: false, secrets: false, lore: false } as any;
// Build a chat whose every reply carries a live marker, as after a Director session.
const chat = host.chat();
chat.length = 0;
const record = controller.record;
for (let i = 0; i < N; i++) {
  const user = i % 2 === 0;
  const text = `${user ? 'U' : 'R'}${i} ` + 'lorem ipsum dolor sit amet '.repeat(Math.ceil(CHARS / 27)).slice(0, CHARS);
  chat.push(user ? { name: 'Player', is_user: true, is_system: false, mes: text } : { name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: text, swipe_id: 0, swipes: [text], swipe_info: [{ extra: {} }], extra: {} });
}
// Give every reply a variant + marker whose cursorBefore is on the chain.
const chain = (controller as any).chainNow();
for (let i = 1; i < N; i += 2) {
  const a = `att_${i}`, v = `var_${i}`;
  record.attempts[a] = { attemptId: a, resolutionId: null, permitId: null, reaction: null, actorId: null, cursorBefore: chain[i], status: 'accepted', generationType: 'normal', hostMessageRef: i, hostVariantRef: 0, variantId: v, injectedText: '', epoch: 0, unadjudicated: false, createdAt: i };
  record.variants[v] = { variantId: v, attemptId: a, resolutionId: null, permitId: null, actorId: null, cursorBefore: chain[i], cursorAfter: chain[i + 1] };
  host.writeMarker(i, { v, a, r: null });
}
host.context.chatMetadata.rpDirector = structuredClone(record);
let fingerprints = 0;
const fingerprint = host.fingerprintMessages.bind(host);
host.fingerprintMessages = (...args: any[]) => { fingerprints++; return fingerprint(...args); };
const t0 = performance.now();
await controller.loadChat();
const t1 = performance.now();
chat.splice(N - 2, 2);
await host.emit('MESSAGE_DELETED');
const t2 = performance.now();
t.after(() => controller.destroy());
assert.ok(fingerprints <= 10, 'full transcript fingerprinting must be constant per refresh');
assert.ok(t1 - t0 < 2000, '800-message load must finish within 2 seconds');
assert.ok(t2 - t1 < 2000, '800-message deletion refresh must finish within 2 seconds');
t.diagnostic('load ' + Math.round(t1-t0) + ' ms; delete ' + Math.round(t2-t1) + ' ms; full hashes ' + fingerprints);
});
