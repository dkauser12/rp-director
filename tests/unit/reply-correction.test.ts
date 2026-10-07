import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withReplyCorrection } from '../../src/workflow.ts';

test('35: an OOC correction changes only the prompt copy of the last user message', () => {
  const messages = [
    { is_user: false, mes: 'System instructions.' },
    { is_user: true, mes: 'Earlier user message.' },
    { is_user: false, mes: 'Earlier reply.' },
    { is_user: true, mes: 'Latest user message.' },
    { is_user: false, mes: 'Current reply.' },
  ];
  const before = structuredClone(messages);
  const corrected = withReplyCorrection(messages, 'Leave the player\'s voluntary response open.');
  assert.deepEqual(messages, before, 'the stored transcript is unchanged');
  assert.deepEqual(corrected.slice(0, 3), before.slice(0, 3), 'the earlier prompt prefix is byte-for-byte stable');
  assert.equal(corrected[4], messages[4]);
  assert.equal(corrected[3]!.mes, "Latest user message.\n\n(OOC: Leave the player's voluntary response open.)");
  assert.notEqual(corrected[3], messages[3]);
});

test('35: missing user messages and empty corrections leave the prompt unchanged', () => {
  const messages = [{ is_user: false, mes: 'A reply.' }];
  assert.deepEqual(withReplyCorrection(messages, 'Correction.'), messages);
  assert.deepEqual(withReplyCorrection([{ is_user: true, mes: 'Hello.' }], '  '), [{ is_user: true, mes: 'Hello.' }]);
});
