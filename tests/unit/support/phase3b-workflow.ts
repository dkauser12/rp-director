/**
 * Extension of support/st-harness.ts for the phase 1b workflow review.
 *
 * Adds what the base harness does not model, each step taken from
 * SillyTavern/public/script.js and scripts/tool-calling.js:
 *  - is_send_press: Host.isGenerating() follows the emulated generation.
 *  - Generate(type, {depth}) (script.js 4290-4570, 5385-5600): GENERATION_STARTED,
 *    regenerate deletes the last non-user message (MESSAGE_DELETED) before the
 *    interceptors, swipe drops the last message from coreChat, streaming
 *    GENERATION_ENDED fires BEFORE MESSAGE_RECEIVED (finalizeIntermediaryMessage
 *    -> markUIGenStopped -> unblockGeneration -> hideStopButton), non-streaming
 *    after it (saveReply -> ... -> unblockGeneration).
 *  - Tool calls (script.js 5408-5436, tool-calling.js 400-418, 786-921):
 *    empty non-swipe placeholder deleted, otherwise finalized with MESSAGE_RECEIVED;
 *    every non-stealth result (ok or error JSON) is saved as an is_system
 *    message with extra.tool_invocations, then Generate('normal', {depth+1}).
 *    The request's tools/tool_choice come from each tool's shouldRegister().
 *  - swipe.to(null,'right',{source,forceSwipeId}) (script.js 9954-10426):
 *    overswipe of a user/system message LOOPS (no generation); of an AI message
 *    sets swipe_id=len, awaits MESSAGE_SWIPED, then Generate('swipe') unless
 *    is_send_press; endSwipe reverts an out-of-range swipe_id.
 *  - stopGeneration (script.js 5607-5620): hideStopButton -> GENERATION_ENDED,
 *    then GENERATION_STOPPED (neither awaited).
 *  - Options menu Regenerate (script.js 11629-11642) and the real
 *    Host.interceptNativeRegenerate capture listener; /regenerate native
 *    callback (slash-commands.js 5643-5670) under the real interceptRegenerateCommand.
 */
import { StHost, Controller, Host, permissiveJudge, turnScript, GUIDE, assert } from './phase3b-st-harness.ts';
export { Controller, Host, permissiveJudge, turnScript, GUIDE, assert };

type Fn = (event: any) => void;
class MiniTarget {
  value = '';
  checked = true;
  readOnly = false;
  style: { display: string } = { display: '' };
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
  /** Native click: capture listeners first at target, then bubble; honours stopImmediatePropagation. */
  click() { return this.dispatch(fakeEvent(this)); }
  dispatch(event: any, extraCapture: Fn[] = []): any {
    for (const fn of [...extraCapture, ...this.capture, ...this.bubble]) { fn(event); if (event.stopped) break; }
    return event;
  }
  /** jQuery .trigger('click') on an <a>: jQuery handlers only (the bubble list here), never native capture listeners. */
  jqTrigger() { for (const fn of this.bubble) fn(fakeEvent(this)); }
}
function fakeEvent(target: MiniTarget, extra: Record<string, unknown> = {}) {
  return { target, key: undefined, isComposing: false, shiftKey: false, altKey: false, metaKey: false, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
}

export type Step =
  | { text: string; delayMs?: number; finalizeDelayMs?: number }
  | { tool: 'auto' | Record<string, unknown>; prose?: string }
  | { fail: string };

export class H2Host extends (StHost as any) {
  sim: any;
  isGenerating(): boolean { return Boolean(this.sim?.sendPress); }
  interceptNativeRegenerate(should: () => boolean, regenerate: () => Promise<unknown>): () => void {
    return Host.prototype.interceptNativeRegenerate.call(this, should, regenerate);
  }
}

export interface Sim2 {
  onStop: (() => void) | null;
  host: any; controller: any; els: Map<string, MiniTarget>;
  sendPress: boolean; stopShown: boolean; streaming: boolean;
  writer: Step[]; log: string[]; envelopes: { type: string; depth: number; envelope: unknown }[];
  tool: any; reply: (n: number) => string;
  generate: (type: string, opts?: { depth?: number }) => Promise<void>;
  swipeRight: () => Promise<void>;
  stop: () => void;
  settle: () => Promise<void>;
  clickSend: (text: string) => Promise<void>;
  menuRegenerate: () => Promise<void>;
  ctrlEnter: () => Promise<void>;
  slashRegen: (args?: Record<string, unknown>) => Promise<unknown>;
  pendingGenerations: Promise<unknown>[];
  /** Listeners registered on MESSAGE_RECEIVED before the Director's (other extensions). */
  earlierMessageReceived: ((...args: unknown[]) => unknown)[];
}

export async function sim2(options: { streaming?: boolean; tools?: boolean; configure?: (s: Sim2) => void | Promise<void>; chat?: any[] } = {}): Promise<Sim2> {
  const els = new Map<string, MiniTarget>();
  for (const id of ['send_but', 'send_textarea', 'option_regenerate', 'options', 'options_button', 'swipes-checkbox']) els.set(id, new MiniTarget(id));
  const documentCapture: Fn[] = [];
  (globalThis as any).document = {
    getElementById: (id: string) => els.get(id) ?? null,
    addEventListener: (_t: string, fn: Fn) => documentCapture.push(fn),
    removeEventListener: (_t: string, fn: Fn) => { const i = documentCapture.indexOf(fn); if (i >= 0) documentCapture.splice(i, 1); },
    body: { dataset: {} },
  };
  const host = new H2Host();
  const sim = {
    host, controller: null as any, els, sendPress: false, stopShown: false, streaming: options.streaming ?? true,
    writer: [] as Step[], onStop: null as null | (() => void), log: [] as string[], envelopes: [] as any[], tool: null as any,
    reply: (n: number) => `Guide reply number ${n}.`, pendingGenerations: [] as Promise<unknown>[],
    earlierMessageReceived: [] as ((...args: unknown[]) => unknown)[],
  } as unknown as Sim2;
  host.sim = sim;
  if (options.chat) host.context.chat = options.chat;
  const textarea = els.get('send_textarea')!;
  Object.defineProperty(textarea, 'value', { get: () => host.composerValue, set: (v: string) => { host.composerValue = v; } });

  // Other extensions' MESSAGE_RECEIVED listeners registered before the Director.
  const originalEmit = host.emit.bind(host);
  host.emit = async (name: string, ...args: unknown[]) => {
    sim.log.push(name === 'GENERATION_STARTED' ? `${name} ${String(args[0])}` : `${name}${args.length ? ' ' + JSON.stringify(args[0]) : ''}${name === 'MESSAGE_RECEIVED' ? ' ' + String(args[1]) : ''}`);
    if (name === 'MESSAGE_RECEIVED') for (const listener of sim.earlierMessageReceived) await listener(...args);
    return originalEmit(name, ...args);
  };

  if (options.tools !== false) {
    Object.assign(host.context, {
      registerFunctionTool: (tool: any) => { sim.tool = tool; },
      unregisterFunctionTool: () => { sim.tool = null; },
      isToolCallingSupported: () => true,
      canPerformToolCalls: (type: string) => !['impersonate', 'quiet', 'continue'].includes(type),
    });
  }
  // Native /regenerate (slash-commands.js 5643): waits for idle, then Generate('regenerate').
  const nativeRegen = { name: 'regenerate', aliases: ['regen'], callback: async (args: any) => {
    const shouldAwait = ['true', 'on', '1'].includes(String(args?.await ?? ''));
    const p = new Promise<void>(resolve => setTimeout(async () => {
      for (let i = 0; i < 100 && sim.sendPress; i++) await new Promise(r => setTimeout(r, 1));
      sim.log.push('native /regenerate -> Generate(regenerate)');
      await sim.generate('regenerate'); resolve();
    }, 1));
    if (shouldAwait) await p;
    return '';
  } };
  const registry: Record<string, any> = { regenerate: nativeRegen, regen: nativeRegen };
  Object.assign(host.context, {
    SlashCommandParser: { commands: registry, addCommandObject: (cmd: any) => { registry[cmd.name] = cmd; for (const a of cmd.aliases ?? []) registry[a] = cmd; } },
    SlashCommand: { fromProps: (props: any) => ({ ...props }) },
  });

  let replyCount = 0;
  const unblock = () => {
    sim.sendPress = false;
    if (sim.stopShown) { sim.stopShown = false; void host.emit('GENERATION_ENDED', host.chat().length); }
  };

  const envelope = async (type: string, depth: number) => {
    // openai.js 2840 + tool-calling.js 400: tools only if canPerformToolCalls(type) (depth < RECURSE_LIMIT in Generate).
    if (['impersonate', 'quiet', 'continue'].includes(type) || depth >= 5 || !sim.tool) return {};
    if (!(await sim.tool.shouldRegister?.())) return {};
    return { tools: [{ type: 'function', function: { name: sim.tool.name, description: sim.tool.description, parameters: sim.tool.parameters } }], tool_choice: 'auto' };
  };

  sim.generate = async (type: string, genOptions: { depth?: number } = {}) => {
    const depth = genOptions.depth ?? 0;
    const chat = host.chat();
    host.generated.push({ type, depth });
    await host.emit('GENERATION_STARTED', type, {}, false);
    // processCommands (script.js 4310-4318): a composer command runs here, then Generate returns early.
    if (!depth && !['regenerate', 'swipe', 'quiet'].includes(type) && host.composerValue.trim().startsWith('/')) {
      const [name] = host.composerValue.trim().slice(1).split(/\s+/);
      host.composerValue = '';
      sim.log.push(`command /${name} from the composer`);
      await registry[name!]?.callback({}, '');
      sim.sendPress = false;
      return;
    }
    let textareaText = '';
    const last = chat.at(-1);
    if (type !== 'regenerate' && type !== 'swipe' && type !== 'quiet' && !depth) {
      sim.sendPress = true;
      textareaText = host.composerValue;
      host.composerValue = '';
    } else if (chat.length && last?.is_user) {
      // script.js 4405: nothing
    } else if (type !== 'quiet' && type !== 'swipe' && !depth && chat.length) {
      chat.length = chat.length - 1;
      await host.emit('MESSAGE_DELETED', chat.length);
    }
    sim.stopShown = true; // deactivateSendButtons
    if (textareaText) {
      chat.push({ name: 'Player', is_user: true, is_system: false, mes: textareaText });
      await host.emit('MESSAGE_SENT', chat.length - 1);
    }
    let aborted = false;
    const core = chat.filter((m: any) => !m.is_system || Array.isArray(m.extra?.tool_invocations));
    if (type === 'swipe') core.pop();
    await sim.controller.interceptor(structuredClone(core), 4096, () => { aborted = true; }, type);
    if (aborted) { sim.log.push(`aborted ${type}`); unblock(); return; }
    const requestEnvelope = await envelope(type, depth);
    sim.envelopes.push({ type, depth, envelope: requestEnvelope, injection: host.injection } as any);
    let step: Step = sim.writer.shift() ?? { text: sim.reply(++replyCount) };
    // A model can only call a tool the request actually carried.
    if ('tool' in step && !(requestEnvelope as any).tools) { sim.log.push(`writer wanted a tool at ${type}@${depth} but none was offered`); step = { text: sim.reply(++replyCount) }; }
    if ('fail' in step) { sim.log.push(`writer failed: ${step.fail}`); unblock(); throw new Error(step.fail); }
    // Streaming placeholder (onStartStreaming -> saveReply fromStreaming) or final saveReply.
    let id: number;
    const placeholder = sim.streaming ? '...' : null;
    const isSwipe = type === 'swipe' && chat.length && !chat.at(-1)!.is_user && chat.at(-1)!.swipe_id !== undefined;
    const isContinue = type === 'continue' && chat.length && !chat.at(-1)!.is_user && !chat.at(-1)!.is_system;
    let continueBase = '';
    if (isContinue) {
      id = chat.length - 1;
      continueBase = chat[id]!.mes;
    } else if (isSwipe) {
      id = chat.length - 1;
      const m = chat[id]!;
      m.swipes.length = Math.max(m.swipes.length, (m.swipe_id ?? 0) + 1);
      m.mes = placeholder ?? '';
    } else {
      chat.push({ ...(host.replier ?? { name: 'Guide' }), is_user: false, is_system: false, mes: placeholder ?? '', swipe_id: 0, swipes: [placeholder ?? ''], swipe_info: [{ extra: {} }], extra: {} });
      id = chat.length - 1;
    }
    const message = chat[id]!;
    const sync = () => { message.swipes[message.swipe_id ?? 0] = message.mes; message.swipe_info ??= []; message.swipe_info[message.swipe_id ?? 0] = { extra: structuredClone(message.extra ?? {}) }; };
    if ('tool' in step) {
      const prose = step.prose ?? '';
      const shouldDelete = type !== 'swipe' && !prose;
      if (shouldDelete) { chat.length = chat.length - 1; await host.emit('MESSAGE_DELETED', chat.length); }
      else { message.mes = prose; sync(); await host.emit('MESSAGE_RECEIVED', id, type); await host.emit('CHARACTER_MESSAGE_RENDERED', id, type); }
      let args: Record<string, unknown>;
      if (step.tool === 'auto') {
        const ids = /requestId ([\w-]+), attemptId ([\w-]+), and speakerActorId ([\w-]+)\./.exec(host.injection) ?? [null, 'req-x', 'att-x', GUIDE];
        args = { schemaVersion: 1, requestId: ids[1], attemptId: ids[2], speakerActorId: ids[3], actions: [{
          proposalId: 'npc-1', actingActorId: ids[3], targetActorIds: [], family: 'overcome_operate',
          method: 'works the gate lock with a pick', boundedResult: 'the gate lock opens',
          failureStake: { kind: 'delay', detail: 'the gate stays locked' }, opposed: false, evidenceRefs: ['latest_input'] }] };
      } else args = step.tool;
      if (!sim.tool) throw new Error('no tool registered');
      sim.log.push(`tool call during ${type} depth ${depth}`);
      const result = await sim.tool.action(args);
      sim.log.push(`tool result: ${String(result).slice(0, 80)}`);
      chat.push({ name: 'SillyTavern System', is_system: true, is_user: false, mes: '<details><summary>Tool calls: RP Director turn adjudication</summary><pre><code>[]</code></pre></details>', extra: { isSmallSys: true, tool_invocations: [{ name: sim.tool.name, result }] } });
      await host.emit('TOOL_CALLS_PERFORMED', []);
      return sim.generate('normal', { depth: depth + 1 });
    }
    if ('delayMs' in step && step.delayMs) {
      // The stream ends at once on Stop (the aborted reader rejects; microtasks only).
      await new Promise<void>(resolve => { const t = setTimeout(resolve, step.delayMs); sim.onStop = () => { clearTimeout(t); queueMicrotask(resolve); }; });
      sim.onStop = null;
    }
    message.mes = isContinue ? `${continueBase} ${step.text}` : step.text;
    // onProgressStreaming(final) work before markUIGenStopped: token count (server tokenizer), reasoning finish.
    if ('finalizeDelayMs' in step && step.finalizeDelayMs) await new Promise(resolve => setTimeout(resolve, step.finalizeDelayMs));
    sync();
    // Non-streaming continue goes through saveReply({type: 'appendFinal'}) (script.js 5531-5535).
    const receivedType = isContinue && !sim.streaming ? 'appendFinal' : type;
    if (sim.streaming) {
      unblock(); // markUIGenStopped -> GENERATION_ENDED (not awaited)
      await host.emit('MESSAGE_RECEIVED', id, receivedType);
      await host.emit('CHARACTER_MESSAGE_RENDERED', id, receivedType);
    } else {
      await host.emit('MESSAGE_RECEIVED', id, receivedType);
      await host.emit('CHARACTER_MESSAGE_RENDERED', id, receivedType);
      unblock();
    }
  };
  host.context.generate = (type: string, genOptions?: Record<string, unknown>) => {
    const p = sim.generate(type, genOptions as any);
    sim.pendingGenerations.push(p.catch(() => {}));
    return p;
  };
  host.context.stopGeneration = () => { sim.log.push('stopGeneration'); (sim as any).onStop?.(); if (sim.stopShown) { sim.stopShown = false; void host.emit('GENERATION_ENDED', host.chat().length); } void host.emit('GENERATION_STOPPED'); };

  // swipe.to / swipe.right (script.js 9954-10426), last message only.
  const swipeTo = async (_event: unknown, _direction: string, swipeOptions: Record<string, any> = {}) => {
    const chat = host.chat();
    const mesId = Number(swipeOptions.forceMesId ?? chat.length - 1);
    const message = chat[mesId]!;
    if (swipeOptions.source !== 'slash_command' && sim.sendPress) { sim.log.push('swipe refused: generating'); return; }
    if (message.swipe_id === undefined) { message.swipe_id = 0; message.swipes = [message.mes]; message.swipe_info = [{ extra: structuredClone(message.extra ?? {}) }]; }
    const original = message.swipe_id;
    let newId = Number(swipeOptions.forceSwipeId ?? original + 1);
    if (newId >= message.swipes.length) {
      const overswipe = message.is_user || message.is_system ? 'loop' : 'regenerate';
      if (overswipe === 'loop') { sim.log.push(`swipe on ${message.is_user ? 'user' : 'system'} message loops: no generation`); newId = 0; if (newId === original) return; message.swipe_id = newId; message.mes = message.swipes[newId]; await host.emit('MESSAGE_SWIPED', mesId); return; }
      message.swipe_id = message.swipes.length;
      await host.emit('MESSAGE_SWIPED', mesId);
      let generation: Promise<void> | null = null;
      if (!sim.sendPress) { sim.sendPress = true; generation = sim.generate('swipe'); }
      try { await generation; } catch (e) { sim.log.push(`swipe generation failed ${(e as Error).message}`); }
      const clamped = Math.max(0, Math.min(message.swipe_id, message.swipes.length - 1));
      if (message.swipe_id !== clamped) { message.swipe_id = clamped; message.mes = message.swipes[clamped]; sim.log.push('swipe reverted'); }
      return;
    }
    message.swipe_id = newId; message.mes = message.swipes[newId];
    await host.emit('MESSAGE_SWIPED', mesId);
  };
  host.context.swipe = { right: (e: unknown, o: Record<string, unknown>) => swipeTo(e, 'right', o), to: swipeTo, state: () => 'none' };
  sim.swipeRight = () => swipeTo(null, 'right', {});
  sim.stop = () => host.context.stopGeneration();

  // ST's own options-menu handler for #option_regenerate (bubble / jQuery listener).
  els.get('option_regenerate')!.addEventListener('click', () => {
    if (!sim.sendPress) { sim.sendPress = true; sim.log.push('native menu Regenerate -> Generate(regenerate)'); const p = sim.generate('regenerate'); sim.pendingGenerations.push(p.catch(() => {})); }
  });
  els.get('options')!.style.display = 'block';
  els.get('options_button')!.addEventListener('click', () => { const m = els.get('options')!; m.style.display = m.style.display === 'none' ? 'block' : 'none'; });
  // ST Send handler (sendTextareaMessage): Generate('normal').
  const stSend = () => { if (sim.sendPress) return; const p = sim.generate('normal'); sim.pendingGenerations.push(p.catch(() => {})); };
  els.get('send_but')!.addEventListener('click', stSend);

  sim.settle = async () => {
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve));
      await Promise.all(sim.pendingGenerations);
      await sim.controller.waitForMessageTasks();
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  sim.clickSend = async (text: string) => {
    host.composerValue = text;
    els.get('send_but')!.click();
    await sim.settle();
  };
  sim.menuRegenerate = async () => { els.get('option_regenerate')!.click(); await sim.settle(); };
  sim.ctrlEnter = async () => { els.get('option_regenerate')!.jqTrigger(); await sim.settle(); };
  sim.slashRegen = async (args: Record<string, unknown> = {}) => { const r = await registry.regen.callback(args, ''); await sim.settle(); return r; };

  const controller = new Controller(host);
  sim.controller = controller;
  controller.settings.pipeline = 'staged';
  controller.settings.modules = { speaker: true, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  controller.settings.profileId = 'binding-dice';
  controller.reloadProfile?.();
  await options.configure?.(sim);
  // Real directorSend is what the intercept calls; record its promise for settle().
  const originalSend = controller.directorSend.bind(controller);
  controller.directorSend = () => { const p = originalSend(); sim.pendingGenerations.push(p.catch(() => {})); return p; };
  await controller.init();
  await controller.setChatPack('default');
  permissiveJudge(controller, turnScript(GUIDE));
  await sim.settle();
  return sim;
}

/** Compact record view: attempts in creation order. */
export function attempts(sim: Sim2) {
  return Object.values<any>(sim.controller.record.attempts).sort((a, b) => a.createdAt - b.createdAt)
    .map(a => `${a.generationType}${a.unadjudicated ? '/unadj' : ''}${a.resolutionId ? '/ruled' : ''}${a.permitId ? '/permit' : ''}:${a.status}`);
}
export function lastMarker(sim: Sim2) { return sim.host.chat().at(-1)?.extra?.rpd ?? null; }
