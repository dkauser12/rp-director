import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/controller.ts';
import { Host, defaultSettings } from '../../src/host.ts';
import type { HostFunctionTool, StContext } from '../../src/host.ts';
import type { DirectorChatRecord, TurnPermit, TurnProposal } from '../../src/types.ts';
import { choice, noul } from './support/test-host.ts';
import { summarizeUsage } from '../../src/usage.ts';
import { DIRECTOR_TOOL_DESCRIPTION, DIRECTOR_TOOL_NAME, TURN_PROPOSAL_SCHEMA } from '../../src/director-tool.ts';

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

  generateHook: () => Promise<void> = async () => {};
  context: StContext;

  constructor() {
    super();
    const settings = defaultSettings();
    settings.connection.kind = 'mock';
    settings.reviewNpcRolls = false;
    settings.askWhenSwiping = false;
    settings.modules.meters = false;
    settings.modules.secrets = false;
    settings.modules.lore = false;
    settings.profileId = 'binding-dice';

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
  override interceptNativeRegenerate(): () => void { return () => {}; }
  override toast(): void {}
  async emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(...args);
  }

  /** ST ToolManager's request boundary: shouldRegister, OpenAI function schema, auto choice. */
  async writerToolEnvelope() {
    const tool = this.tool;
    if (!tool || !(await tool.shouldRegister?.())) return {};
    return structuredClone({ tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }], tool_choice: 'auto' });
  }
}

async function harness(withReaction = false) {
  const host = new ToolHost();
  const controller = new Controller(host);
  // Production migrates saved Mock connections; tests choose their provider explicitly.
  controller.settings.connection.kind = 'mock';
  if (withReaction) {
    host.composerText = () => 'No. Explain yourself.';
    const original = controller.provider.bind(controller);
    controller.provider = () => {
      const base = original();
      return { ...base, evaluate: async (request, signal) => {
        const result = await base.evaluate(request, signal);
        if (request.questions.move) { result.answers.move = choice('NONE'); result.answers.move_count = choice('one'); result.errors = {}; result.unresolvedQuestionIds = []; }
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
  await controller.setChatPack('default');
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
      writerFinished.resolve();
      await generation;
      controller.destroy();
    },
  };
}

test('W8: the NPC tool applies its dice immediately and returns the frozen permit without review', async t => {
  const h = await harness();
  t.after(() => h.close());
  const result = JSON.parse(await h.callTool());
  assert.equal(result.ok, true);
  assert.equal(h.host.reviews.length, 0);
  assert.equal(Object.keys(h.controller.record!.permits).length, 1);
  assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.permitId, result.permit.permitId);
  assert.ok(h.host.saves.some(record => Boolean(record.permits[result.permit.permitId])));
  assert.equal(result.permit.profile, undefined);
  assert.equal(h.host.tool!.shouldRegister!(), true, 'the follow-up keeps the same writer tool list');
  await h.controller.interceptor([], 4096, () => assert.fail('followup must not abort'), 'normal');
  assert.match(h.host.injection, /Now write the final reply/);
});

test('review 32: normal, tool follow-up, swipe and native regenerate have identical writer tools and tool_choice', async t => {
  const h = await harness();
  t.after(() => h.close());
  const normal = await h.host.writerToolEnvelope();
  assert.deepEqual(normal, { tools: [{ type: 'function', function: { name: DIRECTOR_TOOL_NAME, description: DIRECTOR_TOOL_DESCRIPTION, parameters: TURN_PROPOSAL_SCHEMA } }], tool_choice: 'auto' });
  const result = JSON.parse(await h.callTool());
  assert.equal(result.ok, true);
  assert.ok(result.permit.constraints.includes('Do not output Director data or metadata such as permits, rulings, request IDs, actor IDs, evidence references, or JSON. This does not prohibit a preset-required fictional tracker block.'));
  await h.controller.interceptor([], 4096, () => assert.fail('tool follow-up aborted'), 'normal');
  assert.deepEqual(await h.host.writerToolEnvelope(), normal);
  assert.match(h.host.injection, /Do not call the tool again, add another consequential action, or emit Director permits, IDs, JSON, or other Director metadata\./);

  await h.host.emit('GENERATION_ENDED');
  h.host.chat().push({ name: 'Guide', original_avatar: 'guide.png', is_user: false, is_system: false, mes: 'The guide works the lock.', swipe_id: 1, swipes: ['The guide works the lock.'] });
  await h.controller.interceptor([], 4096, () => assert.fail('swipe aborted'), 'swipe');
  assert.deepEqual(await h.host.writerToolEnvelope(), normal);
  assert.match(h.host.injection, /The Director tool is closed for this reply; do not call it\./);
  const beforeRefusal = structuredClone(h.controller.record);
  const saves = h.host.saves.length;
  h.controller.provider = () => assert.fail('a wording-swipe tool call must not contact the judge');
  assert.equal(JSON.parse(await h.callTool()).ok, false);
  assert.deepEqual(h.controller.record, beforeRefusal, 'closed-window call cannot change the frozen decisions');
  assert.equal(h.host.saves.length, saves);

  await h.host.emit('GENERATION_ENDED');
  h.host.chat().pop();
  await h.host.emit('MESSAGE_DELETED');
  await h.controller.interceptor([], 4096, () => assert.fail('regenerate aborted'), 'regenerate');
  assert.deepEqual(await h.host.writerToolEnvelope(), normal);
});

test('review 32: tool registration follows enabled, pause and Decisions switches independently of the window', async t => {
  const h = await harness();
  t.after(() => h.close());
  await h.host.emit('GENERATION_ENDED');
  assert.equal(h.host.tool!.shouldRegister!(), true);
  const before = structuredClone(h.controller.record);
  assert.equal(JSON.parse(await h.callTool()).ok, false);
  assert.deepEqual(h.controller.record, before);
  h.controller.settings.modules.decisions = false;
  assert.deepEqual(await h.host.writerToolEnvelope(), {});
  h.controller.settings.modules.decisions = true;
  h.controller.settings.enabled = false;
  assert.deepEqual(await h.host.writerToolEnvelope(), {});
  h.controller.settings.enabled = true;
  h.controller.record!.paused = true;
  assert.deepEqual(await h.host.writerToolEnvelope(), {});
  h.controller.record!.paused = false;
  assert.equal(h.host.tool!.shouldRegister!(), true);
});

test('W8: a failed NPC judge continues without a ruling or generation stop', async t => {
  const h = await harness();
  t.after(() => h.close());
  h.controller.provider = () => { throw new Error('network disconnected'); };
  const result = JSON.parse(await h.callTool());
  assert.equal(result.ok, false);
  assert.deepEqual(h.controller.record!.permits, {});
  await h.controller.interceptor([], 4096, () => assert.fail('failed tool must fail open'), 'normal');
  assert.equal(h.host.stops, 0);
  assert.doesNotMatch(h.host.injection, /Now write the final reply/);
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
  assert.equal(h.host.context.chat[2]!.mes, prose);
  const badge = h.host.readWorkflowBadge(2);
  assert.ok(badge);
  assert.deepEqual(badge.results.map(entry => entry.source), ['npc']);
});

for (const placeholder of ['', '...']) {
  test(`reasoning in message.extra with ${JSON.stringify(placeholder)} content does not count as prior prose`, async t => {
    const h = await harness();
    t.after(() => h.close());
    h.host.chat().push({
      name: 'Guide', is_user: false, is_system: false, original_avatar: 'guide.png', mes: placeholder,
      extra: { reasoning: 'A local test reasoning field preceding a tool call.' },
    });
    const result = JSON.parse(await h.callTool());
    assert.equal(result.ok, true);
    assert.equal(h.host.reviews.length, 0);
    assert.equal(h.controller.record!.attempts[h.proposal.attemptId]!.toolStatus, 'permitted');
    assert.equal(Object.keys(h.controller.record!.permits).length, 1);
  });
}

test('visible assistant prose before the tool is rejected without review or a permit', async t => {
  const h = await harness();
  t.after(() => h.close());
  const judgeErrors = [...(h.controller.record!.attempts[h.proposal.attemptId]!.judgeErrors ?? [])];
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
  assert.deepEqual(h.controller.record!.attempts[h.proposal.attemptId]!.judgeErrors ?? [], judgeErrors, 'writer prose adds no judge failure');
});

for (const decision of ['keep', 'cancel'] as const) {
  test(`W8: enabled NPC review waits for ${decision} before the writer continues`, async t => {
    const h = await harness();
    t.after(() => h.close());
    h.controller.settings.reviewNpcRolls = true;
    const gate = deferred<'keep' | 'cancel'>();
    let reviewOpen = false;
    h.host.reviewRolls = async () => { reviewOpen = true; return gate.promise; };
    let returned = false;
    const result = h.callTool().then(value => { returned = true; return JSON.parse(value); });
    await until(() => reviewOpen);
    assert.equal(returned, false);
    assert.deepEqual(h.controller.record!.permits, {});
    gate.resolve(decision);
    assert.equal((await result).ok, decision === 'keep');
    assert.equal(Object.keys(h.controller.record!.permits).length, decision === 'keep' ? 1 : 0);
    assert.equal(h.host.stops, decision === 'cancel' ? 1 : 0);
  });
}

test('W8: reviewed NPC rolls can be rolled again without changing the assessment', async t => {
  const h = await harness();
  t.after(() => h.close());
  h.controller.settings.reviewNpcRolls = true;
  const reviewed: TurnPermit[] = [];
  h.host.reviewRolls = async permit => { reviewed.push(structuredClone(permit)); return reviewed.length === 1 ? 'reroll' : 'keep'; };
  const result = JSON.parse(await h.callTool());
  assert.equal(result.ok, true);
  assert.equal(reviewed.length, 2);
  assert.notEqual(reviewed[0]!.permitId, reviewed[1]!.permitId);
  assert.deepEqual(reviewed[0]!.actions[0]!.assessment, reviewed[1]!.actions[0]!.assessment);
  assert.equal(Object.keys(h.controller.record!.permits).length, 1);
});

test('C4 NPC threshold review accounts for both requests and keeps the final receipt on the attempt', async t => {
  const h = await harness();
  t.after(() => h.close());
  h.controller.settings.reviewNpcRolls = true;
  h.controller.profile.resolutionMethod = 'threshold';
  const base = h.controller.provider();
  let calls = 0, reviews = 0;
  h.controller.provider = () => ({ ...base, kind: 'jev', evaluate: async request => {
    calls++;
    return { requestId: request.requestId, provider: 'jev', requestedModel: 'example', returnedModel: 'example',
      answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, noul(0.5)])), errors: {}, unresolvedQuestionIds: [],
      inputTokens: 20, outputTokens: 4, costUsd: 0.0012, durationMs: 1, transportAttempts: 1 };
  } });
  h.controller.settings.connection.kind = 'openrouter';
  h.host.reviewRolls = async () => ++reviews === 1 ? 'reroll' : 'keep';
  assert.equal(JSON.parse(await h.callTool()).ok, true);
  assert.equal(calls, 2);
  const attempt = h.controller.record!.attempts[h.proposal.attemptId]!;
  assert.equal(attempt.requestUsage!.length, 2);
  assert.equal(summarizeUsage(attempt.requestUsage!).costUsd, 0.0024);
  assert.equal(summarizeUsage(h.controller.sessionUsage).inputTokens, 40);
  const entry = h.controller.record!.inspector.find(entry => entry.kind === 'tool_checkpoint' && entry.networkCalls)!;
  assert.equal(entry.networkCalls, 2);
  assert.equal(entry.requestUsage!.length, 2);
});

test('W8: pause before the NPC tool keeps it inert and makes no judge request', async t => {
  const h = await harness();
  t.after(() => h.close());
  await h.controller.setPaused(true);
  h.controller.provider = () => assert.fail('paused tool called judge');
  assert.equal(h.host.tool!.shouldRegister!(), false);
  assert.equal(JSON.parse(await h.callTool()).ok, false);
  assert.deepEqual(h.controller.record!.permits, {});
});
