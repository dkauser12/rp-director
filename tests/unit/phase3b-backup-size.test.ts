/** The rollback copy retains state without duplicating inspector diagnostics. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from './support/test-host.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-071-long.json', import.meta.url), 'utf8'));

test('3b item 9: first legacy load shrinks metadata and backs up only restorable state', async () => {
  const { host, controller } = await harness();
  host.context.chat = structuredClone(fixture.chat);
  host.context.chatMetadata = structuredClone(fixture.metadata);
  const before = JSON.stringify(host.context.chatMetadata).length;
  let saves = 0;
  host.context.saveMetadata = async () => { saves++; };
  await controller.loadChat();
  const after = JSON.stringify(host.context.chatMetadata).length;
  assert.ok(saves >= 1);
  const backupRef = host.context.chatMetadata.rpDirector_0_7_backup;
  assert.equal(Object.hasOwn(backupRef as object, 'inspector'), false, 'diagnostic payloads are omitted from rollback storage');
  await controller.setPaused(false); // any later persist
  assert.equal(host.context.chatMetadata.rpDirector_0_7_backup, backupRef, 'written once, never rewritten by the extension');
  // A SillyTavern branch/checkpoint saves { ...chat_metadata, main_chat } into the new file: the backup goes with it.
  const branchMetadata: Record<string, unknown> = { ...host.context.chatMetadata, main_chat: 'original' };
  assert.equal(branchMetadata.rpDirector_0_7_backup, backupRef);
  assert.ok(after < before, `legacy chat metadata must shrink from ${before} bytes, got ${after}`);
});
