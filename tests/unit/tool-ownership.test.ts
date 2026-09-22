import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostFunctionTool, StContext } from '../../src/host.ts';

const makeTool = (label: string): HostFunctionTool => ({ name: 'RPDirector_AdjudicateTurn', description: label, parameters: {}, action: async () => label });

test('disabled base does not register over another owner; inactive teardown cannot remove current tool', () => {
  let tool: HostFunctionTool | null = null;
  const settings = defaultSettings();
  const context = { extensionSettings: { rpDirector: settings }, registerFunctionTool: (value: HostFunctionTool) => { tool = value; }, unregisterFunctionTool: () => { tool = null; } } as unknown as StContext;
  class LocalHost extends Host { override ctx() { return context; } }
  const first = new LocalHost(), second = new LocalHost();
  assert.equal(first.registerFunctionTool(makeTool('first')), true);
  settings.enabled = false;
  assert.equal(second.registerFunctionTool(makeTool('disabled')), false);
  assert.equal(tool!.description, 'first');
  settings.enabled = true;
  assert.equal(second.registerFunctionTool(makeTool('second')), true);
  first.unregisterFunctionTool('RPDirector_AdjudicateTurn');
  assert.equal(tool!.description, 'second');
  second.unregisterFunctionTool('RPDirector_AdjudicateTurn');
  assert.equal(tool, null);
});

test('base takeover disables a loaded Auto runtime while retaining the base settings reference', () => {
  const settings = defaultSettings();
  const autoSettings = { enabled: true };
  const context = { extensionSettings: { rpDirector: settings, rpDirectorAuto: autoSettings }, saveSettingsDebounced: () => {} } as unknown as StContext;
  class LocalHost extends Host { override ctx() { return context; } }
  let disabled = 0, destroyed = 0;
  const global = globalThis as unknown as Record<string, unknown>;
  const previous = global.rpDirectorAuto;
  global.rpDirectorAuto = { controller: { setEnabled: (value: boolean) => { assert.equal(value, false); disabled++; }, destroy: () => { destroyed++; } } };
  try {
    new LocalHost().takeOverAuto();
    assert.equal(autoSettings.enabled, false);
    assert.equal(context.extensionSettings.rpDirector, settings);
    assert.equal(disabled, 1); assert.equal(destroyed, 1);
  } finally { if (previous === undefined) delete global.rpDirectorAuto; else global.rpDirectorAuto = previous; }
});
