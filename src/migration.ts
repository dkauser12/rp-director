/** One-time consolidation and reload recovery. These helpers never touch the host. */
import type { DirectorSettings } from './types.ts';
import { canonicalProfileId, LEGACY_PROFILE_IDS } from './profiles.ts';
import { normalizeReactionSettings } from './npc-reaction.ts';
import { normalizeLoreSettings } from './lore/settings.ts';
import { normalizeUiPreferences } from './ui-preferences.ts';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Existing base settings are authoritative; Auto settings are deliberately not an input. */
export function normalizeBaseSettings(defaults: DirectorSettings, existing: unknown): DirectorSettings {
  const saved = object(existing) ?? {};
  const result = structuredClone({
    ...defaults,
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : defaults.enabled,
    askWhenSwiping: typeof saved.askWhenSwiping === 'boolean' ? saved.askWhenSwiping : defaults.askWhenSwiping,
    reviewNpcRolls: typeof saved.reviewNpcRolls === 'boolean' ? saved.reviewNpcRolls : defaults.reviewNpcRolls,
    profileId: canonicalProfileId(typeof saved.profileId === 'string' ? saved.profileId : defaults.profileId),
    connection: { ...defaults.connection, ...(object(saved.connection) ?? {}) },
    reactions: normalizeReactionSettings(saved.reactions),
    showBadges: typeof saved.showBadges === 'boolean' ? saved.showBadges : defaults.showBadges,
    ...normalizeUiPreferences(saved),
    profileOverrides: { ...defaults.profileOverrides, ...(object(saved.profileOverrides) ?? {}) },
    // Revision 3 removes the legacy pipeline and its state machine permanently.
    pipeline: 'staged',
    settingsRevision: 3,
    waitForJudgeSeconds: typeof saved.waitForJudgeSeconds === 'number' && Number.isFinite(saved.waitForJudgeSeconds) && saved.waitForJudgeSeconds >= 0
      ? Math.max(2, Math.min(saved.waitForJudgeSeconds, 120)) : defaults.waitForJudgeSeconds,
    modules: {
      replyCheck: typeof object(saved.modules)?.replyCheck === 'boolean' ? object(saved.modules)!.replyCheck as boolean
        : object(saved.modules) && ['speaker', 'decisions', 'meters', 'secrets'].every(key => object(saved.modules)![key] === false) && object(saved.modules)!.lore !== true ? false : true,
      speaker: typeof object(saved.modules)?.speaker === 'boolean' ? object(saved.modules)!.speaker as boolean : defaults.modules.speaker,
      decisions: typeof object(saved.modules)?.decisions === 'boolean' ? object(saved.modules)!.decisions as boolean : defaults.modules.decisions,
      meters: typeof object(saved.modules)?.meters === 'boolean' ? object(saved.modules)!.meters as boolean : defaults.modules.meters,
      secrets: typeof object(saved.modules)?.secrets === 'boolean' ? object(saved.modules)!.secrets as boolean : defaults.modules.secrets,
      pacing: typeof object(saved.modules)?.pacing === 'boolean' ? object(saved.modules)!.pacing as boolean
        : object(saved.modules) && (['speaker', 'decisions', 'meters', 'secrets'] as const).every(key => object(saved.modules)![key] === false) && object(saved.modules)!.lore !== true ? false
        : defaults.modules.pacing ?? true,
      // Lore arrived after the other suites: off for anyone who had switched them all off.
      lore: typeof object(saved.modules)?.lore === 'boolean' ? object(saved.modules)!.lore as boolean
        : object(saved.modules) && (['speaker', 'decisions', 'meters', 'secrets'] as const).every(key => object(saved.modules)![key] === false) ? false
        : defaults.modules.lore,
    },
    lore: normalizeLoreSettings(saved.lore),
  }) as DirectorSettings;
  if (result.connection.kind === 'mock') result.connection = { ...defaults.connection, kind: 'openrouter' };
  for (const [legacy, current] of Object.entries(LEGACY_PROFILE_IDS)) {
    if (result.profileOverrides[legacy]) {
      if (!result.profileOverrides[current]) result.profileOverrides[current] = result.profileOverrides[legacy];
      delete result.profileOverrides[legacy];
    }
  }
  return result;
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
