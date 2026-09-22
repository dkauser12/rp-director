/**
 * Binding outcome resolution (plan §5).
 *
 * Exactly one driving signal (a Noul probability or an anchored Score level)
 * is normalised to x in [0,1], looked up in an authored policy table, and
 * resolved in code by threshold or by one recorded uniform draw. Confidence
 * never enters. Actor policy gates which explicitly declared attempts are
 * adjudicated, and scoped frozen settlements decide whether a final ruling is
 * reused without consulting today's edited table.
 *
 * The table's columns (outcomes) are entirely player-defined: a name, what
 * the writer is told, what gets recorded on Accept, and whether that record
 * settles the matter. Nothing here knows what "success" or "failure" means.
 */
import type { ActionSpec, ActorPolicy, Answer, Applicability, DecisionSnapshot, FrozenResolution, Outcome, OutcomeDef, OutcomeTier, PolicyBand, ProviderKind, RegisteredEffect, ResolutionMethod, SettledGain } from './types.ts';
import { hash53, canonicalText } from './identity.ts';
import { BASIS_POINTS, DEFAULT_OUTCOMES, LEGACY_TIER_DEFAULTS, isOutcomeTier, settledOutcome, validateBands } from './table.ts';

export { BASIS_POINTS, validateBands };
export type { Validation as PolicyValidation } from './table.ts';

// ---------------------------------------------------------------------------
// Signal normalisation
// ---------------------------------------------------------------------------

export interface NormalisedSignal {
  x: number;
  primitive: 'noul' | 'score';
  levels: number | null;
}

/** Noul → x = noul. Score with K levels → x = score / (K − 1). Choice and confidence are never signals. */
export function normaliseSignal(answer: Answer): { ok: true; signal: NormalisedSignal } | { ok: false; error: string } {
  if (answer.type === 'noul') {
    if (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return { ok: false, error: 'noul out of range' };
    return { ok: true, signal: { x: answer.noul, primitive: 'noul', levels: null } };
  }
  if (answer.type === 'score') {
    const levels = Object.keys(answer.legend ?? {}).length;
    if (levels < 2) return { ok: false, error: 'score needs at least two levels' };
    if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1) return { ok: false, error: 'score out of range' };
    return { ok: true, signal: { x: answer.score / (levels - 1), primitive: 'score', levels } };
  }
  return { ok: false, error: 'a choice answer cannot drive outcome resolution' };
}

// ---------------------------------------------------------------------------
// Table lookup and resolution
// ---------------------------------------------------------------------------

export function findBand(bands: PolicyBand[], x: number): PolicyBand | null {
  if (!Number.isFinite(x) || x < 0 || x > 1) return null;
  for (const band of bands) {
    if (x >= band.lowerInclusive && (x < band.upper || (band.upperInclusive && x === band.upper))) return band;
  }
  return null;
}

/**
 * Samples one outcome from a band with a recorded uniform u in [0,1).
 * Integer basis points and half-open cumulative intervals in column order:
 * u < cumulative/10000 selects the interval, so a draw exactly on a boundary
 * selects the next positive interval and never two.
 */
export function sampleOutcome(band: PolicyBand, u: number, order: readonly string[] = DEFAULT_OUTCOMES.map(o => o.name)): Outcome {
  if (!(u >= 0 && u < 1)) throw new Error('draw must be in [0,1)');
  let cumulative = 0;
  for (const outcome of order) {
    cumulative += Math.round(Number(band.sampleWeights[outcome] ?? 0) * BASIS_POINTS);
    if (u < cumulative / BASIS_POINTS) return outcome;
  }
  throw new Error('sample table does not cover [0,1)');
}

export interface ResolveInput {
  bands: PolicyBand[];
  /** Columns of the table, in order. Defaults to the three starter outcomes. */
  outcomes?: readonly OutcomeDef[];
  method: 'threshold' | 'sample';
  signal: NormalisedSignal;
  /** Required in sample mode; ignored in threshold mode (no draw is stored). */
  draw: number | null;
}

export interface ResolveOutput {
  outcome: Outcome;
  /** The full outcome column the ruling landed on. */
  def: OutcomeDef;
  band: PolicyBand;
  method: 'threshold' | 'sample';
  draw: number | null;
}

export function resolveOutcome(input: ResolveInput): { ok: true; value: ResolveOutput } | { ok: false; error: string } {
  const outcomes = input.outcomes && input.outcomes.length ? input.outcomes : DEFAULT_OUTCOMES;
  const band = findBand(input.bands, input.signal.x);
  if (!band) return { ok: false, error: `no policy band covers x=${input.signal.x}` };
  let name: string;
  let draw: number | null = null;
  if (input.method === 'threshold') {
    name = band.thresholdOutcome;
  } else {
    if (input.draw === null || !(input.draw >= 0 && input.draw < 1)) return { ok: false, error: 'sample mode requires a recorded draw in [0,1)' };
    draw = input.draw;
    try { name = sampleOutcome(band, draw, outcomes.map(o => o.name)); } catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  const def = outcomes.find(o => o.name === name);
  if (!def) return { ok: false, error: `band ${band.id} resolves to "${name}", which is not an outcome column` };
  return { ok: true, value: { outcome: def.name, def: structuredClone(def), band, method: input.method, draw } };
}

// ---------------------------------------------------------------------------
// Reading rulings saved by the earlier build (three built-in meanings)
// ---------------------------------------------------------------------------

/** Legacy meaning of a stored ruling; an unknown name never grants anything. */
export function tierForResolution(resolution: Pick<FrozenResolution, 'outcome' | 'outcomeTier'>): OutcomeTier {
  if (isOutcomeTier(resolution.outcomeTier)) return resolution.outcomeTier;
  return isOutcomeTier(resolution.outcome) ? resolution.outcome : 'deferred';
}

/** The writer instruction a ruling carries: its frozen text, or the starter text for rulings saved before outcomes were player-defined. */
export function instructionForResolution(resolution: Pick<FrozenResolution, 'outcome' | 'outcomeInstruction' | 'outcomeTier' | 'outcomeNote'>): string {
  if (typeof resolution.outcomeInstruction === 'string') return resolution.outcomeInstruction;
  const base = LEGACY_TIER_DEFAULTS[tierForResolution(resolution)].instruction;
  return resolution.outcomeNote && resolution.outcomeNote.trim() ? `${base} ${resolution.outcomeNote.trim()}` : base;
}

// ---------------------------------------------------------------------------
// Applicability and rules-derived decisions
// ---------------------------------------------------------------------------

export type ApplicabilityGate =
  | { kind: 'adjudicate' }
  | { kind: 'skip'; reason: 'not_favorable' | 'no_action' | 'outside_actor_policy' | 'not_uncertain_consequential' | 'not_contested' }
  | { kind: 'pause'; reason: 'unresolved_applicability' | 'missing_gain' }
  | { kind: 'rules'; outcome: OutcomeDef; reason: string };

export interface GateOptions {
  actorPolicy: ActorPolicy;
  playerActorId: string;
  currentSceneId: number;
  settledGains?: Record<string, SettledGain>;
}

/**
 * Decides whether an action needs the judge.
 * - no declared action → nothing to adjudicate (speaker-only turn).
 * - `not_favorable` → no adjudication.
 * - `unresolved` → pause for manual confirmation; never a hidden extractor.
 * - the gain already carries a value recorded by an outcome marked final →
 *   that ruling stands and is returned without a paid call. With the starter
 *   table this is "already achieved, not put at risk again"; a player-defined
 *   final failure closes the door the same way.
 */
export function gateAction(
  action: ActionSpec | null,
  established: Record<string, unknown>,
  outcomes: readonly OutcomeDef[] = DEFAULT_OUTCOMES,
  options: GateOptions = { actorPolicy: 'player_favorable', playerActorId: 'player', currentSceneId: 1 },
): ApplicabilityGate {
  if (!action) return { kind: 'skip', reason: 'no_action' };
  if (action.uncertainConsequential === false) return { kind: 'skip', reason: 'not_uncertain_consequential' };
  const actorId = action.actingActorId ?? action.playerActorId;
  const applicability: Applicability = action.applicability;
  switch (options.actorPolicy) {
    case 'player_favorable':
      if (actorId !== options.playerActorId) return { kind: 'skip', reason: 'outside_actor_policy' };
      if (applicability === 'not_favorable') return { kind: 'skip', reason: 'not_favorable' };
      if (applicability !== 'favorable') return { kind: 'pause', reason: 'unresolved_applicability' };
      break;
    case 'player_attempts':
      if (actorId !== options.playerActorId) return { kind: 'skip', reason: 'outside_actor_policy' };
      break;
    case 'contested':
      if (action.opposed !== true) return { kind: 'skip', reason: 'not_contested' };
      break;
    case 'any_declared_actor':
      break;
  }
  if (!action.requestedGain || !action.requestedGain.trim()) return { kind: 'pause', reason: 'missing_gain' };
  const gainVar = gainVariableId(action);
  const frozen = options.settledGains?.[gainVar];
  if (frozen && (frozen.scope === 'persistent' || (frozen.scope === 'scene' && frozen.sceneId === options.currentSceneId))) {
    return { kind: 'rules', outcome: structuredClone(frozen.outcome), reason: `gain ${gainVar} already stands as frozen outcome "${frozen.outcome.name}" from ${frozen.resolutionId}` };
  }
  // Legacy records had no frozen settlement registry. Preserve their exact
  // old identity/behavior until normalizeRecord can hydrate it from accepted
  // resolutions; never apply this fallback to new scoped identities.
  if (action.identityVersion !== 2) {
    const settled = settledOutcome(outcomes, established[gainVar]);
    if (settled) return { kind: 'rules', outcome: structuredClone(settled), reason: `legacy gain ${gainVar} already stands as "${settled.records}" (${settled.name})` };
  }
  return { kind: 'adjudicate' };
}

/**
 * Stable variable id that records the state of a declared gain. Keyed on the
 * template and the normalised gain text (not the per-turn action id) so a
 * gain that was already ruled on is recognised when it is declared again.
 */
export function gainVariableId(action: Pick<ActionSpec, 'templateId' | 'requestedGain'> & Partial<ActionSpec>): string {
  const full = action;
  if (full.identityVersion !== 2) {
    return `gain:${action.templateId}:${hash53(canonicalText(String(action.requestedGain ?? '')).toLowerCase())}`;
  }
  const actor = canonicalText(full.actingActorId ?? full.playerActorId ?? 'unknown').toLowerCase();
  const targets = [...new Set(full.targetActorIds ?? [])].map(x => canonicalText(x).toLowerCase()).sort().join(',');
  const scope = full.resolutionScope ?? 'attempt';
  const scopeKey = scope === 'attempt'
    ? full.actionId
    : scope === 'scene'
      ? `scene:${Number.isFinite(full.sceneId) ? full.sceneId : 0}`
      : canonicalText(full.persistentFactKey || full.requestedGain).toLowerCase();
  const result = scope === 'persistent' && canonicalText(full.persistentFactKey ?? '')
    ? ''
    : canonicalText(String(full.requestedGain ?? '')).toLowerCase();
  return `gain:v2:${hash53(JSON.stringify({ actor, targets, scope, scopeKey, result }))}`;
}

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

export interface FreezeInput {
  resolutionId: string;
  previousResolutionId: string | null;
  action: ActionSpec;
  snapshot: DecisionSnapshot;
  assessment: Answer | null;
  decisionSource: 'rules' | 'provider' | 'manual';
  policyRevision: string;
  band: PolicyBand | null;
  method: ResolutionMethod;
  draw: number | null;
  outcome: Outcome;
  /** The outcome column ruled on. Its instruction, recorded value and final flag are frozen with the ruling. */
  def?: OutcomeDef | null;
  /** Legacy inputs, used only when `def` is absent. */
  outcomeTier?: OutcomeTier;
  outcomeNote?: string;
  cursorBefore: string | null;
  generation: number;
  providerKind: ProviderKind | null;
  requestedModel: string | null;
  returnedModel: string | null;
  now: number;
}

/** Builds the immutable frozen record saved before the writer starts. */
export function freeze(input: FreezeInput): FrozenResolution {
  const record: FrozenResolution = {
    resolutionId: input.resolutionId,
    previousResolutionId: input.previousResolutionId,
    actionId: input.action.actionId,
    action: structuredClone(input.action),
    snapshot: structuredClone(input.snapshot),
    assessment: input.assessment ? structuredClone(input.assessment) : null,
    decisionSource: input.decisionSource,
    policyRevision: input.policyRevision,
    policyBand: input.band ? structuredClone(input.band) : null,
    method: input.method,
    draw: input.draw,
    outcome: input.outcome,
    status: 'prepared',
    cursorBefore: input.cursorBefore,
    generation: input.generation,
    providerKind: input.providerKind,
    requestedModel: input.requestedModel,
    returnedModel: input.returnedModel,
    createdAt: input.now,
  };
  if (input.def) {
    record.outcomeInstruction = input.def.instruction;
    record.outcomeRecords = input.def.records;
    record.outcomeFinal = input.def.final;
  } else {
    record.outcomeTier = tierForResolution({ outcome: input.outcome, outcomeTier: input.outcomeTier });
    record.outcomeNote = input.outcomeNote ?? '';
  }
  return record;
}

/** The outcome column a stored ruling was made with, when it was frozen by this build. */
export function defOfResolution(resolution: FrozenResolution): OutcomeDef | null {
  if (typeof resolution.outcomeInstruction !== 'string') return null;
  return { name: resolution.outcome, instruction: resolution.outcomeInstruction, records: resolution.outcomeRecords ?? '', final: resolution.outcomeFinal === true };
}

/**
 * Effects an accepted ruling applies. A player-defined outcome writes its
 * `records` value to the gain's variable (nothing when empty). Rulings saved
 * by the earlier build fall back to their template's registered effects.
 */
export function effectsFor(resolution: Pick<FrozenResolution, 'action' | 'outcome' | 'outcomeTier' | 'outcomeRecords'>): RegisteredEffect[] {
  if (typeof resolution.outcomeRecords === 'string') {
    return resolution.outcomeRecords ? [{ op: 'set_enum', variableId: gainVariableId(resolution.action), value: resolution.outcomeRecords }] : [];
  }
  return structuredClone(resolution.action.effectsByOutcome?.[tierForResolution(resolution)] ?? []);
}
