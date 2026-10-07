import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateAutoHistory, normalizeBaseSettings } from '../../src/migration.ts';
import { applyEvent, newRecord, normalizeRecord } from '../../src/state.ts';
import { defaultSettings, Host } from '../../src/host.ts';
import type { HostChatMessage, StContext } from '../../src/host.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, DirectorChatRecord } from '../../src/types.ts';

function oldReply(): DirectorChatRecord {
  const action: ActionSpec = {
    actionId: 'action', templateId: 'acquire_secure', playerActorId: 'player', actingActorId: 'player', targetActorIds: [],
    attemptedAction: 'takes the key', requestedGain: 'the key is secured', applicability: 'favorable', preconditions: [],
    effectsByOutcome: { deferred: [], progress_only: [], achieved: [{ op: 'set_enum', variableId: 'key', value: 'secured' }] },
  };
  const resolution = freeze({
    resolutionId: 'resolution', previousResolutionId: null, action,
    snapshot: { chatId: 'chat', cursorBefore: 'before', stateRevision: 0, scopeId: 'shared-public', profileRevision: 'p1', catalogRevision: '', actorBindingRevision: '', state: {} },
    assessment: { type: 'noul', noul: 1, confidence: null, provenance: 'fixture' }, decisionSource: 'provider', policyRevision: 'p1',
    band: null, method: 'threshold', draw: null, outcome: 'achieved', cursorBefore: null, generation: 1,
    providerKind: 'mock', requestedModel: null, returnedModel: null, now: 1,
  });
  let record = newRecord('seed', 'p1');
  for (const event of [
    { type: 'prepare', resolution, action, attemptId: 'attempt', actorId: 'npc', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'attempt', cursorBefore: 'before', epoch: 1, injectedText: 'binding' },
    { type: 'completed', attemptId: 'attempt', epoch: 1, operationId: 'complete', variantId: 'variant', hostMessageRef: 0, hostVariantRef: 0, cursorAfter: 'after', now: 2 },
  ] satisfies Parameters<typeof applyEvent>[1][]) record = applyEvent(record, event).record;
  return record;
}

test('W6: 0.7 pending observer records load without repair and retain frozen turns and story', () => {
  const legacy = {
    ...oldReply(),
    projection: { cursor: 'after', state: { sceneId: 7 }, status: 'stale', reason: 'observer failed' },
    checkpoints: { before: { stateAfter: { variables: { key: 'secured' } } } },
  };
  (legacy.attempts.attempt! as unknown as Record<string, unknown>).status = 'observing';
  const variant = legacy.variants.variant! as unknown as Record<string, unknown>;
  variant.acceptance = 'pending'; variant.observerStatus = 'failed'; variant.observerError = 'connection unavailable'; variant.observation = { operations: [] };
  legacy.story = {
    packId: 'adventure', packSource: 'user', secrets: [{ id: 'key', text: 'Hidden key', holders: ['npc'] }],
    history: { before: { at: 1, meters: { npc: { resolve: 2 } }, knownBy: { key: ['npc'] } } },
    lore: { before: { at: 1, refs: [{ world: 'Keep', uid: 1, title: 'Gate', score: 0.8 }], requests: 1, books: ['Keep'], failed: [] } },
  };
  const before = structuredClone(legacy);
  const loaded = normalizeRecord(legacy, 'seed', 'p1');
  assert.deepEqual(legacy, before, 'normalization never mutates the saved input');
  assert.deepEqual(loaded.story, legacy.story);
  assert.deepEqual(loaded.resolutions, legacy.resolutions);
  assert.deepEqual(loaded.permits, legacy.permits);
  assert.equal(loaded.attempts.attempt!.status, 'accepted');
  assert.equal('acceptance' in loaded.variants.variant!, false);
  assert.equal(loaded.attempts.attempt!.injectedText, 'binding');
  for (const key of ['projection', 'checkpoints']) assert.equal(key in loaded, false);
  for (const key of ['observerStatus', 'observerError', 'observation']) assert.equal(key in loaded.variants.variant!, false);
  assert.deepEqual(normalizeRecord(loaded, 'seed', 'p1'), loaded, 'migration is idempotent');
});

test('revision 3 retains private policy, connections, reaction weights and module choices, dropping removed fields', () => {
  const defaults = defaultSettings();
  const privateTable = { [defaults.profileId]: { resolutionMethod: 'sample' as const, outcomes: [{ name: 'private_result', instruction: 'private policy', records: '', final: false }] } };
  const existing = {
    enabled: false, profileId: defaults.profileId, bindingConfirmedAt: 'saved', observerConnection: { stProfileId: 'old-sidecar' },
    pipeline: 'legacy', settingsRevision: 2, connection: { kind: 'openrouter' as const, model: '~typesafe/jev-latest' },
    profileOverrides: privateTable, modules: { speaker: false, decisions: false, meters: false, secrets: false, lore: false },
    reactions: { ...defaults.reactions, enabled: false }, removedFutureLegacyField: true,
  };
  const before = structuredClone(existing);
  const normalized = normalizeBaseSettings(defaults, existing);
  assert.deepEqual(existing, before);
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.connection.kind, 'openrouter');
  assert.equal(normalized.connection.model, '~typesafe/jev-latest');
  assert.deepEqual(normalized.profileOverrides, privateTable);
  assert.notEqual(normalized.profileOverrides, privateTable);
  assert.deepEqual(normalized.modules, { ...existing.modules, pacing: false, replyCheck: false });
  assert.equal(normalized.reactions.enabled, false);
  assert.equal(normalized.pipeline, 'staged'); assert.equal(normalized.settingsRevision, 3);
  assert.equal(normalized.waitForJudgeSeconds, 10);
  for (const key of ['bindingConfirmedAt', 'observerConnection', 'removedFutureLegacyField']) assert.equal(key in normalized, false);
  assert.deepEqual(normalizeBaseSettings(defaults, normalized), normalized);
  assert.deepEqual(normalizeBaseSettings(defaults, undefined), defaults, 'first use does not import Auto settings');
});

test('Auto-only metadata migrates all valid swipe markers once without changing either source history or transcript', () => {
  const auto = oldReply();
  auto.attempts['other-attempt'] = { ...auto.attempts.attempt!, attemptId: 'other-attempt', variantId: 'other-variant', hostVariantRef: 1 };
  auto.variants['other-variant'] = { ...auto.variants.variant!, variantId: 'other-variant', attemptId: 'other-attempt', cursorAfter: 'other-cursor' };
  const metadata = { rpDirectorAuto: auto, otherExtension: { retained: true } };
  const marker = { v: 'variant', a: 'attempt', r: 'resolution' };
  const otherMarker = { v: 'other-variant', a: 'other-attempt', r: 'resolution' };
  const messages: HostChatMessage[] = [{ name: 'Guide', mes: 'The key is secured.', is_user: false, is_system: false, original_avatar: 'guide.png', swipe_id: 0, swipes: ['The key is secured.', 'I secure the key.'], extra: { rpda: marker, keep: true }, swipe_info: [{ extra: { rpda: marker } }, { extra: { rpda: otherMarker } }] }];
  const before = structuredClone({ metadata, messages });
  const migrated = migrateAutoHistory(metadata, messages);
  assert.equal(migrated.migrated, true);
  assert.deepEqual({ metadata, messages }, before);
  assert.deepEqual(migrated.metadata.rpDirector, auto);
  assert.notEqual(migrated.metadata.rpDirector, auto);
  assert.deepEqual(migrated.metadata.rpDirectorAuto, auto);
  assert.deepEqual(migrated.messages[0]!.extra!.rpd, marker);
  assert.deepEqual(migrated.messages[0]!.swipe_info![1]!.extra!.rpd, otherMarker);
  const host = new Host();
  assert.deepEqual(host.fingerprintMessages(migrated.messages), host.fingerprintMessages(messages));
  class MarkerHost extends Host {
    override ctx(): StContext { return { chat: migrated.messages } as StContext; }
  }
  assert.deepEqual(new MarkerHost().readMarker(0), marker, 'base Host sees the selected migrated marker');
  const second = migrateAutoHistory(migrated.metadata, migrated.messages);
  assert.equal(second.migrated, false);
  assert.deepEqual(second, { ...migrated, migrated: false });
});

test('existing base history always wins and invalid Auto markers cannot invent base links', () => {
  const base = oldReply();
  const auto = oldReply();
  const metadata = { rpDirector: base, rpDirectorAuto: auto };
  const messages: HostChatMessage[] = [{ name: 'Guide', mes: 'Reply', is_user: false, is_system: false, extra: { rpda: { v: 'unknown', a: 'attempt', r: null }, rpd: { v: 'base', a: 'base', r: null } } }];
  const untouched = migrateAutoHistory(metadata, messages);
  assert.equal(untouched.migrated, false);
  assert.equal(untouched.metadata, metadata);
  assert.equal(untouched.messages, messages);
  const autoOnly = migrateAutoHistory<HostChatMessage>({ rpDirectorAuto: auto }, [{ ...messages[0]!, extra: { rpda: { v: 'unknown', a: 'attempt', r: null } } }]);
  assert.equal(autoOnly.migrated, true);
  assert.equal(autoOnly.messages[0]!.extra!.rpd, undefined);
});
