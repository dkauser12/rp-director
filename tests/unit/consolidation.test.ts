import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateAutoHistory, normalizeBaseSettings, recoverInterruptedObservations } from '../../src/migration.ts';
import { applyEvent, emptyState, newRecord, normalizeRecord } from '../../src/state.ts';
import { defaultSettings, Host } from '../../src/host.ts';
import type { HostChatMessage, StContext } from '../../src/host.ts';
import { freeze } from '../../src/resolver.ts';
import type { ActionSpec, DirectorChatRecord, ObservationRecord } from '../../src/types.ts';

function oldReply(observerRequired = false): DirectorChatRecord {
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
    { type: 'set_baseline', cursor: 'before', state: emptyState(), reason: 'fixture' },
    { type: 'prepare', resolution, action, attemptId: 'attempt', actorId: 'npc', epoch: 1, composerText: '', now: 1 },
    { type: 'bind', attemptId: 'attempt', cursorBefore: 'before', epoch: 1, injectedText: 'binding' },
    { type: 'completed', attemptId: 'attempt', epoch: 1, operationId: 'complete', variantId: 'variant', hostMessageRef: 0, hostVariantRef: 0, cursorAfter: 'after', now: 2, observerRequired },
  ] satisfies Parameters<typeof applyEvent>[1][]) record = applyEvent(record, event).record;
  if (!observerRequired) {
    delete record.variants.variant!.observerStatus;
    delete record.variants.variant!.observation;
    delete record.variants.variant!.observerError;
  }
  return record;
}

function observation(): ObservationRecord {
  return {
    schemaVersion: 1, requestId: 'request', attemptId: 'attempt', variantId: 'variant', baseCursor: 'before', cursorAfter: 'after', stateRevision: 0,
    realizedResolutionIds: ['resolution'], operations: [{ operationId: 'observed-time', op: 'advance_time', seconds: 20, quality: 'estimated' }],
    unresolved: [], providerKind: 'mock', requestedModel: null, returnedModel: null, durationMs: 0, inputTokens: null, outputTokens: null,
  };
}

test('accepted legacy base history remains exact across migration, reload, and saved swipe restore', () => {
  const legacy = applyEvent(oldReply(), { type: 'accept', attemptId: 'attempt', operationId: 'legacy-accept', now: 3 }).record;
  const original = structuredClone(legacy);
  const recovered = recoverInterruptedObservations(normalizeRecord(legacy, 'seed', 'p1'));
  assert.deepEqual(recovered.recoveredVariantIds, []);
  assert.deepEqual(recovered.record, original);
  const selected = applyEvent(recovered.record, { type: 'select_variant', variantId: 'variant', cursorAfter: 'after', chain: ['before', 'after'] }).record;
  const reloaded = applyEvent(selected, { type: 'head_changed', cursor: 'after', chain: ['before', 'after'], reason: 'load' }).record;
  assert.deepEqual(reloaded, original);
  assert.equal(reloaded.projection.state.revision, 1);
  assert.equal(reloaded.projection.state.variables.key, 'secured');
});

test('legacy pending reply becomes retryable and only observation can commit its effects once', () => {
  const legacy = oldReply();
  const original = structuredClone(legacy);
  const recovered = recoverInterruptedObservations(normalizeRecord(legacy, 'seed', 'p1'));
  assert.deepEqual(legacy, original, 'migration does not mutate its input');
  assert.deepEqual(recovered.recoveredVariantIds, ['variant']);
  assert.equal(recovered.record.variants.variant!.observerStatus, 'failed');
  assert.equal(recovered.record.attempts.attempt!.status, 'stale');
  assert.match(recovered.record.projection.reason ?? '', /predates.*Retry observation/);
  assert.deepEqual(recovered.record.checkpoints, legacy.checkpoints);
  let record = applyEvent(recovered.record, { type: 'retry_observation', attemptId: 'attempt', variantId: 'variant' }).record;
  assert.equal(record.attempts.attempt!.status, 'observing');
  assert.equal(record.projection.state.variables.key, undefined);
  record = applyEvent(record, { type: 'observation_ready', attemptId: 'attempt', variantId: 'variant', observation: observation() }).record;
  assert.equal(record.projection.state.variables.key, undefined);
  record = applyEvent(record, { type: 'commit_observation', variantId: 'variant', operationId: 'commit', now: 4 }).record;
  const duplicate = applyEvent(record, { type: 'commit_observation', variantId: 'variant', operationId: 'commit', now: 5 }).record;
  assert.equal(record.projection.state.variables.key, 'secured');
  assert.equal(record.projection.state.elapsedSeconds, 20);
  assert.equal(record.projection.state.revision, 1);
  assert.deepEqual(record, duplicate);
});

test('reloaded in-flight observer is retryable and recovery is idempotent', () => {
  const interrupted = oldReply(true);
  const recovered = recoverInterruptedObservations(interrupted);
  assert.deepEqual(recovered.recoveredVariantIds, ['variant']);
  assert.equal(recovered.record.attempts.attempt!.status, 'stale');
  assert.equal(recovered.record.variants.variant!.observerStatus, 'failed');
  assert.match(recovered.record.variants.variant!.observerError ?? '', /interrupted by a reload/);
  const again = recoverInterruptedObservations(recovered.record);
  assert.deepEqual(again.recoveredVariantIds, []);
  assert.deepEqual(again.record, recovered.record);
  const retry = applyEvent(again.record, { type: 'retry_observation', attemptId: 'attempt', variantId: 'variant' }).record;
  const ready = applyEvent(retry, { type: 'observation_ready', attemptId: 'attempt', variantId: 'variant', observation: observation() }).record;
  assert.equal(ready.variants.variant!.observerStatus, 'ready');
  assert.deepEqual(recoverInterruptedObservations(ready).record, ready, 'ready observation survives reload without another request');
});

test('base settings preserve existing private policy and connection while filling observer defaults', () => {
  const defaults = defaultSettings();
  const privateTable = { ...defaults.profileOverrides, [defaults.profileId]: { resolutionMethod: 'sample' as const, outcomes: [{ name: 'private_result', instruction: 'private policy', records: '', final: false }] } };
  const existing = { enabled: false, profileId: defaults.profileId, bindingConfirmedAt: 'saved', connection: { kind: 'openrouter' as const, model: '~typesafe/jev-latest' }, profileOverrides: privateTable };
  const before = structuredClone(existing);
  const sibling = { ...defaultSettings(), connection: { ...defaults.connection, kind: 'mock' as const }, observerConnection: { stProfileId: 'auto-only-sidecar' }, profileOverrides: {} };
  const settings = { rpDirector: existing, rpDirectorAuto: sibling };
  const normalized = normalizeBaseSettings(defaults, settings.rpDirector);
  assert.deepEqual(existing, before);
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.connection.kind, 'openrouter');
  assert.equal(normalized.connection.model, '~typesafe/jev-latest');
  assert.equal(normalized.observerConnection.stProfileId, '');
  assert.deepEqual(normalized.profileOverrides, privateTable);
  assert.notEqual(normalized.profileOverrides, privateTable);
  assert.deepEqual(normalizeBaseSettings(defaults, undefined), defaults, 'first use does not import Auto settings');
});

test('Auto-only metadata migrates all valid swipe markers once without changing either source history or transcript', () => {
  const auto = oldReply(true);
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
  const auto = oldReply(true);
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
