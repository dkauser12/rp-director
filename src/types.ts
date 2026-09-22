/**
 * RP Director application contracts.
 *
 * These are the extension's own types. Nothing here is a SillyTavern API; the
 * only host-facing surface is `HostAdapter` in host.ts. The shapes follow the
 * v3 handoff contract (tests/fixtures/decision-contract.reference.ts) and add
 * the runtime records the lifecycle reducer needs.
 */

// ---------------------------------------------------------------------------
// Primitives and questions
// ---------------------------------------------------------------------------

export type Primitive = 'choice' | 'score' | 'noul';
export type Phase = 'guide' | 'observe';
export type ProviderKind = 'mock' | 'rules' | 'jev' | 'structured';
/**
 * Legacy. Before outcomes were fully player-defined, each carried one of three
 * built-in meanings. Kept only so saved rulings and saved tables from that
 * build still read correctly.
 */
export type OutcomeTier = 'deferred' | 'progress_only' | 'achieved';
export const OUTCOME_TIERS: readonly OutcomeTier[] = ['deferred', 'progress_only', 'achieved'];
/** An outcome is a variable name defined by the profile (a column of the policy table). */
export type Outcome = string;
/** One column of the policy table. Everything about an outcome is defined by the player. */
export interface OutcomeDef {
  /** Variable name: letters, digits, underscore. Recorded in every ruling. */
  name: string;
  /** Exactly what the writer is told when this outcome is ruled. May use {{gain}}, {{action}}, {{target}}, {{player}}, {{speaker}}. */
  instruction: string;
  /** Value written to the gain's variable when the reply is accepted. Empty records nothing. */
  records: string;
  /** True: once accepted, the ruling stands for the action's declared scope. */
  final: boolean;
}
/** Default outcome names, in column order. */
export const OUTCOMES: readonly Outcome[] = ['deferred', 'progress_only', 'achieved'];
export const YIELD = 'YIELD';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };

export interface Capabilities {
  primitives: Primitive[];
  distributions: 'native' | 'model_reported' | 'deterministic' | 'unavailable';
  confidence: 'native_distribution_statistic' | 'unavailable';
  structuredOutput: 'native_typed' | 'json_schema' | 'json_object' | 'validated_text' | 'in_process';
  independentSharedStateBatch: boolean;
  maxQuestions: number | null;
  cancellation: 'abort_signal' | 'best_effort';
  usageReporting: boolean;
}

export interface EvidenceSpan {
  id: string;
  actorId: string;
  role: 'user' | 'assistant' | 'author';
  text: string;
  accepted: boolean;
}

export interface DecisionSnapshot {
  chatId: string;
  cursorBefore: string;
  stateRevision: number;
  scopeId: string;
  profileRevision: string;
  catalogRevision: string;
  actorBindingRevision: string;
  /** Focused allowed evidence, never the entire writer prompt. */
  state: Json;
}

export interface EvaluationRequest {
  requestId: string;
  phase: Phase;
  snapshot: DecisionSnapshot;
  questions: Record<string, Question>;
}

export type Provenance = 'native' | 'model_reported' | 'rule' | 'fixture';

interface AnswerMeta {
  provenance: Provenance;
  /** Always null for Noul and for providers without native confidence. */
  confidence: number | null;
}

export type Answer =
  | (AnswerMeta & { type: 'choice'; choice: string; probabilities: Record<string, number> | null })
  | (AnswerMeta & { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number> | null })
  | (AnswerMeta & { type: 'noul'; noul: number; confidence: null });

export interface EvaluationResult {
  requestId: string;
  provider: ProviderKind;
  requestedModel: string | null;
  returnedModel: string | null;
  answers: Record<string, Answer>;
  /** Questions the provider could not answer validly. Never turned into facts. */
  unresolvedQuestionIds: string[];
  /** Per-question validation errors, keyed by question id. */
  errors: Record<string, string>;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  transportAttempts: number;
}

export interface DecisionProvider {
  readonly kind: ProviderKind;
  readonly capabilities: Capabilities;
  evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<EvaluationResult>;
}

// ---------------------------------------------------------------------------
// Actions, policy, frozen resolutions
// ---------------------------------------------------------------------------

export type Applicability = 'favorable' | 'not_favorable' | 'unresolved';
export type AttemptFamily =
  | 'overcome_operate'
  | 'contest_impose'
  | 'evade_resist'
  | 'conceal_deceive'
  | 'detect_discover'
  | 'influence_negotiate'
  | 'acquire_secure';
export type ActorPolicy = 'player_favorable' | 'player_attempts' | 'contested' | 'any_declared_actor';
export type ResolutionScope = 'attempt' | 'scene' | 'persistent';
export type FailureStakeKind = 'delay' | 'exposure' | 'injury' | 'lost_position' | 'resource_cost' | 'relationship_friction' | 'closed_opportunity' | 'other';

export interface FailureStake {
  kind: FailureStakeKind;
  /** A short authored boundary for what the consequence may mean in prose. */
  detail: string;
}

export interface Precondition {
  factId: string;
  expected: Json;
  actual: Json;
  known: boolean;
}

export interface ActionSpec {
  actionId: string;
  /** v2 identities include acting actor, canonical targets and resolution scope. */
  identityVersion?: 2;
  templateId: string;
  /** The character attempting the action. Distinct from the character selected to write the reply. */
  actingActorId?: string;
  /** Legacy field retained so existing frozen resolutions remain readable. */
  playerActorId: string;
  targetActorIds: string[];
  attemptedAction: string;
  requestedGain: string;
  applicability: Applicability;
  /** False means established/trivial or without meaningful failure; no adjudication is made. */
  uncertainConsequential?: boolean;
  /** True only when an actor or active force is actually opposing the attempt. */
  opposed?: boolean;
  resolutionScope?: ResolutionScope;
  /** Scene captured when declared. Used only for scene-scoped settlement. */
  sceneId?: number;
  /** Optional stable author label for a persistent fact; the attempt family is deliberately not identity. */
  persistentFactKey?: string;
  failureStake?: FailureStake;
  /** Observer-visible cues or other concise evidence. For detection this is the only knowledge evidence. */
  availableEvidence?: string;
  /** Automatic mode resolves only the first qualifying attempt in a bundled message. */
  additionalAttemptsPolicy?: 'defer_after_first';
  preconditions: Precondition[];
  /** Legacy (pre player-defined outcomes). New actions do not carry it; the outcome's own instruction is used. */
  outcomeText?: Record<OutcomeTier, { required: string[]; forbidden: string[] }>;
  /** Legacy. New rulings derive their effect from the outcome's `records` value. */
  effectsByOutcome?: Record<OutcomeTier, RegisteredEffect[]>;
}

export type RegisteredEffect =
  | { op: 'set_enum'; variableId: string; value: string | boolean }
  | { op: 'set_bounded_value'; variableId: string; value: number }
  | { op: 'apply_named_delta'; variableId: string; deltaName: string }
  | { op: 'advance_time'; seconds: number; quality: 'exact' | 'estimated' }
  | { op: 'set_known_location'; actorId: string; placeId: string | null; status: 'known' | 'unknown' | 'in_transit' };

export interface PolicyBand {
  id: string;
  lowerInclusive: number;
  upper: number;
  upperInclusive: boolean;
  /** Name of the outcome column this band resolves to in Binding mode. */
  thresholdOutcome: Outcome;
  /** Dice-mode weight per outcome column name; whole basis points summing to 1. */
  sampleWeights: Record<Outcome, number>;
}

export type ResolutionMethod = 'threshold' | 'sample' | 'rules' | 'manual';
export type ResolutionStatus = 'prepared' | 'accepted' | 'superseded' | 'invalidated';

export interface FrozenResolution {
  resolutionId: string;
  previousResolutionId: string | null;
  actionId: string;
  /** Immutable copy of the action as it was adjudicated. */
  action: ActionSpec;
  snapshot: DecisionSnapshot;
  assessment: Answer | null;
  decisionSource: 'rules' | 'provider' | 'manual';
  policyRevision: string;
  policyBand: PolicyBand | null;
  method: ResolutionMethod;
  /** Recorded uniform draw in [0,1) for sample mode; null otherwise. */
  draw: number | null;
  /** Outcome column name as it was when the ruling was frozen. */
  outcome: Outcome;
  /** The outcome's writer instruction, as it was when the ruling was frozen. */
  outcomeInstruction?: string;
  /** The value this ruling records on Accept, frozen with it. Empty records nothing. */
  outcomeRecords?: string;
  /** Whether this ruling stands once accepted, frozen with it. */
  outcomeFinal?: boolean;
  /** Legacy meaning, present only on rulings saved by the build with built-in meanings. */
  outcomeTier?: OutcomeTier;
  /** Legacy writer note. */
  outcomeNote?: string;
  status: ResolutionStatus;
  /**
   * Fingerprint of the accepted prefix this resolution constrains. Null until
   * the host has appended the user's message and the interceptor binds it.
   */
  cursorBefore: string | null;
  /** Monotonic per-cursor generation; explicit rerolls increment it. */
  generation: number;
  providerKind: ProviderKind | null;
  requestedModel: string | null;
  returnedModel: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Attempts, variants, checkpoints, projection
// ---------------------------------------------------------------------------

export type AttemptStatus = 'prepared' | 'writing' | 'observing' | 'provisional' | 'accepted' | 'rejected' | 'cancelled' | 'failed' | 'stale';
export type GenerationType = 'normal' | 'swipe' | 'regenerate' | 'continue';

export interface GenerationAttempt {
  attemptId: string;
  resolutionId: string | null;
  /** Optional permit for newly planned NPC actions in this writer attempt. */
  permitId?: string | null;
  actorId: string | null;
  /** Null until bound by the interceptor. */
  cursorBefore: string | null;
  status: AttemptStatus;
  generationType: GenerationType;
  /** Host message index at completion; informational only, never identity. */
  hostMessageRef: number | null;
  /** Host swipe index at completion; informational only. */
  hostVariantRef: number | null;
  variantId: string | null;
  injectedText: string;
  /** Chat epoch the attempt belongs to; results from another epoch are stale. */
  epoch: number;
  /** True when the host generated without the Director pipeline. */
  unadjudicated: boolean;
  /** Tool checkpoint state. Missing on records from earlier builds. */
  toolStatus?: 'not_offered' | 'offered' | 'permitted' | 'failed' | 'malformed' | 'reused';
  toolError?: string | null;
  createdAt: number;
}

export interface VariantRecord {
  variantId: string;
  attemptId: string;
  resolutionId: string | null;
  permitId?: string | null;
  actorId: string | null;
  cursorBefore: string | null;
  /** Fingerprint of the accepted prefix including this variant. */
  cursorAfter: string | null;
  acceptance: 'pending' | 'accepted' | 'rejected' | 'auto';
  /** Post-generation observation is provisional until this variant is selected and committed. */
  observerStatus?: 'pending' | 'ready' | 'failed' | 'not_required';
  observation?: ObservationRecord | null;
  observerError?: string | null;
}

// ---------------------------------------------------------------------------
// Writer tool checkpoint and post-generation observer
// ---------------------------------------------------------------------------

export interface PlannedAction {
  proposalId: string;
  actingActorId: string;
  targetActorIds: string[];
  family: AttemptFamily;
  method: string;
  boundedResult: string;
  failureStake: FailureStake;
  opposed: boolean;
  evidenceRefs: string[];
}

export interface TurnProposal {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  speakerActorId: string;
  actions: PlannedAction[];
}

export interface PermittedAction {
  proposalId: string;
  resolutionId: string;
  actingActorId: string;
  targetActorIds: string[];
  family: AttemptFamily;
  method: string;
  boundedResult: string;
  failureStake: FailureStake;
  opposed: boolean;
  outcome: Outcome;
  instruction: string;
  recordedValue: string;
  finalForScope: boolean;
  scope: 'attempt';
  assessment?: Answer;
  draw?: number | null;
  methodUsed?: 'threshold' | 'sample';
  policyBand?: PolicyBand;
  outcomeDefinition?: OutcomeDef;
}

export interface TurnPermit {
  schemaVersion: 1;
  permitId: string;
  attemptId: string;
  speakerActorId: string;
  baseCursor: string;
  stateRevision: number;
  actions: PermittedAction[];
  compactState: {
    sceneId: number;
    revision: number;
  };
  constraints: string[];
  createdAt: number;
  previousPermitId?: string | null;
  reviewHistory?: { permitId: string; actions: PermittedAction[]; choice: 'reroll' | 'reassess'; at: number }[];
  reviewedAt?: number;
  proposal?: TurnProposal;
  snapshot?: DecisionSnapshot;
  profile?: DirectorProfile;
}

export type ObservationOperation =
  | { operationId: string; op: 'advance_time'; seconds: number; quality: 'exact' | 'estimated' }
  | { operationId: string; op: 'set_known_location'; actorId: string; placeId: string | null; status: 'known' | 'unknown' | 'in_transit' }
  | { operationId: string; op: 'transfer_item'; itemId: string; fromActorId: string | null; toActorId: string | null }
  | { operationId: string; op: 'set_condition'; actorId: string; conditionId: string; active: boolean }
  | { operationId: string; op: 'mark_fact_known'; actorId: string; factId: string }
  | { operationId: string; op: 'mark_secret_revealed'; secretId: string; actorIds: string[] };

export interface ObservationRegistry {
  actorIds: string[];
  placeIds: string[];
  itemIds: string[];
  conditionIds: string[];
  factIds: string[];
  secretIds: string[];
}

export interface ObservationRequest {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  variantId: string;
  baseCursor: string;
  cursorAfter: string;
  stateRevision: number;
  acceptedSpan: EvidenceSpan;
  expectedResolutionIds: string[];
  expectedRulings: {
    resolutionId: string;
    actingActorId: string;
    boundedResult: string;
    outcome: Outcome;
    instruction: string;
  }[];
  permit: TurnPermit | null;
  priorState: CompactState;
  registry: ObservationRegistry;
}

export interface ObservationRecord {
  schemaVersion: 1;
  requestId: string;
  attemptId: string;
  variantId: string;
  baseCursor: string;
  cursorAfter: string;
  stateRevision: number;
  realizedResolutionIds: string[];
  operations: ObservationOperation[];
  unresolved: string[];
  providerKind: ProviderKind | 'local';
  requestedModel: string | null;
  returnedModel: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Position {
  status: 'known' | 'unknown' | 'in_transit';
  placeId: string | null;
  lastKnownPlaceId: string | null;
  offstage: boolean;
}

/** Frozen meaning of an accepted final ruling; later table edits cannot reinterpret it. */
export interface SettledGain {
  variableId: string;
  resolutionId: string;
  outcome: OutcomeDef;
  scope: ResolutionScope;
  sceneId: number | null;
}

export interface CompactState {
  revision: number;
  variables: Record<string, string | number | boolean | null>;
  settledGains: Record<string, SettledGain>;
  unresolvedVariableIds: string[];
  elapsedSeconds: number;
  timeQuality: 'exact' | 'estimated' | 'unresolved';
  sceneId: number;
  sceneReplyCount: number;
  positions: Record<string, Position>;
  notifiedDeadlineIds: string[];
  acceptedResolutionIds: string[];
  acceptedPermitIds: string[];
  itemOwners: Record<string, string | null>;
  conditions: Record<string, Record<string, boolean>>;
  knownFacts: Record<string, string[]>;
  revealedSecrets: Record<string, string[]>;
  lastObservedCursor: string;
  trackingStatus: 'current' | 'pending' | 'stale';
}

export interface Checkpoint {
  cursor: string;
  parentCursor: string | null;
  stateAfter: CompactState;
  variantId: string | null;
  acceptedResolutionId: string | null;
  observationOperationIds: string[];
}

export type ProjectionStatus = 'current' | 'provisional' | 'stale' | 'unknown';

export interface Projection {
  /** Cursor of the head the projection describes. */
  cursor: string | null;
  state: CompactState;
  status: ProjectionStatus;
  /** Why the projection is stale or unknown, for the inspector. */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Actors, pending generation, inspector, chat record
// ---------------------------------------------------------------------------

export interface ActorBinding {
  actorId: string;
  /** Host avatar filename (durable), or 'persona' for the player. */
  avatar: string;
  name: string;
  control: 'npc' | 'user';
}

export interface PendingGeneration {
  attemptId: string;
  resolutionId: string | null;
  actorId: string | null;
  epoch: number;
  /** Composer text captured at decision time; the host must consume the same text. */
  composerText: string;
  createdAt: number;
}

export interface SpeakerDecision {
  questionId: string | null;
  eligibleActorIds: string[];
  /** Raw provider probabilities (or null when the provider gave none). */
  raw: Record<string, number> | null;
  /** Values after priors and repetition factor, renormalised. */
  adjusted: Record<string, number> | null;
  selected: string;
  source: 'explicit' | 'provider' | 'rules' | 'all_zero' | 'single' | 'yield';
  tieBroken: boolean;
}

export interface InspectorEntry {
  id: string;
  at: number;
  epoch: number;
  kind: 'director_send' | 'director_next' | 'wording_regeneration' | 'reroll' | 'native_bypass' | 'acceptance' | 'tool_checkpoint' | 'observer' | 'restore' | 'error' | 'yield' | 'info';
  attemptId: string | null;
  resolutionId: string | null;
  actionId: string | null;
  applicability: Applicability | null;
  questions: Record<string, Question> | null;
  /** Exactly what was sent as `state`, so exclusions are auditable. */
  stateSent: Json | null;
  answers: Record<string, Answer> | null;
  speaker: SpeakerDecision | null;
  policyBandId: string | null;
  draw: number | null;
  outcome: Outcome | null;
  injectedText: string | null;
  providerKind: ProviderKind | null;
  requestedModel: string | null;
  returnedModel: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  networkCalls: number;
  message: string;
}

export interface DirectorChatRecord {
  schemaVersion: 1;
  seedId: string;
  actors: Record<string, ActorBinding>;
  actions: Record<string, ActionSpec>;
  resolutions: Record<string, FrozenResolution>;
  permits: Record<string, TurnPermit>;
  attempts: Record<string, GenerationAttempt>;
  variants: Record<string, VariantRecord>;
  /** Keyed by `cursorAfter`. */
  checkpoints: Record<string, Checkpoint>;
  appliedOperationIds: string[];
  pending: PendingGeneration | null;
  projection: Projection;
  inspector: InspectorEntry[];
  /** Active profile revision when the record was last touched. */
  profileRevision: string;
}

// ---------------------------------------------------------------------------
// Profiles and settings
// ---------------------------------------------------------------------------

export interface DirectorProfile {
  id: string;
  label: string;
  /** One plain sentence shown next to the label in settings. */
  description: string;
  revision: string;
  mode: 'binding' | 'advisory';
  swipePolicy: 'reuse_resolution' | 'native';
  complianceAcceptance: 'manual_poc' | 'auto';
  resolutionMethod: 'threshold' | 'sample';
  /** Columns of the policy table, in order. */
  outcomes: OutcomeDef[];
  /** Rows of the policy table. */
  bands: PolicyBand[];
  drivingQuestionId: 'gain_noul' | 'gain_score';
  /** Which declared attempts the outcome judge is allowed to adjudicate. */
  actorPolicy: ActorPolicy;
  speakers: {
    includeYield: boolean;
    priors: Record<string, number>;
    repetitionFactor: number;
    manualOverrideWins: boolean;
  };
  budgets: {
    maxPreNetworkCalls: number;
    maxRecentMessages: number;
    maxSerializedCharacters: number;
    maxQuestions: number;
    maxAcceptedRepliesPerActivation: number;
    automaticRetries: number;
    deadlineMs: number;
  };
  injection: {
    depth: number;
    role: 'system' | 'user' | 'assistant';
  };
  advisoryInfluence: number;
}

export type ConnectionKind = 'mock' | 'rules' | 'jev' | 'structured' | 'openrouter';

export interface ConnectionSettings {
  kind: ConnectionKind;
  /** Jev: native endpoint URL. Structured (direct): OpenAI-compatible base URL. */
  baseUrl: string;
  model: string;
  /** Structured: route through a SillyTavern connection profile (server-side secrets) instead of a browser fetch. */
  stProfileId: string;
  /** Mock: which fixture scenario to replay. */
  mockScenario: string;
}

export interface ObserverConnectionSettings {
  /** Empty uses the decision provider in bounded entailment mode. */
  stProfileId: string;
}

export interface DirectorSettings {
  enabled: boolean;
  profileId: string;
  /** ISO timestamp of the user's explicit first-use confirmation, or null. */
  bindingConfirmedAt: string | null;
  connection: ConnectionSettings;
  observerConnection: ObserverConnectionSettings;
  showBar: boolean;
  inspectorOpen: boolean;
  /** Per-profile user edits (bands, priors) keyed by profile id. */
  profileOverrides: Record<string, Partial<DirectorProfile>>;
}

// ---------------------------------------------------------------------------
// Action templates (milestone 3 hand-authored set)
// ---------------------------------------------------------------------------

export interface ActionTemplate {
  id: string;
  label: string;
  gainPrompt: string;
  attemptPrompt: string;
}
