/**
 * A Next turn (director_next: 0.7.x "Next" replies still in old chats, and the
 * public directorNext()/directorContinue()) has no user message of its own.
 * checkReply picks the latest user message anyway (controller.ts 1929-1931,
 * 1960), and withReplyCorrection appends the OOC note to it: above the previous
 * reply, not at the tail. The prompt then changes before the previous reply (a
 * writer-cache miss for it) and reads as if that reply had answered the OOC note.
 */
import { test } from 'node:test';
import { rc, score, until, assert } from './support/phase3c-replycheck.ts';

test('a Next turn\'s automatic rewrite only changes the prompt at its tail', async () => {
  let checks = 0;
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(++checks === 2 ? 4 : 0) } : {}) });
  const prompts: { type: string; chat: string[] }[] = [];
  const interceptor = h.controller.interceptor.bind(h.controller);
  h.controller.interceptor = async (chat: any[], size: number, abort: (i: boolean) => void, type: string) => {
    await interceptor(chat, size, abort, type);
    prompts.push({ type, chat: chat.map(m => String(m.mes)) });
  };
  await h.sim.clickSend('I nod. "Open the gate, please."');
  await until(() => h.checks().length === 1, 'first check');
  await h.sim.settle();
  // The character continues without new input.
  const next = h.controller.directorNext();
  await until(() => h.checks().length >= 2, 'the Next reply is checked');
  await next; await h.sim.settle();
  const original = prompts.filter(p => p.type === 'normal').at(-1)!;
  const rewrite = prompts.find(p => p.type === 'swipe');
  assert.ok(rewrite, 'the Next reply was rewritten automatically');
  console.log(rewrite!.chat.slice(-2));
  assert.deepEqual(rewrite!.chat.slice(0, -1), original.chat.slice(0, -1), 'nothing above the tail message changes');
});
