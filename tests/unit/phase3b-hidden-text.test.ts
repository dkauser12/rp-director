import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleText } from '../../src/pipeline/spans.ts';

test('3b/13: a stopped reply hides unclosed details and HTML comments through end of text', () => {
  assert.equal(visibleText('She smiles.\n<details><summary>Tracker</summary>HIDDEN unfinished text'), 'She smiles.');
  assert.equal(visibleText('She smiles.\n<!-- HIDDEN unfinished text'), 'She smiles.');
  assert.equal(visibleText('She smiles.<!-- HIDDEN --> Then waves.<!-- HIDDEN unfinished'), 'She smiles. Then waves.');
});

test('3b/13: valid closing details tags with whitespace retain the prose that follows', () => {
  for (const close of ['</details >', '</details\t>', '</DETAILS\n>']) {
    assert.equal(visibleText(`Before.<details>HIDDEN${close}After.`), 'Before. After.');
    assert.equal(visibleText(`Before.<details>HIDDEN<details>NESTED${close}HIDDEN${close}After.`), 'Before. After.');
  }
});
