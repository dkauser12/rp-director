/**
 * C3 registration order. src/index.ts registers the macros only after
 * `await controller.init()` succeeds. If init throws (or before it finishes), no
 * `director` macro exists, ST leaves `{{director::active}}` as raw text, and {{if}}
 * treats raw text as TRUE (verified on ST's real engine: tests/host-harness/st-macro/
 * unregistered.mjs), which inverts every preset guard. The handler already returns
 * '' safely without a controller record, so registering first costs nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../../src/host.ts';

test('C3: readers and commands are registered while init is pending and remain registered if init fails', async t => {
  let finishFlags!: () => void;
  const flags = new Promise<void>(resolve => { finishFlags = resolve; });
  t.mock.method(Host.prototype, 'loadFlags', () => flags);
  const registered: string[] = [];
  const commands: string[] = [];
  const context = {
    macros: { registry: { registerMacro: (name: string) => { registered.push(name); return {}; } } },
    SlashCommand: { fromProps: (props: { name: string }) => props },
    SlashCommandParser: { addCommandObject: (command: { name: string }) => { commands.push(command.name); } },
    chat: [], characters: [], groups: [], name1: 'Player', characterId: undefined, groupId: null, chatId: undefined, chatMetadata: {},
    extensionSettings: {}, eventTypes: { CHAT_CHANGED: 'CHAT_CHANGED' },
    eventSource: { on: () => { throw new Error('host event bus unavailable'); }, removeListener: () => {} },
    getCurrentChatId: () => undefined, getRequestHeaders: () => ({}), saveSettingsDebounced: () => {},
  };
  (globalThis as any).SillyTavern = { getContext: () => context };
  (globalThis as any).document = { readyState: 'complete', body: { dataset: {} }, getElementById: () => null, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  const errors: unknown[][] = [];
  const originalError = console.error; console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await import('../../src/index.ts');
    assert.deepEqual(registered, ['director'], 'pending init already has the safe empty reader');
    assert.equal(commands.length, 6, 'pending init already has the command handlers');
    finishFlags();
    for (let i = 0; i < 50 && !errors.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  } finally { console.error = originalError; }
  assert.ok(errors.some(args => String(args[0]).includes('failed to initialise')), 'sanity: init failed');
  assert.ok(errors.some(args => String(args[1]).includes('host event bus unavailable')), 'the failure occurred inside controller.init');
  assert.deepEqual(registered, ['director'], 'the reader must exist so guards resolve to "" instead of raw (truthy) text');
  assert.deepEqual(commands, ['director-pause', 'director-reroll', 'director-reassess', 'director-pack', 'director-speaker', 'director-get']);
});
