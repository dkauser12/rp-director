import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostChatMessage, StContext } from '../../src/host.ts';
import { applyEvent, emptyState, newRecord } from '../../src/state.ts';
import { actorIdFor, prefixCursor } from '../../src/identity.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, FrozenResolution } from '../../src/types.ts';

type SwipeChoice = Awaited<ReturnType<Host['chooseSwipeAction']>>;
type Handler = (...args: unknown[]) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'the expected async boundary was reached');
}

/** The actual Controller and Host adapters run against this in-memory ST boundary. */
class TestHost extends Host {
  private handlers = new Map<string, Handler[]>();
  currentChatId = 'native-test';
  confirmCount = 0;
  swipeChoices: string[] = [];
  generated = 0;
  injection = '';
  notices: string[] = [];
  confirmResult: () => Promise<boolean> = async () => false;
  swipeResult: () => Promise<SwipeChoice> = async () => 'reuse';
  context: StContext;

  constructor() {
    super();
    const settings = defaultSettings();
    this.context = {
      chat: [
        { name: 'Player', is_user: true, is_system: false, mes: 'I try the gate.' },
        { name: 'Guide', is_user: false, is_system: false, mes: 'The gate remains shut.', original_avatar: 'guide.png', swipe_id: 0, swipes: ['The gate remains shut.'], extra: {} },
      ],
      characters: [{ name: 'Guide', avatar: 'guide.png', description: 'A guide.' }],
      groups: [], name1: 'Player', characterId: 0, groupId: null, chatId: 'native-test',
      chatMetadata: {}, extensionSettings: { rpDirector: settings },
      eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED'].map(name => [name, name])),
      eventSource: {
        on: (name, handler) => { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); },
        removeListener: (name, handler) => { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); },
      },
      getCurrentChatId: () => this.currentChatId,
      getRequestHeaders: () => ({}),
      generate: async () => { this.generated += 1; },
      stopGeneration: () => {}, saveMetadata: async () => {}, saveChat: async () => {}, saveSettingsDebounced: () => {},
      setExtensionPrompt: (_key, value) => { this.injection = value; },
      swipe: { right: async () => {}, state: () => 'none' },
      uuidv4: () => 'test-uuid',
      ConnectionManagerRequestService: { sendRequest: async () => { throw new Error('Unexpected sidecar request'); } },
      ChatCompletionService: { processRequest: async () => { throw new Error('Unexpected completion request'); } },
    };
  }

  override ctx(): StContext { return this.context; }
  override async loadFlags(): Promise<void> {}
  override isGenerating(): boolean { return false; }
  override isAutoMode(): boolean { return false; }
  override composerText(): string { return ''; }
  override interceptNativeSend(): () => void { return () => {}; }
  override toast(_kind: 'info' | 'success' | 'warning' | 'error', message: string): void { this.notices.push(message); }
  override async confirm(): Promise<boolean> { this.confirmCount += 1; return this.confirmResult(); }
  override async chooseSwipeAction(kind: 'ruled' | 'native'): Promise<SwipeChoice> {
    this.swipeChoices.push(kind);
    return this.swipeResult();
  }
  async emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(...args);
  }
}

async function harness() {
  const host = new TestHost();
  const controller = new Controller(host);
  await controller.init();
  return { host, controller };
}

test('disabled base creates no history and chat switches disarm manual declarations', async () => {
  const host = new TestHost();
  (host.context.extensionSettings.rpDirector as ReturnType<typeof defaultSettings>).enabled = false;
  host.context.extensionSettings.rpDirectorAuto = { enabled: true };
  const controller = new Controller(host);
  await controller.init();
  assert.equal(controller.record, null);
  assert.equal(host.context.chatMetadata.rpDirector, undefined);
  controller.actionDraft = { templateId: 'overcome_operate', actingActorId: 'player', targetActorIds: [], attemptedAction: 'old chat action', requestedGain: 'old result', applicability: 'favorable', uncertainConsequential: true, opposed: false, resolutionScope: 'attempt', persistentFactKey: '', failureStakeKind: 'delay', failureStakeDetail: '', availableEvidence: '' };
  await controller.loadChat();
  assert.equal(controller.actionDraft, null);
  assert.equal(host.context.chatMetadata.rpDirector, undefined);
});

function overswipe(host: TestHost): HostChatMessage {
  const message = host.chat().at(-1)!;
  // Native ST preserves the old text/marker while moving to the unsaved slot.
  message.swipe_id = message.swipes!.length;
  return message;
}

test('the collapsed manual override still adjudicates its declared method and result', async () => {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  controller.setActionDraft({ templateId: 'overcome_operate', actingActorId: 'player', targetActorIds: [], attemptedAction: 'pick the gate lock', requestedGain: 'the lock opens',
    applicability: 'favorable', uncertainConsequential: true, opposed: false, resolutionScope: 'attempt', persistentFactKey: '', failureStakeKind: 'delay', failureStakeDetail: 'lose a minute', availableEvidence: 'a pick and a worn lock' });
  let sentKeys: string[] = [];
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => { sentKeys = Object.keys(request.questions); return base.evaluate(request, signal); } };
  };
  await controller.directorSend();
  assert.deepEqual(sentKeys, ['gain_noul']);
  const resolution = Object.values(controller.record!.resolutions)[0];
  assert.equal(resolution?.action.attemptedAction, 'pick the gate lock');
  assert.equal(resolution?.action.requestedGain, 'the lock opens');
  assert.equal(controller.actionDraft, null);
  assert.equal(host.generated, 1);
});

test('duplicate native Director Send calls share a single pending confirmation and release their lock', async () => {
  const { host, controller } = await harness();
  const answer = deferred<boolean>();
  host.confirmResult = () => answer.promise;
  const first = controller.directorSend();
  const duplicate = controller.directorSend();
  await until(() => host.confirmCount > 0);
  assert.equal(host.confirmCount, 1);
  assert.equal(host.generated, 0);
  answer.resolve(false);
  await Promise.all([first, duplicate]);
  host.confirmResult = async () => false;
  await controller.directorSend();
  assert.equal(host.confirmCount, 2, 'a cancelled send must release its lock for the next user action');
  assert.equal(host.generated, 0);
});

test('selecting saved blank or ellipsis swipes does not present a generation choice', async () => {
  const { host } = await harness();
  const message = host.chat().at(-1)!;
  message.swipes = ['', '...'];
  for (let swipe = 0; swipe < message.swipes.length; swipe++) {
    message.swipe_id = swipe;
    message.mes = message.swipes[swipe]!;
    await host.emit('MESSAGE_SWIPED', 1);
  }
  assert.deepEqual(host.swipeChoices, []);
  assert.equal(host.generated, 0);
});

test('disabled base is inert, and enabled base retains priority over a legacy Auto setting', async () => {
  const { host, controller } = await harness();
  overswipe(host);
  const before = structuredClone(controller.record);
  controller.settings.enabled = false;
  await host.emit('MESSAGE_SWIPED', 1);
  assert.deepEqual(host.swipeChoices, []);
  assert.deepEqual(controller.record, before);
  controller.settings.enabled = true;
  host.context.extensionSettings.rpDirectorAuto = { enabled: true };
  host.swipeResult = async () => 'cancel';
  await host.emit('MESSAGE_SWIPED', 1);
  assert.deepEqual(host.swipeChoices, ['native']);
  assert.deepEqual(controller.record, before);
});

test('cancelling the new-swipe choice aborts in the interceptor before an attempt is created', async () => {
  const { host, controller } = await harness();
  host.swipeResult = async () => 'cancel';
  overswipe(host);
  const before = structuredClone(controller.record);
  await host.emit('MESSAGE_SWIPED', 1);
  assert.deepEqual(host.swipeChoices, ['native']);
  const aborts: boolean[] = [];
  await controller.interceptor([], 4096, immediately => aborts.push(immediately), 'swipe');
  assert.deepEqual(aborts, [true]);
  assert.deepEqual(controller.record, before);
  assert.equal(host.injection, '');
});

test('an old swipe popup cannot adopt or write state after a chat switch', async () => {
  const { host, controller } = await harness();
  const choice = deferred<SwipeChoice>();
  host.swipeResult = () => choice.promise;
  overswipe(host);
  const oldEvent = host.emit('MESSAGE_SWIPED', 1);
  await until(() => host.swipeChoices.length === 1);
  host.currentChatId = 'different-chat';
  host.context.chatMetadata = {};
  host.context.chat = [{ name: 'Guide', is_user: false, is_system: false, original_avatar: 'guide.png', mes: 'A different place.', swipe_id: 0, swipes: ['A different place.'] }];
  await host.emit('CHAT_CHANGED');
  await until(() => controller.record?.seedId === host.seedId());
  const newRecordBefore = structuredClone(controller.record);
  choice.resolve('manage');
  await oldEvent;
  assert.deepEqual(controller.record, newRecordBefore, 'the late choice must not baseline the new chat with an old prefix');
  const aborts: boolean[] = [];
  await controller.interceptor([], 4096, immediately => aborts.push(immediately), 'swipe');
  assert.deepEqual(aborts, [true], 'the abandoned generation must not continue against the new chat');
  assert.deepEqual(controller.record, newRecordBefore);
});

function ruling(id: string, cursor: string, outcome: string, generation: number): FrozenResolution {
  const action: ActionSpec = {
    actionId: 'gate-action', templateId: 'acquire_secure', actingActorId: 'player', playerActorId: 'player', targetActorIds: [],
    attemptedAction: 'opens the gate', requestedGain: 'the gate is opened', applicability: 'favorable', resolutionScope: 'attempt',
    preconditions: [], effectsByOutcome: { achieved: [], deferred: [], progress_only: [] },
  };
  return freeze({
    resolutionId: id, previousResolutionId: null, action,
    snapshot: { chatId: 'native-test', cursorBefore: cursor, stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: {} },
    assessment: { type: 'noul', noul: outcome === 'achieved' ? 1 : 0, confidence: null, provenance: 'fixture' },
    decisionSource: 'provider', policyRevision: 'p1', band: null, method: 'threshold', draw: null,
    outcome, cursorBefore: cursor, generation, providerKind: 'mock', requestedModel: null, returnedModel: null, now: generation,
  });
}

test('reuse binds the selected swipe ruling even when a newer ruling exists at the same prefix', async () => {
  const { host, controller } = await harness();
  const seed = host.seedId();
  const base = prefixCursor(seed, host.fingerprintMessages(host.chat().slice(0, -1)));
  const head = prefixCursor(seed, host.fingerprintMessages(host.chat()));
  const actorId = actorIdFor('Guide', 'guide.png');
  const oldRuling = ruling('old-ruling', base, 'deferred', 1);
  const newerRuling = ruling('newer-ruling', base, 'achieved', 2);
  let record = newRecord(seed, controller.profile.revision);
  const reduce = (event: Parameters<typeof applyEvent>[1]) => { record = applyEvent(record, event).record; };
  reduce({ type: 'set_baseline', cursor: base, state: emptyState(), reason: 'test precursor' });
  reduce({ type: 'prepare', resolution: oldRuling, action: oldRuling.action, attemptId: 'old-attempt', actorId, epoch: controller.epoch, composerText: '', now: 1 });
  reduce({ type: 'bind', attemptId: 'old-attempt', cursorBefore: base, epoch: controller.epoch, injectedText: '' });
  reduce({ type: 'completed', attemptId: 'old-attempt', epoch: controller.epoch, operationId: 'old-completion', variantId: 'old-variant', hostMessageRef: 1, hostVariantRef: 0, cursorAfter: head, now: 2, observerRequired: true });
  reduce({ type: 'reroll', previousResolutionId: oldRuling.resolutionId, resolution: newerRuling, now: 3 });
  controller.record = record;
  host.writeMarker(1, { v: 'old-variant', a: 'old-attempt', r: oldRuling.resolutionId });
  overswipe(host);
  await host.emit('MESSAGE_SWIPED', 1);
  assert.deepEqual(host.swipeChoices, ['ruled']);
  const aborts: boolean[] = [];
  await controller.interceptor([], 4096, immediately => aborts.push(immediately), 'swipe');
  assert.deepEqual(aborts, []);
  const newAttempts = Object.values(controller.record!.attempts).filter(attempt => attempt.attemptId !== 'old-attempt');
  assert.equal(newAttempts.length, 1);
  assert.equal(newAttempts[0]!.resolutionId, oldRuling.resolutionId);
  assert.equal(newAttempts[0]!.unadjudicated, false);
  assert.match(host.injection, /deferred/i);
  assert.equal(controller.record!.resolutions[newerRuling.resolutionId]!.outcome, 'achieved');
});
