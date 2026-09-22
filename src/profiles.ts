/**
 * Built-in profiles. `binding` mirrors profiles/binding.json and `advisory`
 * mirrors profiles/advisory.json (a unit test keeps the policy table in sync).
 * Profiles are data: no scripts, no expressions, no endpoints, no secrets.
 *
 *   binding       the judge's score picks the outcome directly (threshold)
 *   binding-dice  the judge's score sets the odds; one recorded roll decides
 *   advisory      the judge's score is only a hint to the writer
 */
import type { DirectorProfile, DirectorSettings, PolicyBand } from './types.ts';
import { DEFAULT_OUTCOMES, normalizeOutcome, validateTable } from './table.ts';

export const DEFAULT_PROFILE_ID = 'binding';

/** Ids used by earlier builds and by the handoff bundle; still accepted everywhere. */
export const LEGACY_PROFILE_IDS: Record<string, string> = {
  'proofdie-poc': 'binding',
  'proofdie-sample': 'binding-dice',
};

export function canonicalProfileId(id: string | null | undefined): string {
  const key = String(id ?? '');
  return LEGACY_PROFILE_IDS[key] ?? key;
}

export const DEFAULT_BANDS: PolicyBand[] = [
  { id: 'b0', lowerInclusive: 0.0, upper: 0.25, upperInclusive: false, thresholdOutcome: 'deferred', sampleWeights: { deferred: 0.9, progress_only: 0.1, achieved: 0.0 } },
  { id: 'b1', lowerInclusive: 0.25, upper: 0.5, upperInclusive: false, thresholdOutcome: 'deferred', sampleWeights: { deferred: 0.7, progress_only: 0.25, achieved: 0.05 } },
  { id: 'b2', lowerInclusive: 0.5, upper: 0.75, upperInclusive: false, thresholdOutcome: 'progress_only', sampleWeights: { deferred: 0.35, progress_only: 0.45, achieved: 0.2 } },
  { id: 'b3', lowerInclusive: 0.75, upper: 1.0, upperInclusive: true, thresholdOutcome: 'achieved', sampleWeights: { deferred: 0.1, progress_only: 0.2, achieved: 0.7 } },
];

const budgets = (): DirectorProfile['budgets'] => ({
  maxPreNetworkCalls: 1,
  maxRecentMessages: 6,
  maxSerializedCharacters: 24000,
  maxQuestions: 48,
  maxAcceptedRepliesPerActivation: 1,
  automaticRetries: 0,
  deadlineMs: 30000,
});

export const BUILTIN_PROFILES: DirectorProfile[] = [
  {
    id: 'binding',
    label: 'Binding',
    description: 'The judge\'s score picks the outcome directly. Frozen before the writer runs; swipes keep it.',
    revision: 'example-3.1.0',
    mode: 'binding',
    swipePolicy: 'reuse_resolution',
    complianceAcceptance: 'manual_poc',
    resolutionMethod: 'threshold',
    outcomes: structuredClone(DEFAULT_OUTCOMES),
    bands: structuredClone(DEFAULT_BANDS),
    drivingQuestionId: 'gain_noul',
    actorPolicy: 'player_attempts',
    speakers: { includeYield: true, priors: {}, repetitionFactor: 1, manualOverrideWins: true },
    budgets: budgets(),
    injection: { depth: 0, role: 'system' },
    advisoryInfluence: 0,
  },
  {
    id: 'binding-dice',
    label: 'Binding + dice',
    description: 'The judge\'s score sets the odds and one recorded roll decides. Frozen before the writer runs; swipes keep it.',
    revision: 'example-3.1.0',
    mode: 'binding',
    swipePolicy: 'reuse_resolution',
    complianceAcceptance: 'manual_poc',
    resolutionMethod: 'sample',
    outcomes: structuredClone(DEFAULT_OUTCOMES),
    bands: structuredClone(DEFAULT_BANDS),
    drivingQuestionId: 'gain_noul',
    actorPolicy: 'player_attempts',
    speakers: { includeYield: true, priors: {}, repetitionFactor: 1, manualOverrideWins: true },
    budgets: budgets(),
    injection: { depth: 0, role: 'system' },
    advisoryInfluence: 0,
  },
  {
    id: 'advisory',
    label: 'Advisory',
    description: 'The judge\'s score is only a hint to the writer. Nothing is frozen; swipes behave as usual.',
    revision: 'example-3.1.0',
    mode: 'advisory',
    swipePolicy: 'native',
    complianceAcceptance: 'auto',
    resolutionMethod: 'threshold',
    outcomes: structuredClone(DEFAULT_OUTCOMES),
    bands: structuredClone(DEFAULT_BANDS),
    drivingQuestionId: 'gain_noul',
    actorPolicy: 'player_attempts',
    speakers: { includeYield: true, priors: {}, repetitionFactor: 1, manualOverrideWins: true },
    budgets: budgets(),
    injection: { depth: 0, role: 'system' },
    advisoryInfluence: 1,
  },
];

export function profileById(id: string): DirectorProfile | null {
  const canonical = canonicalProfileId(id);
  const p = BUILTIN_PROFILES.find(x => x.id === canonical);
  return p ? structuredClone(p) : null;
}

/** Applies the user's stored overrides (bands, priors, method) and re-validates; invalid overrides are dropped with a reason. */
export function effectiveProfile(settings: DirectorSettings): { profile: DirectorProfile; warnings: string[] } {
  const warnings: string[] = [];
  const base = profileById(settings.profileId) ?? profileById(DEFAULT_PROFILE_ID)!;
  const override = settings.profileOverrides?.[base.id];
  if (!override) return { profile: base, warnings };
  const merged: DirectorProfile = { ...base, ...override, id: base.id, speakers: { ...base.speakers, ...(override.speakers ?? {}) }, budgets: { ...base.budgets, ...(override.budgets ?? {}) }, injection: { ...base.injection, ...(override.injection ?? {}) } };
  if (override.bands || override.outcomes) {
    // Columns and rows are validated together: a table is only usable as a whole.
    // Tables saved by the build with built-in meanings are migrated on read.
    const table = { outcomes: (override.outcomes ?? base.outcomes).map(normalizeOutcome), bands: override.bands ?? base.bands };
    const v = validateTable(table);
    if (!v.ok) {
      warnings.push(`policy table override rejected: ${v.errors.join('; ')}`);
      merged.outcomes = structuredClone(base.outcomes);
      merged.bands = structuredClone(base.bands);
    } else {
      merged.outcomes = structuredClone(table.outcomes);
      merged.bands = structuredClone(table.bands);
    }
  }
  if (merged.resolutionMethod !== 'threshold' && merged.resolutionMethod !== 'sample') {
    warnings.push('unknown resolution method override rejected');
    merged.resolutionMethod = base.resolutionMethod;
  }
  merged.revision = `${base.revision}+user-${revisionHash(merged)}`;
  return { profile: merged, warnings };
}

/** Short content hash so edits to the policy table produce a new revision (M3-11). */
export function revisionHash(profile: DirectorProfile): string {
  const payload = JSON.stringify({ outcomes: profile.outcomes, bands: profile.bands, method: profile.resolutionMethod, priors: profile.speakers.priors, rep: profile.speakers.repetitionFactor, driving: profile.drivingQuestionId, mode: profile.mode, actorPolicy: profile.actorPolicy });
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
