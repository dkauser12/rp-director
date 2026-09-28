import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostChatMessage, StContext } from '../../src/host.ts';
import { applyEvent, emptyState, newRecord } from '../../src/state.ts';
import { actorIdFor, prefixCursor } from '../../src/identity.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, EvaluationRequest, FrozenResolution } from '../../src/types.ts';
import type { ReactionKind } from '../../src/npc-reaction.ts';

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
    // These tests specify the legacy one-batch pipeline's behavior.
    settings.pipeline = 'legacy';
    this.context = {
      chat: [
        { name: 'Player', is_user: true, is_system: false, mes: 'I try the gate.' },
        { name: 'Guide', is_user: false, is_system: false, mes: 'The gate remains shut.', original_avatar: 'guide.png', swipe_id: 0, swipes: ['The gate remains shut.'], extra: {} },
      ],
      characters: [{ name: 'Guide', avatar: 'guide.png', description: 'A guide.' }],
      groups: [], name1: 'Player', characterId: 0, groupId: null, chatId: 'native-test',
      chatMetadata: {}, extensionSettings: { rpDirector: settings },
      eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED'].map(name => [name, name])),
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

test('completed replies store regexable results without treating the footer as fiction', async () => {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  host.composerText = () => 'I try the gate.';
  const prose = 'The gate opens a little, but the chain holds.';
  const renders: number[] = [];
  host.context.updateMessageBlock = index => { renders.push(index); };
  host.context.generate = async () => {
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false,
      mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', 2, 'normal');
  };
  await controller.directorSend();
  const message = host.chat()[2]!;
  assert.match(message.mes, /\[RP_DIRECTOR\]\n\{.*"status":"ruled".*\}\n\[\/RP_DIRECTOR\]$/);
  assert.equal(message.swipes![0], message.mes);
  assert.ok(renders.includes(2));
  message.extra!.display_text = 'Translated reply.';
  message.swipes![0] = 'Outdated copy.';
  await host.emit('CHARACTER_MESSAGE_RENDERED', 2, 'normal');
  assert.match(String(message.extra!.display_text), /\[RP_DIRECTOR\]/, 'late translated display gets the same result');
  assert.equal(message.swipes![0], message.mes, 'selected swipe is repaired even when source mes was unchanged');
  assert.equal(host.fingerprintMessages([message])[0]!.text, prose);
  const observation = controller.record!.inspector.find(entry => entry.kind === 'observer')!;
  assert.equal((observation.stateSent as { acceptedSpan: { text: string } }).acceptedSpan.text, prose);
  const promptCopy = structuredClone(host.chat());
  controller.settings.enabled = false;
  await controller.interceptor(promptCopy, 4096, () => {}, 'quiet');
  assert.equal(promptCopy[2]!.mes, prose, 'the footer stays out of actual writer prompts even when Director is disabled');
  assert.match(message.mes, /\[RP_DIRECTOR\]/, 'stripping prompt copies must preserve saved results');
  controller.settings.enabled = true;
  await controller.commitReply();
  assert.equal(Object.values(controller.record!.variants)[0]!.acceptance, 'accepted');
  await controller.loadChat();
  assert.equal((message.mes.match(/\[RP_DIRECTOR\]/g) ?? []).length, 1, 'reload cannot duplicate the footer');
  assert.equal(controller.record!.projection.status, 'current');
  const kept = message.mes;
  const marker = structuredClone(message.extra!.rpd);
  message.swipes!.push('Untracked alternative.');
  message.swipe_info!.push({ extra: {} });
  message.swipe_id = 1;
  message.mes = message.swipes![1]!;
  message.extra = {};
  await host.emit('MESSAGE_SWIPED', 2);
  assert.equal(message.mes, 'Untracked alternative.');
  message.swipe_id = 0;
  message.mes = kept;
  message.extra = { rpd: marker };
  await host.emit('MESSAGE_SWIPED', 2);
  assert.equal(message.mes, kept, 'returning to a saved variant restores its original results');
  const originalUser = host.chat()[0]!.mes;
  host.chat()[0]!.mes = 'Earlier user input changed.';
  await host.emit('MESSAGE_EDITED', 0);
  await until(() => !message.mes.includes('[RP_DIRECTOR]'));
  assert.equal(message.mes, prose, 'editing a predecessor removes obsolete results from its descendants');
  host.chat()[0]!.mes = originalUser;
  await host.emit('MESSAGE_EDITED', 0);
  await until(() => message.mes === kept);
  assert.equal(message.mes, kept, 'restoring the original prefix restores the saved result');
  message.mes = message.mes.replace(prose, 'Edited fictional outcome.');
  await host.emit('MESSAGE_EDITED', 2);
  await until(() => !message.mes.includes('[RP_DIRECTOR]'));
  assert.equal(message.mes, 'Edited fictional outcome.', 'edited fiction must not retain an obsolete result');
  assert.equal(message.swipes![0], message.mes);
});

test('oversized essential context stops before any judge or writer request', async () => {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  host.composerText = () => 'I try the gate. ' + 'x'.repeat(controller.profile.budgets.maxSerializedCharacters);
  let calls = 0;
  const original = controller.provider.bind(controller);
  controller.provider = () => ({ ...original(), evaluate: async () => { calls++; throw new Error('unexpected judge call'); } });
  await controller.directorSend();
  assert.equal(calls, 0);
  assert.equal(host.generated, 0);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
  assert.match(controller.lastError ?? '', /context.*limit/i);
});

async function completedReactionHarness(kind: ReactionKind, outcome: string) {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  host.composerText = () => 'No. I ask the guide to explain.';
  for (const key of Object.keys(controller.settings.reactions.weights[kind])) controller.settings.reactions.weights[kind][key] = key === outcome ? 1 : 0;
  let calls = 0;
  let injected = '';
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => {
      calls++;
      const result = await base.evaluate(request, signal);
      result.answers.attempt_gate = { type: 'choice', choice: 'none', probabilities: null, confidence: null, provenance: 'fixture' };
      const id = Object.keys(request.questions).find(id => id.startsWith('npc_reaction_'));
      if (id) {
        assert.match(request.questions[id]!.instructions, new RegExp(actorIdFor('Guide', 'guide.png')));
        result.answers[id] = { type: 'choice', choice: kind, probabilities: null, confidence: null, provenance: 'fixture' };
        delete result.errors[id];
      }
      return result;
    } };
  };
  host.context.generate = async () => {
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    injected = host.injection;
    const prose = 'The guide pauses and takes a different approach.';
    host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false,
      mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] });
    await host.emit('MESSAGE_RECEIVED', 2, 'normal');
  };
  await controller.directorSend();
  return { host, controller, calls: () => calls, injected: () => injected };
}

for (const [kind, outcome] of [['resolve', 'change_tactic'], ['secret', 'slip'], ['exposure', 'suspicion']] as const) {
  test(`hybrid ${kind} direction uses configured odds once and survives wording swipes`, async () => {
    const { host, controller, calls, injected } = await completedReactionHarness(kind, outcome);
    assert.equal(calls(), 1, 'trigger questions share the pre-pass request');
    assert.equal(Object.keys(controller.record!.resolutions).length, 0);
    const attempt = Object.values(controller.record!.attempts)[0]!;
    assert.equal(attempt.reaction?.kind, kind);
    assert.equal(attempt.reaction?.outcome, outcome);
    assert.match(injected(), new RegExp(`${kind} → ${outcome}`));
    const footer = JSON.parse(host.chat()[2]!.mes.split('[RP_DIRECTOR]\n')[1]!.split('\n[/RP_DIRECTOR]')[0]!);
    assert.equal(footer.status, 'directed');
    assert.equal(footer.results[0].outcome, outcome);
    assert.equal(footer.results[0].support, null);
    assert.equal(footer.results[0].roll, attempt.reaction!.draw);
    const keptReaction = structuredClone(attempt.reaction);
    overswipe(host);
    await host.emit('MESSAGE_SWIPED', 2);
    await controller.interceptor([], 4096, () => assert.fail('wording reuse aborted'), 'swipe');
    const replacement = Object.values(controller.record!.attempts).find(entry => entry.status === 'writing')!;
    assert.deepEqual(replacement.reaction, keptReaction);
    assert.match(host.injection, new RegExp(`${kind} → ${outcome}`));
    assert.equal(calls(), 1, 'wording swipes do not re-detect or redraw the reaction');
    controller.destroy();
  });
}

test('adopting an edited reply cannot revive the reaction behind its stale marker', async () => {
  const { host, controller, calls } = await completedReactionHarness('resolve', 'change_tactic');
  try {
    const message = host.chat()[2]!;
    const originalMarker = structuredClone(host.readMarker(2)!);
    assert.equal(controller.record!.attempts[originalMarker.a]!.reaction?.outcome, 'change_tactic');
    message.mes = 'The edited guide reply establishes a different exchange.';
    message.swipes![0] = message.mes;
    await host.emit('MESSAGE_EDITED', 2);
    assert.deepEqual(host.readMarker(2), originalMarker, 'native edits can retain the old Director marker');
    const liveCursor = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat()));
    assert.notEqual(controller.record!.variants[originalMarker.v]!.cursorAfter, liveCursor);
    host.swipeResult = async () => 'manage';
    overswipe(host);
    await host.emit('MESSAGE_SWIPED', 2);
    assert.deepEqual(host.swipeChoices, ['native'], 'the edited reply must enter the adoption path');
    await controller.interceptor([], 4096, () => assert.fail('adoption unexpectedly aborted'), 'swipe');
    const replacement = Object.values(controller.record!.attempts).find(entry => entry.status === 'writing')!;
    assert.ok(replacement);
    assert.notEqual(replacement.attemptId, originalMarker.a);
    assert.equal(replacement.reaction, null);
    assert.doesNotMatch(host.injection, /Director NPC reaction|resolve → change_tactic/);
    assert.equal(calls(), 2, 'adoption judges its own predecessor instead of reusing the stale reply');
    assert.equal(controller.record!.attempts[originalMarker.a]!.reaction?.outcome, 'change_tactic', 'historical reaction remains recorded only on its original attempt');
  } finally { controller.destroy(); }
});

test('Continue preserves a reaction-only reply and replaces its footer without another judge call', async () => {
  const { host, controller, calls } = await completedReactionHarness('resolve', 'change_tactic');
  try {
    const message = host.chat()[2]!;
    const originalMarker = structuredClone(host.readMarker(2)!);
    const frozenReaction = structuredClone(controller.record!.attempts[originalMarker.a]!.reaction);
    assert.ok(frozenReaction);
    assert.equal((message.mes.match(/\[RP_DIRECTOR\]/g) ?? []).length, 1);
    await controller.interceptor(structuredClone(host.chat()), 4096, () => assert.fail('Continue unexpectedly aborted'), 'continue');
    const continuation = Object.values(controller.record!.attempts).find(entry => entry.status === 'writing')!;
    assert.ok(continuation);
    assert.deepEqual(continuation.reaction, frozenReaction);
    assert.equal(continuation.resolutionId, null);
    assert.equal(continuation.permitId, null);
    assert.match(host.injection, /resolve → change_tactic/);
    // Native Continue appends to saved message text, after the old footer.
    message.mes += '\nThe guide explains the same offer in different terms.';
    message.swipes![0] = message.mes;
    await host.emit('MESSAGE_RECEIVED', 2, 'continue');
    await new Promise<void>(resolve => setTimeout(resolve, 0)); // Let deferred message completion run.
    await until(() => controller.record!.attempts[continuation.attemptId]?.status === 'provisional');
    await host.emit('CHARACTER_MESSAGE_RENDERED', 2, 'continue');
    assert.equal((message.mes.match(/\[RP_DIRECTOR\]/g) ?? []).length, 1);
    assert.equal(message.swipes![0], message.mes);
    assert.match(message.mes, /The guide explains the same offer in different terms\./);
    const footer = JSON.parse(message.mes.split('[RP_DIRECTOR]\n')[1]!.split('\n[/RP_DIRECTOR]')[0]!);
    assert.equal(footer.status, 'directed');
    assert.equal(footer.results.length, 1);
    assert.equal(footer.results[0].outcome, frozenReaction.outcome);
    assert.equal(footer.results[0].roll, frozenReaction.draw);
    assert.equal(host.readMarker(2)!.a, continuation.attemptId);
    assert.equal(calls(), 1, 'Continue neither re-detects nor redraws the reaction');
  } finally { controller.destroy(); }
});

test('a concrete action ruling suppresses a competing NPC reaction', async () => {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  host.composerText = () => 'I force the locked gate open.';
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => {
      const result = await base.evaluate(request, signal);
      for (const id of Object.keys(request.questions).filter(id => id.startsWith('npc_reaction_'))) {
        result.answers[id] = { type: 'choice', choice: 'exposure', probabilities: null, confidence: null, provenance: 'fixture' };
      }
      return result;
    } };
  };
  await controller.directorSend();
  assert.equal(Object.keys(controller.record!.resolutions).length, 1);
  assert.equal(Object.values(controller.record!.attempts)[0]!.reaction, null);
});

test('history trimming is visible and preserves the current input sent to the judge', async () => {
  const { host, controller } = await harness();
  controller.settings.bindingConfirmedAt = 'confirmed';
  host.composerText = () => 'I try the gate.';
  host.context.chat[0]!.mes = 'old history '.repeat(4000);
  let sent: EvaluationRequest | undefined;
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => { sent = request; return base.evaluate(request, signal); } };
  };
  await controller.directorSend();
  assert.ok(sent);
  assert.ok(JSON.stringify(sent.snapshot.state).length <= controller.profile.budgets.maxSerializedCharacters);
  assert.equal((sent.snapshot.state as { latestInput: string }).latestInput, 'I try the gate.');
  assert.ok(controller.record!.inspector.some(entry => /context.*dropped oldest/i.test(entry.message)));
  assert.equal(host.generated, 1);
});

test('adopting a native swipe uses only its predecessor scene and revision', async () => {
  const { host, controller } = await harness();
  const baseCursor = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat().slice(0, -1)));
  const before = { ...emptyState(), revision: 7, sceneId: 3, sceneReplyCount: 2, variables: { gate: 'closed' } };
  controller.record = applyEvent(controller.record!, { type: 'set_baseline', cursor: baseCursor, state: before, reason: 'fixture predecessor' }).record;
  controller.record.projection.state = { ...emptyState(), revision: 44, sceneId: 9, sceneReplyCount: 11, variables: { gate: 'open' } };
  host.swipeResult = async () => 'manage';
  let sent: EvaluationRequest | undefined;
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => { sent = request; return base.evaluate(request, signal); } };
  };
  overswipe(host);
  await host.emit('MESSAGE_SWIPED', 1);
  assert.ok(sent);
  assert.equal(sent.snapshot.stateRevision, 7);
  assert.deepEqual((sent.snapshot.state as { scene: unknown }).scene, { id: 3, acceptedReplyCount: 2 });
  assert.deepEqual((sent.snapshot.state as { facts: unknown }).facts, { gate: 'closed' });
  assert.equal(Object.values(controller.record.resolutions)[0]?.action.sceneId, 3);
});

test('oversized native swipe context cancels generation before judging', async () => {
  const { host, controller } = await harness();
  const baseCursor = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat().slice(0, -1)));
  const before = { ...emptyState(), variables: { oversized: 'x'.repeat(controller.profile.budgets.maxSerializedCharacters) } };
  controller.record = applyEvent(controller.record!, { type: 'set_baseline', cursor: baseCursor, state: before, reason: 'fixture predecessor' }).record;
  host.swipeResult = async () => 'manage';
  let calls = 0;
  const original = controller.provider.bind(controller);
  controller.provider = () => ({ ...original(), evaluate: async () => { calls++; throw new Error('unexpected judge call'); } });
  overswipe(host);
  await host.emit('MESSAGE_SWIPED', 1);
  const aborts: boolean[] = [];
  await controller.interceptor([], 4096, immediately => aborts.push(immediately), 'swipe');
  assert.equal(calls, 0);
  assert.deepEqual(aborts, [true]);
  assert.equal(Object.keys(controller.record!.resolutions).length, 0);
});

test('an adopted swipe discards a decision if its predecessor changes during the request', async () => {
  const { host, controller } = await harness();
  const baseCursor = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat().slice(0, -1)));
  controller.record = applyEvent(controller.record!, { type: 'set_baseline', cursor: baseCursor, state: emptyState(), reason: 'fixture predecessor' }).record;
  host.swipeResult = async () => 'manage';
  const finish = deferred<void>();
  let calls = 0;
  const original = controller.provider.bind(controller);
  controller.provider = () => {
    const base = original();
    return { ...base, evaluate: async (request, signal) => { calls++; await finish.promise; return base.evaluate(request, signal); } };
  };
  overswipe(host);
  const choosing = host.emit('MESSAGE_SWIPED', 1);
  await until(() => calls === 1);
  controller.record.checkpoints[baseCursor]!.stateAfter.revision++;
  finish.resolve();
  await choosing;
  const aborts: boolean[] = [];
  await controller.interceptor([], 4096, immediately => aborts.push(immediately), 'swipe');
  assert.deepEqual(aborts, [true]);
  assert.equal(Object.keys(controller.record.resolutions).length, 0);
  assert.ok(host.notices.some(message => /predecessor changed/.test(message)));
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
