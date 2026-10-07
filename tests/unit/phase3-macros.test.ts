import test from 'node:test';
import assert from 'node:assert/strict';
import { registerDirectorMacros, resolveDirectorMacro } from '../../src/macros.ts';
import type { DirectorMacroDefinition, DirectorMacroState } from '../../src/macros.ts';
import { registerDirectorCommands } from '../../src/commands.ts';
import type { HostSlashCommand } from '../../src/host.ts';
import { workflowBadgeLabel } from '../../src/workflow-badge.ts';
import type { WorkflowBadge } from '../../src/workflow-badge.ts';

function state(): DirectorMacroState {
  return {
    active: true,
    modules: { decisions: true, pacing: true, meters: true, lore: true, speaker: true, secrets: true, reactions: true, replyCheck: true },
    outcome: 'at a price', odds: 0.34, roll: 0.34, scene: 'conversation', pack: 'default',
    meters: { Guide: { regard: 'warm' }, 'npc:guide': { regard: 'warm' } },
  };
}

/** The public registry ABI; nested arguments have already been evaluated by ST. */
function registeredReader(getState: () => DirectorMacroState | null | undefined) {
  let definition: DirectorMacroDefinition | null = null;
  assert.equal(registerDirectorMacros({ registerMacro(name, value) {
    assert.equal(name, 'director');
    definition = value;
    return value;
  } }, getState), true);
  assert.ok(definition);
  const reader = definition as DirectorMacroDefinition;
  return (key: string) => reader.handler({ args: key.split('::') });
}

test('C3 registry values use badge formats and zero dice remain truthy for nested if/setvar readers', () => {
  const current = state();
  const read = registeredReader(() => current);
  assert.equal(read('outcome'), 'at a price');
  assert.equal(read('odds'), '34%');
  assert.equal(read('roll'), '34/100');
  assert.equal(read('scene'), 'conversation');
  assert.equal(read('pack'), 'default');
  assert.equal(read('meter::Guide::regard'), 'warm');
  assert.equal(read('meter::npc:guide::regard'), 'warm');
  assert.equal(read('meter::guide::REGARD'), 'warm');
  assert.equal(read('active'), 'true');
  assert.equal(read('module::reply-check'), 'true');
  current.roll = 0;
  current.odds = 0;
  const variables = new Map<string, string>();
  // Registry callbacks return resolved strings to the outer macro. ST's false set
  // includes zero, false and off; the dice display intentionally avoids that set.
  const nested = read('roll');
  variables.set('director_roll', nested);
  assert.equal(['', '0', 'false', 'off'].includes(nested), false);
  assert.equal(variables.get('director_roll'), '0/100');
  assert.equal(read('odds'), '0%');
});

test('C3 readers observe the supplied generation, preserve wording swipes and read a new Roll again draw', () => {
  let current: DirectorMacroState | null = null;
  const read = registeredReader(() => current);
  assert.equal(read('outcome'), '', 'no previous-turn fallback before the pre-pass');
  current = state();
  const first = ['outcome', 'odds', 'roll', 'scene', 'meter::Guide::regard'].map(read);
  current = structuredClone(current);
  assert.deepEqual(['outcome', 'odds', 'roll', 'scene', 'meter::Guide::regard'].map(read), first, 'wording swipe reuses frozen values');
  current = { ...current, roll: 0.89, outcome: 'setback', odds: 0.2 };
  assert.deepEqual(['outcome', 'odds', 'roll', 'scene'].map(read), ['setback', '20%', '89/100', 'conversation']);
  current = null;
  assert.equal(read('roll'), '', 'a new unprepared turn cannot see the previous draw');
});

test('C3 outcome readers and badge pills display plain labels while preserving the stored id', () => {
  for (const [outcome, label] of [['not_yet', 'not yet'], ['at_a_price', 'at a price'], ['custom_result', 'custom result']] as const) {
    const current = { ...state(), outcome };
    const badge: WorkflowBadge = { schemaVersion: 1, attemptId: 'test', unavailable: false, errors: [], reaction: null,
      results: [{ source: 'move', actorId: 'player', action: 'Open the gate.', outcome, instruction: '', odds: null, draw: null }] };
    assert.equal(resolveDirectorMacro(current, 'outcome'), label);
    assert.equal(workflowBadgeLabel(badge), `Director · ${label}`);
    assert.equal(badge.results[0]!.outcome, outcome);
  }
});

test('C3 inactive/unset/module-off readers are empty, including invalid and inherited keys', () => {
  const current = state();
  for (const reason of ['off', 'paused', 'standing aside', 'unruled']) {
    const inactive = { ...current, active: false };
    for (const key of ['active', 'outcome', 'odds', 'roll', 'scene', 'pack', 'module::meters', 'meter::Guide::regard']) {
      assert.equal(resolveDirectorMacro(inactive, key), '', reason);
    }
  }
  current.modules = { ...current.modules, decisions: false, pacing: false, meters: false };
  for (const key of ['outcome', 'odds', 'roll', 'scene', 'meter::Guide::regard', 'module::meters']) assert.equal(resolveDirectorMacro(current, key), '');
  assert.equal(resolveDirectorMacro(current, 'module::lore'), 'true');
  assert.equal(resolveDirectorMacro(current, 'module::constructor'), '');
  assert.equal(resolveDirectorMacro(current, 'pack'), 'default');
  current.modules.meters = true;
  for (const key of ['unknown', '', 'meter::Missing::regard', 'meter::Guide::missing', 'meter::Guide::__proto__', 'meter::constructor::regard', 'outcome::extra', 'active::extra']) {
    assert.equal(resolveDirectorMacro(current, key), '');
  }
  assert.equal(resolveDirectorMacro({ active: true, modules: { decisions: true, pacing: true } }, 'roll'), '');
  assert.equal(resolveDirectorMacro({ ...current, pack: 'auto' }, 'pack'), '');
});

test('C3 macro dry runs never throw when host context is missing, stale or partially available', () => {
  const read = registeredReader(() => { throw new Error('dry run has no chat'); });
  assert.equal(read('active'), '');
  assert.equal(read('roll'), '');
  assert.equal(registerDirectorMacros(undefined, () => null), false);
  const partial = registeredReader(() => ({ active: true } as DirectorMacroState));
  assert.equal(partial('outcome'), '');
  for (const roll of [NaN, Infinity, -0.1, 1]) assert.equal(resolveDirectorMacro({ ...state(), roll }, 'roll'), '');
});

test('C3 slash commands use addCommandObject and preserve names, async mutations and macro pipeline values', async () => {
  const calls: unknown[][] = [];
  const commands = new Map<string, HostSlashCommand>();
  const current = state();
  assert.equal(registerDirectorCommands({
    SlashCommandParser: { addCommandObject: command => { const c = command as HostSlashCommand; commands.set(c.name, c); } },
    SlashCommand: { fromProps: props => props },
  }, {
    pause: async value => { calls.push(['pause', value]); },
    reroll: async () => { calls.push(['reroll']); },
    reassess: async () => { calls.push(['reassess']); },
    setPack: async value => { calls.push(['pack', value]); },
    setSpeaker: async value => { calls.push(['speaker', value]); },
    get: key => resolveDirectorMacro(current, key),
  }), true);
  assert.deepEqual([...commands.keys()], ['director-pause', 'director-reroll', 'director-reassess', 'director-pack', 'director-speaker', 'director-get']);
  const invoke = (name: string, text = '') => commands.get(`director-${name}`)!.callback({}, text);
  assert.equal(await invoke('pause', 'ON'), '');
  assert.equal(await invoke('pause', 'off'), '');
  assert.equal(await invoke('reroll'), '');
  assert.equal(await invoke('reassess'), '');
  assert.equal(await invoke('pack', 'default'), '');
  assert.equal(await invoke('pack', 'AUTO'), '');
  assert.equal(await invoke('speaker', 'River Guide'), '');
  assert.equal(await invoke('speaker', 'auto'), '');
  assert.equal(await invoke('get', 'meter::Guide::regard'), 'warm');
  assert.equal(await invoke('get', '{{director::roll}}'), '34/100');
  assert.equal(await invoke('get', 'unknown'), '');
  assert.deepEqual(calls, [['pause', true], ['pause', false], ['reroll'], ['reassess'], ['pack', 'default'], ['pack', 'auto'], ['speaker', 'River Guide'], ['speaker', 'auto']]);
  await assert.rejects(async () => invoke('pause', 'maybe'), /on.*off/);
  await assert.rejects(async () => invoke('pack'), /id\|auto/);
  await assert.rejects(async () => invoke('speaker'), /name\|auto\|yield/);
  assert.equal(calls.length, 8, 'invalid commands never mutate');
});
