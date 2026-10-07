/**
 * Phase 3d, item 19 (housekeeping):
 * - a failed import of SillyTavern's extensions.js is logged, because Dynamic
 *   Response is then treated as absent (no hand-back tag line);
 * - the reply check publishes the rewrite's values before its swipe (item 10 of
 *   phase 3c); when that swipe never reaches Generate, the preview must not
 *   outlive the dispatch, or readers report a generation that never ran.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Host } from '../../src/host.ts';
import { rc, score, until } from './support/phase3c-replycheck.ts';

test('phase3d: a failed extensions.js import logs that Dynamic Response is treated as absent', async t => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  // In Node the host modules do not exist next to the source, so every import fails.
  await new Host().loadFlags();
  assert.ok(warnings.some(text => text.includes('extensions.js') && text.includes('Dynamic Response is treated as absent')), warnings.join(' | '));
});

test('phase3d: a rewrite whose swipe never dispatched leaves no reader preview behind', async t => {
  const h = await rc({ answers: request => ('speaks_for_user' in request.questions ? { speaks_for_user: score(4) } : {}) });
  t.after(() => h.controller.destroy());
  let dispatched = 0;
  h.host.swipeRight = async () => { dispatched++; throw new Error('native swipe rejected'); };
  await h.sim.clickSend('I ask the guide to open the gate.');
  await until(() => h.host.notices.some((notice: string) => notice.includes('rewrite could not start')), 'the rewrite failed to start');
  await h.sim.settle();
  assert.equal(dispatched, 1, 'sanity: the check tried to dispatch its rewrite');
  assert.equal(h.controller.macroUpcomingAttemptId, null, 'the preview is cleared with the dispatch');
  assert.equal(h.controller.getMacro('active'), '', 'readers are empty outside a generation');
  assert.equal(h.controller.getMacro('outcome'), '');
});
