/**
 * SillyTavern-faithful harness for the 0.7.x "swallowed Send" repro.
 *
 * - Runs the REAL Host.interceptNativeSend against a tiny DOM whose dispatch is
 *   capture-first at the target (as Chromium does), so SillyTavern's own Send
 *   handler only runs when the Director does not stop the event.
 * - Emulates script.js Generate() event order (verified in
 *   SillyTavern/public/script.js 4290-4570, 3560-3870, 10270-10330):
 *   GENERATION_STARTED -> [composer text: sendMessageAsUser -> MESSAGE_SENT]
 *   -> runGenerationInterceptors -> streaming placeholder '...'
 *   -> final text -> MESSAGE_RECEIVED -> CHARACTER_MESSAGE_RENDERED.
 *   Swipes: MESSAGE_SWIPED (awaited, the popup) then Generate('swipe').
 *
 * ROOT is this repository (relative to this file).
 */
import assert from 'node:assert/strict';

export const ROOT = new URL('../../../', import.meta.url).href;
const { Controller } = await import(ROOT + 'src/controller.ts');
const { Host } = await import(ROOT + 'src/host.ts');
const identity = await import(ROOT + 'src/identity.ts');
const support = await import(ROOT + 'tests/unit/support/test-host.ts');
export const { choice, noul, scriptJudge } = support;
export const { actorIdFor, cursorChain, extendCursor } = identity;
export { Controller, Host };

type Fn = (event: any) => void;
/** At-target dispatch: capture listeners first, then bubble listeners; honours stopImmediatePropagation. */
class MiniTarget {
  value = '';
  dataset: Record<string, string> = {};
  private capture: Fn[] = [];
  private bubble: Fn[] = [];
  id: string;
  constructor(id: string) { this.id = id; }
  addEventListener(_type: string, fn: Fn, useCapture?: boolean | { capture?: boolean }) {
    const cap = typeof useCapture === 'object' ? Boolean(useCapture.capture) : Boolean(useCapture);
    (cap ? this.capture : this.bubble).push(fn);
  }
  removeEventListener(_type: string, fn: Fn) {
    this.capture = this.capture.filter(f => f !== fn);
    this.bubble = this.bubble.filter(f => f !== fn);
  }
  dispatch(event: any, extraCapture: Fn[] = []): any {
    for (const fn of [...extraCapture, ...this.capture, ...this.bubble]) {
      fn(event);
      if (event.stopped) break;
    }
    return event;
  }
  listeners() { return { capture: [...this.capture], bubble: [...this.bubble] }; }
}

function fakeEvent(target: MiniTarget, extra: Record<string, unknown> = {}) {
  return {
    target, key: undefined, isComposing: false, shiftKey: false, altKey: false, metaKey: false,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    ...extra,
  };
}

export class StHost extends support.TestHost {
  /** The production intercept, not the test-host no-op. */
  interceptNativeSend(should: () => boolean, send: () => Promise<void>): () => void {
    return Host.prototype.interceptNativeSend.call(this, should, send);
  }
}

export interface Sim {
  host: StHost;
  controller: any;
  button: MiniTarget;
  textarea: MiniTarget;
  /** SillyTavern's own Send handler ran (i.e. the Director did not stop the click). */
  stSends: number;
  /** Promise of the Director's directorSend started by the intercept, if any. */
  lastDirectorSend: Promise<void> | null;
  /** Runs once while the next reply is still the streaming placeholder '...'. */
  midStream: (() => Promise<void>) | null;
  generate: (type: string, options?: Record<string, unknown>) => Promise<void>;
  clickSend: (options?: { wait?: boolean }) => Promise<any>;
  pressEnter: () => Promise<any>;
  swipe: () => Promise<void>;
  reloadPage: () => Promise<void>;
  settle: () => Promise<void>;
  reply: (n: number) => string;
  /** name/original_avatar of generated replies. */
  replier: Record<string, string>;
}

export async function simulate(options: { configure?: (sim: Sim) => void | Promise<void>; prepareHost?: (host: StHost) => void } = {}): Promise<Sim> {
  const button = new MiniTarget('send_but');
  const textarea = new MiniTarget('send_textarea');
  const documentCapture: Fn[] = [];
  (globalThis as any).document = {
    getElementById: (id: string) => (id === 'send_but' ? button : id === 'send_textarea' ? textarea : null),
    addEventListener: (_t: string, fn: Fn) => documentCapture.push(fn),
    removeEventListener: (_t: string, fn: Fn) => { const i = documentCapture.indexOf(fn); if (i >= 0) documentCapture.splice(i, 1); },
    body: { dataset: {} },
  };
  const host = new StHost();
  options.prepareHost?.(host);
  // The composer textarea is the host's composer value.
  Object.defineProperty(textarea, 'value', { get: () => host.composerValue, set: (v: string) => { host.composerValue = v; } });

  let replyCount = 0;
  const sim = {
    host, controller: null as any, button, textarea, stSends: 0, lastDirectorSend: null as Promise<void> | null, midStream: null as null | (() => Promise<void>),
    reply: (n: number) => `Guide reply number ${n}.`,
    replier: { name: 'Guide', original_avatar: 'guide.png' } as Record<string, string>,
  } as Sim;

  sim.settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
    await sim.controller.waitForMessageTasks();
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };

  // script.js Generate(type) as far as the Director can observe it.
  sim.generate = async (type: string, generateOptions: Record<string, unknown> = {}) => {
    host.generated.push({ type, ...generateOptions });
    const chat = host.chat();
    await host.emit('GENERATION_STARTED', type, generateOptions, false);
    if (type === 'normal' && host.composerValue) {
      const text = host.composerValue;
      host.composerValue = '';
      chat.push({ name: 'Player', is_user: true, is_system: false, mes: text });
      await host.emit('MESSAGE_SENT', chat.length - 1);
    }
    let aborted = false;
    await sim.controller.interceptor(structuredClone(chat), 4096, () => { aborted = true; }, type);
    if (aborted) return;
    const text = sim.reply(++replyCount);
    let id: number;
    if (type === 'swipe') {
      id = chat.length - 1;
      chat[id]!.mes = '...';
    } else {
      chat.push({ ...sim.replier, is_user: false, is_system: false, mes: '...', swipe_id: 0, swipes: ['...'], swipe_info: [{ extra: {} }], extra: {} } as any);
      id = chat.length - 1;
    }
    if (sim.midStream) { const hook = sim.midStream; sim.midStream = null; await hook(); }
    const message = chat[id]!;
    message.mes = text;
    message.swipes = message.swipes ?? [];
    message.swipes[message.swipe_id ?? 0] = text;
    await host.emit('MESSAGE_RECEIVED', id, type);
    await host.emit('CHARACTER_MESSAGE_RENDERED', id, type);
    await host.emit('GENERATION_ENDED', chat.length);
    // Generate() resolves here; the Director's own turn waits for its message
    // tasks after this returns (writerSettled), so callers settle afterwards.
  };
  host.context.generate = (type: string, generateOptions?: Record<string, unknown>) => sim.generate(type, generateOptions);

  // SillyTavern's own handlers (jQuery bubble listeners). continue_on_send=false and
  // send_if_empty='' in this harness, so an empty Send is Generate('normal').
  let stGeneration: Promise<void> | null = null;
  const stSend = () => { sim.stSends += 1; stGeneration = sim.generate('normal'); };
  button.addEventListener('click', stSend);
  textarea.addEventListener('keydown', (event: any) => { if (event.key === 'Enter' && !event.shiftKey) stSend(); });

  const wireController = async () => {
    const controller = new Controller(host);
    sim.controller = controller;
    await options.configure?.(sim);
    // The intercept calls this.directorSend() at click time; record its promise.
    const original = controller.directorSend.bind(controller);
    controller.directorSend = () => { const p = original(); sim.lastDirectorSend = p; return p; };
    await controller.init();
  };
  await wireController();

  sim.clickSend = async (clickOptions: { wait?: boolean } = {}) => {
    sim.lastDirectorSend = null; stGeneration = null;
    const event = button.dispatch(fakeEvent(button));
    if (clickOptions.wait === false) return Object.assign(event, { director: sim.lastDirectorSend, native: stGeneration });
    if (sim.lastDirectorSend) await sim.lastDirectorSend;
    if (stGeneration) await stGeneration;
    await sim.settle();
    return event;
  };
  sim.pressEnter = async () => {
    sim.lastDirectorSend = null; stGeneration = null;
    const event = fakeEvent(textarea, { key: 'Enter' });
    textarea.dispatch(event, documentCapture); // document capture runs before the target's listeners
    if (sim.lastDirectorSend) await sim.lastDirectorSend;
    if (stGeneration) await stGeneration;
    await sim.settle();
    return event;
  };
  sim.swipe = async () => {
    const chat = host.chat();
    const message = chat.at(-1)!;
    message.swipe_id = message.swipes!.length; // new swipe slot, then MESSAGE_SWIPED is awaited, then Generate('swipe')
    await host.emit('MESSAGE_SWIPED', chat.length - 1);
    await sim.generate('swipe');
    await sim.settle();
  };
  sim.reloadPage = async () => {
    sim.controller.destroy(); // drops event handlers and the DOM intercept
    host.injection = '';
    await wireController();   // a new page: fresh controller, record re-read from chat metadata
    await sim.settle();
  };
  return sim;
}

export function turnScript(target: string, move = 's2') {
  return {
    move: choice(move), move_count: choice('one'),
    owner: choice('player'), target: choice(target), family: choice('influence_negotiate'),
    action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'),
    ruling: noul(0.45),
  };
}

export const GUIDE = actorIdFor('Guide', 'guide.png');

/** Scripted answers first; any other question gets a valid generic answer (first choice, 0.5, lowest score). */
export function permissiveJudge(controller: any, script: Record<string, unknown>): any[] {
  const requests: any[] = [];
  const original = controller.provider.bind(controller);
  controller.provider = () => ({
    ...original(),
    evaluate: async (request: any) => {
      requests.push(structuredClone(request));
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries<any>(request.questions)) {
        if (script[id]) answers[id] = script[id];
        else if (question.type === 'choice') answers[id] = choice(Object.keys(question.criteria)[0]!);
        else if (question.type === 'noul') answers[id] = noul(0.5);
        else answers[id] = { type: 'score', score: 0, legend: Object.fromEntries(question.criteria.map((c: string, i: number) => [String(i), c])), probabilities: null, confidence: null, provenance: 'fixture' };
      }
      return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: 'fixture', answers, unresolvedQuestionIds: [], errors: {}, inputTokens: null, outputTokens: null, durationMs: 1, transportAttempts: 1 };
    },
  });
  return requests;
}

/** Compact view of the record: no prose. */
export function view(sim: Sim) {
  const record = sim.controller.record;
  const chain = cursorChain(record.seedId, sim.host.fingerprintMessages(sim.host.chat()));
  const at = (cursor: string | null) => { const i = chain.indexOf(cursor as string); return i >= 0 ? `head-${chain.length - 1 - i}` : (cursor ? 'off-chain' : 'null'); };
  const attempts = Object.values<any>(record.attempts).sort((a, b) => a.createdAt - b.createdAt)
    .map(a => `${a.generationType}${a.unadjudicated ? '/unadj' : ''}${a.resolutionId ? '/ruled' : ''}:${a.status}`);
  return {
    status: sim.controller.status,
    projection: `${record.projection.status}@${at(record.projection.cursor)}${record.projection.reason ? ` (${record.projection.reason})` : ''}`,
    checkpointAtHead: Boolean(record.checkpoints[chain.at(-1)!]),
    checkpoints: Object.keys(record.checkpoints).length,
    attempts,
    stateRevision: record.projection.state.revision,
    chatLength: sim.host.chat().length,
    epoch: sim.controller.epoch,
    lastInspector: record.inspector.slice(-1).map((e: any) => `${e.kind}: ${e.message}`)[0],
  };
}

export { assert };
