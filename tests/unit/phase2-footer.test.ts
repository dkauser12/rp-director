import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripChatResultFooters, stripResultFooter } from '../../src/result-footer.ts';
import { Controller } from '../../src/controller.ts';
import { actorIdFor, prefixCursor } from '../../src/identity.ts';
import { WORKFLOW_BADGE_KEY } from '../../src/workflow-badge.ts';
import type { DirectorChatRecord } from '../../src/types.ts';
import { TestHost, choice, noul, scriptJudge, writerReplies } from './support/test-host.ts';

const FOOTER = '[RP_DIRECTOR]\n{"status":"no_ruling","results":[]}\n[/RP_DIRECTOR]';

test('U4 strips only reserved standalone one-line footer blocks without changing other prose', () => {
  for (const text of [`A character quotes ${FOOTER}`, ` ${FOOTER}`, '[RP_DIRECTOR] is a tag.',
    '[RP_DIRECTOR]\n{\n"status":"no_ruling"\n}\n[/RP_DIRECTOR]', '  Actual prose  ']) assert.equal(stripResultFooter(text), text);
  assert.equal(stripResultFooter(`First.\n\n${FOOTER}\n\nContinued prose.`), 'First.\n\nContinued prose.');
  assert.equal(stripResultFooter(`First.\r\n\r\n${FOOTER.replaceAll('\n', '\r\n')}\r\nSecond.`), 'First.\r\nSecond.');
  assert.equal(stripResultFooter(`${FOOTER}\n\n${FOOTER}`), '');
});

test('U4 migration includes unselected swipes, display text and separate per-swipe extras', () => {
  const messages = [{ mes: `Reply one.\n\n${FOOTER}`, display_text: `Shown reply.\n\n${FOOTER}`,
    swipes: [`Reply one.\n\n${FOOTER}`, `Reply two.\n\n${FOOTER}`],
    extra: { display_text: `Shown reply.\n\n${FOOTER}`, unrelated: 'keep' },
    swipe_info: [{ extra: { display_text: `First display.\n\n${FOOTER}`, other: true } }, { extra: { display_text: `Second display.\n\n${FOOTER}` } }] }];
  const result = stripChatResultFooters(messages);
  assert.deepEqual(result, { messages: 1, copies: 7, changedMessageIds: [0] });
  assert.equal(messages[0]!.mes, 'Reply one.');
  assert.equal(messages[0]!.display_text, 'Shown reply.');
  assert.deepEqual(messages[0]!.swipes, ['Reply one.', 'Reply two.']);
  assert.deepEqual(messages[0]!.extra, { display_text: 'Shown reply.', unrelated: 'keep' });
  assert.deepEqual(messages[0]!.swipe_info, [{ extra: { display_text: 'First display.', other: true } }, { extra: { display_text: 'Second display.' } }]);
  assert.deepEqual(stripChatResultFooters(messages), { messages: 0, copies: 0, changedMessageIds: [] });
});

for (const enabled of [false, true]) test(`U4 chat load saves cleanup and Activity together once with Enabled ${enabled}`, async t => {
  const host = new TestHost();
  let saves = 0;
  host.context.saveMetadata = async () => { saves++; };
  host.context.saveChat = async () => assert.fail('cleanup must use the single metadata/chat save');
  host.context.chat[1]!.mes += `\n\n${FOOTER}`;
  host.context.chat[1]!.swipes![0] += `\n\n${FOOTER}`;
  const before = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat()));
  const controller = new Controller(host);
  t.after(() => controller.destroy());
  controller.settings.enabled = enabled;
  host.context.updateMessageBlock = id => { void host.emit('CHARACTER_MESSAGE_RENDERED', id); };
  await controller.init();
  assert.equal(saves, 1);
  assert.equal(prefixCursor(host.seedId(), host.fingerprintMessages(host.chat())), before, 'cleanup cannot change the frozen transcript identity');
  assert.doesNotMatch(host.context.chat[1]!.mes, /RP_DIRECTOR/);
  const saved = host.context.chatMetadata.rpDirector as DirectorChatRecord;
  assert.equal(saved.inspector.filter(entry => entry.message.includes('footer')).length, 1);
  assert.match(saved.inspector.at(-1)!.message, /Removed 2 old Director footer copies from 1 message/);
  await controller.loadChat();
  assert.equal((host.context.chatMetadata.rpDirector as DirectorChatRecord).inspector.filter(entry => entry.message.includes('footer')).length, 1);
  if (!enabled) assert.equal(saves, 1, 'disabled reload has no second cleanup save');
});

test('U4 footer cleanup retains the original ruling and swipe choice without judge requests or a new draw', async t => {
  const host = new TestHost();
  const controller = new Controller(host);
  t.after(() => controller.destroy());
  await controller.init();
  controller.settings.modules = { speaker: false, decisions: true, meters: false, secrets: false, lore: false };
  controller.settings.reactions.enabled = false;
  controller.settings.askWhenSwiping = true;
  await controller.setChatPack('default');
  scriptJudge(controller, { move: choice('s1'), move_count: choice('one'), owner: choice('player'), target: choice(actorIdFor('Guide', 'guide.png')),
    family: choice('influence_negotiate'), action_specification: choice('SPECIFIED_HERE'), antecedent: choice('NONE'), ruling: noul(0.45) });
  writerReplies(host, controller, 'Guide', 'guide.png', 'The guide opens the gate.');
  host.composerValue = 'Open the gate for me.';
  await controller.directorSend();
  const reply = host.chat().at(-1)!;
  assert.equal(reply.mes, 'The guide opens the gate.', 'new replies never get a text footer');
  assert.ok(reply.extra?.[WORKFLOW_BADGE_KEY]);
  const frozen = structuredClone(Object.values(controller.record!.resolutions));
  reply.mes += `\n\n${FOOTER}`;
  reply.swipes![0] = reply.mes;
  const prefix = prefixCursor(host.seedId(), host.fingerprintMessages(host.chat()));
  await controller.loadChat();
  assert.equal(prefixCursor(host.seedId(), host.fingerprintMessages(host.chat())), prefix);
  let choices = 0;
  host.swipeResult = async () => { choices++; return 'reuse'; };
  const requests = scriptJudge(controller, {});
  reply.swipe_id = reply.swipes!.length;
  await host.emit('MESSAGE_SWIPED', host.chat().length - 1);
  await controller.interceptor([], 4096, () => assert.fail('swipe unexpectedly aborted'), 'swipe');
  assert.equal(choices, 1);
  assert.equal(requests.length, 0);
  assert.deepEqual(Object.values(controller.record!.resolutions), frozen);
});
