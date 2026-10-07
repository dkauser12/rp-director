/**
 * A closer model of SillyTavern's swipe() (public/script.js 9954-10426) for races
 * between two swipes, installed over the phase 3c reply-check harness (rc()).
 *
 * Differences from rc()'s swipeTo that matter for concurrent swipes:
 *  - syncMesToSwipe (6896-6941) does nothing when swipes[swipe_id] is not yet a
 *    string: a second overswipe started while the first one's slot is still empty
 *    does not copy the old text into that slot (rc() does);
 *  - animateSwipeTransition (10169-10229) uses one global CSS animation: a newer
 *    swipe restarting it ends the older swipe's running animation early;
 *  - swipeState is one global, reset by whichever endSwipe() runs (10099).
 * Unchanged: slash_command/delete/back/auto_swipe/swipe_picker sources bypass the
 * "generating" and "one swipe at a time" checks; MESSAGE_SWIPED is awaited, then
 * Generate('swipe') starts un-awaited only when !is_send_press; endSwipe awaits
 * the generation and reverts an out-of-range swipe_id to the last swipe.
 */
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function installFaithfulSwipe(h: any, options: { outMs?: number; inMs?: number } = {}) {
  const { host, sim } = h;
  let swipeState: 'none' | 'swiping' = 'none';
  let running: (() => void) | null = null;
  const animate = (ms = 0) => new Promise<void>(resolve => {
    if (!ms) { resolve(); return; }
    running?.();
    let timer: ReturnType<typeof setTimeout>;
    const done = () => { clearTimeout(timer); if (running === done) running = null; resolve(); };
    timer = setTimeout(done, ms);
    running = done;
  });
  const sync = (message: any, id: number) => {
    message.swipe_id = id;
    message.mes = message.swipes[id];
    message.extra = structuredClone(message.swipe_info?.[id]?.extra ?? {});
  };
  const syncMesToSwipe = (message: any) => {
    if (typeof message.swipe_id !== 'number' || !Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) return;
    if (typeof message.swipes[message.swipe_id] !== 'string' || !message.swipe_info[message.swipe_id]) return;
    message.swipes[message.swipe_id] = message.mes;
    message.swipe_info[message.swipe_id] = { ...message.swipe_info[message.swipe_id], extra: structuredClone(message.extra ?? {}) };
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
    let generation: Promise<void> | null = null;
    const endSwipe = async () => {
      if (generation) { try { await generation; } catch (e) { sim.log.push(`swipe generation failed ${(e as Error).message}`); } }
      const clamped = Math.max(0, Math.min(message.swipe_id, message.swipes.length - 1));
      if (message.swipe_id !== clamped) { sync(message, clamped); sim.log.push(`swipe reverted to ${clamped}`); }
      swipeState = 'none';
    };
    const original = Number(message.swipe_id ?? 0);
    let next = Number(o.forceSwipeId ?? original);
    const show = async () => { await animate(options.outMs); await host.emit('MESSAGE_SWIPED', mesId); await animate(options.inMs); await endSwipe(); };
    if (o.source === 'delete' || o.source === 'back') { sync(message, next); await show(); return; }
    syncMesToSwipe(message);
    if (direction === 'left') {
      if (o.forceSwipeId == null) next--;
      if (next < 0) next = message.swipes.length - 1;
      sync(message, next); await show(); return;
    }
    if (o.forceSwipeId == null) next++;
    if (next < message.swipes.length) { sync(message, next); await show(); return; }
    message.swipe_id = message.swipes.length;
    sim.log.push(`overswipe to ${message.swipe_id}`);
    await animate(options.outMs);
    await host.emit('MESSAGE_SWIPED', mesId);
    if (!sim.sendPress) {
      sim.sendPress = true;
      const pending = sim.generate('swipe') as Promise<void>;
      generation = pending;
      sim.pendingGenerations.push(pending.catch(() => {}));
    }
    await animate(options.inMs);
    await endSwipe();
  };
  host.context.swipe = { right: (e: unknown, o: Record<string, unknown>) => swipeTo(e, 'right', o), to: swipeTo, state: () => swipeState };
  sim.swipeRight = () => swipeTo(null, 'right', {});
  sim.swipeLeft = () => swipeTo(null, 'left', {});
  return { state: () => swipeState, wait };
}
