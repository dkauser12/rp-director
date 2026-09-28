/** In-memory SillyTavern boundary for controller-level tests (1:1 by default, group on request). */
import assert from 'node:assert/strict';
import { Controller } from '../../../src/controller.ts';
import { Host, defaultSettings } from '../../../src/host.ts';
import type { HostChatMessage, StContext } from '../../../src/host.ts';
import type { Answer, EvaluationRequest, EvaluationResult } from '../../../src/types.ts';

type Handler = (...args: unknown[]) => unknown;
type SwipeChoice = Awaited<ReturnType<Host['chooseSwipeAction']>>;

export class TestHost extends Host {
  private handlers = new Map<string, Handler[]>();
  currentChatId = 'staged-test';
  generated: Record<string, unknown>[] = [];
  injection = '';
  notices: string[] = [];
  composerValue = '';
  swipeResult: () => Promise<SwipeChoice> = async () => 'reuse';
  context: StContext;

  constructor(options: { group?: boolean } = {}) {
    super();
    const settings = defaultSettings();
    settings.bindingConfirmedAt = 'confirmed';
    const characters = [
      { name: 'Guide', avatar: 'guide.png', description: 'A careful guide. GUIDE-CARD', personality: 'dry' },
      { name: 'Mira', avatar: 'mira.png', description: 'A bold companion. MIRA-CARD', personality: 'warm' },
    ];
    this.context = {
      chat: [
        { name: 'Player', is_user: true, is_system: false, mes: 'We reach the gate.' },
        { name: 'Guide', is_user: false, is_system: false, mes: 'The gate remains shut. "State your business, or wait until dawn."', original_avatar: 'guide.png', swipe_id: 0, swipes: ['The gate remains shut. "State your business, or wait until dawn."'], extra: {} },
      ],
      characters,
      groups: options.group ? [{ id: 'g1', name: 'Party', chat_id: 'staged-test', members: ['guide.png', 'mira.png'], disabled_members: [] }] : [],
      name1: 'Player', characterId: 0, groupId: options.group ? 'g1' : null, chatId: 'staged-test',
      chatMetadata: {}, extensionSettings: { rpDirector: settings },
      eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_RECEIVED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SENT', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED'].map(name => [name, name])),
      eventSource: {
        on: (name: string, handler: Handler) => { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); },
        removeListener: (name: string, handler: Handler) => { this.handlers.set(name, (this.handlers.get(name) ?? []).filter(item => item !== handler)); },
      },
      getCurrentChatId: () => this.currentChatId,
      getRequestHeaders: () => ({}),
      generate: async (_type: string, generateOptions?: Record<string, unknown>) => { this.generated.push(generateOptions ?? {}); },
      stopGeneration: () => {}, saveMetadata: async () => {}, saveChat: async () => {}, saveSettingsDebounced: () => {},
      setExtensionPrompt: (_key: string, value: string) => { this.injection = value; },
      swipe: { right: async () => {}, state: () => 'none' },
      uuidv4: () => 'test-uuid',
      ConnectionManagerRequestService: { sendRequest: async () => { throw new Error('Unexpected sidecar request'); } },
      ChatCompletionService: { processRequest: async () => { throw new Error('Unexpected completion request'); } },
    } as unknown as StContext;
  }

  override ctx(): StContext { return this.context; }
  override async loadFlags(): Promise<void> {}
  override isGenerating(): boolean { return false; }
  override isAutoMode(): boolean { return false; }
  override composerText(): string { return this.composerValue; }
  override interceptNativeSend(): () => void { return () => {}; }
  override toast(_kind: 'info' | 'success' | 'warning' | 'error', message: string): void { this.notices.push(message); }
  override async confirm(): Promise<boolean> { return true; }
  override async chooseSwipeAction(): Promise<SwipeChoice> { return this.swipeResult(); }
  override async postUserMessage(): Promise<boolean> { return true; }
  async emit(name: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(...args);
  }
}

export const choice = (value: string): Answer => ({ type: 'choice', choice: value, probabilities: null, confidence: null, provenance: 'fixture' } as Answer);
export const noul = (value: number): Answer => ({ type: 'noul', noul: value, confidence: null, provenance: 'fixture' } as Answer);

/** Replaces the judge with a script keyed by question id and records every request. */
export function scriptJudge(controller: Controller, script: Record<string, Answer>): EvaluationRequest[] {
  const requests: EvaluationRequest[] = [];
  const original = controller.provider.bind(controller);
  controller.provider = () => ({
    ...original(),
    evaluate: async (request: EvaluationRequest): Promise<EvaluationResult> => {
      requests.push(structuredClone(request));
      const answers: Record<string, Answer> = {};
      const errors: Record<string, string> = {};
      for (const id of Object.keys(request.questions)) {
        if (script[id]) answers[id] = script[id]!;
        else errors[id] = 'not scripted';
      }
      return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: 'fixture', answers, unresolvedQuestionIds: Object.keys(errors), errors, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
    },
  });
  return requests;
}

/** Makes the fake writer produce one reply from the given character, observed like a real one. */
export function writerReplies(host: TestHost, controller: Controller, name: string, avatar: string, prose: string): { injected: () => string } {
  let injected = '';
  host.context.generate = async (_type: string, options?: Record<string, unknown>) => {
    host.generated.push(options ?? {});
    await controller.interceptor([], 4096, () => assert.fail('unexpected abort'), 'normal');
    injected = host.injection;
    host.chat().push({ name, original_avatar: avatar, is_user: false, is_system: false, mes: prose, swipe_id: 0, swipes: [prose], swipe_info: [{ extra: {} }] } as HostChatMessage);
    await host.emit('MESSAGE_RECEIVED', host.chat().length - 1, 'normal');
  };
  return { injected: () => injected };
}

export async function harness(options: { group?: boolean } = {}) {
  const host = new TestHost(options);
  const controller = new Controller(host);
  await controller.init();
  return { host, controller };
}
