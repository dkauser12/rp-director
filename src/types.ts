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

import type { ReactionResult, ReactionSettings } from './npc-reaction.ts';

export type Primitive = 'choice' | 'score' | 'noul';
export type Phase = 'guide';
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
  /** USD reported by the provider; missing is unknown, never a zero-cost estimate. */
  costUsd?: number | null;
  durationMs: number;
  transportAttempts: number;
}

export interface DecisionProvider {
  readonly kind: ProviderKind;
  readonly capabilities: Capabilities;
  evaluate(request: EvaluationRequest, signal: AbortSignal): Promise<EvaluationResult>;
}

/** A real judge request, independent of saved answers replayed on a wording swipe. */
export interface RequestUsage {
  requestId: string;
  stage: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
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
  /** Set when the staged pipeline declared this action; frozen with the ruling and used to reassess it. */
  pipeline?: 'staged';
  move?: StagedMove;
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
  /** Old ruling evidence was removed; the frozen outcome and dice remain reusable. */
  replayTrimmed?: boolean;
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
// Frozen attempts and variants
// ---------------------------------------------------------------------------

export type AttemptStatus = 'prepared' | 'writing' | 'accepted' | 'rejected' | 'cancelled' | 'failed' | 'stale';
export type GenerationType = 'normal' | 'swipe' | 'regenerate' | 'continue';

export interface GenerationAttempt {
  /** This turn is outside the retained judge-replay window. */
  replayTrimmed?: boolean;
  frozenPackId?: string;
  /** Successful decision output, including a judged no-move, survives replay trimming. */
  decisionsApplied?: boolean;
  frozenPacing?: import('./pacing.ts').FrozenPacing | null;
  replyCheck?: import('./reply-check.ts').ReplyCheckResult;
  replyCheckError?: string;
  replyCorrection?: string;
  rerolledByCheck?: import('./reply-check.ts').ReplyCheckReason;
  /** Zero-based original wording, which need not be next to its rewrite. */
  replyOriginalSwipe?: number;
  replyNudge?: string;
  attemptId: string;
  /** Actual requests for this turn, retained when old inspector payloads are trimmed. */
  requestUsage?: RequestUsage[];
  resolutionId: string | null;
  /** Optional permit for newly planned NPC actions in this writer attempt. */
  permitId?: string | null;
  reaction?: ReactionResult | null;
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
  /** Frozen speaker choice, reused by swipes even after settings change. */
  frozenSpeaker?: SpeakerDecision | null;
  /** Exact character state given to the writer for this turn. */
  frozenStateBlock?: string;
  /** Story snapshot before judging this user turn; explicit retries start here. */
  storyBefore?: StorySnapshot | null;
  /** Judged snapshot frozen for this variant, restored when its swipe is selected. */
  storyAfter?: StorySnapshot | null;
  /** Frozen, JSON-safe writer lore activation; null means no lore for this turn. */
  frozenLorePlan?: { force: string[]; managed: string[]; nearEnd?: boolean } | null;
  /** Error types recorded when one or more judge stages failed open. */
  judgeErrors?: string[];
  /** Failed stages, kept separately from error categories for selective retries. */
  judgeFailedStages?: string[];
  /** Successful independent stage answers can be replayed during a judge retry. */
  stageRecords?: import('./pipeline/staged.ts').StageRecord[];
  turnKind?: 'director_send' | 'director_next';
  /** Exact input this turn answered, including a Next turn's own exchange. */
  inputText?: string;
  /** Writer tool state. Missing on records from earlier builds. */
  toolStatus?: 'not_offered' | 'offered' | 'permitted' | 'failed' | 'malformed' | 'reused';
  toolError?: string | null;
  /** Key of the lore picks (story.lore) this attempt is written with; null or missing = none. */
  loreCursor?: string | null;
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
}

// ---------------------------------------------------------------------------
// Writer tool
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
  /** Old judge proposal/evidence was removed; the kept action rulings remain. */
  replayTrimmed?: boolean;
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

/** The staged pipeline's record of what was ruled: the player's own passage and its routing. */
export interface StagedMove {
  packId: string;
  packVersion: number;
  spanId: string;
  /** Verbatim passage of the player's message. */
  passage: string;
  /** Verbatim earlier NPC passage the move referred to, if any. */
  antecedent: string | null;
  route: 'DIRECT_ATTEMPT' | 'SPECIFIED_NPC_MOVE' | 'HANDOFF' | 'UNRULED';
  familyKey: string;
  ownerId: string;
  /** An actor id, SELF, SEVERAL, SCENE, or null. */
  targetId: string | null;
  specification: 'SPECIFIED_HERE' | 'SPECIFIED_BY_PUBLIC_REFERENCE' | 'UNSPECIFIED_INITIATIVE' | null;
  count: 'one' | 'multiple' | null;
}

export interface SpeakerDecision {
  questionId: string | null;
  eligibleActorIds: string[];
  /** Raw provider probabilities (or null when the provider gave none). */
  raw: Record<string, number> | null;
  /** Values after priors and repetition factor, renormalised. */
  adjusted: Record<string, number> | null;
  selected: string;
  source: 'explicit' | 'provider' | 'rules' | 'all_zero' | 'single' | 'yield' | 'move_owner';
  tieBroken: boolean;
}

export interface InspectorEntry {
  id: string;
  at: number;
  epoch: number;
  kind: 'director_send' | 'director_next' | 'wording_regeneration' | 'reroll' | 'tool_checkpoint' | 'error' | 'yield' | 'info';
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
  requestUsage?: RequestUsage[];
  message: string;
}

export interface DirectorChatRecord {
  /** Last saved selected transcript chain, used to rebase edited prefixes by index. */
  transcriptCursors?: string[];
  /** A raw 0.7 record still needs its pre-user story keys migrated on chat load. */
  legacyStoryLayout?: true;
  /** User-prefix identities already given their one automatic wording retry. */
  replyCheckRerolls?: string[];
  schemaVersion: 1;
  /** Marks normalized v0.8 data; earlier raw records get a separate rollback backup. */
  dataVersion?: 2;
  seedId: string;
  actors: Record<string, ActorBinding>;
  actions: Record<string, ActionSpec>;
  resolutions: Record<string, FrozenResolution>;
  permits: Record<string, TurnPermit>;
  attempts: Record<string, GenerationAttempt>;
  variants: Record<string, VariantRecord>;
  appliedOperationIds: string[];
  pending: PendingGeneration | null;
  /** Per-chat pause; does not change global module settings. */
  paused: boolean;
  inspector: InspectorEntry[];
  /** Active profile revision when the record was last touched. */
  profileRevision: string;
  /** Genre pack, secrets and judged character state for this chat. */
  story: StoryState;
}

/** Something only some characters know. Holders know it from the start. */
export interface SecretRecord {
  id: string;
  text: string;
  holders: string[];
}

/** Character state judged at one point of the transcript. */
export interface StorySnapshot {
  at: number;
  /** NPC id -> meter key -> level index. */
  meters: Record<string, Record<string, number>>;
  /** Per-meter judgment status. Absent on legacy snapshots: saved values were judged. */
  assessed?: Record<string, Record<string, boolean>>;
  /** Secret id -> actor ids who know it (always including its holders). */
  knownBy: Record<string, string[]>;
}

export interface StoryState {
  /** A pack id, or 'auto' until the judge picks one for this chat. */
  packId: string;
  packSource: 'auto' | 'judge' | 'user';
  secrets: SecretRecord[];
  /** Snapshots keyed by the transcript cursor they were judged at; the nearest earlier one on the current branch applies. */
  history: Record<string, StorySnapshot>;
  /** Identical wording-swipe snapshots share one stored payload. Targets are direct history keys. */
  historyAliases?: Record<string, string>;
  /** Lore chosen for a turn, keyed by the cursor the turn was decided at; swipes and continues reuse it. */
  lore: Record<string, LoreSelectionRecord>;
}

export interface LoreSelectionRecord {
  at: number;
  refs: { world: string; uid: number; title: string; score: number }[];
  /** Separately admissible evidence picks are never inferred from writer picks. */
  evidenceRefs?: { world: string; uid: number; title: string; score: number }[];
  /** Public scene where these picks were selected, retained while they are reused. */
  scene?: Json;
  /** Selection settings and book visibility fingerprint for safe reuse. */
  configuration?: string;
  requests: number;
  /** Books the turn could draw on; managed books among them lose keyword activation while this turn is written. */
  books: string[];
  /** Books whose walk got no valid answer; their keyword lore stays on even when managed. */
  failed: string[];
}

/**
 * How the Director treats one lorebook.
 *   off      ignored entirely
 *   judge    rulings may read the chosen entries; the writer keeps SillyTavern's keyword activation only
 *   assist   as judge, and the chosen entries are also activated for the writer
 *   managed  as assist, and keyword activation of the book is switched off (constant entries stay)
 */
export type LoreBookMode = 'off' | 'judge' | 'assist' | 'managed';

export interface LoreBookSettings {
  mode: LoreBookMode;
  /** Public books may inform discovery rulings; everything else is private to them. */
  public: boolean;
}

export interface LoreSettings {
  /** Keep picked writer lore near the tail of the prompt to preserve its prefix cache. */
  placeNearEnd: boolean;
  books: Record<string, LoreBookSettings>;
  /** Mode for books without their own setting. */
  defaultMode: LoreBookMode;
  maxEntries: number;
  width: number;
  minProbability: number;
  maxDepth: number;
  /** Characters of lore a ruling may read. */
  judgeChars: number;
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

export interface DirectorSettings {
  enabled: boolean;
  /** Ask before a wording swipe of a reply with a frozen ruling. */
  askWhenSwiping: boolean;
  /** Let the user keep or reroll NPC tool results before prose continues. */
  reviewNpcRolls: boolean;
  profileId: string;
  connection: ConnectionSettings;
  reactions: ReactionSettings;
  showBadges: boolean;
  /** Editable pacing and reply-check preferences. */
  pacingTexts: Record<'combat' | 'conversation' | 'travel' | 'intimate' | 'downtime', string>;
  /** Only active while Pacing is enabled; missing on older saved settings. */
  handBackBeats?: boolean;
  replyCheckThresholds: { speaksForUser: number; followsRuling: number; responds: number; repeats: number };
  /** Per-profile user edits (bands, priors) keyed by profile id. */
  profileOverrides: Record<string, Partial<DirectorProfile>>;
  /** The only supported decision pipeline. */
  pipeline: 'staged';
  /** Total pre-reply judge wait, in seconds. Zero means proceed immediately. */
  waitForJudgeSeconds: number;
  /** Settings migrations applied (3: staged only; observer and confirmation removed). */
  settingsRevision: number;
  /** Independently switchable suites. NPC reactions keep their own `reactions.enabled` switch. */
  modules: { speaker: boolean; decisions: boolean; meters: boolean; secrets: boolean; lore: boolean; replyCheck?: boolean; pacing?: boolean };
  lore: LoreSettings;
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
