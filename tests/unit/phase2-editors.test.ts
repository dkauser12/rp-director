import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Controller } from '../../src/controller.ts';
import { defaultSettings } from '../../src/host.ts';
import { effectiveProfile } from '../../src/profiles.ts';
import { buildTableEditor, TABLE_HELP, TIP } from '../../src/tableui.ts';
import { buildLorePanel, refreshLorePanel } from '../../src/loreui.ts';
import { buildActionPanel } from '../../src/manual-ui.ts';
import { packById } from '../../src/pack/packs.ts';
import { TABLE_PRESETS } from '../../src/presets.ts';

class ElementStub extends EventTarget {
  tag: string;
  children: (ElementStub | string)[] = [];
  attributes: Record<string, string> = {};
  textContent = '';
  className = '';
  value = '';
  checked = false;
  disabled = false;
  selected = false;
  placeholder = '';
  title = '';
  tabIndex = 0;
  dataset: Record<string, string> = {};
  classList = { add: (_name: string) => {}, toggle: (_name: string, _force?: boolean) => {} };
  constructor(tag: string) { super(); this.tag = tag; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; if (key === 'value') this.value = value; if (key === 'title') this.title = value; }
  append(...children: (ElementStub | string)[]) { this.children.push(...children); }
  replaceChildren(...children: (ElementStub | string)[]) { this.children = children; }
  get options(): ElementStub[] { return this.children.filter(child => typeof child !== 'string'); }
  get selectedOptions(): ElementStub[] { return this.options.filter(option => option.selected); }
  querySelector(selector: string): ElementStub | null { return this.findAll(node => selector.startsWith('#') ? node.attributes.id === selector.slice(1) : node.tag === selector)[0] ?? null; }
  findAll(match: (node: ElementStub) => boolean): ElementStub[] { return this.children.flatMap(child => typeof child === 'string' ? [] : [...(match(child) ? [child] : []), ...child.findAll(match)]); }
  click() { this.dispatchEvent(new Event('click')); }
}

function dom(fetcher: typeof fetch = async () => ({ status: 404 } as Response)) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const fetchOriginal = globalThis.fetch;
  const root = new ElementStub('root');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: (tag: string) => new ElementStub(tag), createTextNode: (text: string) => text,
    getElementById: (id: string) => root.querySelector(`#${id}`),
  } });
  globalThis.fetch = fetcher;
  return { root, close() { globalThis.fetch = fetchOriginal; if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); } };
}

function tableController() {
  const settings = defaultSettings();
  const controller = {
    settings, profile: effectiveProfile(settings).profile, profileWarnings: [],
    host: { saveSettings() {}, toast() {} },
    reloadProfile() { controller.profile = effectiveProfile(settings).profile; },
  } as unknown as Controller;
  return controller;
}

test('phase 2: outcome draft reports unsaved edits until apply or discard while method applies immediately', async () => {
  const d = dom();
  try {
    const controller = tableController();
    const editor = buildTableEditor(controller);
    const element = editor.element as unknown as ElementStub;
    d.root.append(element);
    const top = element.children[0] as ElementStub;
    const method = top.querySelector('select')!;
    assert.deepEqual(method.options.map(option => option.textContent), ['Threshold', 'Dice']);
    assert.equal(editor.isDirty(), false);
    method.value = 'sample'; method.dispatchEvent(new Event('change'));
    assert.equal(controller.profile.resolutionMethod, 'sample');
    assert.equal(editor.isDirty(), false, 'an immediately saved method is not an unsaved table edit');
    const instruction = element.querySelector('textarea')!;
    instruction.value = 'The door remains closed.'; instruction.dispatchEvent(new Event('input'));
    assert.equal(editor.isDirty(), true);
    assert.notEqual(controller.profile.outcomes[0]!.instruction, instruction.value);
    element.querySelector('#rpd-bands-apply')!.click();
    assert.equal(controller.profile.outcomes[0]!.instruction, 'The door remains closed.');
    assert.equal(editor.isDirty(), false);
    element.querySelector('#rpd-row-add')!.click();
    assert.equal(editor.isDirty(), true);
    editor.reload();
    assert.equal(editor.isDirty(), false, 'discard restores the applied table');
    await new Promise(resolve => setImmediate(resolve));
  } finally { d.close(); }
});

test('phase 2: asynchronous local presets leave the open table draft and focused field intact', async () => {
  let complete!: (response: Response) => void;
  const d = dom(() => new Promise(resolve => { complete = resolve; }));
  try {
    const editor = buildTableEditor(tableController());
    const element = editor.element as unknown as ElementStub;
    d.root.append(element);
    const instruction = element.querySelector('textarea')!;
    instruction.value = 'The guard asks for a password.'; instruction.dispatchEvent(new Event('input'));
    complete({ status: 404 } as Response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(element.querySelector('textarea'), instruction);
    assert.equal(instruction.value, 'The guard asks for a password.');
    assert.equal(editor.isDirty(), true);
  } finally { d.close(); }
});

test('phase 3c: local preset discovery is quiet on success and keeps inline and console warnings', async () => {
  const notices: string[] = [];
  const warnings: unknown[][] = [];
  const localId = 'example_local_table';
  const preset = { ...structuredClone(TABLE_PRESETS[0]!), id: localId, label: 'Example local table' };
  const d = dom(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ schemaVersion: 1, presets: [preset, { id: 'invalid' }] }) } as Response));
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const controller = tableController();
    controller.host.toast = (_kind, message) => { notices.push(message); };
    const editor = buildTableEditor(controller);
    const element = editor.element as unknown as ElementStub;
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(element.querySelector('#rpd-preset')!.options.some(option => option.attributes.value === localId), 'the valid local preset is available');
    assert.deepEqual(notices, [], 'opening Outcomes does not announce routine success');
    assert.ok(element.findAll(node => node.textContent === 'Some local presets could not be loaded.').length);
    assert.ok(warnings.some(args => args[0] === '[RP Director] local presets:'));
  } finally {
    const index = TABLE_PRESETS.findIndex(preset => preset.id === localId);
    if (index >= 0) TABLE_PRESETS.splice(index, 1);
    console.warn = originalWarn;
    d.close();
  }
});

test('phase 2: table help uses plain row terminology and one sentence per hint', () => {
  for (const hint of [...TABLE_HELP, ...Object.values(TIP)]) {
    assert.doesNotMatch(hint, /\b(projection|band|binding|observer|permit|baseline|provisional|commit|variant|cursor)\b/i);
    assert.equal((hint.match(/[.!?](?:\s|$)/g) ?? []).length, 1, hint);
  }
});

function loreController(books: () => Promise<unknown[]>) {
  return {
    settings: defaultSettings(), loreHooked: true,
    host: { saveSettings() {}, chatKey: () => 'example-chat' },
    actorsForUi: () => [], loreActivationForUi: () => null, loreBooksForUi: books,
  } as unknown as Controller;
}

const book = { world: 'Town guide', mode: 'judge', public: true, source: 'Chat', selectable: 2, entries: 3, index: 'flat', tunnelVisionManages: false };

test('phase 2: reopening Lore rebuilds its book rows even when settings are unchanged', async () => {
  const d = dom();
  try {
    let calls = 0;
    const controller = loreController(async () => { calls++; return [book]; });
    d.root.append(buildLorePanel(controller) as unknown as ElementStub);
    await refreshLorePanel(controller);
    assert.equal(d.root.querySelector('#rpd-lore-books')!.querySelector('b')!.textContent, 'Town guide');
    await refreshLorePanel(controller);
    assert.equal(calls, 1, 'the same mounted view can reuse its rows');
    d.root.replaceChildren(buildLorePanel(controller) as unknown as ElementStub);
    await refreshLorePanel(controller);
    assert.equal(calls, 2);
    assert.equal(d.root.querySelector('#rpd-lore-books')!.querySelector('b')!.textContent, 'Town guide');
  } finally { d.close(); }
});

test('phase 2: a late Lore response cannot fill a newly opened workspace with old rows', async () => {
  const d = dom();
  try {
    let complete!: (books: unknown[]) => void;
    let calls = 0;
    const controller = loreController(() => ++calls === 1 ? new Promise(resolve => { complete = resolve; }) : Promise.resolve([book]));
    const first = buildLorePanel(controller) as unknown as ElementStub;
    d.root.append(first);
    const pending = refreshLorePanel(controller);
    d.root.replaceChildren(buildLorePanel(controller) as unknown as ElementStub);
    await refreshLorePanel(controller);
    complete([{ ...book, world: 'Old town' }]); await pending;
    assert.equal(d.root.querySelector('#rpd-lore-books')!.querySelector('b')!.textContent, 'Town guide');
    assert.equal(first.querySelector('#rpd-lore-books')!.querySelector('b'), null);
  } finally { d.close(); }
});

test('phase 2: manual actor and target labels always show the player as {{user}}', () => {
  const d = dom();
  try {
    const controller = { chatPack: () => packById('investigation'), actionDraft: null, setActionDraft() {},
      actionActorsForUi: () => [{ actorId: 'player', name: 'Example player', disabled: false }, { actorId: 'guide', name: 'Guide', disabled: false }],
    } as unknown as Controller;
    const panel = buildActionPanel(controller) as unknown as ElementStub;
    d.root.append(panel); panel.dispatchEvent(new Event('rpd-refresh'));
    for (const id of ['rpd-action-actor', 'rpd-action-target']) assert.deepEqual(panel.querySelector(`#${id}`)!.options.map(option => option.textContent), ['{{user}}', 'Guide']);
  } finally { d.close(); }
});
