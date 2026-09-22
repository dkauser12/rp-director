/** Proposed application contracts only. These are not SillyTavern APIs or an SDK. */
export type Primitive = 'choice' | 'score' | 'noul';
export type Phase = 'guide' | 'observe';
export type ProviderKind = 'mock' | 'rules' | 'jev' | 'structured';
export type Outcome = 'deferred' | 'progress_only' | 'achieved';
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
  state: Json; // Focused allowed evidence, never the entire writer prompt.
}
export interface EvaluationRequest {
  requestId: string;
  phase: Phase;
  snapshot: DecisionSnapshot;
  questions: Record<string, Question>;
}
interface AnswerMeta {
  provenance: 'native' | 'model_reported' | 'rule' | 'fixture';
  confidence: number | null; // Always null for Noul and unavailable provider confidence.
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
  unresolvedQuestionIds: string[];
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

export interface ActionSpec {
  actionId: string;
  templateId: string;
  playerActorId: string;
  targetActorIds: string[];
  attemptedAction: string;
  requestedGain: string;
  applicability: 'favorable' | 'not_favorable' | 'unresolved';
  preconditions: { factId: string; expected: Json; actual: Json; known: boolean }[];
  outcomeText: Record<Outcome, { required: string[]; forbidden: string[] }>;
  // Hand-authored registered effects only, never arbitrary model JSON patches.
  effectsByOutcome: Record<Outcome, RegisteredEffect[]>;
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
  thresholdOutcome: Outcome;
  sampleWeights: Record<Outcome, number>;
}
export interface FrozenResolution {
  resolutionId: string;
  previousResolutionId: string | null;
  action: ActionSpec;
  snapshot: DecisionSnapshot;
  assessment: Answer | null;
  decisionSource: 'rules' | 'provider' | 'manual';
  policyRevision: string;
  policyBand: PolicyBand | null;
  method: 'threshold' | 'sample' | 'rules' | 'manual';
  draw: number | null;
  outcome: Outcome;
  status: 'prepared' | 'accepted' | 'superseded' | 'invalidated';
}
export interface GenerationAttempt {
  attemptId: string;
  resolutionId: string | null;
  actorId: string | null;
  cursorBefore: string;
  status: 'writing' | 'provisional' | 'accepted' | 'rejected' | 'cancelled' | 'failed';
  hostMessageRef: string | null;
  hostVariantRef: string | null;
  injectedText: string;
}
export interface Position {
  status: 'known' | 'unknown' | 'in_transit';
  placeId: string | null;
  lastKnownPlaceId: string | null;
  offstage: boolean;
}
export interface CompactState {
  revision: number;
  variables: Record<string, string | number | boolean | null>;
  unresolvedVariableIds: string[];
  elapsedSeconds: number;
  timeQuality: 'exact' | 'estimated' | 'unresolved';
  sceneId: number;
  sceneReplyCount: number;
  positions: Record<string, Position>;
  notifiedDeadlineIds: string[];
  acceptedResolutionIds: string[];
  lastObservedCursor: string;
  trackingStatus: 'current' | 'pending' | 'stale';
}
export interface Checkpoint {
  cursor: string;
  parentCursor: string | null;
  stateAfter: CompactState;
  hostVariantRef: string | null;
  acceptedResolutionId: string | null;
  observationOperationIds: string[];
}
/** Names below are Director adapter obligations, NOT existing host function names. */
export interface HostAdapterRequirements {
  describeInstalledVersion(): Promise<string>;
  readSnapshot(): Promise<DecisionSnapshot>;
  persistPrepared(resolution: FrozenResolution): Promise<void>;
  resolveCurrentActorIndex(actorId: string): Promise<number>;
  generateForResolvedActor(index: number, attemptId: string): Promise<void>;
  setTemporaryDirectorBlock(text: string): Promise<void>;
  clearTemporaryDirectorBlock(): Promise<void>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
}
