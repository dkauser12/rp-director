import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowBadge, isWorkflowBadge, workflowBadgeLabel, WORKFLOW_BADGE_KEY } from '../../src/workflow-badge.ts';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostChatMessage, HostSlashCommand, StContext } from '../../src/host.ts';
import { freeze } from '../../src/resolver.ts';
import type { GenerationAttempt, TurnPermit, PermittedAction } from '../../src/types.ts';
import type { Controller } from '../../src/controller.ts';
import { openWorkflowBadge } from '../../src/ui.ts';
import { newRecord } from '../../src/state.ts';

function attempt(): GenerationAttempt {
  return {
    attemptId: 'attempt', resolutionId: 'ruling', actorId: 'npc', cursorBefore: 'before', status: 'writing',
    generationType: 'normal', hostMessageRef: null, hostVariantRef: null, variantId: null, injectedText: '',
    epoch: 1, unadjudicated: false, createdAt: 1,
  };
}

function ruling() {
  return freeze({
    resolutionId: 'ruling', previousResolutionId: null,
    action: { actionId: 'action', templateId: 'acquire_secure', actingActorId: 'player', playerActorId: 'player', targetActorIds: [],
      attemptedAction: 'I take the key.', requestedGain: 'key secured', applicability: 'favorable', preconditions: [] },
    snapshot: { chatId: 'chat', cursorBefore: 'before', stateRevision: 0, scopeId: 'public', profileRevision: 'profile', catalogRevision: '', actorBindingRevision: '', state: {} },
    assessment: { type: 'noul', noul: 0.8, confidence: null, provenance: 'fixture' }, decisionSource: 'provider', policyRevision: 'profile',
    band: { id: 'band', lowerInclusive: 0, upper: 1, upperInclusive: true, thresholdOutcome: 'at a price', sampleWeights: { 'at a price': 0.34, blocked: 0.66 } },
    method: 'sample', draw: 0.51, outcome: 'at a price', cursorBefore: 'before', generation: 1, providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1,
  });
}

function npcPermit(): TurnPermit {
  const action: PermittedAction = {
    proposalId: 'npc', resolutionId: 'npc-roll', actingActorId: 'npc', targetActorIds: ['player'], family: 'contest_impose', method: 'Pushes the door.',
    boundedResult: 'The door opens.', failureStake: { kind: 'delay', detail: 'Door stays closed.' }, opposed: true,
    outcome: 'blocked', instruction: 'The door remains closed.', recordedValue: '', finalForScope: false, scope: 'attempt',
    draw: 0.99, methodUsed: 'sample', policyBand: ruling().policyBand!,
  };
  return { schemaVersion: 1, permitId: 'permit', attemptId: 'attempt', speakerActorId: 'npc', baseCursor: 'before', stateRevision: 0,
    actions: [action], compactState: { sceneId: 1, revision: 0 }, constraints: [], createdAt: 1 };
}

class BadgeHost extends Host {
  context = { chat: [], characters: [{ avatar: 'npc.png', name: 'Guide' }], characterId: 0, groupId: null, getCurrentChatId: () => 'chat' } as unknown as StContext;
  override ctx(): StContext { return this.context; }
  override isGenerating(): boolean { return false; }
}

test('the badge shows frozen outcome odds and dice rather than confidence or assessment', () => {
  const resolution = ruling();
  const original = structuredClone(resolution);
  const badge = buildWorkflowBadge({ attempt: attempt(), resolution });
  assert.equal(workflowBadgeLabel(badge), 'Director · at a price · 34% · rolled 51');
  assert.equal(badge.results[0]?.action, 'I take the key.');
  assert.deepEqual(resolution, original);
  assert.equal(isWorkflowBadge(badge), true);
});

test('automatic NPC rolls are listed alongside the player ruling without review history', () => {
  const permit = npcPermit();
  permit.reviewHistory = [{ permitId: 'old', actions: [{ ...permit.actions[0]!, outcome: 'old outcome' }], choice: 'reroll', at: 0 }];
  const badge = buildWorkflowBadge({ attempt: attempt(), resolution: ruling(), permit });
  assert.equal(badge.results.length, 2);
  assert.equal(badge.results[1]?.source, 'npc');
  assert.equal(badge.results[1]?.draw, 0.99);
  assert.equal(badge.results[1]?.instruction, 'The door remains closed.');
  assert.equal(JSON.stringify(badge).includes('old outcome'), false);
  assert.match(workflowBadgeLabel(badge), /\+1 roll$/);
});

test('judge failure is visible while successful frozen parts stay available', () => {
  const item = attempt();
  item.judgeErrors = ['timeout', 'timeout'];
  item.toolError = 'invalid NPC action';
  const badge = buildWorkflowBadge({ attempt: item, resolution: ruling() });
  assert.equal(badge.unavailable, true);
  assert.deepEqual(badge.errors, ['timeout', 'invalid NPC action']);
  assert.equal(badge.results[0]?.draw, 0.51);
  assert.match(workflowBadgeLabel(badge), /^Director · judge unavailable · at a price/);
  assert.equal(workflowBadgeLabel(buildWorkflowBadge({ attempt: attempt() })), 'Director · no move');
});

test('badge writes preserve prose, isolate swipe data and survive selected-swipe restoration', () => {
  const host = new BadgeHost();
  const message: HostChatMessage = { name: 'Guide', is_user: false, is_system: false, mes: 'First wording.', swipe_id: 0,
    swipes: ['First wording.', 'Second wording.'], swipe_info: [{ extra: { other: 'one' } }, { extra: { other: 'two' } }], extra: { other: 'one' } };
  host.context.chat = [message];
  const first = buildWorkflowBadge({ attempt: attempt(), resolution: ruling() });
  host.writeWorkflowBadge(0, first);
  first.results[0]!.outcome = 'mutated caller';
  assert.equal(host.readWorkflowBadge(0)?.results[0]?.outcome, 'at a price');
  assert.equal(message.mes, 'First wording.');
  assert.deepEqual(message.swipes, ['First wording.', 'Second wording.']);
  assert.equal(message.swipe_info![0]!.extra!.other, 'one');
  assert.equal(message.swipe_info![1]!.extra![WORKFLOW_BADGE_KEY], undefined);
  message.swipe_id = 1;
  message.extra = structuredClone(message.swipe_info![1]!.extra);
  host.writeWorkflowBadge(0, buildWorkflowBadge({ attempt: { ...attempt(), attemptId: 'second', judgeErrors: ['network'] } }));
  assert.equal(host.readWorkflowBadge(0)?.attemptId, 'second');
  message.swipe_id = 0;
  message.extra = structuredClone(message.swipe_info![0]!.extra);
  assert.equal(host.readWorkflowBadge(0)?.attemptId, 'attempt');
  assert.equal(host.readWorkflowBadge(0)?.unavailable, false);
  assert.equal(host.writeWorkflowBadge(0, null), true);
  assert.equal(host.readWorkflowBadge(0), null);
  assert.equal(host.writeWorkflowBadge(0, null), false);
  assert.equal((message.swipe_info![1]!.extra![WORKFLOW_BADGE_KEY] as unknown as { attemptId: string }).attemptId, 'second', 'clearing edited swipe metadata preserves another swipe');
});

test('malformed imported badge data and user-message data are ignored', () => {
  const host = new BadgeHost();
  const badge = buildWorkflowBadge({ attempt: attempt() });
  host.context.chat = [{ name: 'Player', is_user: true, is_system: false, mes: 'Hi', extra: {} }];
  host.writeWorkflowBadge(0, badge);
  assert.deepEqual(host.chat()[0]!.extra, {});
  assert.equal(host.readWorkflowBadge(0), null);
  for (const value of [null, {}, { ...badge, results: [{}] }, { ...badge, errors: [1] }, { ...badge, reaction: {} }]) assert.equal(isWorkflowBadge(value), false);
});

test('W4 slash commands dispatch one explicit action and return no composer text', async () => {
  const host = new BadgeHost();
  const commands: HostSlashCommand[] = [];
  host.context.SlashCommand = { fromProps: props => props };
  host.context.SlashCommandParser = { addCommandObject: command => commands.push(command as typeof commands[number]) };
  const calls: string[] = [];
  const actions = { pause: () => {}, reroll: async () => { calls.push('reroll'); }, reassess: async () => { calls.push('reassess'); },
    setPack: () => {}, setSpeaker: () => {}, get: () => '' };
  assert.equal(host.registerDirectorCommands(actions), true);
  for (const name of ['director-reroll', 'director-reassess']) {
    assert.equal(commands.filter(command => command.name === name).length, 1);
    assert.equal(await commands.find(command => command.name === name)!.callback({}, ''), '');
  }
  assert.deepEqual(calls, ['reroll', 'reassess']);
  delete host.context.SlashCommand;
  assert.equal(host.registerDirectorCommands(actions), false);
});

test('production defaults use the recommended connection and bounded staged wait without binding or observer state', () => {
  const settings = defaultSettings();
  assert.equal(settings.connection.kind, 'openrouter');
  assert.equal(settings.pipeline, 'staged');
  assert.equal(settings.settingsRevision, 3);
  assert.equal(settings.waitForJudgeSeconds, 10);
  assert.equal(settings.askWhenSwiping, true);
  assert.equal(settings.reviewNpcRolls, true);
  assert.equal('bindingConfirmedAt' in settings, false);
  assert.equal('observerConnection' in settings, false);
});

class ElementStub {
  children: unknown[] = [];
  textContent = '';
  className = '';
  checked = false;
  setAttribute() {}
  append(...children: unknown[]) { this.children.push(...children); }
}

test('badge popup exposes explicit reroll and reassess without applying either on close', async () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementStub(), createTextNode: (text: string) => text } });
  try {
    const host = new BadgeHost();
    host.context.chat = [{ name: 'Guide', is_user: false, is_system: false, mes: 'Reply.', swipe_id: 0, extra: {} }];
    host.context.POPUP_TYPE = { TEXT: 1 };
    const record = newRecord('seed', 'profile');
    record.attempts.attempt = attempt();
    host.writeWorkflowBadge(0, buildWorkflowBadge({ attempt: attempt(), resolution: ruling(), permit: npcPermit() }));
    const calls: string[] = [];
    const controller = { host, record, settings: defaultSettings(), canRerollSelected: () => true,
      reroll: async (swipe: boolean) => { calls.push(`reroll:${swipe}`); }, reassess: async (swipe: boolean) => { calls.push(`reassess:${swipe}`); },
      retryJudge: async () => { calls.push('retry'); } } as unknown as Controller;
    let choice: unknown = 1;
    host.context.callGenericPopup = async (_content, _type, _value, options) => {
      assert.deepEqual((options?.customButtons as { text: string }[]).map(button => button.text), ['Roll again', 'Reassess', 'Open Activity']);
      return choice;
    };
    await openWorkflowBadge(controller, 0);
    assert.deepEqual(calls, []);
    choice = 1001;
    await openWorkflowBadge(controller, 0);
    choice = 1002;
    await openWorkflowBadge(controller, 0);
    assert.deepEqual(calls, ['reroll:true', 'reassess:true']);
    host.context.callGenericPopup = async () => { host.chat()[0]!.swipe_id = 1; return 1001; };
    await openWorkflowBadge(controller, 0);
    assert.deepEqual(calls, ['reroll:true', 'reassess:true'], 'a popup opened for a different swipe cannot reroll the current one');
    host.writeWorkflowBadge(0, buildWorkflowBadge({ attempt: { ...attempt(), judgeErrors: ['timeout'] } }));
    host.context.callGenericPopup = async (_content, _type, _value, options) => {
      assert.ok((options?.customButtons as { text: string }[]).some(button => button.text === 'Try the judge again'));
      return 1003;
    };
    await openWorkflowBadge(controller, 0);
    assert.deepEqual(calls, ['reroll:true', 'reassess:true', 'retry']);
    host.context.callGenericPopup = async () => { host.chat()[0]!.mes = 'Edited while popup was open.'; return 1003; };
    await openWorkflowBadge(controller, 0);
    assert.deepEqual(calls, ['reroll:true', 'reassess:true', 'retry'], 'in-place transcript edits invalidate the popup target');
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('W3 ruled swipe choice defaults to Keep and remembers the optional silent setting', async () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementStub(), createTextNode: (text: string) => text } });
  try {
    const host = new BadgeHost();
    const settings = defaultSettings();
    let saves = 0;
    let popupCalls = 0;
    host.saveSettings = () => { saves++; };
    host.context.POPUP_TYPE = { CONFIRM: 2 };
    host.context.POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: 0 };
    host.context.callGenericPopup = async (content, _type, _value, options) => {
      popupCalls++;
      assert.equal(options?.okButton, 'Keep the result');
      assert.equal(options?.cancelButton, 'Cancel');
      assert.deepEqual((options?.customButtons as { text: string }[]).map(button => button.text), ['Roll again']);
      const label = (content as unknown as ElementStub).children[2] as ElementStub;
      (label.children[0] as ElementStub).checked = true;
      return 1;
    };
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, settings), 'reuse');
    assert.equal(settings.askWhenSwiping, false);
    assert.equal(saves, 1);
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, settings), 'reuse');
    assert.equal(popupCalls, 1);
    settings.askWhenSwiping = true;
    host.context.callGenericPopup = async () => 1001;
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, settings), 'reroll');
    host.context.callGenericPopup = async () => 0;
    assert.equal(await host.chooseSwipeAction('ruled', true, undefined, settings), 'cancel');
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('W8 NPC review shows percentages and 0–100 rolls, and Stop closes the waiting popup', async () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => new ElementStub(), createTextNode: (text: string) => text } });
  try {
    const host = new BadgeHost();
    host.context.POPUP_TYPE = { CONFIRM: 2 };
    host.context.POPUP_RESULT = { AFFIRMATIVE: 1, CANCELLED: 0 };
    const textOf = (node: ElementStub): string => `${node.textContent} ${node.children.map(child => typeof child === 'string' ? child : textOf(child as ElementStub)).join(' ')}`;
    host.context.callGenericPopup = async (content, _type, _value, options) => {
      const text = textOf(content as unknown as ElementStub);
      assert.match(text, /66% · rolled 99/);
      assert.doesNotMatch(text, /draw|support|threshold assessment/);
      assert.equal(options?.okButton, 'Keep & continue');
      assert.equal(options?.cancelButton, 'Cancel');
      return 1;
    };
    assert.equal(await host.reviewRolls(npcPermit(), { npc: 'Guide' }, 'sample', new AbortController().signal), 'keep');
    const abort = new AbortController();
    host.context.callGenericPopup = async (_content, _type, _value, options) => new Promise(resolve => {
      const onOpen = options?.onOpen as (popup: { complete: (value: unknown) => Promise<unknown> }) => void;
      onOpen({ complete: async value => { resolve(value); } });
      abort.abort();
    });
    assert.equal(await host.reviewRolls(npcPermit(), { npc: 'Guide' }, 'sample', abort.signal), 'cancel');
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('host sending is gated only by active generation, not swipe or editing state', () => {
  const host = new BadgeHost();
  host.context.swipe = { right: async () => {}, state: () => 'editing' };
  assert.equal(host.nativeSendBlocked(), false);
  host.isGenerating = () => true;
  assert.equal(host.nativeSendBlocked(), true);
});

test('native capture leaves editing to ST and replaces only managed Regenerate clicks', () => {
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const send = new EventTarget();
  const regenerate = new EventTarget();
  const doc = Object.assign(new EventTarget(), { getElementById: (id: string) => id === 'send_but' ? send : id === 'option_regenerate' ? regenerate : null });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  try {
    const host = new BadgeHost();
    host.context.chat = [{ name: 'Guide', mes: 'The guide waits.', is_user: false, is_system: false, swipe_id: 0, swipes: ['The guide waits.'] }];
    let swipeState = 'editing';
    host.context.swipe = { right: async () => {}, state: () => swipeState };
    host.composerText = () => 'Continue.';
    let managed = true;
    let directorSends = 0;
    let nativeSends = 0;
    let directorRegenerates = 0;
    let nativeRegenerates = 0;
    const removeSend = host.interceptNativeSend(() => true, async () => { directorSends++; });
    const removeRegenerate = host.interceptNativeRegenerate(() => managed, async () => { directorRegenerates++; });
    send.addEventListener('click', () => { nativeSends++; });
    regenerate.addEventListener('click', () => { nativeRegenerates++; });
    send.dispatchEvent(new Event('click', { cancelable: true }));
    assert.deepEqual([nativeSends, directorSends], [1, 0]);
    swipeState = 'none';
    send.dispatchEvent(new Event('click', { cancelable: true }));
    assert.deepEqual([nativeSends, directorSends], [1, 1]);
    regenerate.dispatchEvent(new Event('click', { cancelable: true }));
    managed = false;
    regenerate.dispatchEvent(new Event('click', { cancelable: true }));
    assert.deepEqual([nativeRegenerates, directorRegenerates], [1, 1]);
    removeSend(); removeRegenerate();
    regenerate.dispatchEvent(new Event('click', { cancelable: true }));
    assert.equal(nativeRegenerates, 2);
  } finally {
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('managed /regenerate and /regen preserve parser arguments, native fallback, await behavior and disposal', async () => {
  const host = new BadgeHost();
  host.context.chat = [{ name: 'Guide', is_user: false, is_system: false, mes: 'Frozen reply.', swipe_id: 0 }];
  const nativeCalls: { named: unknown; unnamed: unknown; self: unknown }[] = [];
  const awaitDefinition = { name: 'await', defaultValue: 'false' };
  const original: HostSlashCommand = {
    name: 'regenerate', aliases: ['regen'], namedArgumentList: [awaitDefinition], helpString: 'Native regeneration help',
    callback: function (named, unnamed) { nativeCalls.push({ named, unnamed, self: this }); return 'native-result'; },
  };
  const registry: Record<string, HostSlashCommand> = { regenerate: original, regen: original };
  host.context.SlashCommand = { fromProps: props => ({ ...props }) };
  host.context.SlashCommandParser = { commands: registry, addCommandObject: value => {
    const command = value as HostSlashCommand;
    registry[command.name] = command;
    for (const alias of command.aliases ?? []) registry[alias] = command;
  } };
  let managed = false;
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const mayFinish = new Promise<void>(resolve => { finish = resolve; });
  const remove = host.interceptRegenerateCommand(() => managed, async () => { started(); await mayFinish; });
  assert.notEqual(registry.regenerate, original);
  assert.equal(registry.regen, registry.regenerate);
  assert.equal((registry.regenerate!.namedArgumentList as unknown[])[0], awaitDefinition);
  assert.equal(registry.regenerate!.helpString, original.helpString);
  const named = { await: 'true', _scope: { pipe: 'kept' } };
  const unnamed = { custom: 'preserve identity' };
  assert.equal(registry.regen!.callback(named, unnamed), 'native-result');
  assert.deepEqual(nativeCalls, [{ named, unnamed, self: original }]);
  managed = true;
  let resolved = false;
  const pending = Promise.resolve(registry.regenerate!.callback(named, '')).then(value => { resolved = true; return value; });
  await didStart;
  assert.equal(resolved, false, 'await=true does not return until the managed wording swipe finishes');
  finish();
  assert.equal(await pending, '');
  assert.equal(nativeCalls.length, 1);
  remove();
  assert.equal(registry.regenerate, original);
  assert.equal(registry.regen, original);
});

test('regenerate registry hook leaves foreign aliases alone, cancels stale scheduling and never overwrites a later owner', async () => {
  const host = new BadgeHost();
  host.context.chat = [{ name: 'Guide', is_user: false, is_system: false, mes: 'Frozen reply.', swipe_id: 0 }];
  const original: HostSlashCommand = { name: 'regenerate', aliases: ['regen'], callback: () => 'native' };
  const foreign: HostSlashCommand = { name: 'foreign', aliases: [], callback: () => 'foreign' };
  const registry: Record<string, HostSlashCommand> = { regenerate: original, regen: foreign };
  host.context.SlashCommand = { fromProps: props => ({ ...props }) };
  host.context.SlashCommandParser = { commands: registry, addCommandObject: value => {
    const command = value as HostSlashCommand;
    registry[command.name] = command;
    for (const alias of command.aliases ?? []) registry[alias] = command;
  } };
  let regenerations = 0;
  const remove = host.interceptRegenerateCommand(() => true, async () => { regenerations++; });
  assert.equal(registry.regen, foreign);
  const pending = registry.regenerate!.callback({ await: 'true' }, '');
  host.chat()[0]!.swipe_id = 1;
  assert.equal(await pending, '');
  assert.equal(regenerations, 0);
  registry.regenerate = foreign;
  remove();
  assert.equal(registry.regenerate, foreign);
  assert.equal(registry.regen, foreign);
  delete host.context.SlashCommandParser;
  assert.doesNotThrow(() => host.interceptRegenerateCommand(() => true, async () => {})());
});

test('managed /regen without await returns immediately while its scheduled wording swipe proceeds', async () => {
  const host = new BadgeHost();
  host.context.chat = [{ name: 'Guide', is_user: false, is_system: false, mes: 'Frozen reply.', swipe_id: 0 }];
  const original: HostSlashCommand = { name: 'regenerate', aliases: ['regen'], callback: () => assert.fail('unexpected native regeneration') };
  const registry: Record<string, HostSlashCommand> = { regenerate: original, regen: original };
  host.context.SlashCommand = { fromProps: props => ({ ...props }) };
  host.context.SlashCommandParser = { commands: registry, addCommandObject: value => {
    const command = value as HostSlashCommand;
    registry[command.name] = command;
    for (const alias of command.aliases ?? []) registry[alias] = command;
  } };
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  const remove = host.interceptRegenerateCommand(() => true, async () => { started(); });
  assert.equal(registry.regen!.callback({}, ''), '');
  await didStart;
  remove();
});
