import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workspace buttons and table labels retain the host min-content wrapping fix', async () => {
  const css = await readFile(new URL('../../style.css', import.meta.url), 'utf8');
  assert.match(css, /\.rpd-workspace-body \.menu_button\s*\{[^}]*width:\s*fit-content;[^}]*overflow-wrap:\s*normal;/);
  assert.match(css, /\.rpd-workspace-body table :is\(th, td\)\s*\{[^}]*overflow-wrap:\s*normal;/);
});
