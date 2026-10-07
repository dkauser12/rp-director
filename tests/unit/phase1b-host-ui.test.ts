import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostSlashCommand, StContext } from '../../src/host.ts';
import { normalizeBaseSettings } from '../../src/migration.ts';
import { buildActionPanel } from '../../src/manual-ui.ts';
import { packById } from '../../src/pack/packs.ts';
import { buildWorkflowBadge, workflowBadgeLabel } from '../../src/workflow-badge.ts';
import { openWorkflowBadge } from '../../src/ui.ts';
import { newRecord } from '../../src/state.ts';
import type { Controller } from '../../src/controller.ts';
import type { GenerationAttempt } from '../../src/types.ts';

class TestHost extends Host {
  generating = false;
  context = { chat: [{ name: 'Guide', mes: 'Reply.', is_user: false, is_system: false, swipe_id: 0, swipes: ['Reply.'] }],
    characters: [{ avatar: 'guide.png', name: 'Guide' }], characterId: 0, groupId: null, getCurrentChatId: () => 'chat',
    chatMetadata: {}, extensionSettings: {}, saveMetadata: async () => {}, swipe: { right: async () => {} },
  } as unknown as StContext;
  override ctx(): StContext { return this.context; }
  override isGenerating(): boolean { return this.generating; }
}

class ElementStub extends EventTarget {
  children: (ElementStub | string)[] = [];
  attributes: Record<string, string> = {};
  textContent = '';
  className = '';
  checked = false;
  disabled = false;
  readOnly = false;
  selected = false;
  value = '';
  placeholder = '';
  style = { display: 'block' };
  setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'value') this.value = value; }
  append(...children: (ElementStub | string)[]) { this.children.push(...children); }
  replaceChildren(...children: (ElementStub | string)[]) { this.children = children; }
  get options(): ElementStub[] { return this.children.filter(child => typeof child !== 'string'); }
  get selectedOptions(): ElementStub[] { return this.options.filter(option => option.selected); }
  click() { this.dispatchEvent(new Event('click')); }
}

function dom() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodes = new Map<string, ElementStub>();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => { const node = new ElementStub(); const set = node.setAttribute.bind(node); node.setAttribute = (key, value) => { set(key, value); if (key === 'id') nodes.set(value, node); }; return node; },
    createTextNode: (value: string) => value,
    getElementById: (id: string) => nodes.get(id) ?? null,
  } });
  return { nodes, close: () => { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); } };
}

function commands(host: TestHost, native: HostSlashCommand['callback']) {
  const original: HostSlashCommand = { name: 'regenerate', aliases: ['regen'], callback: native, isExtension: false, isThirdParty: false, source: 'slash-commands.js' };
  const registry: Record<string, HostSlashCommand> = { regenerate: original, regen: original };
  host.context.SlashCommand = { fromProps: props => ({ ...props }) };
  host.context.SlashCommandParser = { commands: registry, addCommandObject: value => {
    const command = value as HostSlashCommand;
    command.isExtension = true; command.isThirdParty = true; command.source = 'rp-director';
    for (const name of [command.name, ...(command.aliases ?? [])]) registry[name] = command;
  } };
  return registry;
}

test('review 16: generated swipes carry the slash-command source while the composer pipeline hides controls', async () => {
  const host = new TestHost();
  let options: Record<string, unknown> | undefined;
  host.context.swipe.to = async (_event, direction, value) => { assert.equal(direction, 'right'); options = value; };
  await host.swipeRight();
  assert.equal(options?.source, 'slash_command');
  assert.equal(options?.forceSwipeId, 1);
});

test('review 17: Swipes off falls back to native regenerate', async () => {
  const d = dom();
  try {
    const checkbox = new ElementStub(); checkbox.checked = false; d.nodes.set('swipes-checkbox', checkbox);
    const host = new TestHost(); const calls: string[] = [];
    host.context.generate = async type => { calls.push(type); };
    host.context.swipe.right = async () => { calls.push('swipe'); };
    await host.swipeRight();
    assert.deepEqual(calls, ['regenerate']);
  } finally { d.close(); }
});

test('review 17: mid-generation /regen keeps native wait-until-idle behavior', async () => {
  const host = new TestHost(); host.generating = true;
  let release!: () => void; const idle = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const registry = commands(host, async () => { await idle; calls.push('native'); return ''; });
  const remove = host.interceptRegenerateCommand(() => true, async () => { calls.push('swipe'); });
  try {
    const pending = registry.regen!.callback({ await: 'true' }, '');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(calls, [], 'no attempt is discarded or started before the host becomes idle');
    host.generating = false; release(); await pending;
    assert.deepEqual(calls, ['native']);
  } finally { release(); remove(); }
});

test('review 17: group regenerate keeps the native last-round callback and native help provenance', async () => {
  const host = new TestHost(); host.context.groupId = 'group'; const calls: string[] = [];
  const registry = commands(host, () => { calls.push('round'); return ''; });
  const remove = host.interceptRegenerateCommand(() => true, async () => { calls.push('single'); });
  try {
    assert.equal(registry.regen!.isThirdParty, false);
    assert.equal(registry.regen!.isExtension, false);
    assert.equal(registry.regen!.source, 'slash-commands.js');
    await registry.regen!.callback({ await: 'true' }, '');
    assert.deepEqual(calls, ['round']);
  } finally { remove(); }
});

test('review 17: an intercepted menu Regenerate closes the host options menu', async () => {
  const d = dom();
  try {
    const control = new ElementStub(); const toggle = new ElementStub(); const menu = new ElementStub();
    d.nodes.set('option_regenerate', control); d.nodes.set('options_button', toggle); d.nodes.set('options', menu);
    let closes = 0; toggle.addEventListener('click', () => { closes++; menu.style.display = 'none'; });
    const host = new TestHost(); let calls = 0;
    const remove = host.interceptNativeRegenerate(() => true, async () => { calls++; });
    control.dispatchEvent(new Event('click', { cancelable: true })); remove();
    assert.equal(calls, 1); assert.equal(closes, 1);
  } finally { d.close(); }
});

test('review 13: composer lock preserves text and restores its previous readonly state', () => {
  const d = dom();
  try {
    const textarea = new ElementStub(); textarea.value = 'Declared action.'; d.nodes.set('send_textarea', textarea);
    const host = new TestHost();
    host.setComposerLocked(true); host.setComposerLocked(true);
    assert.equal(textarea.readOnly, true); assert.equal(textarea.value, 'Declared action.');
    host.setComposerLocked(false); assert.equal(textarea.readOnly, false);
    textarea.readOnly = true; host.setComposerLocked(true); host.setComposerLocked(false);
    assert.equal(textarea.readOnly, true, 'does not release a lock that belongs to the host');
  } finally { d.close(); }
});

test('review 19: manual override families and discovery hints follow the selected chat pack', () => {
  const d = dom();
  try {
    let pack = packById('romance');
    const controller = { chatPack: () => pack, actionDraft: null, actionActorsForUi: () => [], setActionDraft: () => {} } as unknown as Controller;
    const panel = buildActionPanel(controller);
    const select = d.nodes.get('rpd-action-template')!;
    assert.deepEqual(select.options.map(option => option.value), pack.families.map(family => family.key));
    pack = packById('investigation'); panel.dispatchEvent(new Event('rpd-refresh'));
    assert.deepEqual(select.options.map(option => option.value), pack.families.map(family => family.key));
    select.value = pack.families.find(family => family.kind === 'discovery')!.key;
    select.dispatchEvent(new Event('change'));
    assert.match(d.nodes.get('rpd-action-evidence')!.placeholder, /only clues this character can perceive/);
  } finally { d.close(); }
});

test('reviews 24/25: saved judge waits clamp to two seconds and saved Mock connections migrate to OpenRouter', () => {
  for (const value of [0, 0.5, 1, 2]) assert.equal(normalizeBaseSettings(defaultSettings(), { waitForJudgeSeconds: value }).waitForJudgeSeconds, 2);
  const saved = { connection: { kind: 'mock', model: 'fixture-model', baseUrl: 'fixture', stProfileId: 'fixture-profile' } };
  const next = normalizeBaseSettings(defaultSettings(), saved);
  assert.equal(next.connection.kind, 'openrouter');
  assert.equal(next.connection.model, '', 'does not send the old mock model to a real provider');
  assert.equal(saved.connection.kind, 'mock', 'does not mutate the saved input');
});

test('review 25: raw legacy chat record is backed up once before the first normalized save', async () => {
  const host = new TestHost();
  const raw = { schemaVersion: 1, seedId: 'seed', projection: { state: { sceneId: 3 } }, privateField: { preserved: true } };
  host.context.chatMetadata.rpDirector = raw;
  const before = structuredClone(raw);
  await host.writeRecord(newRecord('seed', 'profile'), host.chatKey()!);
  assert.deepEqual(host.context.chatMetadata.rpDirector_0_7_backup, before);
  raw.privateField.preserved = false;
  await host.writeRecord(newRecord('seed', 'profile'), host.chatKey()!);
  assert.deepEqual(host.context.chatMetadata.rpDirector_0_7_backup, before, 'backup is independent and never replaced');
});

test('3b item 9: backup omits inspector, and removal is chat scoped and never replaces the current record', async () => {
  const host = new TestHost();
  const raw = { schemaVersion: 1, seedId: 'seed', projection: {}, inspector: [{ answers: 'diagnostics' }], story: { meters: 'kept' } };
  host.context.chatMetadata.rpDirector = raw;
  const current = newRecord('seed', 'profile');
  await host.writeRecord(current, host.chatKey()!);
  assert.deepEqual(host.context.chatMetadata.rpDirector_0_7_backup, { schemaVersion: 1, seedId: 'seed', projection: {}, story: { meters: 'kept' } });
  assert.equal(raw.inspector.length, 1, 'does not mutate the original input');
  assert.equal(await host.removeLegacyRecordBackup('another-chat'), false);
  assert.equal(host.hasLegacyRecordBackup(), true);
  assert.equal(await host.removeLegacyRecordBackup(host.chatKey()!), true);
  assert.equal(host.hasLegacyRecordBackup(), false);
  await host.writeRecord(current, host.chatKey()!);
  assert.equal(host.hasLegacyRecordBackup(), false, 'the normalized record does not recreate a removed backup');
  assert.deepEqual(host.context.chatMetadata.rpDirector, current);
});

test('3b item 17: native regenerate offers keep or reroll and dismissal keeps the result', async () => {
  const d = dom();
  try {
    const host = new TestHost();
    host.context.POPUP_TYPE = { CONFIRM: 2 };
    host.context.POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: null };
    let options: Record<string, unknown> = {};
    host.context.callGenericPopup = async (_content, _type, _input, value) => { options = value!; return null; };
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, defaultSettings(), false), 'reuse');
    assert.equal(options.cancelButton, false);
    assert.equal(options.okButton, 'Keep the result');
    assert.deepEqual((options.customButtons as { text: string }[]).map(button => button.text), ['Roll again']);
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, defaultSettings()), 'cancel', 'ordinary wording swipe still supports cancel');
  } finally { d.close(); }
});

test('3b item 18: a user-last regenerate stays native and the swipe helper generates a reply', async () => {
  const host = new TestHost(); host.context.chat[0]!.is_user = true;
  const calls: string[] = [];
  host.context.generate = async type => { calls.push(type); };
  const registry = commands(host, () => { calls.push('native'); });
  const remove = host.interceptRegenerateCommand(() => true, async () => { calls.push('swipe'); });
  try { await registry.regen!.callback({ await: 'true' }, ''); await host.swipeRight(); }
  finally { remove(); }
  assert.deepEqual(calls, ['native', 'normal']);
});

test('3b item 12: group draft enforcement selects the frozen actor before prompt construction', () => {
  const host = new TestHost(); host.context.groupId = 'group';
  host.context.characters.push({ name: 'Ranger', avatar: 'ranger.png' });
  host.context.groups = [{ id: 'group', name: 'Party', chat_id: 'chat', members: ['guide.png', 'ranger.png'], disabled_members: [] }];
  host.context.characterId = 1;
  const selected: unknown[] = [];
  Object.assign(host, { flags: {
    setCharacterId(index: number) { host.context.characterId = index; selected.push(index); },
    setCharacterName(name: string) { selected.push(name); },
  } });
  assert.equal(host.enforceGroupSpeaker('guide.png'), true);
  assert.deepEqual(selected, [0, 'Guide']);
  assert.equal(host.enforceGroupSpeaker('missing.png'), false);
});

test('3b item 12: Swipes-off regeneration receives the frozen group speaker', async () => {
  const d = dom();
  try {
    const checkbox = new ElementStub(); checkbox.checked = false; d.nodes.set('swipes-checkbox', checkbox);
    const host = new TestHost(); host.context.groupId = 'group';
    let options: Record<string, unknown> | undefined;
    host.context.generate = async (type, value) => { assert.equal(type, 'regenerate'); options = value; };
    await host.swipeRight(0);
    assert.equal(options?.force_chid, 0);
  } finally { d.close(); }
});

function attempt(stages: string[]): GenerationAttempt {
  return { attemptId: 'attempt', resolutionId: null, actorId: 'npc', cursorBefore: 'before', status: 'accepted',
    generationType: 'normal', hostMessageRef: 0, hostVariantRef: 0, variantId: null, injectedText: '', epoch: 1,
    unadjudicated: true, createdAt: 1, judgeErrors: ['timeout'], judgeFailedStages: stages } as GenerationAttempt;
}

test('reviews 5/22: badge retry targets only failed move/route/ruling stages; Decisions off hides all ruling actions', async () => {
  const d = dom();
  try {
    const host = new TestHost(); const record = newRecord('seed', 'profile');
    const controller = { host, record, settings: defaultSettings(), canRerollSelected: () => true } as unknown as Controller;
    host.context.POPUP_TYPE = { TEXT: 1 }; let buttons: string[] = [];
    host.context.callGenericPopup = async (_content, _type, _value, options) => { buttons = (options?.customButtons as { text: string }[]).map(button => button.text); return 1; };
    for (const stage of ['reaction', 'lore', 'pack', 'meters']) {
      record.attempts.attempt = attempt([stage]); host.writeWorkflowBadge(0, buildWorkflowBadge({ attempt: record.attempts.attempt }));
      await openWorkflowBadge(controller, 0); assert.equal(buttons.includes('Try the judge again'), false, stage);
    }
    for (const stage of ['move', 'route', 'ruling']) {
      record.attempts.attempt = attempt([stage]); host.writeWorkflowBadge(0, buildWorkflowBadge({ attempt: record.attempts.attempt }));
      await openWorkflowBadge(controller, 0); assert.equal(buttons.includes('Try the judge again'), true, stage);
    }
    controller.settings.modules.decisions = false;
    await openWorkflowBadge(controller, 0); assert.deepEqual(buttons, ['Open Activity']);
  } finally { d.close(); }
});

test('review 24: the badge identifies writer tool errors without blaming the judge', () => {
  const source = { ...attempt([]), judgeErrors: [], toolError: 'prose_before_tool: Prose preceded the request.' };
  const badge = buildWorkflowBadge({ attempt: source });
  assert.equal(badge.unavailable, false);
  assert.equal(badge.retryEligible, false);
  assert.match(workflowBadgeLabel(badge), /writer tool request rejected/);
  assert.doesNotMatch(workflowBadgeLabel(badge), /judge unavailable/);
});

test('review 30: package, lock and manifest agree, and runtime reads the package version', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const pkg = JSON.parse(read('package.json')); const manifest = JSON.parse(read('manifest.json')); const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, manifest.version); assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  const source = read('src/index.ts');
  assert.match(source, /import .* from ['"]\.\.\/package\.json['"]/);
  assert.doesNotMatch(source, /version: ['"]\d/);
});
