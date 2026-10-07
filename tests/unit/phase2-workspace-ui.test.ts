import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountUi, openDirector, openWorkflowBadge } from '../../src/ui.ts';
import { defaultSettings } from '../../src/host.ts';
import { effectiveProfile } from '../../src/profiles.ts';
import { newRecord } from '../../src/state.ts';
import { packById } from '../../src/pack/packs.ts';
import type { Controller } from '../../src/controller.ts';
import type { HostChatMessage } from '../../src/host.ts';
import type { WorkflowBadge } from '../../src/workflow-badge.ts';
import type { InspectorEntry } from '../../src/types.ts';

/** Only connected nodes are visible to document queries, as in the host popup. */
class ElementStub extends EventTarget {
  tagName: string;
  children: (ElementStub | string)[] = [];
  parent: ElementStub | null = null;
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  textContent = '';
  className = '';
  value = '';
  checked = false;
  selected = false;
  disabled = false;
  hidden = false;
  open = false;
  title = '';
  tabIndex = 0;
  style = { display: '' };
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean) => { const next = force ?? !this.classList.contains(name); if (next) this.classList.add(name); else this.classList.remove(name); return next; },
  };
  constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); }
  get id() { return this.attributes.id ?? ''; }
  set id(value: string) { this.attributes.id = value; }
  get options(): ElementStub[] { return this.children.filter(child => child instanceof ElementStub); }
  get selectedOptions(): ElementStub[] { return this.options.filter(option => option.selected); }
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
    if (key === 'value') this.value = value;
    if (key === 'title') this.title = value;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_match, char: string) => char.toUpperCase())] = value;
  }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  append(...children: (ElementStub | string)[]) { for (const child of children) { if (child instanceof ElementStub) { child.remove(); child.parent = this; } this.children.push(child); } }
  replaceChildren(...children: (ElementStub | string)[]) { for (const child of this.children) if (child instanceof ElementStub) child.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  focus() {}
  click() { this.dispatchEvent(new Event('click')); }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1]!)) return false;
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const match of selector.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      const key = match[1]!;
      const value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_all, char: string) => char.toUpperCase())] : this.attributes[key];
      if (value === undefined || match[2] !== undefined && value !== match[2]) return false;
    }
    return !selector.includes(':checked') || this.checked;
  }
  querySelectorAll(selector: string): ElementStub[] {
    const space = selector.indexOf(' ');
    if (space !== -1) return this.querySelectorAll(selector.slice(0, space)).flatMap(node => node.querySelectorAll(selector.slice(space + 1)));
    return this.children.flatMap(child => child instanceof ElementStub ? [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)] : []);
  }
  querySelector(selector: string): ElementStub | null { return this.querySelectorAll(selector)[0] ?? null; }
  text(): string { return this.textContent + this.children.map(child => typeof child === 'string' ? child : child.text()).join(''); }
}

type PopupOptions = { onOpen?: (popup: unknown) => unknown; onClosing?: () => Promise<boolean> | boolean; [key: string]: unknown };
interface Popup {
  element: ElementStub;
  options: PopupOptions;
  resolve: (result: number) => void;
}

function fixture() {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const oldFetch = globalThis.fetch;
  const root = new ElementStub('body');
  const settingsHost = new ElementStub('div'); settingsHost.setAttribute('id', 'extensions_settings2');
  const menuHost = new ElementStub('div'); menuHost.setAttribute('id', 'extensionsMenu');
  root.append(settingsHost, menuHost);
  const documentStub = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(documentStub, {
    createElement: (tag: string) => new ElementStub(tag), createTextNode: (text: string) => text,
    getElementById: (id: string) => root.querySelector(`#${id}`),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: ElementStub });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
  globalThis.fetch = async () => ({ status: 404 } as Response);
  const popups: Popup[] = [];
  const confirmations: string[] = [];
  const notices: string[] = [];
  let hasBackup = true;
  const hostEvents = new Map<string, (() => void)[]>();
  let confirmResult = 0;
  let refresh = () => {};
  let command: ((tab?: string) => Promise<unknown>) | null = null;
  let chatKey = 'example-chat';
  const settings = defaultSettings(); settings.enabled = true; settings.connection.kind = 'mock';
  const savedSettings: ReturnType<typeof defaultSettings>[] = [];
  const profile = effectiveProfile(settings).profile;
  const record = newRecord('example-chat', profile.revision);
  record.actors.player = { actorId: 'player', avatar: 'persona', name: 'Example player', control: 'user' };
  const chat: HostChatMessage[] = [
    { name: 'Example player', mes: 'I ask about the gate.', is_user: true, is_system: false },
    { name: 'Guide', mes: 'The guide answers.', is_user: false, is_system: false, swipe_id: 0 },
  ];
  const badges = new Map<number, WorkflowBadge>();
  let beforeMount = false;
  const context = {
    name1: 'Example player', POPUP_TYPE: { TEXT: 'text', CONFIRM: 'confirm' }, POPUP_RESULT: { AFFIRMATIVE: 1 },
    async callGenericPopup(content: HTMLElement | string, type: unknown, _input: string, options: PopupOptions) {
      if (type === 'confirm') { confirmations.push(String(content)); return confirmResult; }
      const element = content as unknown as ElementStub;
      assert.equal(element.parent, null, 'popup content must start detached');
      beforeMount = true;
      await Promise.resolve();
      root.append(element);
      let resolve!: (result: number) => void;
      const pending = new Promise<number>(done => { resolve = done; });
      popups.push({ element, options, resolve });
      await options.onOpen?.({});
      return pending;
    },
  };
  const pack = packById('investigation');
  const host = {
    ctx: () => context, chatKey: () => chatKey, chat: () => chat, readWorkflowBadge: (id: number) => badges.get(id) ?? null,
    on(event: string, handler: () => void) { hostEvents.set(event, [...(hostEvents.get(event) ?? []), handler]); },
    registerWorkspaceCommand(callback: (tab?: string) => Promise<unknown>) { command = callback; return true; },
    connectionProfiles: () => [], saveSettings() { savedSettings.push(structuredClone(settings)); }, toast(_kind: string, message: string) { notices.push(message); },
    hasLegacyRecordBackup: () => hasBackup,
    async removeLegacyRecordBackup(expectedChatKey: string) { if (expectedChatKey !== chatKey) return false; hasBackup = false; return true; },
    isGenerating: () => false, fingerprintMessages: (messages: HostChatMessage[]) => messages.map(message => ({ role: message.is_user ? 'user' : 'assistant', text: message.mes, actorKey: message.name })),
  };
  const controller = {
    host, settings, profile, record, status: 'Ready', lastError: null, lastWorkingConnection: null, speakerOverride: null, actionDraft: null, profileWarnings: [], loreHooked: true,
    onChange(callback: () => void) { refresh = callback; },
    setEnabled(value: boolean) { settings.enabled = value; refresh(); },
    async setPaused(value: boolean) { record.paused = value; refresh(); },
    setSpeakerOverride() {}, async setChatPack() {}, async addSecret() {}, async removeSecret() {},
    reloadProfile() { controller.profile = effectiveProfile(settings).profile; refresh(); },
    actorsForUi: () => [{ actorId: 'guide', name: 'Guide', disabled: false }],
    actionActorsForUi: () => [{ actorId: 'player', name: '{{user}}', disabled: false }, { actorId: 'guide', name: 'Guide', disabled: false }],
    chatPackInfo: () => ({ packId: pack.id, source: 'manual' }), packsForUi: () => [pack], chatPack: () => pack,
    characterStateForUi: () => [{ name: 'Guide', meters: [{ label: 'Trust', level: 'Cautious', rank: '2 of 5' }] }],
    secretsForUi: () => [], lastLoreForUi: () => null, loreActivationForUi: () => null,
    loreBooksForUi: async () => [{ world: 'Town guide', mode: 'judge', public: true, source: 'Chat', selectable: 1, entries: 1, index: 'none', tunnelVisionManages: false }],
    setActionDraft() {}, canRerollSelected: () => false,
  } as unknown as Controller;
  return {
    controller, root, popups, confirmations, notices, badges, chat, savedSettings,
    emit: (event: string) => { for (const handler of hostEvents.get(event) ?? []) handler(); },
    setChatKey: (value: string) => { chatKey = value; },
    beforeMount: () => beforeMount, setConfirmation: (value: number) => { confirmResult = value; },
    command: (tab?: string) => { assert.ok(command); return command(tab); }, refresh: () => refresh(),
    async close(popup: Popup, result = 1) {
      if (popup.options.onClosing && !await popup.options.onClosing()) return false;
      popup.element.remove(); popup.resolve(result); await flush(); return true;
    },
    restore() {
      globalThis.fetch = oldFetch;
      for (const [name, previous] of [['document', oldDocument], ['HTMLElement', oldElement], ['sessionStorage', oldStorage]] as const) {
        if (previous) Object.defineProperty(globalThis, name, previous); else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('3b item 9: Advanced removes only the current chat rollback copy and disables the completed action', async () => {
  const f = fixture();
  try {
    const record = structuredClone(f.controller.record);
    const pending = openDirector(f.controller, 'settings'); await flush();
    const remove = f.root.querySelector('#rpd-remove-rollback')!;
    assert.equal(remove.disabled, false);
    remove.click(); await flush();
    assert.equal(remove.disabled, true);
    assert.deepEqual(f.controller.record, record);
    assert.deepEqual(f.notices, ['Removed the 0.7 rollback copy.']);
    await f.close(f.popups[0]!); await pending;
  } finally { f.restore(); }
});

test('3b item 30: workspace marks its native dialog for independent viewport sizing', async () => {
  const f = fixture();
  try {
    const pending = openDirector(f.controller); await flush();
    const dialog = new ElementStub('dialog');
    await f.popups[0]!.options.onOpen?.({ dlg: dialog });
    assert.equal(dialog.classList.contains('rpd-workspace-dialog'), true);
    await f.close(f.popups[0]!); await pending;
  } finally { f.restore(); }
});

test('C4 Activity lists each request and the badge keeps turn cost after inspector trimming', async () => {
  const f = fixture();
  try {
    const usage = [
      { requestId: 'scene-request', stage: 'state', costUsd: 0.0012, inputTokens: 20, outputTokens: 4, durationMs: 8 },
      { requestId: 'check-request', stage: 'reply_check', costUsd: 0.0003, inputTokens: 12, outputTokens: 3, durationMs: 5 },
    ];
    f.badges.set(1, { schemaVersion: 1, attemptId: 'cost-attempt', unavailable: false, errors: [], results: [], reaction: null, requestUsage: usage,
      pacing: { scene: 'conversation', handBack: 'HAND_BACK', dynamicResponse: true, instruction: 'Stay here.', handBackInstruction: 'Stop at the question.' },
      replyCheck: { speaksForUser: 0, responds: 2, repeats: 0, followsRuling: null, reason: null, nudge: '' }, rerolledByCheck: 'writes for {{user}}', replyOriginalSwipe: 0 });
    const pending = openDirector(f.controller, 'activity'); await flush();
    const popup = f.popups[0]!;
    assert.equal(popup.element.querySelectorAll('.rpd-request-usage').length, 2);
    assert.match(popup.element.text(), /state · \$0\.0012 · Tokens in\/out: 20\/4/);
    assert.match(popup.element.text(), /reply check · \$0\.0003 · Tokens in\/out: 12\/3/);
    assert.match(popup.element.text(), /Requests: 2 · \$0\.0015 · Tokens in\/out: 32\/7/);
    assert.match(popup.element.text(), /Scene: conversation/);
    assert.match(popup.element.text(), /The original reply is swipe 1/);
    assert.match(popup.element.text(), /No automatic rewrite needed/);
    await f.close(popup); await pending;
    const badgePending = openWorkflowBadge(f.controller, 1); await flush();
    const badgePopup = f.popups[1]!;
    assert.match(badgePopup.element.text(), /Requests: 2 · \$0\.0015 · Tokens in\/out: 32\/7/);
    await f.close(badgePopup); await badgePending;
  } finally { f.restore(); }
});

test('C4 Settings counts fresh request costs once across chats and never charges saved or wording records', async () => {
  const f = fixture();
  try {
    const usage = { requestId: 'new-request', stage: 'state', costUsd: 0.0012, inputTokens: 20, outputTokens: 4, durationMs: 8 };
    f.controller.record!.inspector = [{ ...inspector('old-receipt', 1), requestUsage: [{ ...usage, requestId: 'saved-request', costUsd: 9 }] }];
    mountUi(f.controller);
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!, session = popup.element.querySelector('#rpd-session')!;
    assert.equal(session.textContent, 'Session: 0 requests · $0.0000');
    f.controller.record!.inspector.push({ ...inspector('new-receipt', 1), requestUsage: [usage] }); f.refresh();
    assert.equal(session.textContent, 'Session: 1 requests · $0.0012');
    f.refresh();
    f.controller.record!.inspector.push({ ...inspector('wording', 0), requestUsage: [] }); f.refresh();
    assert.equal(session.textContent, 'Session: 1 requests · $0.0012');
    f.setChatKey('next-chat'); f.controller.record = newRecord('next-chat', f.controller.profile.revision);
    f.controller.record.inspector = [{ ...inspector('another-saved-receipt', 1), requestUsage: [{ ...usage, requestId: 'other-saved', costUsd: 15 }] }]; f.refresh();
    assert.equal(session.textContent, 'Session: 1 requests · $0.0012');
    f.controller.record.inspector.push({ ...inspector('free-request', 1), requestUsage: [{ ...usage, requestId: 'free', costUsd: 0 }] }); f.refresh();
    assert.equal(session.textContent, 'Session: 2 requests · $0.0012');
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('C4 Settings uses runtime session receipts even after cancellation removes the turn history', async () => {
  const f = fixture();
  try {
    const receipts = [{ requestId: 'cancelled-call', stage: 'state', costUsd: null as number | null, inputTokens: null, outputTokens: null, durationMs: 0 }];
    Object.defineProperty(f.controller, 'sessionUsage', { value: receipts });
    mountUi(f.controller);
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!, session = popup.element.querySelector('#rpd-session')!;
    assert.equal(session.textContent, 'Session: 1 requests · cost not reported');
    receipts[0]!.costUsd = 0.0012; f.refresh();
    assert.equal(session.textContent, 'Session: 1 requests · $0.0012');
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('C1/C2/C5 Settings switches the new modules and enables hand-back only under Pacing', async () => {
  const f = fixture();
  try {
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!;
    const pacing = popup.element.querySelector('#rpd-module-pacing')!;
    const replyCheck = popup.element.querySelector('#rpd-module-reply-check')!;
    const handBack = popup.element.querySelector('#rpd-hand-back-beats')!;
    assert.equal(handBack.checked, true);
    pacing.checked = false; pacing.dispatchEvent(new Event('change'));
    assert.equal(f.controller.settings.modules.pacing, false);
    assert.equal(handBack.disabled, true);
    pacing.checked = true; pacing.dispatchEvent(new Event('change'));
    assert.equal(handBack.disabled, false);
    handBack.checked = false; handBack.dispatchEvent(new Event('change'));
    assert.equal(f.controller.settings.handBackBeats, false);
    replyCheck.checked = false; replyCheck.dispatchEvent(new Event('change'));
    assert.equal(f.controller.settings.modules.replyCheck, false);
    assert.doesNotMatch(popup.element.text(), /saved for when .* becomes available/);
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('workspace fills the initial chat pane only after the host mounts its popup', async () => {
  const f = fixture();
  try {
    const pending = openDirector(f.controller);
    await flush();
    assert.equal(f.beforeMount(), true);
    const popup = f.popups[0]!;
    assert.equal(popup.options.wide, true);
    assert.equal(popup.options.large, true);
    assert.equal(popup.element.querySelector('#rpd-pack')!.options.length, 2);
    assert.equal(popup.element.querySelector('#rpd-speaker')!.options.length, 3);
    assert.match(popup.element.querySelector('#rpd-meters')!.text(), /Guide: Trust: Cautious/);
    assert.equal(popup.element.querySelector('#rpd-secret-holders')!.querySelectorAll('input').length, 2);
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('workspace keeps a table draft across tabs and rejects closing until discard is confirmed', async () => {
  const f = fixture();
  try {
    const pending = openDirector(f.controller, 'outcomes'); await flush();
    const popup = f.popups[0]!;
    const instruction = popup.element.querySelector('textarea')!;
    instruction.value = 'The guide asks for proof.'; instruction.dispatchEvent(new Event('input'));
    popup.element.querySelector('#rpd-tab-chat')!.click();
    assert.equal(popup.element.querySelector('#rpd-pane-outcomes')!.hidden, true);
    popup.element.querySelector('#rpd-tab-outcomes')!.click();
    assert.equal(popup.element.querySelector('textarea'), instruction);
    assert.equal(instruction.value, 'The guide asks for proof.');
    f.setConfirmation(0);
    assert.equal(await f.close(popup), false);
    assert.equal(f.confirmations.length, 1);
    assert.equal(f.root.querySelector('#rpd-workspace'), popup.element);
    assert.equal(instruction.value, 'The guide asks for proof.');
    f.setConfirmation(1);
    assert.equal(await f.close(popup), true);
    await pending;
    assert.notEqual(f.controller.profile.outcomes[0]!.instruction, instruction.value, 'discard must not apply the draft');
  } finally { f.restore(); }
});

test('drawer, wand menu and command share one workspace and slash tabs populate after mounting', async () => {
  const f = fixture();
  try {
    mountUi(f.controller);
    assert.equal(f.root.querySelector('#rpd-status')!.textContent, 'Ready');
    assert.equal(f.root.querySelector('#rpd-open-menu')!.textContent, 'Director');
    f.root.querySelector('#rpd-open')!.click(); await flush();
    assert.equal(f.popups.length, 1);
    const first = f.popups[0]!;
    await f.command('  ACTIVITY ');
    assert.equal(f.popups.length, 1);
    assert.equal(first.element.querySelector('#rpd-tab-activity')!.getAttribute('aria-selected'), 'true');
    assert.match(first.element.querySelector('#rpd-activity')!.text(), /Last 20 replies/);
    f.root.querySelector('#rpd-open-menu')!.click(); await flush();
    assert.equal(f.popups.length, 1);
    assert.equal(first.element.querySelector('#rpd-tab-activity')!.getAttribute('aria-selected'), 'true');
    await f.close(first);
    const command = f.command('lore'); await flush();
    const second = f.popups[1]!;
    assert.match(second.element.querySelector('#rpd-lore-books')!.text(), /Town guide/);
    await f.close(second); await command;
    f.root.querySelector('#rpd-open-menu')!.click(); await flush();
    assert.equal(f.popups.length, 3);
    await f.close(f.popups[2]!);
  } finally { f.restore(); }
});

test('a reply badge opens Activity for that reply after the badge popup closes', async () => {
  const f = fixture();
  try {
    f.badges.set(1, { schemaVersion: 1, attemptId: 'example-attempt', unavailable: false, errors: [], results: [], reaction: null, move: 'Example player asks about the gate.' });
    const pending = openWorkflowBadge(f.controller, 1); await flush();
    const badgePopup = f.popups[0]!;
    const controls = badgePopup.options.customButtons as { text: string; result: number }[];
    const activity = controls.find(control => control.text === 'Open Activity'); assert.ok(activity);
    await f.close(badgePopup, activity.result); await flush();
    const workspace = f.popups[1]!;
    assert.equal(workspace.element.querySelector('#rpd-tab-activity')!.getAttribute('aria-selected'), 'true');
    assert.equal(workspace.element.querySelector('#rpd-turn-1')!.getAttribute('aria-pressed'), 'true');
    assert.match(workspace.element.querySelector('.rpd-activity-detail')!.text(), /\{\{user\}\} asks about the gate/);
    await f.close(workspace); await pending;
  } finally { f.restore(); }
});

test('an older badge opens its own detail beyond the recent 20 and keeps mobile details visible on refresh', async () => {
  const f = fixture();
  try {
    f.badges.set(1, { schemaVersion: 1, attemptId: 'early-attempt', unavailable: false, errors: [], results: [], reaction: null, move: 'Example player asks about the old gate.' });
    for (let turn = 0; turn < 24; turn++) {
      f.chat.push({ name: 'Example player', is_user: true, is_system: false, mes: `Later move ${turn}.` });
      f.chat.push({ name: 'Guide', is_user: false, is_system: false, mes: `Later reply ${turn}.`, swipe_id: 0 });
    }
    mountUi(f.controller);
    const pending = openWorkflowBadge(f.controller, 1); await flush();
    const badgePopup = f.popups[0]!;
    const controls = badgePopup.options.customButtons as { text: string; result: number }[];
    const activity = controls.find(control => control.text === 'Open Activity'); assert.ok(activity);
    await f.close(badgePopup, activity.result); await flush();
    const workspace = f.popups[1]!;
    assert.equal(workspace.element.querySelector('#rpd-turn-1'), null, 'the recent list stays limited to 20 replies');
    assert.equal(workspace.element.querySelector('.rpd-activity-list')!.querySelectorAll('button').length, 20);
    assert.match(workspace.element.querySelector('.rpd-activity-detail')!.text(), /\{\{user\}\} asks about the old gate/);
    assert.equal(workspace.element.querySelector('.rpd-activity-layout')!.classList.contains('rpd-detail-open'), true);
    f.refresh();
    assert.equal(workspace.element.querySelector('.rpd-activity-layout')!.classList.contains('rpd-detail-open'), true);
    f.chat.push({ name: 'Guide', is_user: false, is_system: false, mes: 'A new reply arrives.', swipe_id: 0 });
    f.refresh();
    assert.match(workspace.element.querySelector('.rpd-activity-detail')!.text(), /\{\{user\}\} asks about the old gate/);
    assert.equal(workspace.element.querySelector('.rpd-activity-layout')!.classList.contains('rpd-detail-open'), true, 'new Activity data must preserve the mobile detail view');
    workspace.element.querySelector('#rpd-activity-back')!.click();
    assert.equal(workspace.element.querySelector('.rpd-activity-layout')!.classList.contains('rpd-detail-open'), false);
    await f.close(workspace); await pending;
  } finally { f.restore(); }
});

function inspector(id: string, requests: number): InspectorEntry {
  return {
    id, at: 1, epoch: 1, kind: 'director_send', attemptId: 'recorded-attempt', resolutionId: null, actionId: null,
    applicability: null, questions: null, stateSent: null,
    answers: { ruling: { type: 'noul', noul: 0.5, confidence: null, provenance: 'native' } },
    speaker: null, policyBandId: null, draw: null, outcome: null, injectedText: null, providerKind: 'jev',
    requestedModel: 'example-model', returnedModel: 'example-model', durationMs: 20,
    inputTokens: 10, outputTokens: 5, networkCalls: requests, message: 'The judge replied.',
  };
}

test('Settings verifies OpenRouter Jev replies and counts only requests made during this session', async () => {
  const f = fixture();
  try {
    f.controller.settings.connection.kind = 'openrouter';
    f.controller.settings.connection.model = '~typesafe/jev-latest';
    f.controller.record!.inspector = [inspector('saved-before-open', 7)];
    mountUi(f.controller);
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!;
    const connection = popup.element.querySelector('#rpd-connection-section')!;
    assert.equal(connection.querySelector('summary b')!.textContent, 'Connection', 'saved requests are not a live connection check');
    assert.match(popup.element.querySelector('#rpd-session')!.textContent, /^Session: 0 requests/);
    f.controller.record!.inspector.push(inspector('new-judge-reply', 3));
    f.controller.lastWorkingConnection = JSON.stringify(f.controller.settings.connection);
    f.refresh();
    assert.equal(connection.querySelector('summary b')!.textContent, 'Connected');
    assert.equal(connection.open, false);
    assert.match(popup.element.querySelector('#rpd-session')!.textContent, /^Session: 3 requests/);
    f.setChatKey('another-example-chat');
    f.controller.record = newRecord('another-example-chat', f.controller.profile.revision);
    f.controller.record.inspector = [inspector('saved-in-another-chat', 41)];
    f.refresh();
    assert.match(popup.element.querySelector('#rpd-session')!.textContent, /^Session: 3 requests/, 'opening saved history must not add its old requests to this session');
    f.controller.record.inspector.push(inspector('new-other-chat-reply', 2));
    f.refresh();
    assert.match(popup.element.querySelector('#rpd-session')!.textContent, /^Session: 5 requests/);
    const oldSignature = JSON.stringify(f.controller.settings.connection);
    f.controller.settings.connection.model = 'example/new-model';
    f.refresh();
    assert.equal(connection.querySelector('summary b')!.textContent, 'Connection');
    assert.equal(connection.open, true);
    f.controller.record.inspector.push(inspector('late-old-model-result', 1));
    f.controller.lastWorkingConnection = oldSignature;
    f.refresh();
    assert.equal(connection.querySelector('summary b')!.textContent, 'Connection', 'a late result from the old connection must not verify the new settings');
    f.controller.lastWorkingConnection = JSON.stringify(f.controller.settings.connection);
    f.refresh();
    assert.equal(connection.querySelector('summary b')!.textContent, 'Connected');
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('turning badges off hides pills without deleting reply details and rendered messages restore them when enabled', async () => {
  const f = fixture();
  try {
    const saved: WorkflowBadge = { schemaVersion: 1, attemptId: 'saved-attempt', unavailable: false, errors: [], results: [], reaction: null };
    f.badges.set(1, saved);
    const chatElement = new ElementStub('div'); chatElement.id = 'chat';
    const messageElement = new ElementStub('div'); messageElement.className = 'mes'; messageElement.setAttribute('mesid', '1');
    const block = new ElementStub('div'); block.className = 'mes_block';
    messageElement.append(block); chatElement.append(messageElement); f.root.append(chatElement);
    mountUi(f.controller);
    assert.ok(block.querySelector('.rpd-workflow-badge'));
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!;
    const toggle = popup.element.querySelector('#rpd-badges')!;
    toggle.checked = false; toggle.dispatchEvent(new Event('change'));
    assert.equal(f.controller.settings.showBadges, false);
    assert.equal(block.querySelector('.rpd-workflow-badge'), null);
    assert.equal(f.badges.get(1), saved, 'hiding the badge must preserve its recorded decisions');
    toggle.checked = true; toggle.dispatchEvent(new Event('change'));
    assert.ok(block.querySelector('.rpd-workflow-badge'));
    const replacement = new ElementStub('div'); replacement.className = 'mes_block';
    messageElement.replaceChildren(replacement);
    f.emit('CHARACTER_MESSAGE_RENDERED');
    assert.ok(replacement.querySelector('.rpd-workflow-badge'));
    assert.equal(f.badges.get(1), saved);
    await f.close(popup); await pending;
  } finally { f.restore(); }
});

test('pacing text and reply-check thresholds save edits and reject invalid scores', async () => {
  const f = fixture();
  try {
    const pending = openDirector(f.controller, 'settings'); await flush();
    const popup = f.popups[0]!;
    const combat = popup.element.querySelector('#rpd-pacing-combat')!;
    const repeats = popup.element.querySelector('#rpd-check-repeats')!;
    assert.equal(combat.value, f.controller.settings.pacingTexts.combat);
    assert.equal(repeats.value, String(f.controller.settings.replyCheckThresholds.repeats));
    assert.match(popup.element.text(), /Hand the turn back at beats/);
    assert.match(popup.element.text(), /thresholds trigger an automatic rewrite or a nudge/);
    assert.match(popup.element.text(), /Check each reply and automatically rewrite at most once per user turn/);
    combat.value = 'Keep each exchange brief and wait for {{user}} to act.';
    combat.dispatchEvent(new Event('change'));
    repeats.value = '2.75'; repeats.dispatchEvent(new Event('change'));
    assert.equal(f.controller.settings.pacingTexts.combat, combat.value);
    assert.equal(f.controller.settings.replyCheckThresholds.repeats, 2.75);
    assert.equal(f.savedSettings.at(-1)!.pacingTexts.combat, combat.value);
    assert.equal(f.savedSettings.at(-1)!.replyCheckThresholds.repeats, 2.75);
    const saves = f.savedSettings.length;
    for (const invalid of ['', '-1', '5', 'not a number']) {
      repeats.value = invalid; repeats.dispatchEvent(new Event('change'));
      assert.equal(repeats.value, '2.75');
      assert.equal(f.controller.settings.replyCheckThresholds.repeats, 2.75);
    }
    assert.equal(f.savedSettings.length, saves, 'invalid scores must not be saved');
    await f.close(popup); await pending;
    const reopened = openDirector(f.controller, 'settings'); await flush();
    const next = f.popups[1]!;
    assert.equal(next.element.querySelector('#rpd-pacing-combat')!.value, combat.value);
    assert.equal(next.element.querySelector('#rpd-check-repeats')!.value, '2.75');
    await f.close(next); await reopened;
  } finally { f.restore(); }
});
