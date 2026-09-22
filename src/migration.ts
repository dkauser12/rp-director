/** One-time consolidation and reload recovery. These helpers never touch the host. */
import type { DirectorChatRecord, DirectorSettings } from './types.ts';
import { canonicalProfileId, LEGACY_PROFILE_IDS } from './profiles.ts';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Existing base settings are authoritative; Auto settings are deliberately not an input. */
export function normalizeBaseSettings(defaults: DirectorSettings, existing: unknown): DirectorSettings {
  const saved = object(existing) ?? {};
  const result = structuredClone({
    ...defaults,
    ...saved,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    profileId: canonicalProfileId(typeof saved.profileId === 'string' ? saved.profileId : defaults.profileId),
    bindingConfirmedAt: typeof saved.bindingConfirmedAt === 'string' || saved.bindingConfirmedAt === null ? saved.bindingConfirmedAt : defaults.bindingConfirmedAt,
    connection: { ...defaults.connection, ...(object(saved.connection) ?? {}) },
    observerConnection: { ...defaults.observerConnection, ...(object(saved.observerConnection) ?? {}) },
    showBar: typeof saved.showBar === 'boolean' ? saved.showBar : defaults.showBar,
    inspectorOpen: typeof saved.inspectorOpen === 'boolean' ? saved.inspectorOpen : defaults.inspectorOpen,
    profileOverrides: { ...defaults.profileOverrides, ...(object(saved.profileOverrides) ?? {}) },
  }) as DirectorSettings;
  for (const [legacy, current] of Object.entries(LEGACY_PROFILE_IDS)) {
    if (result.profileOverrides[legacy]) {
      if (!result.profileOverrides[current]) result.profileOverrides[current] = result.profileOverrides[legacy];
      delete result.profileOverrides[legacy];
    }
  }
  return result;
}

/**
 * A browser reload cannot resume an old observer promise. Historical accepted
 * checkpoints stay authoritative; only uncommitted replies become retryable.
 * Call after normalizeRecord and only when loading a chat, never while live
 * observation work is still running.
 */
export function recoverInterruptedObservations(input: DirectorChatRecord): { record: DirectorChatRecord; recoveredVariantIds: string[] } {
  const record = structuredClone(input);
  const recoveredVariantIds: string[] = [];
  for (const variant of Object.values(record.variants)) {
    if (variant.acceptance !== 'pending') continue;
    const attempt = record.attempts[variant.attemptId];
    if (!attempt || attempt.variantId !== variant.variantId || attempt.status === 'accepted') continue;
    // A completed observation is usable after reload and must not be rerun.
    if (variant.observerStatus === 'ready' && variant.observation) continue;
    const legacy = variant.observerStatus === undefined || variant.observerStatus === 'not_required';
    const interrupted = variant.observerStatus === 'pending' || attempt.status === 'observing';
    if (!legacy && !interrupted) continue;
    const reason = legacy
      ? 'This reply predates post-reply observation. Retry observation before continuing.'
      : 'Post-reply observation was interrupted by a reload. Retry observation before continuing.';
    variant.observerStatus = 'failed';
    variant.observerError = reason;
    variant.observation = null;
    attempt.status = 'stale';
    recoveredVariantIds.push(variant.variantId);
    if (record.projection.cursor === variant.cursorAfter) {
      const predecessor = variant.cursorBefore ? record.checkpoints[variant.cursorBefore] : undefined;
      record.projection = {
        cursor: variant.cursorAfter,
        state: structuredClone(predecessor?.stateAfter ?? record.projection.state),
        status: 'stale',
        reason,
      };
    }
  }
  return { record, recoveredVariantIds };
}

export interface MarkerCarrier {
  extra?: Record<string, unknown>;
  swipe_info?: { extra?: Record<string, unknown> }[];
}

/**
 * Import an Auto-only history as a whole, preserving Auto data for rollback.
 * Two existing histories are never merged. Marker keys do not participate in
 * transcript fingerprints, so copying them leaves all stored cursors intact.
 */
export function migrateAutoHistory<T extends MarkerCarrier>(
  metadata: Record<string, unknown>,
  messages: T[],
): { metadata: Record<string, unknown>; messages: T[]; migrated: boolean } {
  if (Object.prototype.hasOwnProperty.call(metadata, 'rpDirector')) return { metadata, messages, migrated: false };
  const auto = object(metadata.rpDirectorAuto);
  if (!auto || auto.schemaVersion !== 1) return { metadata, messages, migrated: false };
  const variants = object(auto.variants) ?? {};
  const attempts = object(auto.attempts) ?? {};
  const migratedMessages = structuredClone(messages);
  const copyMarker = (container: { extra?: Record<string, unknown> }): void => {
    const marker = object(container.extra?.rpda);
    if (!marker || typeof marker.v !== 'string' || typeof marker.a !== 'string') return;
    const variant = object(variants[marker.v]);
    const attempt = object(attempts[marker.a]);
    if (!variant || !attempt || variant.attemptId !== marker.a || attempt.variantId !== marker.v) return;
    container.extra = { ...(container.extra ?? {}), rpd: structuredClone(marker) };
  };
  for (const message of migratedMessages) {
    copyMarker(message);
    for (const swipe of message.swipe_info ?? []) if (swipe) copyMarker(swipe);
  }
  return {
    metadata: { ...metadata, rpDirector: structuredClone(auto) },
    messages: migratedMessages,
    migrated: true,
  };
}
