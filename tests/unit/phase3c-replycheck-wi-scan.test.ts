/**
 * The correction is spliced into the interceptor's `chat` (controller.ts 1582-1586).
 * SillyTavern builds the World Info scan buffer from that same array after the
 * interceptors run (script.js 4564 -> 4624: chatForWI = coreChat.map(...);
 * getWorldInfoPrompt(chatForWI, ...)). So words that exist only in the
 * correction ("consent", "thoughts", "feelings", "decisions", "time", the
 * persona name...) can activate keyword entries on the rewrite only. Those
 * entries land wherever the book puts them (before the chat for ↑Char/↓Char),
 * so the rewrite's prompt differs from the original's well above the last user
 * message: more than the correction, and a writer-cache miss.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('the correction does not enter the World Info scan buffer', async () => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  const seen: { type: string; scan: string }[] = [];
  const interceptor = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (chat: any[], size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    // script.js 4624, world_info_include_names off; default scan depth 2.
    const chatForWI = chat.map(x => x.mes).reverse();
    seen.push({ type, scan: chatForWI.slice(0, 2).join('\n') });
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => seen.some(entry => entry.type === 'swipe'), 'the automatic rewrite');
  await h.sim.settle();
  const [original, rewrite] = seen;
  console.log(rewrite!.scan);
  const keyword = /\bconsent\b/i; // a plausible lorebook key in adult RP books
  assert.doesNotMatch(original!.scan, keyword);
  assert.doesNotMatch(rewrite!.scan, keyword, 'a keyword only the correction contains cannot activate lore on the rewrite');
});
