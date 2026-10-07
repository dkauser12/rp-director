/**
 * Reply-check (C2) review harness on top of phase3b-workflow.ts.
 *
 * Adds, each from SillyTavern public/script.js on this build:
 *  - swipe() (9954-10426): swipe_id = len, clearMessageData (keeps extra.rpd),
 *    animateSwipe(run_generate): swipe-out animation -> await MESSAGE_SWIPED ->
 *    Generate('swipe') NOT awaited -> swipe-in animation -> endSwipe(): await
 *    generation, clamp swipe_id, revert an out-of-range id. Slash-command and
 *    delete sources bypass the "generating" and "one swipe at a time" checks.
 *  - onFinishStreaming (3808-3818) / onSuccess (5561-5575): after MESSAGE_RECEIVED
 *    and CHARACTER_MESSAGE_RENDERED, Generate still awaits saveChatConditional()
 *    before it resolves (network I/O): modelled by `saveLatencyMs`.
 *  - deleteSwipe (9339-9399): splice swipes/swipe_info, set swipe_id, await
 *    MESSAGE_SWIPE_DELETED, then swipe(DELETE) to show the neighbour.
 *  - The composer's `input` listener (Host.onComposerInput) is captured so a test
 *    can "type".
 */
import { sim2, attempts, GUIDE, assert } from './phase3b-workflow.ts';
export { attempts, GUIDE, assert };

export const score = (value: number) => ({ type: 'score', score: value, legend: {}, probabilities: null, confidence: null, provenance: 'fixture' });
export const noul = (value: number) => ({ type: 'noul', noul: value, confidence: null, provenance: 'fixture' });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface RcOptions {
  streaming?: boolean;
  /** Swipe-out / swipe-in animation (ms). */
  outMs?: number;
  inMs?: number;
  /** saveChatConditional() latency before Generate resolves (ms). */
  saveLatencyMs?: number;
  /** Runs during the swipe-out animation of the next swipe (before MESSAGE_SWIPED). */
  askWhenSwiping?: boolean;
  /** Per-request answer overrides for the reply check (and anything else). */
  answers?: (request: any, index: number) => Record<string, unknown>;
}

export async function rc(options: RcOptions = {}) {
  let typing: () => void = () => {};
  const popups: string[] = [];
  const sim: any = await sim2({
    streaming: options.streaming ?? true,
    configure: (s: any) => {
      s.host.onComposerInput = (cb: () => void) => { typing = cb; return () => { typing = () => {}; }; };
      s.controller.settings.modules.replyCheck = true;
      s.controller.settings.askWhenSwiping = options.askWhenSwiping ?? false;
      s.host.swipeResult = async () => { popups.push('W3'); return 'reuse'; };
    },
  });
  // Reply-check answers layered over the permissive staged judge that sim2 installed.
  const requests: any[] = [];
  const base = sim.controller.provider.bind(sim.controller);
  sim.controller.provider = () => {
    const provider = base();
    return { ...provider, evaluate: async (request: any, signal: AbortSignal) => {
      requests.push(structuredClone(request));
      const result = await provider.evaluate(request, signal);
      const extra = options.answers?.(request, requests.length - 1) ?? {};
      const answers = { ...result.answers };
      for (const [id, answer] of Object.entries(extra)) if (id in request.questions) answers[id] = answer;
      return { ...result, answers };
    } };
  };

  // SillyTavern's generation promise also awaits saveChatConditional() after the events.
  const generate = sim.generate.bind(sim);
  sim.generate = async (type: string, opts?: any) => {
    await generate(type, opts);
    if (options.saveLatencyMs) await wait(options.saveLatencyMs);
  };

  let swipeState: 'none' | 'swiping' = 'none';
  let swipeOutHook: null | (() => void | Promise<void>) = null;
  const host = sim.host;
  const sync = (message: any, id: number) => {
    message.swipe_id = id;
    message.mes = message.swipes[id];
    message.extra = structuredClone(message.swipe_info?.[id]?.extra ?? {});
  };
  const swipeTo = async (_event: unknown, direction: 'left' | 'right', o: Record<string, any> = {}) => {
    const chat = host.chat();
    const mesId = Number(o.forceMesId ?? chat.length - 1);
    const message = chat[mesId];
    const bypass = ['delete', 'back', 'auto_swipe', 'slash_command', 'swipe_picker'].includes(o.source);
    if (!bypass) {
      if (sim.sendPress) { sim.log.push('swipe refused: generating'); return; }
      if (swipeState !== 'none') { sim.log.push('swipe ignored: another swipe'); return; }
    }
    swipeState = 'swiping';
    try {
      const original = Number(message.swipe_id ?? 0);
      let next = Number(o.forceSwipeId ?? original);
      if (o.source === 'delete') {
        sync(message, next);
        await host.emit('MESSAGE_SWIPED', mesId);
        return;
      }
      // syncMesToSwipe
      message.swipes[message.swipe_id] = message.mes;
      message.swipe_info[message.swipe_id] = { extra: structuredClone(message.extra ?? {}) };
      if (direction === 'left') {
        if (o.forceSwipeId == null) next--;
        if (next < 0) next = message.swipes.length - 1;
        sync(message, next);
        await host.emit('MESSAGE_SWIPED', mesId);
        return;
      }
      if (o.forceSwipeId == null) next++;
      if (next < message.swipes.length) { sync(message, next); await host.emit('MESSAGE_SWIPED', mesId); return; }
      // Overswipe of an AI message: regenerate.
      message.swipe_id = message.swipes.length;
      if (options.outMs) await wait(options.outMs);
      if (swipeOutHook) { const hook = swipeOutHook; swipeOutHook = null; await hook(); }
      await host.emit('MESSAGE_SWIPED', mesId);
      let generation: Promise<void> | null = null;
      if (!sim.sendPress) { sim.sendPress = true; const pending = sim.generate('swipe') as Promise<void>; generation = pending; sim.pendingGenerations.push(pending.catch(() => {})); }
      if (options.inMs) await wait(options.inMs);
      try { await generation; } catch (e) { sim.log.push(`swipe generation failed ${(e as Error).message}`); }
      const clamped = Math.max(0, Math.min(message.swipe_id, message.swipes.length - 1));
      if (message.swipe_id !== clamped) { sync(message, clamped); sim.log.push('swipe reverted'); }
    } finally { swipeState = 'none'; }
  };
  host.context.swipe = { right: (e: unknown, o: Record<string, unknown>) => swipeTo(e, 'right', o), to: swipeTo, state: () => swipeState };
  sim.swipeRight = () => swipeTo(null, 'right', {});
  sim.swipeLeft = () => swipeTo(null, 'left', {});

  const deleteSwipe = async () => {
    const chat = host.chat();
    const messageId = chat.length - 1;
    const message = chat[messageId];
    const swipeId = message.swipe_id;
    message.swipes.splice(swipeId, 1);
    message.swipe_info.splice(swipeId, 1);
    const newSwipeId = Math.min(swipeId, message.swipes.length - 1);
    message.swipe_id = newSwipeId;
    await host.emit('MESSAGE_SWIPE_DELETED', { messageId, swipeId, newSwipeId });
    await swipeTo(null, 'right', { source: 'delete', forceMesId: messageId, forceSwipeId: newSwipeId });
  };

  // Stop button bookkeeping (h2's stopGeneration already emits ENDED/STOPPED).
  let stops = 0;
  const stop = host.context.stopGeneration;
  host.context.stopGeneration = () => { stops++; stop(); };

  return {
    sim, host, controller: sim.controller, requests, popups,
    checks: () => requests.filter(r => 'speaks_for_user' in r.questions),
    type: (text: string) => { host.composerValue = text; typing(); },
    onSwipeOut: (hook: () => void | Promise<void>) => { swipeOutHook = hook; },
    deleteSwipe: async () => { await deleteSwipe(); await sim.settle(); },
    stops: () => stops,
    last: () => host.chat().at(-1),
  };
}

/** Wait until an asynchronous reply-check boundary is reached (fails loudly otherwise). */
export async function until(predicate: () => boolean, label = 'condition') {
  for (let i = 0; i < 400 && !predicate(); i++) await wait(5);
  assert.ok(predicate(), `timed out waiting for ${label}`);
}
