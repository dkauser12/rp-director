import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/host.ts';
import { normalizeBaseSettings } from '../../src/migration.ts';
import { normalizeUiPreferences } from '../../src/ui-preferences.ts';
import { Controller } from '../../src/controller.ts';
import { TestHost, choice, noul } from './support/test-host.ts';
import type { EvaluationResult } from '../../src/types.ts';

test('phase 2: settings retire the strip, default badges on, and preserve saved preferences', () => {
  const defaults = defaultSettings();
  const saved = normalizeBaseSettings(defaults, { showBar: false, inspectorOpen: true, showBadges: false,
    pacingTexts: { combat: 'One exchange.', downtime: '' }, replyCheckThresholds: { repeats: 2.5 } });
  assert.equal(saved.showBadges, false);
  assert.equal(Object.hasOwn(saved, 'showBar'), false);
  assert.equal(Object.hasOwn(saved, 'inspectorOpen'), false);
  assert.equal(saved.pacingTexts.combat, 'One exchange.');
  assert.equal(saved.pacingTexts.downtime, '');
  assert.equal(saved.replyCheckThresholds.repeats, 2.5);
  assert.equal(normalizeBaseSettings(defaults, { showBar: false }).showBadges, true);
  assert.deepEqual(normalizeBaseSettings(defaults, saved), saved);
  saved.pacingTexts.combat = 'Changed.';
  assert.notEqual(defaults.pacingTexts.combat, saved.pacingTexts.combat);
});

test('phase 2: imported reply-check scores stay within their scales and reject non-finite values', () => {
  const result = normalizeUiPreferences({ pacingTexts: { combat: 9 }, replyCheckThresholds: { speaksForUser: Infinity, followsRuling: 7, responds: -2, repeats: NaN } });
  assert.deepEqual(result.replyCheckThresholds, { speaksForUser: 2.85, followsRuling: 1, responds: 0, repeats: 3 });
  assert.equal(typeof result.pacingTexts.combat, 'string');
});

test('phase 2: a late connection test verifies only the connection that sent it', async () => {
  const host = new TestHost();
  const controller = new Controller(host);
  await controller.init();
  const provider = controller.provider();
  controller.settings.connection.kind = 'openrouter';
  controller.settings.connection.model = 'example/first';
  const originalConnection = JSON.stringify(controller.settings.connection);
  let finish!: (result: EvaluationResult) => void;
  controller.provider = () => ({ ...provider, kind: 'structured', evaluate: () => new Promise(resolve => { finish = resolve; }) });
  const pending = controller.testTable({ outcomes: controller.profile.outcomes, bands: controller.profile.bands }, 'threshold');
  controller.settings.connection.model = 'example/second';
  finish({ requestId: 'test', provider: 'structured', requestedModel: 'example/first', returnedModel: 'example/first',
    answers: { table_signal: noul(0.5), table_outcome: choice(controller.profile.outcomes[0]!.name), table_band: choice(controller.profile.bands[0]!.id) },
    unresolvedQuestionIds: [], errors: {}, durationMs: 2, inputTokens: null, outputTokens: null, transportAttempts: 1 });
  await pending;
  assert.equal(controller.lastWorkingConnection, originalConnection);
  assert.notEqual(controller.lastWorkingConnection, JSON.stringify(controller.settings.connection));
});
