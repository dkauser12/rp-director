import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostFunctionTool, StContext } from '../../src/host.ts';
import type { DirectorChatRecord, TurnPermit, TurnProposal } from '../../src/types.ts';
import type { RollReviewChoice } from '../../src/roll-review.ts';

type Handler = (...args: unknown[]) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 30 && !predicate(); i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(predicate(), 'the expected tool review boundary was reached');
}

/** Runs the real registered tool action; only ST I/O and its review dialog are replaced. */
class ToolHost extends Host {
  private handlers = new Map<string, Handler[]>();
  tool: HostFunctionTool | null = null;
  injection = '';
  generating = false;
  stops = 0;
  reviews: TurnPermit[] = [];
  saves: DirectorChatRecord[] = [];
  choose = deferred<RollReviewChoice>();
  generateHook: () => Promise<void> = async () => {};
  context: StContext;

  constructor() {
    super();
    const settings = defaultSettings();
    settings.bindingConfirmedAt = '2026-01-01T00:00:00Z';
    settings.profileId = 'binding-dice';
    // These tests specify the legacy one-batch pipeline's tool flow.
    settings.pipeline = 'legacy';
    this.context = {
      chat: [{ name: 'Player', is_user: true, is_system: false, mes: 'The gate is locked.' }],
      characters: [{ name: 'Guide', avatar: 'guide.png', description: 'A guide at the gate.' }],
      groups: [], name1: 'Player', characterId: 0, groupId: null, chatId: 'tool-test',
      chatMetadata: {}, extensionSettings: { rpDirector: settings },
      eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED'].map(name => [name, name])),
      eventSource: {
        on: (name, handler) => { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); },
        removeListener: (name, handler) => { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); },
      },
      getCurrentChatId: () => 'tool-test', getRequestHeaders: () => ({}),
      generate: async () => { this.generating = true; await this.generateHook(); this.generating = false; },
      // ST stopGeneration emits this event without awaiting its listeners.
      stopGeneration: () => { this.stops += 1; this.generating = false; void this.emit('GENERATION_STOPPED'); },
      saveMetadata: async () => { this.saves.push(structuredClone(this.context.chatMetadata.rpDirector as DirectorChatRecord)); },
      saveChat: async () => {}, saveSettingsDebounced: () => {},
      setExtensionPrompt: (_key, value) => { this.injection = value; },
      swipe: { right: async () => {}, state: () => 'none' }, uuidv4: () => 'test-uuid',
      registerFunctionTool: tool => { this.tool = tool; }, unregisterFunctionTool: () => { this.tool = null; },
      isToolCallingSupported: () => true, canPerformToolCalls: () => true,
      ConnectionManagerRequestService: { sendRequest: async () => { throw new Error('Unexpected sidecar request'); } },
      ChatCompletionService: { processRequest: async () => { throw new Error('Unexpected completion request'); } },
    };
  }

  override ctx(): StContext { return this.context; }
  override async loadFlags(): Promise<void> {}
  override isGenerating(): boolean { return this.generating; }
  override isAutoMode(): boolean { return false; }
  override composerText(): string { return ''; }
  override interceptNativeSend(): () => void { return () => {}; }
  override toast(): void {}
  override async reviewRolls(permit: TurnPermit): Promise<RollReviewChoice> {
    this.reviews.push(structuredClone(permit));
    return this.choose.promise;
  }
  async emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(...args);
  }
}

async function harness(withReaction = false) {
  const host = new ToolHost();
  const controller = new Controller(host);
  if (withReaction) {
    host.composerText = () => 'No. Explain yourself.';
    const original = controller.provider.bind(controller);
    controller.provider = () => {
      const base = original();
      return { ...base, evaluate: async (request, signal) => {
        const result = await base.evaluate(request, signal);
        if (request.questions.attempt_gate) result.answers.attempt_gate = { type: 'choice', choice: 'none', probabilities: null, confidence: null, provenance: 'fixture' };
        for (const id of Object.keys(request.questions).filter(id => id.startsWith('npc_reaction_'))) {
          result.answers[id] = { type: 'choice', choice: 'resolve', probabilities: null, confidence: null, provenance: 'fixture' };
        }
        return result;
      } };
    };
  }
  const bound = deferred<void>();
  const writerFinished = deferred<void>();
  host.generateHook = async () => {
    await controller.interceptor([], 4096, () => assert.fail('the initial writer must not abort'), 'normal');
    bound.resolve();
    await writerFinished.promise;
  };
  await controller.init();
  const generation = controller.directorSend();
  await bound.promise;
  assert.equal(host.tool?.shouldRegister?.(), true, 'the normal Director generation offers its registered tool');
  const ids = /requestId ([\w-]+), attemptId ([\w-]+), and speakerActorId ([\w-]+)\./.exec(host.injection);
  assert.ok(ids, 'the writer receives the frozen tool identity in its actual injection');
  const proposal: TurnProposal = {
    schemaVersion: 1, requestId: ids[1]!, attemptId: ids[2]!, speakerActorId: ids[3]!,
    actions: [{
      proposalId: 'open-gate', actingActorId: ids[3]!, targetActorIds: [], family: 'overcome_operate',
      method: 'works the gate lock with a pick', boundedResult: 'the gate lock opens',
      failureStake: { kind: 'delay', detail: 'the gate stays locked while the guide loses time' },
      opposed: false, evidenceRefs: ['msg:0'],
    }],
  };
  return {
    host, controller, proposal,
    callTool: () => Promise.resolve(host.tool!.action(proposal)),
    async close() {
      host.choose.resolve('cancel');
      writerFinished.resolve();
      await generation;
      controller.destroy();
    },
  };
}

test('the registered tool action does not return or persist a permit until Keep', async t => {
  const h = await harness();
  t.after(() => h.close());
  let returned = false;
  const response = h.callTool().then(value => { returned = true; return value; });
  await until(() => h.host.reviews.length === 1);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(returned, false, 'ST cannot start the recursive completion while review is open');
  assert.equal(h.controller.status, 'Review rolls');
  assert.deepEqual(h.controller.record!.permits, {});
  assert.ok(h.host.saves.every(record => Object.keys(record.permits).length === 0), 'no unkept permit reaches saved metadata');
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.permitId, null);
  h.host.choose.resolve('keep');
  const result = JSON.parse(await response);
  assert.equal(result.ok, true);
  assert.equal(Object.keys(h.controller.record!.permits).length, 1);
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.permitId, result.permit.permitId);
  assert.ok(h.host.saves.some(record => Boolean(record.permits[result.permit.permitId])));
  assert.ok(result.permit.reviewedAt);
  assert.equal(result.permit.profile, undefined, 'internal tables are not returned to the writer');
  assert.equal(h.host.tool!.shouldRegister!(), false, 'the permitted followup must not offer another tool call');
  const aborts: boolean[] = [];
  await h.controller.interceptor([], 4096, immediately => aborts.push(immediately), 'normal');
  assert.deepEqual(aborts, []);
  assert.match(h.host.injection, /Now write the final reply/);
});

test('cancelling tool review survives ST stop events and aborts recursive generation', async t => {
  const h = await harness();
  t.after(() => h.close());
  const response = h.callTool();
  await until(() => h.host.reviews.length === 1);
  h.host.choose.resolve('cancel');
  const result = JSON.parse(await response);
  assert.equal(result.code, 'cancelled');
  assert.equal(h.host.stops, 1);
  assert.deepEqual(h.controller.record!.permits, {});
  assert.ok(h.host.saves.every(record => Object.keys(record.permits).length === 0));
  const attemptIds = Object.keys(h.controller.record!.attempts);
  const aborts: boolean[] = [];
  await h.controller.interceptor([], 4096, immediately => aborts.push(immediately), 'normal');
  assert.deepEqual(aborts, [true]);
  assert.deepEqual(Object.keys(h.controller.record!.attempts), attemptIds, 'cancel must not start an unadjudicated replacement attempt');
  assert.equal(h.host.injection, '');
});

test('a kept NPC action supersedes its reaction and delayed tool intermediaries never get footers', async t => {
  const h = await harness(true);
  t.after(() => h.close());
  assert.ok(h.controller.record!.attempts[h.proposal.attemptId]!.reaction);
  assert.match(h.host.injection, /Director NPC reaction/);
  h.host.context.chat.push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false,
    mes: '...', extra: { reasoning: 'Planning the action.' } });
  await h.host.emit('MESSAGE_RECEIVED', 1, 'normal');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.variantId, null, 'deferred completion waits for the tool lifecycle, not merely one event-loop tick');
  assert.equal(h.host.context.chat[1]!.extra?.rpd, undefined);
  const response = h.callTool();
  await until(() => h.host.reviews.length === 1);
  h.host.choose.resolve('keep');
  const result = JSON.parse(await response);
  assert.equal(result.ok, true);
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.reaction, null);
  await h.controller.interceptor([], 4096, () => assert.fail('followup aborted'), 'normal');
  assert.doesNotMatch(h.host.injection, /Director NPC reaction/);
  const prose = 'The guide works the gate lock.';
  h.host.context.chat.push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false,
    mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] });
  await h.host.emit('MESSAGE_RECEIVED', 2, 'normal');
  await h.close();
  assert.equal(h.host.context.chat[1]!.mes, '...');
  const footer = JSON.parse(h.host.context.chat[2]!.mes.split('[RP_DIRECTOR]\n')[1]!.split('\n[/RP_DIRECTOR]')[0]!);
  assert.equal(footer.status, 'ruled');
  assert.deepEqual(footer.results.map((entry: { kind: string }) => entry.kind), ['action']);
});

for (const placeholder of ['', '...']) {
  test(`reasoning in message.extra with ${JSON.stringify(placeholder)} content does not count as prior prose`, async t => {
    const h = await harness();
    t.after(() => h.close());
    h.host.chat().push({
      name: 'Guide', is_user: false, is_system: false, original_avatar: 'guide.png', mes: placeholder,
      extra: { reasoning: 'A local test reasoning field preceding a tool call.' },
    });
    h.host.choose.resolve('keep');
    const result = JSON.parse(await h.callTool());
    assert.equal(result.ok, true);
    assert.equal(h.host.reviews.length, 1);
    assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.toolStatus, 'permitted');
    assert.equal(Object.keys(h.controller.record!.permits).length, 1);
  });
}

test('visible assistant prose before the tool is rejected without review or a permit', async t => {
  const h = await harness();
  t.after(() => h.close());
  h.host.chat().push({
    name: 'Guide', is_user: false, is_system: false, original_avatar: 'guide.png', mes: 'The guide opens the locked gate.',
    extra: { reasoning: 'A local test reasoning field.' },
  });
  const result = JSON.parse(await h.callTool());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'prose_before_tool');
  assert.equal(h.host.reviews.length, 0);
  assert.deepEqual(h.controller.record!.permits, {});
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.toolStatus, 'malformed');
});
