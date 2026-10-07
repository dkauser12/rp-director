/**
 * Judge, freeze, then write. Failed stages leave the reply unruled.
 * Owns per-chat history and cancellation identity; host effects stay in Host.
 */
import type {
  ActionSpec, ActorPolicy, Answer, Applicability, DecisionProvider, LoreBookMode, DecisionSnapshot, DirectorChatRecord, DirectorProfile, DirectorSettings,
  EvaluationResult, FailureStakeKind, FrozenResolution, GenerationType, InspectorEntry,
  Json, Question, SpeakerDecision, StagedMove, TurnPermit, GenerationAttempt, StorySnapshot, RequestUsage,
} from './types.ts';
import { YIELD } from './types.ts';
import { Host, VARIANT_MARKER_KEY } from './host.ts';
import type { HostActor, HostChatMessage } from './host.ts';
import { actorIdFor, newId, prefixCursor, cursorChain, randomDraw, PLAYER_LABEL, hash53 } from './identity.ts';
import { applyEvent, normalizeRecord, compactRecord, activeResolutionForCursor, replayIsTrimmed } from './state.ts';
import { rebaseRecordCursors } from './state-cursors.ts';
import type { DirectorEvent } from './state.ts';
import { gateAction, normaliseSignal, resolveOutcome, freeze, instructionForResolution } from './resolver.ts';
import type { PolicyTable } from './table.ts';
import { validateTable } from './table.ts';
import { buildTableTestRequest, evaluateTableTest, localFailure, localOnly, transportFailure } from './tabletest.ts';
import type { TableTestReport } from './tabletest.ts';
import { decideSpeaker } from './speaker.ts';
import type { SpeakerCandidate } from './speaker.ts';
import { attemptNoulQuestion, attemptScoreQuestion, checkBatch, speakerQuestion } from './questions.ts';
import { bindingBlock, advisoryBlock, combinedBlock } from './prompts.ts';
import { declareAction, templateById } from './templates.ts';
import { effectiveProfile } from './profiles.ts';
import { createMockProvider, createRulesProvider, createJevProvider, createOpenRouterDecisionsProvider, createStructuredProvider, createDirectFetchTransport, ProviderError } from './providers.ts';
import {
  DIRECTOR_TOOL_NAME, DIRECTOR_TOOL_DESCRIPTION, TURN_PROPOSAL_SCHEMA, adjudicateTurnProposal, permitFollowupBlock,
  toolPlanningBlock, validateTurnProposal, writerPermit,
} from './director-tool.ts';
import type { ToolProposalErrorCode } from './director-tool.ts';
import { rerollPermit, reviewPermit } from './roll-review.ts';
import { withinBudget, JudgeWaitBudget, visibleJudgeData } from './workflow.ts';
import { assessReply, replyCheckQuestions, replyCheckRuling, replyCheckState, replyCorrection } from './reply-check.ts';
import type { ReplyCheckReason } from './reply-check.ts';
import { resolveDirectorMacro } from './macros.ts';
import type { DirectorMacroState } from './macros.ts';
import { pacingBlock, PACING_QUESTION_IDS } from './pacing.ts';
import type { FrozenPacing } from './pacing.ts';
import { buildWorkflowBadge } from './workflow-badge.ts';
import { failedRequestUsage, mergeRequestUsage, requestUsage, summarizeUsage } from './usage.ts';
import { stripResultFooter } from './result-footer.ts';
import { chooseReaction, reactionQuestion } from './npc-reaction.ts';
import type { ReactionKind, ReactionResult, ReactionSettings } from './npc-reaction.ts';
import { runStaged, StagedError, stageError, validateStageAnswers, evaluateStageWithReplay } from './pipeline/staged.ts';
import type { StagedOutput, StageId, StageRecord } from './pipeline/staged.ts';
import { isOutOfCharacterMessage, visibleText } from './pipeline/spans.ts';
import type { EvidenceActor } from './pipeline/evidence.ts';
import { rulingQuestion } from './pipeline/questions.ts';
import { familyByKey, meterLabel } from './pack/pack.ts';
import type { GenrePack } from './pack/pack.ts';
import { hasPack, listPacks, loadLocalPacks, packById } from './pack/packs.ts';
import { packQuestion } from './pipeline/pack-pick.ts';
import { applyStateAnswers, meterFacts, stateBlock, stateEvidence, stateQuestions } from './pipeline/character-state.ts';
import { knownByAt, levelsAt, loreAt, snapshotAt, withLore, withSnapshot } from './story.ts';
import { buildTree, selectable } from './lore/tree.ts';
import { loreSceneAnchor, loreSceneQuestion, loreSceneState, reuseLorePicks, runLoreStage } from './lore/stage.ts';
import type { LoreBookInput, LoreStageResult } from './lore/stage.ts';
import { bookSettings, effectiveMode, lorePlan } from './lore/settings.ts';

export type DirectorStatus = 'Off' | 'No chat' | 'Ready' | 'Deciding' | 'Frozen' | 'Writing' | 'Paused' | 'Error';

export interface ActionDraft {
  templateId: string;
  actingActorId: string;
  targetActorIds: string[];
  attemptedAction: string;
  requestedGain: string;
  applicability: Applicability;
  uncertainConsequential: boolean;
  opposed: boolean;
  failureStakeKind: FailureStakeKind;
  failureStakeDetail: string;
  availableEvidence: string;
}

export const PLAYER_ACTOR_ID = 'player';
export const JEV_KEY_STORAGE = 'rpDirector.jev.sessionKey';
export const STRUCTURED_KEY_STORAGE = 'rpDirector.structured.sessionKey';

interface ActorMap {
  byId: Record<string, HostActor & { actorId: string }>;
  byAvatar: Record<string, string>;
  order: string[];
}

/** Staged requests go through the companion plugin: at most 16 questions and 96 KiB of state each. */
const STAGED_MAX_QUESTIONS = 16;
const STAGED_MAX_REACTION_TRIGGERS = 14;
const STAGED_MAX_STATE_CHARS = 60000;
/** Characters whose meters are judged each turn (the eligible speakers, in group order). */
const STATE_MAX_CHARACTERS = 6;

interface TurnModules { pacing?: boolean; replyCheck?: boolean; speaker: boolean; decisions: boolean; reactions: boolean; meters: boolean; secrets: boolean; lore: boolean }

/** Characters of public scene the lore questions carry. */
const LORE_STATE_CHARS = 24000;

/** One turn's lore stage: its result, the books it could draw on, or why it failed. */
interface LoreTurn {
  result: LoreStageResult | null;
  books: string[];
  error: string | null;
  configuration?: string;
  scene?: Json;
}

function loreNote(turn: LoreTurn): string {
  if (turn.error) return `Lore selection failed (${turn.error}); SillyTavern's keyword lore applies this turn.`;
  if (!turn.result) return '';
  const { refs, requests, failedWorlds } = turn.result;
  const calls = `${requests} request${requests === 1 ? '' : 's'}`;
  const failed = failedWorlds.length ? ` No valid answer for ${failedWorlds.join(', ')}; keyword lore stays on there.` : '';
  return (refs.length ? `Lore: ${refs.map(r => `${r.world} › ${r.title}`).join('; ')} (${calls}).` : `Lore: nothing needed this turn (${calls}).`) + failed;
}

interface StagedTurnContext {
  kind: 'director_send' | 'director_next';
  composerText: string;
  epoch: number;
  chatKey: string | null;
  actors: ActorMap;
  isGroup: boolean;
  candidates: SpeakerCandidate[];
  eligible: string[];
  names: Record<string, string>;
  explicit: string | null;
  /** The Speaker module is off in a group: the host picks the replier. */
  nativeSpeaker: boolean;
  lastSpeakerActorId: string | null;
  modules: TurnModules;
  reactionSettings: ReactionSettings;
  /** True when the profile, reactions, declaration or scene changed while deciding. */
  changed: () => boolean;
  transcriptPrefix?: HostChatMessage[];
  boundPrefix?: HostChatMessage[];
  replay?: boolean;
  retrySource?: GenerationAttempt;
  swipe?: boolean;
  nativeSwipePending?: boolean;
}

/** Everything the staged turn needs to freeze and dispatch its reply. */
interface TurnFinish {
  packId: string;
  requestUsage?: RequestUsage[];
  pacing?: FrozenPacing | null;
  /** story.lore key of this turn's picks, or null when lore did not run. */
  loreCursor: string | null;
  storyBefore: StorySnapshot | null;
  storyAfter: StorySnapshot | null;
  swipe?: boolean;
  nativeSwipePending?: boolean;
  kind: 'director_send' | 'director_next';
  composerText: string;
  epoch: number;
  actors: ActorMap;
  isGroup: boolean;
  names: Record<string, string>;
  /** null: the host picks the replier (Speaker module off in a group). */
  speaker: SpeakerDecision | null;
  preparedAction: ActionSpec | null;
  resolution: FrozenResolution | null;
  bandId: string | null;
  reaction: ReactionResult | null;
  snapshot: DecisionSnapshot;
  established: Record<string, unknown>;
  decisionsOn: boolean;
  disarmDeclaration: boolean;
  advisoryNotes: string[];
  questions: Record<string, Question> | null;
  answers: Record<string, Answer> | null;
  stateSent: Json;
  result: EvaluationResult | null;
  networkCalls: number;
  actionId: string | null;
  applicability: Applicability | null;
  fallbackMessage: string;
  messageSuffix: string;
  /** Judged character state and knowledge boundaries for the writer ('' when none). */
  stateBlock: string;
  stageRecords?: StageRecord[];
  failedStages?: string[];
  /** The staged pipeline's result; 'unruled' means the route itself left the move unruled. */
  outcome?: StagedOutput['outcome'];
  retrySource?: GenerationAttempt;
}

type ToolWindowPhase = 'initial' | 'cancelled' | 'followup_pending' | 'followup_writing' | 'failed_pending' | 'failed_writing' | 'malformed_pending' | 'malformed_writing';

interface ToolWindow {
  requestId: string;
  attemptId: string;
  speakerActorId: string;
  baseCursor: string;
  stateRevision: number;
  chatLengthAtBind: number;
  priorReplyText?: string;
  allowedEvidenceRefs: string[];
  snapshot: DecisionSnapshot;
  actorNames: Record<string, string>;
  phase: ToolWindowPhase;
  permit: TurnPermit | null;
  error: string | null;
  used: boolean;
}

interface PreparedToolContext {
  requestId: string;
  attemptId: string;
  speakerActorId: string;
  snapshot: DecisionSnapshot;
  actorNames: Record<string, string>;
  allowedEvidenceRefs: string[];
  available: boolean;
}

export class Controller {
  readonly host: Host;
  settings: DirectorSettings;
  profile: DirectorProfile;
  profileWarnings: string[] = [];
  record: DirectorChatRecord | null = null;
  chatKey: string | null = null;
  epoch = 0;
  status: DirectorStatus = 'Off';
  lastError: string | null = null;
  /** Runtime-only evidence for the connection label; never inferred from imported activity. */
  lastWorkingConnection: string | null = null;
  /** Runtime receipts span chats and include cancelled calls; never loaded from history. */
  readonly sessionUsage: RequestUsage[] = [];
  speakerOverride: string | null = null;
  actionDraft: ActionDraft | null = null;
  private actionDraftRevision = 0;
  private currentAttemptId: string | null = null;
  private pendingInjection = '';
  private inFlight: AbortController | null = null;
  private listeners: (() => void)[] = [];
  private unsubscribe: (() => void)[] = [];
  private continueRemaining = 0;
  private toolRegistered = false;
  /** Whether the host offers the World Info hooks lore selection needs. */
  loreHooked = false;
  private toolWindow: ToolWindow | null = null;
  private preparedTool: PreparedToolContext | null = null;
  private messageTasks = new Set<Promise<void>>();
  private writerSettled: Promise<void> | null = null;
  private nativeTurnBusy = false;
  private errorTypes = new Set<string>();
  private turnErrors: string[] = [];
  private approvedSwipeCursor: string | null = null;
  private decidingMessage: HostChatMessage | null = null;
  private decidingNewSend = false;
  private completionCandidate: string | null = null;
  /** Completion follows the host message object, even after Stop or a slow listener. */
  private replyBinding: { attemptId: string; index: number; message: HostChatMessage | null; swipeId: number; rejected: Set<HostChatMessage>; ended: Promise<void>; end: () => void } | null = null;
  private toolContinuation: { attemptId: string; injection: string } | null = null;
  private writerIdleWaiters = new Set<() => void>();
  private preparedDeadline: number | null = null;
  private pendingForSwipe = false;
  private preparedInputCursor: string | null = null;
  private cancelSwipe = false;
  private replyCheckAbort: AbortController | null = null;
  private replyCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Identity survives cancellation until the single native swipe dispatch settles.
   * `finished`: a real completion was received (never an empty, '...' or tool
   * intermediary). `toolFollowUp`: its writer called the Director tool, so
   * SillyTavern's next 'normal' generation is its follow-up (`followUpPending`
   * once that generation started).
   */
  private automaticReply: { sourceId: string; message: HostChatMessage; chatKey: string | null;
    reason: ReplyCheckReason; correction: string; originalSwipe: number; nextSwipe: number;
    attemptId: string | null; swipeObserved: boolean; started: boolean; finished: boolean; cancelled: boolean; preserveUserChanges: boolean;
    toolFollowUp: boolean; followUpPending: boolean } | null = null;
  private explicitRetry: { sourceId: string; resolutionId: string | null; permitId: string | null; inspectorId: string } | null = null;
  /** The source a native Regenerate confirmed at GENERATION_STARTED, before SillyTavern deleted the reply. */
  private regenerateSource: { sourceId: string; resolutionId: string | null; permitId: string | null; cursor: string } | null = null;
  private macroUpcomingAttemptId: string | null = null;
  /** Input cursor of a Director resend whose preview must survive its 'normal' start. */
  private macroUpcomingCursor: string | null = null;
  private macroSuppressed = false;
  /**
   * Quiet, impersonate and dry-run generations suppress readers only until their
   * own data is built (or they end): each saves the outer state. `nested` ones
   * started while a Director generation was building its prompt (from its start
   * to its GENERATE_AFTER_DATA), so their GENERATION_ENDED is not that
   * generation's end (`nestedEnds` counts those). `restore` is the Director block
   * taken out of a quiet or impersonate prompt, put back unless rewritten meanwhile.
   */
  private suppressions: { suppressed: boolean; dry: boolean; nested: boolean; restore?: { text: string; version: number } }[] = [];
  private nestedEnds = 0;
  private buildingGeneration = false;
  private dryRunRestore: { attemptId: string; epoch: number; text: string } | null = null;
  private groupGenerationType: string | null = null;
  private groupSpeakerFailure: string | null = null;

  constructor(host: Host) {
    this.host = host;
    this.settings = host.settings();
    const eff = effectiveProfile(this.settings);
    this.profile = eff.profile;
    this.profileWarnings = eff.warnings;
  }

  // ---- lifecycle --------------------------------------------------------------

  async init(): Promise<void> {
    await this.host.loadFlags();
    if (typeof window !== 'undefined' && typeof location !== 'undefined') void loadLocalPacks().then(result => { if (result.warnings.length) console.warn('[RP Director] local packs:', ...result.warnings); this.notify(); });
    const sub = (event: string, handler: (...args: unknown[]) => unknown) => this.unsubscribe.push(this.host.on(event, handler));
    sub('CHAT_CHANGED', () => void this.onChatChanged());
    sub('GENERATION_STARTED', (type, params, dryRun) => this.onGenerationStarted(String(type), { ...params as Record<string, unknown>, dryRun: Boolean(dryRun || (params as Record<string, unknown> | undefined)?.dryRun) }));
    if (this.host.ctx().eventTypes.GENERATE_AFTER_DATA) sub('GENERATE_AFTER_DATA', (_data, dryRun) => {
      // The suppressing generation's prompt is built: restore the outer generation's readers and block.
      const frame = this.suppressions.at(-1);
      if (frame && frame.dry === Boolean(dryRun)) {
        this.suppressions.pop();
        this.macroSuppressed = frame.suppressed;
        this.resumeInjection(frame);
        if (!frame.dry && frame.nested) this.nestedEnds += 1;
      } else if (!dryRun) {
        // The Director generation's own prompt is built: later starts are not nested in it.
        this.buildingGeneration = false;
        this.nestedEnds = 0;
      }
      if (!dryRun) return;
      const restore = this.dryRunRestore;
      this.dryRunRestore = null;
      if (restore && restore.epoch === this.epoch && this.currentAttemptId === restore.attemptId
        && this.record?.attempts[restore.attemptId]?.status === 'writing') this.setInjection(restore.text);
    });
    sub('GENERATION_STOPPED', () => void this.onGenerationStopped());
    sub('GENERATION_ENDED', () => this.onGenerationEnded());
    if (this.host.ctx().eventTypes.GROUP_WRAPPER_STARTED) sub('GROUP_WRAPPER_STARTED', details => {
      this.groupGenerationType = String((details as { type?: string } | undefined)?.type ?? 'normal');
      this.groupSpeakerFailure = null;
    });
    if (this.host.ctx().eventTypes.GROUP_MEMBER_DRAFTED) sub('GROUP_MEMBER_DRAFTED', () => this.enforceDraftedSpeaker());
    if (this.host.ctx().eventTypes.GROUP_WRAPPER_FINISHED) sub('GROUP_WRAPPER_FINISHED', () => { this.groupGenerationType = null; this.groupSpeakerFailure = null; });
    sub('MESSAGE_RECEIVED', (mesId, type) => { this.queueMessageReceived(Number(mesId), String(type ?? 'normal')); });
    if (this.host.ctx().eventTypes.CHARACTER_MESSAGE_RENDERED) sub('CHARACTER_MESSAGE_RENDERED', async mesId => {
      if (this.settings.enabled && this.refreshWorkflowBadge(Number(mesId))) await this.persist();
    });
    sub('MESSAGE_SENT', (mesId) => this.onMessageSent(Number(mesId)));
    sub('MESSAGE_SWIPED', (mesId) => this.onMessageSwiped(Number(mesId)));
    sub('MESSAGE_EDITED', (mesId) => void this.onHeadChanged('edit', Number(mesId)));
    sub('MESSAGE_DELETED', () => void this.onHeadChanged('delete', null));
    sub('MESSAGE_SWIPE_DELETED', (details) => { this.onSwipeDeleted(details); void this.onHeadChanged('unknown', null); });
    this.loreHooked = this.host.installLoreHook();
    this.host.onLoreActivation = () => this.notify();
    this.registerWriterTool();
    this.unsubscribe.push(this.host.interceptNativeSend(
      () => this.settings.enabled && Boolean(this.record && this.host.chatKey()) && !this.record?.paused && !this.host.isAutoDirectorEnabled(),
      () => this.directorSend(),
    ));
    this.unsubscribe.push(this.host.interceptNativeRegenerate(
      () => this.settings.enabled && !this.record?.paused && Boolean(this.record) && this.host.hasSelectedReply(),
      () => this.regenerateSelected(),
    ));
    this.unsubscribe.push(this.host.interceptRegenerateCommand(
      () => this.settings.enabled && !this.record?.paused && Boolean(this.record) && this.host.hasSelectedReply(),
      () => this.regenerateSelected(),
    ));
    this.unsubscribe.push(this.host.onComposerInput(() => this.cancelReplyCheck()));
    await this.loadChat();
  }

  private registerWriterTool(): void {
    this.toolRegistered = this.host.registerFunctionTool({
      name: DIRECTOR_TOOL_NAME,
      displayName: 'RP Director turn adjudication',
      description: DIRECTOR_TOOL_DESCRIPTION,
      parameters: TURN_PROPOSAL_SCHEMA,
      action: async (args) => this.onToolCall(args),
      formatMessage: () => 'Director is adjudicating the planned NPC action…',
      shouldRegister: () => this.shouldOfferWriterTool(),
      stealth: false,
    });
  }

  destroy(): void {
    this.cancelReplyCheck();
    this.replyBinding?.end();
    this.releaseWriterWaiters();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.host.unregisterFunctionTool(DIRECTOR_TOOL_NAME);
    this.host.removeLoreHook();
    this.inFlight?.abort(new Error('Director destroyed'));
    this.toolWindow = null;
    this.preparedTool = null;
    this.host.clearInjection();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (e) { console.error('[RP Director] listener failed', e); }
    }
  }

  reloadProfile(): void {
    this.settings = this.host.settings();
    const before = this.profile.revision;
    const eff = effectiveProfile(this.settings);
    this.profile = eff.profile;
    this.profileWarnings = eff.warnings;
    if (this.record && before !== this.profile.revision) {
      this.apply({ type: 'invalidate_prepared', reason: `profile revision ${before} → ${this.profile.revision}`, onlyUnbound: false, profileRevision: this.profile.revision });
      void this.persist();
    }
    this.refreshStatus();
  }

  // ---- record helpers ---------------------------------------------------------

  private apply(event: DirectorEvent): string[] {
    if (!this.record) return ['no record'];
    const out = applyEvent(this.record, event);
    this.record = out.record;
    for (const n of out.notices) console.debug('[RP Director]', event.type, n);
    return out.notices;
  }

  private async persist(): Promise<void> {
    if (!this.record || !this.chatKey) return;
    try {
      const liveVariantIds = this.host.chat().flatMap(message => [message.extra, ...(message.swipe_info ?? []).map(info => info?.extra)])
        .flatMap(extra => { const marker = extra?.rpd as { v?: unknown } | undefined; return typeof marker?.v === 'string' ? [marker.v] : []; });
      const chain = this.chainNow();
      this.record.transcriptCursors = chain;
      this.record = compactRecord(this.record, { liveCursors: chain, liveVariantIds,
        activeAttemptIds: [this.currentAttemptId, this.completionCandidate, this.explicitRetry?.sourceId],
        activeResolutionIds: [this.explicitRetry?.resolutionId], activePermitIds: [this.explicitRetry?.permitId] });
      const ok = await this.host.writeRecord(this.record, this.chatKey);
      if (!ok) console.warn('[RP Director] metadata write skipped (chat changed)');
    } catch (e) {
      console.error('[RP Director] metadata write failed', e);
    }
    this.notify();
  }

  private inspect(partial: Partial<InspectorEntry> & { kind: InspectorEntry['kind']; message: string }): void {
    const entry: InspectorEntry = {
      id: newId('ins'), at: Date.now(), epoch: this.epoch, attemptId: null, resolutionId: null, actionId: null, applicability: null,
      questions: null, stateSent: null, answers: null, speaker: null, policyBandId: null, draw: null, outcome: null, injectedText: null,
      providerKind: null, requestedModel: null, returnedModel: null, durationMs: null, inputTokens: null, outputTokens: null, networkCalls: 0,
      ...partial,
    };
    this.apply({ type: 'inspect', entry });
  }

  /** Count only actual transport calls; saved answer replay never enters this wrapper. */
  private usageProvider(provider: DecisionProvider, stage: string, receipts: RequestUsage[], network = this.isNetworkProvider()): DecisionProvider {
    if (!network) return provider;
    return { ...provider, evaluate: async (request, signal) => {
      const started = Date.now();
      const receipt = failedRequestUsage(request.requestId, stage, 0);
      receipts.push(receipt);
      this.sessionUsage.push(receipt);
      this.notify();
      try {
        const result = await provider.evaluate(request, signal);
        Object.assign(receipt, requestUsage(result, stage), { requestId: request.requestId });
        return result;
      } finally { receipt.durationMs = Date.now() - started; this.notify(); }
    } };
  }

  /** `toast` false: the caller tells the user in its own sentence, so a later failure of this type still toasts. */
  private reportJudgeError(type: string, detail: string, extra: Partial<InspectorEntry> = {}, stage = type, toast = true): void {
    const message = `${detail.replace(/[.\s]+$/, '')}. Your chat isn't affected.`;
    this.lastError = message;
    if (!this.turnErrors.includes(type)) this.turnErrors.push(type);
    this.inspect({ kind: 'error', message, ...extra });
    const key = `${stage}:${type}`;
    if (toast && !this.errorTypes.has(key)) {
      this.errorTypes.add(key);
      this.host.toast('warning', message);
    }
    this.notify();
  }

  private recoverJudgeStage(stage: string): void {
    for (const key of this.errorTypes) if (key.startsWith(`${stage}:`)) this.errorTypes.delete(key);
    if (!this.errorTypes.size && this.lastError !== null) {
      this.lastError = null;
      // The drawer chip follows the recovery (an idle 'Error' becomes 'Ready').
      this.refreshStatus();
    }
  }

  refreshStatus(): void {
    if (!this.settings.enabled) this.status = 'Off';
    else if (!this.record) this.status = 'No chat';
    else if (this.record.paused) this.status = 'Paused';
    else if (!['Deciding', 'Writing', 'Frozen'].includes(this.status)) this.status = this.lastError ? 'Error' : 'Ready';
    this.notify();
  }

  clearError(): void {
    this.errorTypes.clear();
    this.lastError = null;
    this.status = 'Ready';
    this.refreshStatus();
  }

  async setPaused(paused: boolean): Promise<void> {
    if (!this.record) { this.host.toast('warning', 'Open a chat first.'); return; }
    this.record.paused = paused;
    if (paused) {
      this.cancelReplyCheck();
      this.inFlight?.abort(new Error('paused'));
      this.host.clearInjection();
      void this.host.armLore(null);
    }
    await this.persist();
    this.refreshStatus();
  }


  // ---- chat load --------------------------------------------------------------

  async loadChat(): Promise<void> {
    this.macroUpcomingAttemptId = null;
    this.macroUpcomingCursor = null;
    this.macroSuppressed = false;
    this.suppressions = [];
    this.nestedEnds = 0;
    this.buildingGeneration = false;
    this.regenerateSource = null;
    this.dryRunRestore = null;
    this.cancelReplyCheck();
    this.errorTypes.clear();
    this.completionCandidate = null;
    this.replyBinding?.end();
    this.replyBinding = null;
    this.toolContinuation = null;
    this.preparedInputCursor = null;
    this.releaseWriterWaiters();
    this.chatKey = this.host.chatKey();
    this.speakerOverride = null;
    this.actionDraft = null;
    this.actionDraftRevision += 1;
    this.currentAttemptId = null;
    this.pendingInjection = '';
    this.toolWindow = null;
    this.preparedTool = null;
    this.preparedDeadline = null;
    this.pendingForSwipe = false;
    this.approvedSwipeCursor = null;
    this.explicitRetry = null;
    this.groupGenerationType = null;
    this.groupSpeakerFailure = null;
    this.host.clearInjection();
    // A footer cleanup rerenders messages; those render events must not use
    // the previous chat's record or create an extra save during migration.
    this.record = null;
    if (!this.chatKey) {
      this.refreshStatus();
      return;
    }
    const stripped = this.host.stripLegacyResultFooters();
    if (!this.settings.enabled && !stripped.copies) {
      this.record = null;
      this.refreshStatus();
      return;
    }
    this.record = normalizeRecord(this.host.readRecord(), this.host.seedId(), this.profile.revision);
    this.record = rebaseRecordCursors(this.record, this.host.chat(), this.host.fingerprintMessages(this.host.chat()));
    if (stripped.copies) this.inspect({ kind: 'info', message: `Removed ${stripped.copies} old Director footer ${stripped.copies === 1 ? 'copy' : 'copies'} from ${stripped.messages} ${stripped.messages === 1 ? 'message' : 'messages'}.` });
    if (!this.settings.enabled) {
      await this.host.writeRecord(this.record, this.chatKey);
      this.record = null;
      this.refreshStatus();
      return;
    }
    this.bindActors();
    for (const attempt of Object.values(this.record.attempts)) {
      if (attempt.status === 'writing' || attempt.status === 'prepared') this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: attempt.epoch, reason: 'reload during generation' });
    }
    this.status = 'Ready';
    this.refreshWorkflowBadges(0);
    await this.persist();
    this.refreshStatus();
  }

  private async onChatChanged(): Promise<void> {
    this.epoch += 1;
    void this.host.armLore(null);
    this.inFlight?.abort(new Error('chat changed'));
    this.inFlight = null;
    this.toolWindow = null;
    this.preparedTool = null;
    this.continueRemaining = 0;
    if (this.record) this.apply({ type: 'abort_epoch', epoch: this.epoch - 1, reason: 'chat changed' });
    this.status = 'Ready';
    this.lastError = null;
    await this.loadChat();
  }

  // ---- actors -----------------------------------------------------------------

  private actorMap(): ActorMap {
    const map: ActorMap = { byId: {}, byAvatar: {}, order: [] };
    for (const actor of this.host.actors()) {
      const actorId = actorIdFor(actor.name, actor.avatar);
      map.byId[actorId] = { ...actor, actorId };
      map.byAvatar[actor.avatar] = actorId;
      map.order.push(actorId);
    }
    return map;
  }

  private bindActors(): ActorMap {
    const map = this.actorMap();
    if (this.record) {
      this.apply({ type: 'bind_actor', binding: { actorId: PLAYER_ACTOR_ID, avatar: 'persona', name: this.host.playerName(), control: 'user' } });
      for (const id of map.order) {
        const a = map.byId[id]!;
        this.apply({ type: 'bind_actor', binding: { actorId: id, avatar: a.avatar, name: a.name, control: 'npc' } });
      }
    }
    return map;
  }

  actorsForUi(): { actorId: string; name: string; disabled: boolean }[] {
    return Object.values(this.actorMap().byId).map(a => ({ actorId: a.actorId, name: a.name, disabled: a.disabled }));
  }

  actionActorsForUi(): { actorId: string; name: string; disabled: boolean }[] {
    return [{ actorId: PLAYER_ACTOR_ID, name: PLAYER_LABEL, disabled: false }, ...this.actorsForUi()];
  }

  // ---- cursors ----------------------------------------------------------------

  private chainNow(): string[] {
    return cursorChain(this.record?.seedId ?? this.host.seedId(), this.host.fingerprintMessages(this.host.chat()));
  }

  private cursorOf(messages: ReturnType<Host['chat']>): string {
    return prefixCursor(this.record?.seedId ?? this.host.seedId(), this.host.fingerprintMessages(messages));
  }



  // ---- provider ---------------------------------------------------------------

  provider(): DecisionProvider {
    const c = this.settings.connection;
    const deadline = this.profile.budgets.deadlineMs;
    switch (c.kind) {
      case 'mock':
        return createMockProvider({ scenario: c.mockScenario || 'gate-deferred', timeoutMs: deadline });
      case 'rules':
        return createRulesProvider({ routing: { speaker: 'explicit_speaker', gain_noul: 'established_fact', gain_score: 'established_fact' } });
      case 'jev':
        return createJevProvider({ baseUrl: c.baseUrl || 'https://api.typesafe.ai/v1/systemone', model: c.model || 'jev-latest', getApiKey: () => sessionStorage.getItem(JEV_KEY_STORAGE), timeoutMs: deadline });
      case 'structured': {
        if (c.stProfileId) return createStructuredProvider({ transport: this.host.stProfileTransport(c.stProfileId), model: c.model || null, timeoutMs: deadline });
        if (!c.baseUrl) throw new Error('structured connection needs a SillyTavern connection profile or a base URL');
        return createStructuredProvider({ transport: createDirectFetchTransport({ baseUrl: c.baseUrl, getApiKey: () => sessionStorage.getItem(STRUCTURED_KEY_STORAGE) }), model: c.model || null, timeoutMs: deadline });
      }
      case 'openrouter':
        return !c.model || /^(?:~)?typesafe\/jev/.test(c.model)
          ? createOpenRouterDecisionsProvider({ transport: this.host.openRouterDecisionsTransport(), model: c.model || '~typesafe/jev-latest', timeoutMs: deadline })
          : createStructuredProvider({ transport: this.host.openRouterTransport(), model: c.model, timeoutMs: deadline });
      default:
        throw new Error(`unknown connection kind ${String(c.kind)}`);
    }
  }

  private isNetworkProvider(): boolean {
    return this.settings.connection.kind === 'jev' || this.settings.connection.kind === 'structured' || this.settings.connection.kind === 'openrouter';
  }

  // ---- director actions -------------------------------------------------------

  async directorSend(): Promise<void> {
    if (this.nativeTurnBusy || this.host.nativeSendBlocked()) return;
    this.nativeTurnBusy = true;
    const epoch = this.epoch;
    try {
      await this.waitForMessageTasks();
      if (epoch !== this.epoch) return;
      await this.directorTurn('director_send');
    } finally { this.nativeTurnBusy = false; }
  }

  async directorNext(): Promise<void> {
    if (this.host.composerText().trim()) {
      this.host.toast('warning', 'The composer has text. Use Send to include it, or clear it before continuing.');
      return;
    }
    await this.directorTurn('director_next');
  }

  /** Finite continuation: re-selects after each accepted reply up to the profile cap; stops on yield, pause, failure, or Stop. */
  async directorContinue(cap = 3): Promise<void> {
    this.continueRemaining = Math.max(1, Math.min(cap, 3));
    while (this.continueRemaining > 0) {
      this.continueRemaining -= 1;
      const before = this.record ? Object.keys(this.record.attempts).length : 0;
      await this.directorTurn('director_next');
      if (!this.record) break;
      const after = Object.keys(this.record.attempts).length;
      if (after === before) break; // yielded, paused, or failed
      if (this.record.paused) break;
    }
    this.continueRemaining = 0;
  }

  stopContinue(): void {
    this.continueRemaining = 0;
    this.host.stopGeneration();
  }

  private async guardTurn(): Promise<boolean> {
    return this.settings.enabled && Boolean(this.record && this.chatKey) && !this.record?.paused && !this.host.isGenerating();
  }

  private async directorTurn(kind: 'director_send' | 'director_next'): Promise<void> {
    if (!(await this.guardTurn())) return;
    this.cancelReplyCheck();
    const record = this.record!;
    const composerText = kind === 'director_send' ? this.host.composerText() : '';
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const declarationRevision = this.actionDraftRevision;
    const profileRevisionAtStart = this.profile.revision;
    const reactionSettings = structuredClone(this.settings.reactions);
    const reactionSettingsAtStart = JSON.stringify(reactionSettings);
    const modules: TurnModules = { ...this.settings.modules, reactions: reactionSettings.enabled };

    // Failed or abandoned writers from before are closed out; their frozen decisions stay.
    for (const attempt of Object.values(record.attempts)) {
      if (attempt.status === 'writing' || attempt.status === 'prepared') this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: attempt.epoch, reason: 'superseded by a new Director turn' });
    }

    if (composerText.trim().startsWith('/')) {
      // Slash commands go through the host parser untouched; nothing to adjudicate.
      this.inspect({ kind: 'info', message: 'Composer holds a slash command; passed to the host parser without a Director decision.' });
      await this.persist();
      try { await this.host.generate(null); } catch (e) { console.warn(e); }
      return;
    }

    if (!modules.speaker && !modules.decisions && !modules.reactions && !modules.meters && !modules.secrets && !modules.lore && !modules.pacing && !modules.replyCheck) {
      // Every suite is off: the Director stands aside for this turn.
      this.inspect({ kind: 'info', message: 'Every Director module is off; native generation with no Director request or injection.' });
      await this.persist();
      try { await this.host.generate(null); } catch (e) { console.warn(e); }
      return;
    }

    // Recreating a deleted exchange reuses the decision at its input cursor.
    const target = kind === 'director_send' && composerText.trim()
      ? [...this.host.chat(), { name: this.host.playerName(), is_user: true, is_system: false, mes: composerText }]
      : this.host.chat();
    const existing = this.attemptAt(target);
    if (existing) {
      const cursor = existing.cursorBefore ?? this.cursorOf(target);
      if (!(await this.confirmRetry(existing, cursor))) return;
      this.approvedSwipeCursor = cursor;
      // Card fields are substituted before the interceptor reuses this decision.
      this.macroUpcomingAttemptId = existing.attemptId;
      this.macroUpcomingCursor = cursor;
      const actor = existing.actorId ? this.actorMap().byId[existing.actorId] : null;
      try { await this.host.generate(this.host.isGroup() && actor ? this.host.resolveIndex(actor.avatar) : null); }
      finally {
        await this.waitForMessageTasks(); this.explicitRetry = null; this.approvedSwipeCursor = null;
        if (this.macroUpcomingCursor === cursor) { this.macroUpcomingAttemptId = null; this.macroUpcomingCursor = null; }
      }
      return;
    }

    this.status = 'Deciding';
    this.cancelSwipe = false;
    this.toolWindow = null;
    this.lastError = null;
    this.notify();

    const actors = this.bindActors();
    const isGroup = this.host.isGroup();
    const candidates: SpeakerCandidate[] = actors.order.map(id => ({ actorId: id, exclusions: actors.byId[id]!.disabled ? ['disabled'] : [] }));
    const eligible = candidates.filter(c => c.exclusions.length === 0).map(c => c.actorId);
    const names: Record<string, string> = {};
    names[PLAYER_ACTOR_ID] = this.host.playerName();
    for (const id of actors.order) names[id] = actors.byId[id]!.name;
    const lastAvatar = this.host.lastAssistantAvatar();
    const lastSpeakerActorId = lastAvatar ? actors.byAvatar[lastAvatar] ?? null : null;

    // Explicit speaker: user override, or the single character of a 1:1 chat.
    let explicit: string | null = this.speakerOverride && this.speakerOverride !== 'auto' ? this.speakerOverride : null;
    if (!isGroup && eligible.length === 1 && !explicit) explicit = eligible[0]!;
    // With the Speaker module off, the host's own group activation picks the replier.
    const nativeSpeaker = isGroup && !explicit && !modules.speaker;
    const changed = (): boolean => this.actionDraftRevision !== declarationRevision || this.profile.revision !== profileRevisionAtStart
      || JSON.stringify(this.settings.reactions) !== reactionSettingsAtStart;

    this.decidingNewSend = kind === 'director_send';
    this.host.setComposerLocked(true);
    try {
      await this.stagedTurn({ kind, composerText, epoch, chatKey, actors, isGroup, candidates, eligible, names, explicit, nativeSpeaker, lastSpeakerActorId, modules, reactionSettings, changed });
    } finally { this.decidingNewSend = false; this.host.setComposerLocked(false); this.preparedDeadline = null; }

  }

  private async stagedTurn(c: StagedTurnContext): Promise<void> {
    const record = this.record!;
    const established = {};
    const npcs = c.eligible;
    const playerName = c.names[PLAYER_ACTOR_ID]!;
    const actorsIn: Record<string, EvidenceActor> = { [PLAYER_ACTOR_ID]: { name: playerName, control: 'user' } };
    for (const id of npcs) {
      const actor = c.actors.byId[id]!;
      actorsIn[id] = { name: actor.name, control: 'npc', card: this.host.cardText(actor.avatar) };
    }
    const transcript = (c.transcriptPrefix ?? this.host.chat()).filter(m => !m.is_system).slice(-this.profile.budgets.maxRecentMessages).map(m => ({
      actorId: m.is_user ? PLAYER_ACTOR_ID : (c.actors.byAvatar[m.original_avatar ?? ''] ?? `name:${m.name}`),
      role: m.is_user ? 'user' as const : 'assistant' as const,
      text: m.is_user ? m.mes ?? '' : stripResultFooter(m.mes ?? ''),
    }));
    const needSpeaker = c.modules.speaker && c.isGroup && !c.explicit && npcs.length > 0;
    const reactionTargets = c.modules.reactions ? (c.explicit ? [c.explicit].filter(id => npcs.includes(id)) : npcs).slice(0, STAGED_MAX_REACTION_TRIGGERS) : [];
    const prefix = c.boundPrefix ?? c.transcriptPrefix;
    const chain = prefix ? cursorChain(record.seedId, this.host.fingerprintMessages(prefix)) : this.chainNow();
    const cursorBefore = chain.at(-1)!;
    const connectionAtStart = JSON.stringify(this.settings.connection);
    let connectionError: unknown = null;
    let provider: DecisionProvider | null = null;
    try { provider = this.provider(); } catch (e) { connectionError = e; }
    let networkCalls = 0;
    const receipts: RequestUsage[] = [];
    const networkProvider = this.isNetworkProvider();
    const abort = new AbortController();
    this.inFlight = abort;
    this.turnErrors = [];
    this.lastError = null;
    this.preparedDeadline = Date.now() + Math.max(0, this.settings.waitForJudgeSeconds) * 1000;
    const timer = setTimeout(() => abort.abort(new JudgeWaitBudget()), Math.max(0, this.preparedDeadline - Date.now()));
    if (this.preparedDeadline <= Date.now()) abort.abort(new JudgeWaitBudget());
    const failedStages = new Set<string>();
    const askedStages = new Set<string>();
    // A failure is reported, keyed and recorded under one stage ID: an NPC
    // reaction rides in the move request but is its own stage.
    const report = (stage: StageId, error: unknown) => {
      if (abort.signal.aborted && !(abort.signal.reason instanceof JudgeWaitBudget)) return;
      const failure = stageError(stage, error);
      const id = stage === 'move' && /^npc_reaction_/.test(failure.message) ? 'reaction' : stage;
      failedStages.add(id);
      if (c.epoch === this.epoch && this.chatKey === c.chatKey) this.reportJudgeError(failure.type, `Judge unavailable (${id}): ${failure.message}`, {}, id);
    };
    let catalogRevision = 'pack:pending';
    const snapshotBase = () => ({
      chatId: c.chatKey!, cursorBefore, stateRevision: 0, scopeId: 'shared-public',
      profileRevision: this.profile.revision, catalogRevision, actorBindingRevision: c.actors.order.join(','),
    });
    const ask = async (stage: StageId, questions: Record<string, Question>, state: Json): Promise<EvaluationResult> => {
      askedStages.add(stage);
      questions = visibleJudgeData(questions);
      state = visibleJudgeData(state);
      const check = checkBatch(questions, STAGED_MAX_QUESTIONS, Object.keys(questions).map(() => 'shared-public'));
      if (!check.ok) throw new StagedError(stage, `batch rejected: ${check.errors.join('; ')}`);
      if (abort.signal.aborted) throw abort.signal.reason;
      if (connectionError || !provider) throw connectionError ?? new Error('No judge connection');
      if (JSON.stringify(state).length > STAGED_MAX_STATE_CHARS) throw new StagedError(stage, 'context exceeds the character budget', 'context_budget');
      const answered = await evaluateStageWithReplay(stage, questions, state, c.replay ? c.retrySource?.stageRecords : undefined, async (_stage, missing, evidence) => {
        if (networkProvider) networkCalls += 1;
        const result = await withinBudget(this.usageProvider(provider!, stage, receipts, networkProvider).evaluate({ requestId: newId('req'), phase: 'guide', snapshot: { ...snapshotBase(), state: evidence }, questions: missing }, abort.signal), abort.signal);
        this.lastWorkingConnection = connectionAtStart;
        return result;
      });
      // Stages riding in another stage's request are answered here too (by question ID).
      for (const id of Object.keys(questions)) {
        if (PACING_QUESTION_IDS.includes(id)) askedStages.add('pacing');
        else if (id.startsWith('npc_reaction_')) askedStages.add('reaction');
      }
      return answered;
    };
    const characters = npcs.slice(0, STATE_MAX_CHARACTERS).map(id => ({ id, name: c.names[id]!, card: actorsIn[id]!.card }));
    const notes: string[] = [];
    // Stage C: lore, started now beside the pack pick, S and A; a ruling awaits it.
    const loreRun = c.modules.lore ? withinBudget(this.startLore(c, transcript, ask), abort.signal)
      .catch(error => ({ result: null, books: [], error: (error as Error).message } as LoreTurn)) : null;

    // Genre pack: chosen once per chat, by the user or, on Auto, by the judge.
    let pack = this.chatPack();
    if (record.story.packId === 'auto' && (c.modules.decisions || c.modules.meters)) {
      try {
        const questions = { pack: packQuestion(listPacks()) };
        const pick = await ask('pack', questions, stateEvidence({ transcript, latestInput: c.composerText, characters, secrets: [], playerName, maxChars: STAGED_MAX_STATE_CHARS }));
        const checked = validateStageAnswers('pack', questions, pick);
        if (checked.errors.length) throw new StagedError('pack', checked.errors[0]!.message, checked.errors[0]!.type);
        const answer = checked.result.answers.pack;
        if (answer?.type === 'choice' && hasPack(answer.choice) && c.epoch === this.epoch && c.chatKey === this.chatKey && !abort.signal.aborted) {
          this.record!.story = { ...this.record!.story, packId: answer.choice, packSource: 'judge' };
          pack = packById(answer.choice);
          notes.push(`Pack for this chat: ${pack.label} (picked by the judge).`);
        } else throw new StagedError('pack', 'No valid genre answer', 'invalid_answers');
      } catch (e) {
        report('pack', e);
        notes.push(`Pack pick failed; kept ${pack.label} this turn.`);
      }
    }
    catalogRevision = `pack:${pack.id}@${pack.version}`;

    // Character state: judged in its own private request, beside the move stages.
    const story = c.retrySource?.storyBefore !== undefined
      ? { ...this.record!.story, history: c.retrySource.storyBefore ? { [cursorBefore]: structuredClone(c.retrySource.storyBefore) } : {} }
      : c.retrySource ? { ...this.record!.story, history: (() => { const prior = snapshotAt(this.record!.story, chain.slice(0, -1)); return prior ? { [cursorBefore]: prior } : {}; })(), historyAliases: {} }
      : this.record!.story;
    const storyBefore = snapshotAt(story, chain);
    const stateNpcs = characters.map(({ id, name }) => ({ id, name }));
    const before = levelsAt(story, chain, pack, stateNpcs.map(n => n.id));
    const knownBefore = knownByAt(story, chain);
    const wantMeters = c.modules.meters && pack.meters.length > 0 && stateNpcs.length > 0;
    const wantSecrets = c.modules.secrets && story.secrets.length > 0;
    const built = wantMeters || wantSecrets ? stateQuestions({
      pack: wantMeters ? pack : { ...pack, meters: [] }, npcs: stateNpcs, levels: before.levels, assessed: before.assessed, playerName,
      secrets: wantSecrets ? story.secrets : [], knownBy: knownBefore, actorNames: { ...c.names, player: playerName }, maxQuestions: stateNpcs.length * pack.meters.length + story.secrets.length,
    }) : null;
    let stateError: string | null = null;
    const stateRecords: StageRecord[] = [];
    const stateEntries = Object.entries(built?.questions ?? {});
    const stateBatches: Record<string, Question>[] = [];
    for (let offset = 0; offset < stateEntries.length; offset += STAGED_MAX_QUESTIONS) stateBatches.push(Object.fromEntries(stateEntries.slice(offset, offset + STAGED_MAX_QUESTIONS)));
    const stateRun = Promise.all(stateBatches.map(async questions => {
      try {
        const result = await ask('state', questions, stateEvidence({ transcript, latestInput: c.composerText, characters, secrets: wantSecrets ? story.secrets : [], playerName, maxChars: STAGED_MAX_STATE_CHARS }));
        const checked = validateStageAnswers('state', questions, result);
        for (const failure of checked.errors) report('state', new StagedError('state', failure.message, failure.type));
        stateRecords.push({ stage: 'state', questions, state: null, result: checked.result });
        return checked.result.answers;
      } catch (error) {
        report('state', error); stateError = (error as Error).message;
        return {};
      }
    })).then(batches => Object.assign({}, ...batches) as Record<string, Answer>);
    const judged = stateRun.then(answers => applyStateAnswers(built?.index ?? {}, answers, before.levels, knownBefore, before.assessed));
    const metersForRuling = wantMeters ? () => judged.then(state => meterFacts(pack, state.meters, playerName, state.assessed)) : undefined;

    const manual = c.kind === 'director_send' && !c.swipe && c.modules.decisions && this.actionDraft && !isOutOfCharacterMessage(visibleText(c.composerText)) ? this.buildDeclaredAction(c.actors) : null;
    let out: StagedOutput;
    try {
      out = await runStaged({
        pack, playerId: PLAYER_ACTOR_ID, actors: actorsIn, eligibleNpcIds: npcs, latestInput: c.composerText, transcript,
        pacing: c.modules.pacing ? { texts: this.settings.pacingTexts, handBack: this.settings.handBackBeats !== false, dynamicResponse: this.host.dynamicResponseEnabled(), playerName } : undefined,
        modules: c.modules, replay: c.replay ? c.retrySource?.stageRecords : undefined,
        manual: manual ? { text: `${manual.attemptedAction}\nRequested result: ${manual.requestedGain}\nUser-provided evidence: ${manual.availableEvidence}`,  ownerId: manual.actingActorId ?? manual.playerActorId, targetId: manual.targetActorIds[0] ?? null, familyKey: this.actionDraft!.templateId } : undefined,
        speakerQuestion: needSpeaker ? speakerQuestion(npcs, c.names, this.profile.speakers.includeYield, c.composerText.trim() || null) : null,
        reactionQuestions: Object.fromEntries(reactionTargets.map(id => [id, reactionQuestion(id)])),
        maxChars: STAGED_MAX_STATE_CHARS,
        meters: metersForRuling,
        lore: loreRun ? () => loreRun.then(turn => turn.result?.evidence ?? []) : undefined,
        maxLoreChars: this.settings.lore.judgeChars,
      }, { evaluate: ask });
    } catch (e) {
      report(e instanceof StagedError ? e.stage : 'move', e);
      out = { pacing: null, outcome: 'unruled', records: [], errors: [], speakerAnswer: null, reactionAnswers: {}, move: null, route: null, antecedentText: null, ruling: null };
    }
    for (const failure of out.errors) report(failure.stage, new StagedError(failure.stage, failure.message, failure.type));
    const judgedState = await judged;
    const loreTurn = loreRun ? await loreRun : null;
    clearTimeout(timer);
    if (loreTurn?.error) report('lore', abort.signal.reason instanceof JudgeWaitBudget ? abort.signal.reason : new Error(loreTurn.error));
    if (loreTurn?.result?.failedWorlds.length) report('lore', new StagedError('lore', 'Some lore questions had no valid answer', 'invalid_answers'));
    if (loreTurn) { const note = loreNote(loreTurn); if (note) notes.push(note); }
    if (stateError) notes.push(`Character state kept from before (the judge request failed: ${stateError}).`);
    else if (judgedState.changes.length) notes.push(`State: ${judgedState.changes.join('; ')}.`);
    out.records.push(...stateRecords);
    if (this.inFlight === abort) this.inFlight = null;
    const loreSteps = loreTurn?.result?.steps ?? [];
    const questions = Object.assign({}, ...out.records.map(r => r.questions), ...loreSteps.map(step => step.questions)) as Record<string, Question>;
    const answers = Object.assign({}, ...out.records.map(r => r.result.answers), ...loreSteps.flatMap(step => step.results.map(r => r.answers))) as Record<string, Answer>;
    const stateSent: Json = out.ruling?.projection.state ?? out.records.filter(r => r.state !== null).at(-1)?.state ?? null;
    const lastResult = out.records.at(-1)?.result ?? null;
    if (c.epoch !== this.epoch || this.chatKey !== c.chatKey || !this.settings.enabled || this.record?.paused
      || (abort.signal.aborted && !(abort.signal.reason instanceof JudgeWaitBudget))) {
      if (c.epoch === this.epoch && this.chatKey === c.chatKey) {
        this.inspect({ kind: 'info', message: 'Judge requests completed before preparation was cancelled.', networkCalls, requestUsage: mergeRequestUsage(receipts) });
        this.status = 'Ready'; this.refreshStatus();
      }
      return;
    }
    if (c.kind === 'director_send' && !c.swipe && this.host.composerText() !== c.composerText) {
      this.status = 'Ready';
      this.inspect({ kind: 'error', message: 'Composer text changed while deciding; preparation discarded (nothing was frozen).', questions, answers, stateSent, networkCalls, requestUsage: mergeRequestUsage(receipts) });
      this.host.toast('warning', 'Your message changed while Director was deciding. Press Send again.');
      await this.persist();
      return;
    }
    if (c.changed()) {
      this.reportJudgeError('invalid_answers', 'Settings changed while the judge was deciding; this reply has no ruling', {}, 'move');
      failedStages.add('move');
      out = { ...out, outcome: 'unruled', move: null, route: null, ruling: null, reactionAnswers: {} };
    }

    // The judged state belongs to this point of the transcript; swipes reuse it.
    // The lore chosen for this turn; swipes and continues of its reply reuse it.
    if (loreTurn?.result) this.record!.story = withLore(this.record!.story, cursorBefore, { at: Date.now(), refs: loreTurn.result.refs, evidenceRefs: loreTurn.result.evidenceRefs, requests: loreTurn.result.requests, books: loreTurn.books, failed: loreTurn.result.failedWorlds, scene: loreTurn.scene, configuration: loreTurn.configuration });
    const judgedMeters = structuredClone(storyBefore?.meters ?? {});
    const assessed = structuredClone(storyBefore?.assessed ?? Object.fromEntries(Object.entries(judgedMeters).map(([npc, values]) => [npc, Object.fromEntries(Object.keys(values).map(key => [key, true]))])));
    if (wantMeters) {
      for (const npc of stateNpcs) {
        judgedMeters[npc.id] = { ...judgedMeters[npc.id], ...judgedState.meters[npc.id] };
        assessed[npc.id] = { ...assessed[npc.id], ...judgedState.assessed[npc.id] };
      }
    }
    const storyAfter: StorySnapshot = { at: Date.now(), meters: judgedMeters, assessed, knownBy: judgedState.knownBy };
    const shownLevels = judgedMeters;
    const writerState = stateBlock({ pack, levels: wantMeters ? shownLevels : {}, assessed, names: c.names, playerName, secrets: record.story.secrets, knownBy: judgedState.knownBy, meters: wantMeters, secretsOn: wantSecrets });

    // Speaker: an NPC who owns the move (an order or a hand-off) writes the reply.
    let speaker: SpeakerDecision | null;
    if (!c.isGroup) {
      speaker = { questionId: null, eligibleActorIds: npcs, raw: null, adjusted: null, selected: c.explicit ?? npcs[0] ?? YIELD, source: c.explicit === YIELD ? 'explicit' : npcs.length ? 'single' : 'yield', tieBroken: false };
    } else if (c.nativeSpeaker) {
      speaker = null;
    } else {
      const decided = decideSpeaker({
        candidates: c.candidates, explicitActorId: c.explicit, includeYield: this.profile.speakers.includeYield, priors: this.profile.speakers.priors,
        repetitionFactor: this.profile.speakers.repetitionFactor, lastSpeakerActorId: c.lastSpeakerActorId, answer: out.speakerAnswer, questionId: needSpeaker ? 'speaker' : null,
      });
      if (!decided.ok) {
        report('speaker', new StagedError('speaker', decided.error, 'invalid_answers'));
        speaker = null; // SillyTavern chooses when the speaker stage fails.
      } else speaker = decided.decision;
    }
    if (c.replay && c.retrySource?.frozenSpeaker && !c.retrySource.judgeFailedStages?.includes('speaker')) speaker = structuredClone(c.retrySource.frozenSpeaker);
    const route = out.route;
    const npcOwner = route && (route.route === 'SPECIFIED_NPC_MOVE' || route.route === 'HANDOFF') && route.ownerId && npcs.includes(route.ownerId) ? route.ownerId : null;
    if (npcOwner && c.isGroup && !c.explicit) {
      speaker = { questionId: speaker?.questionId ?? null, eligibleActorIds: npcs, raw: speaker?.raw ?? null, adjusted: speaker?.adjusted ?? null, selected: npcOwner, source: 'move_owner', tieBroken: false };
    }

    // Ruling or reaction.
    let action: ActionSpec | null = null;
    let resolution: FrozenResolution | null = null;
    let bandId: string | null = null;
    let reaction: ReactionResult | null = null;
    const advisoryNotes: string[] = [];
    let unruledReason: string | null = out.outcome === 'unruled' ? route?.reason ?? 'the routing is unresolved' : null;
    try {
    if (out.outcome === 'ruled' && route && out.move && out.ruling) {
      const staged = this.stagedAction(out, 0, pack);
      const declared = manual ? { ...manual, pipeline: 'staged' as const, move: staged.move } : staged;
      const gate = gateAction(declared, established, this.profile.outcomes, {
        actorPolicy: this.profile.actorPolicy, playerActorId: PLAYER_ACTOR_ID, currentSceneId: 0,
      });
      const snapshot: DecisionSnapshot = { ...snapshotBase(), state: out.ruling.projection.state };
      if (gate.kind === 'skip' || gate.kind === 'pause') {
        unruledReason = `the actor policy leaves it unruled (${gate.reason.replace(/_/g, ' ')})`;
      } else if (gate.kind === 'rules') {
        action = declared;
        resolution = freeze({
          resolutionId: newId('res'), previousResolutionId: null, action: declared, snapshot, assessment: null, decisionSource: 'rules', policyRevision: this.profile.revision,
          band: null, method: 'rules', draw: null, outcome: gate.outcome.name, def: gate.outcome, cursorBefore: null, generation: 1, providerKind: null, requestedModel: null, returnedModel: null, now: Date.now(),
        });
      } else if (this.profile.mode === 'binding') {
        const sig = normaliseSignal(out.ruling.answer);
        if (!sig.ok) throw new StagedError('ruling', sig.error, 'invalid_answers');
        const draw = this.profile.resolutionMethod === 'sample' ? randomDraw().u : null;
        const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: this.profile.resolutionMethod, signal: sig.signal, draw });
        if (!resolved.ok) throw new StagedError('ruling', resolved.error, 'invalid_answers');
        action = declared;
        bandId = resolved.value.band.id;
        resolution = freeze({
          resolutionId: newId('res'), previousResolutionId: null, action: declared, snapshot, assessment: out.ruling.answer, decisionSource: 'provider', policyRevision: this.profile.revision,
          band: resolved.value.band, method: resolved.value.method, draw: resolved.value.draw, outcome: resolved.value.outcome, def: resolved.value.def, cursorBefore: null, generation: 1,
          providerKind: lastResult?.provider ?? null, requestedModel: lastResult?.requestedModel ?? null, returnedModel: lastResult?.returnedModel ?? null, now: Date.now(),
        });
      } else {
        const sig = normaliseSignal(out.ruling.answer);
        if (sig.ok) advisoryNotes.push(`Support for "${out.move.span.text}" is assessed at ${sig.signal.x.toFixed(2)} on a 0–1 scale. Treat this as guidance about plausibility, not a ruling.`);
      }
    } else if (out.outcome === 'handoff' && route?.ownerId && c.modules.reactions) {
      try { reaction = chooseReaction('initiative', c.reactionSettings, route.ownerId, randomDraw().u); }
      catch (error) { this.inspect({ kind: 'info', message: `Hand-off reaction skipped: ${(error as Error).message}` }); }
    } else if (out.outcome === 'no_move' && c.modules.reactions && speaker && speaker.selected !== YIELD) {
      const answer = out.reactionAnswers[speaker.selected];
      if (answer?.type === 'choice' && ['resolve', 'secret', 'exposure'].includes(answer.choice)) {
        try { reaction = chooseReaction(answer.choice as ReactionKind, c.reactionSettings, speaker.selected, randomDraw().u); }
        catch (error) { this.inspect({ kind: 'info', message: `NPC reaction skipped: ${(error as Error).message}` }); }
      }
    }

    } catch (error) {
      report('ruling', error);
      action = null;
      resolution = null;
      bandId = null;
      unruledReason = 'the judge was unavailable';
    }
    // Recovery only after every report of the turn (speaker and ruling report late).
    for (const stage of askedStages) if (!failedStages.has(stage)) this.recoverJudgeStage(stage);

    if (c.replay && c.retrySource) {
      if (c.retrySource.resolutionId) resolution = this.record!.resolutions[c.retrySource.resolutionId] ?? resolution;
      if (c.retrySource.reaction && !c.retrySource.judgeFailedStages?.includes('reaction')) reaction = structuredClone(c.retrySource.reaction);
    }
    const name = (id: string | null | undefined) => (id ? c.names[id] ?? id : '');
    const moveText = out.move ? `"${out.move.span.text}"` : 'no move to rule on';
    const routeParts = route ? [route.route.toLowerCase().replace(/_/g, ' '), route.familyKey, route.ownerId ? `owner ${name(route.ownerId)}` : '', route.targetId ? `target ${name(route.targetId)}` : '',
      out.ruling?.answer.type === 'noul' ? `P=${out.ruling.answer.noul.toFixed(2)}` : ''].filter(Boolean) : [];
    const messageSuffix = ` Staged: ${moveText}${routeParts.length ? ` (${routeParts.join(', ')})` : ''}; ${networkCalls || out.records.length} request${(networkCalls || out.records.length) === 1 ? '' : 's'}.${notes.length ? ' ' + notes.join(' ') : ''}`;
    const speakerLabel = speaker ? name(speaker.selected) : 'chosen by SillyTavern';
    const fallbackMessage = unruledReason ? `Staged: unruled, because ${unruledReason}. Speaker ${speakerLabel}.${messageSuffix}`
      : out.outcome === 'handoff' ? `Staged: hand-off to ${name(route?.ownerId)}; NPC reactions are off, so no response was drawn. Speaker ${speakerLabel}.${messageSuffix}`
      : advisoryNotes.length ? `Advisory: support assessed, no binding outcome. Speaker ${speakerLabel}.${messageSuffix}`
      : `Speaker ${speakerLabel}; no move to rule on.${messageSuffix}`;
    await this.finishTurn({
      packId: pack.id,
      kind: c.kind, swipe: c.swipe, nativeSwipePending: c.nativeSwipePending, composerText: c.composerText, epoch: c.epoch, actors: c.actors, isGroup: c.isGroup, names: c.names, speaker,
      preparedAction: action, resolution, bandId, reaction, snapshot: { ...snapshotBase(), state: loreSceneState(transcript, c.composerText, c.names, STAGED_MAX_STATE_CHARS) }, established,
      decisionsOn: c.modules.decisions, disarmDeclaration: Boolean(manual) && c.kind === 'director_send' && !c.swipe, advisoryNotes,
      questions: Object.keys(questions).length ? questions : null, answers, stateSent, result: lastResult, networkCalls, requestUsage: mergeRequestUsage(receipts),
      actionId: action?.actionId ?? null, applicability: action?.applicability ?? null, fallbackMessage, messageSuffix, stateBlock: writerState,
      loreCursor: loreTurn?.result ? cursorBefore : null,
      storyBefore: storyBefore ? structuredClone(storyBefore) : null,
      storyAfter, pacing: out.pacing, stageRecords: out.records, failedStages: [...failedStages], outcome: out.outcome, retrySource: c.replay ? c.retrySource : undefined,
    });
  }

  /**
   * Stage C for one staged turn. Books come from every cast member (a group
   * scan only loads the speaker's, so the ruling may know more than the
   * writer's World Info can carry). Never rejects: a failure leaves
   * SillyTavern's keyword lore in charge for the turn.
   */
  private startLore(c: StagedTurnContext, transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[], ask: (stage: StageId, questions: Record<string, Question>, state: Json) => Promise<EvaluationResult>): Promise<LoreTurn> {
    const settings = this.settings.lore;
    const cast = [...new Set([...c.eligible, ...(c.explicit ? [c.explicit] : [])])].map(id => c.actors.byId[id]?.avatar).filter((a): a is string => Boolean(a));
    return (async (): Promise<LoreTurn> => {
      try {
        const catalog = await this.host.loreCatalog(cast);
        const roots = this.host.tunnelVisionRoots();
        const inputs: LoreBookInput[] = [];
        for (const book of catalog.books) {
          if (effectiveMode(settings, book.world, this.host.tunnelVisionManages(book.world)) === 'off') continue;
          const tree = buildTree(book.world, catalog.entries, roots[book.world] ?? null);
          if (tree) inputs.push({ tree, public: bookSettings(settings, book.world).public });
        }
        const books = catalog.books.map(b => b.world);
        if (inputs.length === 0) return { result: null, books, error: null };
        const scene = loreSceneState(transcript, c.composerText, c.names, LORE_STATE_CHARS);
        const configuration = hash53(JSON.stringify([settings, inputs.map(book => [book.tree.world, book.public, [...book.tree.entries.keys()]])]));
        const frozen = c.replay && c.retrySource?.loreCursor ? this.record?.story.lore[c.retrySource.loreCursor] : null;
        if (frozen && !c.retrySource?.judgeFailedStages?.includes('lore')) {
          return { result: reuseLorePicks(inputs, frozen), books, error: null, scene: frozen.scene ?? loreSceneAnchor(scene), configuration };
        }
        const previous = this.record ? loreAt(this.record.story, cursorChain(this.record.seedId, this.host.fingerprintMessages(c.transcriptPrefix ?? this.host.chat()))) : null;
        const reuse = previous?.scene !== undefined && previous.configuration === configuration && previous.failed.length === 0;
        // The continuity gate sees public scene text only, never picked titles.
        const state: Json = reuse ? { ...(scene as Record<string, Json>), previousScene: visibleJudgeData(previous.scene!) } : scene;
        const result = await runLoreStage(inputs, () => questions => ask('lore', questions, state), {
          width: settings.width, minProbability: settings.minProbability, maxEntries: settings.maxEntries, maxDepth: settings.maxDepth,
        }, reuse ? { previous, sceneQuestion: loreSceneQuestion() } : undefined);
        return { result, books, error: null, scene: result.reused ? previous!.scene : loreSceneAnchor(scene), configuration };
      } catch (e) {
        return { result: null, books: [], error: e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message };
      }
    })();
  }

  /**
   * Arms the writer's World Info scan with the lore of the turn an attempt
   * belongs to. Lore binds to attempts, never to transcript position, so a tool
   * follow-up, a swipe of it, or a later Next turn each get exactly their own.
   */
  private async armLoreForAttempt(attemptId: string | null | undefined): Promise<void> {
    if (!attemptId || !this.record || !this.settings.modules.lore) return;
    const attempt = this.record.attempts[attemptId];
    if (!attempt) return;
    let plan = attempt.frozenLorePlan;
    if (plan === undefined && attempt.loreCursor) {
      const found = this.record.story.lore[attempt.loreCursor];
      if (found) {
        const legacy = lorePlan(found.refs, world => effectiveMode(this.settings.lore, world, this.host.tunnelVisionManages(world)), found.books, found.failed, this.settings.lore.placeNearEnd);
        plan = { force: [...legacy.force], managed: [...legacy.managed], nearEnd: legacy.nearEnd };
        attempt.frozenLorePlan = plan;
      }
    }
    if (!plan) return;
    try {
      await this.host.armLore({ force: new Set(plan.force), managed: new Set(plan.managed), nearEnd: plan.nearEnd });
    } catch (error) {
      void this.host.armLore(null);
      this.reportJudgeError('network', 'Lore unavailable: ' + (error as Error).message, {}, 'lore');
    }
  }

  /** The frozen action for a staged ruling: the player's own passage, routed. */
  private stagedAction(out: StagedOutput, sceneId: number, pack: GenrePack): ActionSpec {
    const route = out.route!;
    const span = out.move!.span;
    const action = declareAction({
      actionId: newId('act'),
      // The pack family is kept on the move; the template only shapes identity and labels.
      templateId: templateById(route.familyKey!) ? route.familyKey! : 'acquire_secure',
      actingActorId: route.ownerId!,
      playerActorId: PLAYER_ACTOR_ID,
      targetActorIds: route.targetId && !['SELF', 'SEVERAL', 'SCENE'].includes(route.targetId) ? [route.targetId] : [],
      attemptedAction: out.antecedentText ? `${span.text} (referring to: ${out.antecedentText})` : span.text,
      requestedGain: span.text,
      applicability: 'favorable',
      uncertainConsequential: true,
      opposed: false,
      resolutionScope: 'attempt',
      sceneId,
      persistentFactKey: '',
      failureStake: { kind: 'other', detail: 'Failure must move the scene without erasing established progress or inventing a disproportionate consequence.' },
      availableEvidence: '',
    })!;
    action.pipeline = 'staged';
    action.move = {
      packId: pack.id, packVersion: pack.version, spanId: span.id, passage: span.text, antecedent: out.antecedentText, route: route.route,
      familyKey: route.familyKey!, ownerId: route.ownerId!, targetId: route.targetId, specification: route.specification, count: out.move!.count,
    };
    if (out.move!.count === 'multiple') action.additionalAttemptsPolicy = 'defer_after_first';
    return action;
  }

  /** The staged ruling question for a frozen move, for Reassess on the same evidence. */
  private stagedRulingQuestion(move: StagedMove): Question {
    const pack = packById(move.packId);
    const family = familyByKey(pack, move.familyKey) ?? pack.families[0]!;
    return rulingQuestion({ family, pack, hasAntecedent: move.antecedent !== null });
  }

  /** End of a staged turn: writer injection, prepared attempt, generation. */
  private async finishTurn(t: TurnFinish): Promise<void> {
    const { kind, composerText, epoch, actors, isGroup, names, speaker, resolution, reaction } = t;
    // Keep a Send's preparation separate from a swipe which started during
    // judging; its tool window and injection still belong to that writer.
    if (!t.nativeSwipePending && !t.swipe && this.host.isGenerating() && this.currentAttemptId) {
      await new Promise<void>(resolve => this.writerIdleWaiters.add(resolve));
      await this.waitForMessageTasks();
      if (epoch !== this.epoch) return;
    }
    const speakerId = speaker ? speaker.selected : null;
    const speakerName = speakerId && speakerId !== YIELD ? names[speakerId] ?? null : null;
    const playerName = this.host.playerName();
    const attemptId = newId('att');
    const toolRequestId = newId('toolreq');
    const writerTool = this.host.writerToolCapability('normal');
    const keptPermit = t.retrySource?.permitId ? this.record?.permits[t.retrySource.permitId] : null;
    const toolAvailable = !keptPermit && t.decisionsOn && speakerId !== null && this.toolRegistered && writerTool.supported && !this.host.isAutoDirectorEnabled();
    const evidenceRefs = [
      'latest_input',
      ...this.host.chat().map((_, index) => `msg:${index}`).slice(-this.profile.budgets.maxRecentMessages),
      ...Object.keys(t.established).sort().map(key => `state:${key}`),
    ];
    const binding = resolution ? bindingBlock({
      action: resolution.action,
      outcome: resolution.outcome,
      instruction: instructionForResolution(resolution),
      actorName: names[resolution.action.actingActorId ?? resolution.action.playerActorId] ?? resolution.action.actingActorId ?? resolution.action.playerActorId,
      speakerName,
      playerName,
      targetNames: resolution.action.targetActorIds.map(id => names[id] ?? id),
      npcActionPolicy: keptPermit ? 'permitted' : toolAvailable ? 'checkpoint' : 'defer',
    }) : '';
    const advisory = advisoryBlock({ influence: this.profile.advisoryInfluence, notes: t.advisoryNotes });
    const planning = t.decisionsOn ? keptPermit ? permitFollowupBlock(keptPermit) + '\nThe Director tool is closed for this reply; do not call it.' : toolPlanningBlock({ attemptId, requestId: toolRequestId, speakerActorId: speakerId ?? '', evidenceRefs, toolAvailable }) : '';
    const replyNudge = this.settings.modules.replyCheck ? (t.retrySource?.replyNudge ?? this.selectedAttempt()?.replyCheck?.nudge ?? '') : '';
    const injected = [combinedBlock(binding, advisory), t.stateBlock, this.reactionBlock(reaction), this.settings.modules.pacing ? pacingBlock(t.pacing ?? null, this.settings.handBackBeats !== false, this.host.dynamicResponseEnabled()) : '', replyNudge, planning].filter(Boolean).join('\n\n');

    if (speakerId === YIELD) {
      const usage = summarizeUsage(t.requestUsage ?? []);
      this.inspect({ kind: 'yield', message: 'Director yielded: no NPC reply.', questions: t.questions, answers: t.answers, stateSent: t.stateSent, speaker, networkCalls: t.networkCalls, requestUsage: t.requestUsage, providerKind: t.result?.provider ?? null, durationMs: usage.durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actionId: t.actionId, applicability: t.applicability });
      // The speaker override is for the next reply only; this yield used it up.
      this.speakerOverride = null;
      this.status = 'Ready';
      if (composerText.trim()) {
        const posted = await this.host.postUserMessage(composerText);
        this.host.toast('info', posted ? 'Director yields: your message was posted without an NPC reply.' : 'Director yields. No NPC reply; your message stays in the composer.');
      } else {
        this.host.toast('info', 'Director yields: no NPC needs to speak.');
      }
      await this.persist();
      this.notify();
      return;
    }

    this.apply({ type: 'prepare', resolution, action: t.preparedAction, reaction, attemptId, actorId: speakerId, epoch, composerText, now: Date.now() });
    const prepared = this.record?.attempts[attemptId];
    if (prepared) {
      prepared.requestUsage = mergeRequestUsage(t.retrySource?.requestUsage, t.requestUsage);
      prepared.frozenPackId = t.packId;
      // The decisions module ran without failing: a ruling, a kept permit, or a judged
      // no-move, hand-off, OOC-only message, policy skip or advisory note. Only a failed
      // decision stage or an UNRULED route leaves it unapplied.
      const decisionFailed = (t.failedStages ?? []).some(stage => ['move', 'route', 'ruling'].includes(stage));
      prepared.decisionsApplied = Boolean(t.decisionsOn && (resolution || keptPermit || (!decisionFailed && t.outcome !== 'unruled')));
      prepared.frozenPacing = structuredClone(t.pacing ?? null);
      prepared.replyNudge = replyNudge;
      prepared.loreCursor = t.loreCursor;
      prepared.storyBefore = structuredClone(t.storyBefore);
      prepared.storyAfter = structuredClone(t.storyAfter);
      prepared.frozenStateBlock = t.stateBlock;
      prepared.frozenSpeaker = speaker ? structuredClone(speaker) : null;
      prepared.judgeErrors = [...this.turnErrors];
      prepared.judgeFailedStages = t.failedStages ?? [];
      prepared.stageRecords = structuredClone(t.stageRecords ?? []);
      prepared.turnKind = kind;
      prepared.inputText = composerText;
      if (t.retrySource?.permitId) prepared.permitId = t.retrySource.permitId;
      const found = t.loreCursor ? this.record?.story.lore[t.loreCursor] : null;
      const plan = found ? lorePlan(found.refs, world => effectiveMode(this.settings.lore, world, this.host.tunnelVisionManages(world)), found.books, found.failed, this.settings.lore.placeNearEnd) : null;
      prepared.frozenLorePlan = plan ? { force: [...plan.force], managed: [...plan.managed], nearEnd: plan.nearEnd } : null;
    }
    this.preparedTool = {
      requestId: toolRequestId,
      attemptId,
      speakerActorId: speakerId ?? '',
      snapshot: t.snapshot,
      actorNames: names,
      allowedEvidenceRefs: evidenceRefs,
      available: toolAvailable,
    };
    this.speakerOverride = null;
    if (t.disarmDeclaration) {
      // Declarations are one-shot. The frozen action remains on the attempt for
      // wording retries and explicit rerolls, but the composer form disarms.
      this.actionDraft = null;
      this.actionDraftRevision += 1;
    }
    const usage = summarizeUsage(t.requestUsage ?? []);
    this.inspect({
      kind, attemptId, resolutionId: resolution?.resolutionId ?? null, actionId: t.actionId, applicability: t.applicability,
      questions: t.questions, stateSent: t.stateSent, answers: t.answers, speaker, policyBandId: t.bandId,
      draw: resolution?.draw ?? null, outcome: resolution?.outcome ?? null, injectedText: injected || null, providerKind: t.result?.provider ?? null,
      requestedModel: t.result?.requestedModel ?? null, returnedModel: t.result?.returnedModel ?? null, durationMs: usage.durationMs,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, networkCalls: t.networkCalls, requestUsage: t.requestUsage,
      message: resolution ? `Frozen ${resolution.outcome} (${resolution.method}${t.bandId ? ', band ' + t.bandId : ''}) for ${names[resolution.action.actingActorId ?? PLAYER_ACTOR_ID] ?? resolution.action.actingActorId ?? playerName}; reply speaker ${speakerName ?? speakerId ?? 'chosen by SillyTavern'}.${t.messageSuffix}`
        : reaction ? `NPC ${reaction.kind}: ${reaction.outcome} for ${names[reaction.actorId] ?? reaction.actorId}; sampled from configured weights, preserved across wording swipes.${t.messageSuffix}`
        : t.fallbackMessage,
    });
    this.pendingForSwipe = Boolean(t.swipe);
    this.preparedInputCursor = t.swipe ? t.snapshot.cursorBefore : null;
    this.pendingInjection = injected;
    this.status = resolution ? 'Frozen' : 'Ready';
    await this.persist();

    if (t.nativeSwipePending) return;
    // A swipe can start while Send is being judged. Keep the Send queued.
    if (this.host.isGenerating()) {
      if (this.replyBinding && this.currentAttemptId && this.currentAttemptId !== attemptId) {
        await new Promise<void>(resolve => this.writerIdleWaiters.add(resolve));
      } else {
        this.apply({ type: 'cancel', attemptId, epoch, reason: 'another generation started before this Send was bound' });
        this.host.toast('info', 'Another reply started. Your message is still in the composer; press Send when it finishes.');
        this.status = 'Ready';
        return;
      }
    }
    await this.waitForMessageTasks();
    if (epoch !== this.epoch) return;

    const actor = speakerId ? actors.byId[speakerId] : undefined;
    const forceIndex = isGroup && actor ? this.host.resolveIndex(actor.avatar) : null;
    this.host.setComposerLocked(false);
    this.status = 'Writing';
    this.notify();
    let settleWriter!: () => void;
    const writerSettled = new Promise<void>(resolve => { settleWriter = resolve; });
    this.writerSettled = writerSettled;
    try {
      try { if (t.swipe) await this.host.swipeRight(forceIndex); else await this.host.generate(forceIndex !== null && forceIndex >= 0 ? forceIndex : null); }
      finally { settleWriter(); if (this.writerSettled === writerSettled) this.writerSettled = null; }
    } catch (e) {
      console.warn('[RP Director] generate failed', e);
    } finally {
      if (epoch !== this.epoch) return;
      this.pendingForSwipe = false;
      this.preparedDeadline = null;
      await this.waitForMessageTasks(attemptId);
      if (epoch !== this.epoch) return;
      const attempt = this.record?.attempts[attemptId];
      if (attempt && (attempt.status === 'writing' || attempt.status === 'prepared')) {
        this.apply({ type: 'cancel', attemptId, epoch, reason: 'the writer finished without a completed message (cancelled, failed, or aborted)' });
        this.host.toast('warning', 'No reply was completed. The frozen decision is still available for retry.');
      }
      if (this.currentAttemptId === attemptId) this.currentAttemptId = null;
      this.pendingInjection = '';
      this.preparedTool = null;
      if (this.toolWindow?.attemptId === attemptId) this.toolWindow = null;
      this.host.clearInjection();
      if (this.status === 'Writing' || this.status === 'Frozen') this.status = 'Ready';
      await this.persist();
      this.refreshStatus();
    }
  }

  // ---- story: genre pack, character state, secrets -------------------------------

  /** This chat's genre pack; Auto uses the default pack until the judge picks one. */
  chatPack(): GenrePack {
    const id = this.record?.story.packId;
    return id && id !== 'auto' && hasPack(id) ? packById(id) : packById('default');
  }

  chatPackInfo(): { packId: string; source: 'auto' | 'judge' | 'user'; label: string } | null {
    if (!this.record) return null;
    const { packId, packSource } = this.record.story;
    return { packId, source: packSource, label: packId === 'auto' ? 'Auto' : this.chatPack().label };
  }

  packsForUi(): { id: string; label: string; description: string }[] {
    return listPacks().map(p => ({ id: p.id, label: p.label, description: p.description }));
  }

  async setChatPack(packId: string): Promise<void> {
    if (packId !== 'auto' && !hasPack(packId)) throw new Error('Unknown genre pack; choose a listed pack id or auto.');
    if (!this.record) return;
    const id = packId === 'auto' || hasPack(packId) ? packId : 'auto';
    this.record.story = { ...this.record.story, packId: id, packSource: id === 'auto' ? 'auto' : 'user' };
    await this.persist();
    this.notify();
  }

  /** Judged meter levels at the head of the transcript, for display. */
  characterStateForUi(): { name: string; meters: { label: string; level: string; rank: string }[] }[] {
    if (!this.record) return [];
    const snap = snapshotAt(this.record.story, this.chainNow());
    if (!snap) return [];
    const pack = this.chatPack();
    return Object.entries(snap.meters).map(([npc, values]) => ({
      name: this.record!.actors[npc]?.name ?? npc,
      meters: pack.meters.filter(m => Number.isInteger(values[m.key])).map(m => ({ label: meterLabel(m, PLAYER_LABEL), level: snap.assessed !== undefined && snap.assessed[npc]?.[m.key] !== true ? 'not yet judged' : m.levels[values[m.key]!]!, rank: snap.assessed !== undefined && snap.assessed[npc]?.[m.key] !== true ? '' : `${values[m.key]! + 1} of ${m.levels.length}` })),
    })).filter(entry => entry.meters.length > 0);
  }

  /** The most recent lore choice on this branch, for display. */
  lastLoreForUi(): { at: number; entries: { book: string; title: string }[]; requests: number } | null {
    if (!this.record) return null;
    const chain = this.chainNow();
    const found = loreAt(this.record.story, chain, chain.length);
    return found ? { at: found.at, entries: found.refs.map(r => ({ book: r.world, title: r.title })), requests: found.requests } : null;
  }

  /** Every lorebook the open chat's cast could draw on, with its Director settings. */
  async loreBooksForUi(): Promise<{ world: string; source: string; entries: number; selectable: number; index: 'tunnelvision' | 'none'; tunnelVisionManages: boolean; mode: LoreBookMode; public: boolean; configured: boolean }[]> {
    if (!this.record) return [];
    const catalog = await this.host.loreCatalog(Object.values(this.actorMap().byId).map(a => a.avatar));
    const roots = this.host.tunnelVisionRoots();
    return catalog.books.map(book => {
      const entries = catalog.entries.filter(e => e.world === book.world);
      const own = bookSettings(this.settings.lore, book.world);
      return {
        world: book.world, source: book.source, entries: entries.length, selectable: entries.filter(selectable).length,
        index: roots[book.world] ? 'tunnelvision' as const : 'none' as const, tunnelVisionManages: this.host.tunnelVisionManages(book.world),
        mode: own.mode, public: own.public, configured: Boolean(this.settings.lore.books[book.world]),
      };
    });
  }

  /** Per book: what the last reply's World Info scan put into the prompt. */
  loreActivationForUi(): { at: number; books: Record<string, { entries: number; chars: number; picked: number }> } | null {
    return this.host.lastLoreActivation();
  }

  setLoreBook(world: string, patch: Partial<{ mode: LoreBookMode; public: boolean }>): void {
    const current = bookSettings(this.settings.lore, world);
    this.settings.lore.books[world] = { ...current, ...patch };
    this.host.saveSettings();
    this.notify();
  }

  secretsForUi(): { id: string; text: string; holders: string[]; knownBy: string[] }[] {
    if (!this.record) return [];
    const known = knownByAt(this.record.story, this.chainNow());
    return this.record.story.secrets.map(s => ({ id: s.id, text: s.text, holders: [...s.holders], knownBy: known[s.id] ?? [...s.holders] }));
  }

  async addSecret(text: string, holders: string[]): Promise<void> {
    if (!this.record || !text.trim()) return;
    const used = new Set(this.record.story.secrets.map(s => s.id));
    let n = this.record.story.secrets.length + 1;
    while (used.has(`s${n}`)) n++;
    this.record.story = { ...this.record.story, secrets: [...this.record.story.secrets, { id: `s${n}`, text: text.trim(), holders: [...new Set(holders)] }] };
    await this.persist();
    this.notify();
  }

  async removeSecret(id: string): Promise<void> {
    if (!this.record) return;
    this.record.story = { ...this.record.story, secrets: this.record.story.secrets.filter(s => s.id !== id) };
    await this.persist();
    this.notify();
  }

  /** Explicit manual input is routed through the staged evidence rules. */
  private buildDeclaredAction(actors: ActorMap): ActionSpec | null {
    const draft = this.actionDraft;
    if (!draft) return null;
    const validActor = (id: string) => id === PLAYER_ACTOR_ID || Boolean(actors.byId[id]);
    return declareAction({
      actionId: newId('act'), templateId: templateById(draft.templateId) ? draft.templateId : 'acquire_secure', actingActorId: validActor(draft.actingActorId) ? draft.actingActorId : PLAYER_ACTOR_ID,
      playerActorId: PLAYER_ACTOR_ID, targetActorIds: draft.targetActorIds.filter(validActor), attemptedAction: draft.attemptedAction,
      requestedGain: draft.requestedGain, applicability: draft.applicability, uncertainConsequential: draft.uncertainConsequential,
      opposed: draft.opposed, resolutionScope: 'attempt', sceneId: 0,
      persistentFactKey: '', failureStake: { kind: draft.failureStakeKind, detail: draft.failureStakeDetail }, availableEvidence: draft.availableEvidence,
    });
  }



  // ---- plan-only writer tool -------------------------------------------------

  private shouldOfferWriterTool(): boolean {
    if (!this.settings.enabled || this.record?.paused || !this.settings.modules.decisions || !this.toolRegistered || this.host.isAutoDirectorEnabled()) return false;
    return this.host.writerToolCapability('normal').supported;
  }

  private toolFailure(window: ToolWindow, code: ToolProposalErrorCode | 'recursive_tool_call' | 'provider_failed' | 'stale_context' | 'prose_before_tool', message: string, malformed = false, cause?: unknown): string {
    window.error = `${code}: ${message}`;
    const failure = stageError('ruling', cause ?? (code === 'provider_failed' ? new Error(message) : new StagedError('ruling', message, 'invalid_answers')));
    if (code === 'provider_failed') this.reportJudgeError(failure.type, `NPC judge unavailable: ${message}`, {}, 'npc');
    else {
      this.inspect({ kind: 'error', message: `Writer tool request rejected: ${message}` });
      if (!this.errorTypes.has(`tool:${code}`)) { this.errorTypes.add(`tool:${code}`); this.host.toast('warning', "The writer's move could not be ruled. Your chat isn't affected."); }
    }
    const attempt = this.record?.attempts[window.attemptId];
    if (attempt && code === 'provider_failed') attempt.judgeErrors = [...new Set([...(attempt.judgeErrors ?? []), failure.type])];
    window.phase = malformed ? 'malformed_pending' : 'failed_pending';
    this.apply({ type: 'tool_result', attemptId: window.attemptId, permit: null, status: malformed ? 'malformed' : 'failed', error: window.error });
    this.inspect({ kind: 'tool_checkpoint', attemptId: window.attemptId, message: `Tool checkpoint refused: ${window.error}`, networkCalls: 0 });
    void this.persist();
    return JSON.stringify({ schemaVersion: 1, ok: false, code, message, attemptId: window.attemptId, retryAllowed: false });
  }

  private async onToolCall(raw: unknown): Promise<string> {
    const window = this.toolWindow;
    // saveReply may have announced prose before ST dispatches the tool. That
    // object is an intermediary, never the reply that receives the decision.
    const binding = this.replyBinding;
    const intermediary = binding ? this.host.chat()[binding.index] : null;
    if (intermediary && !intermediary.is_user && !intermediary.is_system) { binding!.rejected.add(intermediary); binding!.end(); }
    // A tool call during the automatic rewrite's generation: the message it saved
    // was an intermediary, not the rewrite, and SillyTavern's next 'normal'
    // generation is the rewrite's follow-up, even after a cancel cleared our state.
    const automatic = this.automaticReply;
    if (automatic?.started && automatic.chatKey === this.chatKey
      && (automatic.cancelled || automatic.attemptId === (this.currentAttemptId ?? this.completionCandidate))) {
      automatic.finished = false;
      automatic.toolFollowUp = true;
    }
    if (!this.settings.enabled || this.record?.paused || !this.settings.modules.decisions || !window || window.phase !== 'initial' || this.currentAttemptId !== window.attemptId) {
      const id = this.currentAttemptId ?? this.completionCandidate;
      if (id && this.settings.enabled && !this.record?.paused) {
        const attempt = this.record?.attempts[id];
        const injection = window?.permit
          ? [(attempt?.injectedText ?? '').split('[Director NPC-action checkpoint]')[0], permitFollowupBlock(window.permit)].filter(Boolean).join('\n\n')
          : attempt?.injectedText || this.pendingInjection || '';
        this.toolContinuation = { attemptId: id, injection: injection + '\n\n[Director tool result]\nThe Director tool is closed for this reply; continue with the same frozen decisions and do not call it again.' };
      }
      return JSON.stringify({ schemaVersion: 1, ok: false, code: 'tool_window_closed', message: 'The Director tool is closed. Continue with the frozen decisions without another tool call.', retryAllowed: false });
    }
    if (window.used) return this.toolFailure(window, 'recursive_tool_call', 'Only one Director tool call is allowed per writer attempt.');
    window.used = true;

    const ignoredPriorReply = window.priorReplyText !== undefined
      && stripResultFooter(this.host.chat()[window.chatLengthAtBind]?.mes ?? '') === window.priorReplyText;
    const priorProse = this.host.assistantProseSince(window.chatLengthAtBind + (ignoredPriorReply ? 1 : 0));
    if (priorProse.length > 0) return this.toolFailure(window, 'prose_before_tool', 'The writer emitted prose before requesting adjudication; the proposal is not accepted.', true);

    const validation = validateTurnProposal(raw, {
      requestId: window.requestId,
      attemptId: window.attemptId,
      speakerActorId: window.speakerActorId,
      knownActorIds: Object.keys(this.record?.actors ?? {}),
      allowedEvidenceRefs: window.allowedEvidenceRefs,
    });
    if (!validation.ok) return this.toolFailure(window, validation.code, validation.message);

    let provider: DecisionProvider;
    const receipts: RequestUsage[] = [];
    let usageRecorded = false;
    try { provider = this.usageProvider(this.planningProvider(this.provider()), 'npc_action', receipts); } catch (error) { return this.toolFailure(window, 'provider_failed', (error as Error).message, false, error); }
    const controller = new AbortController();
    this.inFlight = controller;
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const timer = setTimeout(() => controller.abort(new JudgeWaitBudget()), Math.max(0, this.settings.waitForJudgeSeconds) * 1000);
    const started = Date.now();
    const frozenProfile = structuredClone(this.profile);
    const stillCurrent = () => epoch === this.epoch && chatKey === this.chatKey && this.toolWindow === window
      && this.settings.enabled && !this.record?.paused && !this.host.isAutoDirectorEnabled()
      && this.record?.attempts[window.attemptId]?.status === 'writing'
      && this.cursorOf(this.host.chat().slice(0, window.chatLengthAtBind)) === window.baseCursor
      && this.profile.revision === frozenProfile.revision;
    try {
      const adjudicationInput = {
        proposal: validation.proposal,
        provider,
        profile: frozenProfile,
        snapshot: window.snapshot,
        actorNames: window.actorNames,
        playerName: this.host.playerName(),
        signal: controller.signal,
      };
      const adjudicated = await withinBudget(adjudicateTurnProposal(adjudicationInput), controller.signal);
      if (!stillCurrent() || controller.signal.aborted) return JSON.stringify({ ok: false, code: 'cancelled' });
      clearTimeout(timer);
      const kept = this.settings.reviewNpcRolls ? await reviewPermit({
        initial: adjudicated.permit, signal: controller.signal, isCurrent: stillCurrent, method: frozenProfile.resolutionMethod,
        choose: permit => this.host.reviewRolls(permit, window.actorNames, frozenProfile.resolutionMethod, controller.signal),
        reroll: async permit => frozenProfile.resolutionMethod === 'sample'
          ? rerollPermit(permit, frozenProfile, window.actorNames, adjudicationInput.playerName)
          : this.reassessPermit(adjudicationInput, controller),
      }) : adjudicated.permit;
      if (!kept || !stillCurrent()) {
        window.phase = 'cancelled';
        if (epoch === this.epoch && chatKey === this.chatKey) {
          this.apply({ type: 'cancel', attemptId: window.attemptId, epoch, reason: 'NPC roll review cancelled' });
          this.host.stopGeneration();
          await this.persist();
        }
        return JSON.stringify({ ok: false, code: 'cancelled', message: 'Cancelled by the user.' });
      }
      window.permit = kept;
      window.phase = 'followup_pending';
      this.status = 'Writing';
      const priorReaction = this.record?.attempts[window.attemptId]?.reaction;
      if (priorReaction) {
        this.pendingInjection = this.pendingInjection.replace(this.reactionBlock(priorReaction), '').trim();
        const attempt = this.record?.attempts[window.attemptId];
        if (attempt) attempt.injectedText = attempt.injectedText.replace(this.reactionBlock(priorReaction), '').trim();
      }
      this.apply({ type: 'tool_result', attemptId: window.attemptId, permit: kept, status: 'permitted', error: null });
      this.recoverJudgeStage('npc');
      const attempt = this.record?.attempts[window.attemptId];
      if (attempt) attempt.requestUsage = mergeRequestUsage(attempt.requestUsage, receipts);
      const usage = summarizeUsage(receipts);
      this.inspect({
        kind: 'tool_checkpoint', attemptId: window.attemptId, message: `Applied ${kept.actions.length} NPC result(s) automatically in ${Date.now() - started} ms.`,
        questions: adjudicated.questions, stateSent: adjudicated.snapshot.state, answers: adjudicated.evaluation.answers,
        providerKind: adjudicated.evaluation.provider, requestedModel: adjudicated.evaluation.requestedModel, returnedModel: adjudicated.evaluation.returnedModel,
        durationMs: usage.durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts),
      });
      usageRecorded = true;
      await this.persist();
      return JSON.stringify({ schemaVersion: 1, ok: true, permit: writerPermit(kept) });
    } catch (error) {
      if (this.inFlight === controller) this.inFlight = null;
      if (!stillCurrent() || (controller.signal.aborted && !(controller.signal.reason instanceof JudgeWaitBudget))) {
        window.phase = 'cancelled';
        return JSON.stringify({ ok: false, code: 'cancelled' });
      }
      const message = error instanceof ProviderError ? `${error.code}: ${error.message}` : (error as Error).message;
      return this.toolFailure(window, 'provider_failed', message, false, error);
    } finally {
      clearTimeout(timer);
      if (this.inFlight === controller) this.inFlight = null;
      if (!usageRecorded && receipts.length && epoch === this.epoch && chatKey === this.chatKey) {
        const attempt = this.record?.attempts[window.attemptId];
        if (attempt) attempt.requestUsage = mergeRequestUsage(attempt.requestUsage, receipts);
        this.inspect({ kind: 'info', attemptId: window.attemptId, message: 'NPC judge request usage.', networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts) });
        await this.persist();
      }
    }
  }

  /** Mock mode remains useful for headed QA even though its canned ids predate planned_N questions. */
  private async reassessPermit(input: Parameters<typeof adjudicateTurnProposal>[0], abort: AbortController): Promise<TurnPermit> {
    const timer = setTimeout(() => abort.abort(new JudgeWaitBudget()), Math.max(0, this.settings.waitForJudgeSeconds) * 1000);
    try { return (await withinBudget(adjudicateTurnProposal(input), abort.signal)).permit; }
    finally { clearTimeout(timer); }
  }

  private planningProvider(base: DecisionProvider): DecisionProvider {
    if (base.kind !== 'mock') return base;
    const scenario = this.settings.connection.mockScenario || 'gate-deferred';
    const x = scenario === 'gate-achieved' ? 0.85 : scenario === 'gate-progress' ? 0.55 : scenario === 'score-low' ? 0.25 : 0.35;
    return {
      kind: 'mock',
      capabilities: base.capabilities,
      async evaluate(request) {
        const answers: Record<string, Answer> = {};
        for (const [id, question] of Object.entries(request.questions)) {
          answers[id] = question.type === 'score'
            ? { type: 'score', score: Math.round(x * (question.criteria.length - 1)), legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])), probabilities: null, confidence: null, provenance: 'fixture' }
            : { type: 'noul', noul: x, confidence: null, provenance: 'fixture' };
        }
        return { requestId: request.requestId, provider: 'mock', requestedModel: null, returnedModel: 'mock-planned-action', answers, unresolvedQuestionIds: [], errors: {}, inputTokens: 0, outputTokens: 0, durationMs: 0, transportAttempts: 1 };
      },
    };
  }

  // ---- interceptor ------------------------------------------------------------

  /** Frozen decisions are keyed by the transcript prefix, never by reply text. */
  private attemptAt(prefix: HostChatMessage[], messageIndex?: number): GenerationAttempt | null {
    if (!this.record) return null;
    const cursor = this.cursorOf(prefix);
    const retrySource = this.explicitRetry ? this.record.attempts[this.explicitRetry.sourceId] : null;
    if (retrySource?.cursorBefore === cursor) return retrySource;
    const marker = messageIndex === undefined ? null : this.host.readMarker(messageIndex);
    const selected = marker ? this.record.attempts[marker.a] : null;
    const chain = cursorChain(this.record.seedId, this.host.fingerprintMessages(prefix));
    const variant = marker ? this.record.variants[marker.v] : null;
    const message = messageIndex === undefined ? null : this.host.chat()[messageIndex];
    const selectedCursor = message ? this.cursorOf([...prefix, message]) : null;
    if (selected?.cursorBefore && chain.includes(selected.cursorBefore) && !selected.unadjudicated
      && variant?.attemptId === selected.attemptId && variant.cursorAfter === selectedCursor
      && (selected.hostVariantRef ?? 0) === (message?.swipe_id ?? 0)) return selected;
    const attempts = Object.values(this.record.attempts).reverse();
    const active = activeResolutionForCursor(this.record, cursor);
    const exact = attempts.find(a => a.cursorBefore === cursor && !a.unadjudicated && a.resolutionId === active?.resolutionId)
      ?? attempts.find(a => a.cursorBefore === cursor && !a.unadjudicated);
    if (exact) return exact;
    // Tool placeholders are not another fictional exchange. Their final reply
    // still belongs to the same input cursor, even after native regeneration.
    let end = prefix.length;
    while (end && !prefix[end - 1]!.is_user && (Array.isArray(prefix[end - 1]!.extra?.tool_invocations)
      || ['', '...'].includes(stripResultFooter(prefix[end - 1]!.mes ?? '').trim()))) end--;
    const inputCursor = chain[end];
    const inputAttempt = end < prefix.length ? attempts.find(a => a.cursorBefore === inputCursor && !a.unadjudicated) : null;
    if (inputAttempt) return inputAttempt;
    // Rejected prose before a tool also stays in the host transcript. The final
    // reply's saved identity identifies its original input cursor.
    if (prefix.some(message => Array.isArray(message.extra?.tool_invocations))) {
      return attempts.find(a => a.hostMessageRef === (messageIndex ?? prefix.length)
        && a.cursorBefore && chain.includes(a.cursorBefore) && !a.unadjudicated) ?? null;
    }
    return null;
  }

  private selectedAttempt(): GenerationAttempt | null {
    const chat = this.host.chat();
    return chat.at(-1)?.is_user ? this.attemptAt(chat) : this.attemptAt(chat.slice(0, -1), chat.length - 1);
  }

  private attemptSpeakerIndex(attempt: GenerationAttempt | null | undefined): number | null {
    if (!this.host.isGroup() || !attempt?.actorId) return null;
    const actor = this.record?.actors[attempt.actorId];
    const index = actor ? this.host.resolveIndex(actor.avatar) : -1;
    return index >= 0 ? index : null;
  }

  private enforceDraftedSpeaker(): void {
    if (!this.settings.enabled || !this.record || this.record.paused || !this.host.isGroup()) return;
    const pending = this.record.pending ? this.record.attempts[this.record.pending.attemptId] : null;
    const source = pending ?? (this.groupGenerationType === 'swipe' || this.groupGenerationType === 'continue'
      ? this.selectedAttempt() : this.attemptAt(this.host.chat()));
    const actor = source?.actorId ? this.record.actors[source.actorId] : null;
    if (source && actor && !this.host.enforceGroupSpeaker(actor.avatar)) this.groupSpeakerFailure = source.attemptId;
  }

  /** Speaker changes must happen before prompt construction, never in the interceptor. */
  private matchesFrozenSpeaker(attempt: GenerationAttempt | null | undefined): boolean {
    if (!this.host.isGroup() || !attempt?.actorId) return true;
    const expected = this.attemptSpeakerIndex(attempt);
    const matches = expected !== null && Number(this.host.ctx().characterId) === expected
      && this.groupSpeakerFailure !== attempt.attemptId;
    if (!matches) {
      this.host.clearInjection();
      this.host.toast('warning', 'The frozen reply speaker is unavailable. Restore that group member and try again; the result is unchanged.');
    }
    return matches;
  }

  private frozenState(source: GenerationAttempt): string {
    if (!this.record) return '';
    if (source.frozenStateBlock !== undefined) {
      // Preserve the original pack's labels and instructions, filtering only
      // the modules the user has since switched off.
      return source.frozenStateBlock.split(/(?=\[Director (?:character state|knowledge boundaries))/)
        .filter(block => block.startsWith('[Director character state') ? this.settings.modules.meters
          : block.startsWith('[Director knowledge boundaries]') ? this.settings.modules.secrets : false)
        .map(block => block.trim()).filter(Boolean).join('\n\n');
    }
    const oldCursor = source.variantId ? this.record.variants[source.variantId]?.cursorAfter : undefined;
    const snap = source.storyAfter ?? (oldCursor ? snapshotAt(this.record.story, [oldCursor]) : null) ?? snapshotAt(this.record.story, this.chainNow());
    if (!snap) return '';
    return stateBlock({ pack: this.chatPack(), levels: snap.meters, assessed: snap.assessed,
      names: Object.fromEntries(Object.values(this.record.actors).map(a => [a.actorId, a.name])),
      playerName: this.host.playerName(), secrets: this.record.story.secrets, knownBy: snap.knownBy,
      meters: this.settings.modules.meters, secretsOn: this.settings.modules.secrets });
  }

  /** `canCancel` false: a native regenerate, which cannot be stopped from deleting its reply. */
  private async confirmRetry(source: GenerationAttempt, cursor: string, canCancel = true): Promise<boolean> {
    if (this.approvedSwipeCursor === cursor) { this.approvedSwipeCursor = null; return true; }
    if (!this.settings.modules.decisions || !this.settings.askWhenSwiping || (!source.resolutionId && !source.permitId) || this.explicitRetry?.sourceId === source.attemptId) return true;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.inFlight = abort;
    try {
      const choice = await this.host.chooseSwipeAction('ruled', true, abort.signal, this.settings, canCancel);
      if (abort.signal.aborted || epoch !== this.epoch || !this.settings.enabled || this.record?.paused) return false;
      if (choice === 'cancel') return !canCancel;
      if (choice === 'reroll') {
        this.inFlight = null;
        if (await this.changeDecision(false, false, source, !canCancel)) return true;
        if (canCancel || epoch !== this.epoch || !this.settings.enabled || this.record?.paused) return false;
        // A native regenerate deletes its reply either way, so a failed Roll again keeps the result.
        this.host.toast('warning', 'The judge could not roll again, so the reply keeps its result.');
      }
      return true;
    } finally { if (this.inFlight === abort) this.inFlight = null; }
  }

  /** Binds a fresh decision or reuses the frozen decision for this exchange. */
  async interceptor(chat: unknown, contextSize: number, abort: (immediately: boolean) => void, type: string): Promise<void> {
    const followUp = type === 'normal' && this.automaticReply?.followUpPending ? this.automaticReply : null;
    if (followUp) followUp.followUpPending = false;
    if (followUp?.cancelled) {
      // The cancelled rewrite's tool follow-up is never written; its intermediary
      // swipe is discarded when the rewrite's dispatch settles.
      this.host.clearInjection();
      abort(true);
      return;
    }
    const automatic = type === 'swipe' || this.toolContinuation || followUp ? this.automaticReply : null;
    await this.prepareGeneration(chat, contextSize, abort, type);
    if (automatic?.cancelled) {
      this.host.clearInjection();
      abort(true);
    }
  }

  /**
   * The Director's own rewrite swipe, identified by its dispatch (its MESSAGE_SWIPED
   * or GENERATION_STARTED was recognised), never by transcript lookup.
   */
  private ownAutomaticSwipe(): NonNullable<Controller['automaticReply']> | null {
    const automatic = this.automaticReply;
    return automatic && (automatic.started || automatic.swipeObserved) && !automatic.cancelled && automatic.chatKey === this.chatKey
      && this.host.chat().at(-1) === automatic.message && automatic.message.swipe_id === automatic.nextSwipe ? automatic : null;
  }

  private async prepareGeneration(_chat: unknown, _contextSize: number, _abort: (immediately: boolean) => void, type: string): Promise<void> {
    const cancelled = this.automaticReply;
    if (cancelled?.cancelled && cancelled.chatKey === this.chatKey && this.host.chat().at(-1) === cancelled.message
      && type === 'swipe' && cancelled.message.swipe_id === cancelled.nextSwipe) {
      this.approvedSwipeCursor = null;
      this.explicitRetry = null;
      this.cancelSwipe = false;
      this.host.clearInjection();
      _abort(true);
      return;
    }
    void this.host.armLore(null);
    if (Array.isArray(_chat)) for (const message of _chat) if (message && !message.is_user && typeof message.mes === 'string') message.mes = stripResultFooter(message.mes);
    if (!this.settings.enabled || !this.record || this.record.paused || this.host.isAutoDirectorEnabled()) { this.host.clearInjection(); return; }
    const genType = (['normal', 'swipe', 'regenerate', 'continue'].includes(type) ? type : null) as GenerationType | null;
    // Another extension's quiet generation never consumes a Cancel meant for a swipe,
    // and its prompt gets no Director block: its start already took the block out
    // (to be put back when its data is built); without an observed start, just clear.
    if (!genType) {
      const frame = [...this.suppressions].reverse().find(item => !item.dry);
      if (frame) this.suspendInjection(frame);
      else this.host.clearInjection();
      return;
    }
    // A native regenerate has already deleted the reply: never abort it. A Cancel
    // is only ever for a swipe, and a cancelled NPC review only for its own follow-up.
    if (genType === 'regenerate') {
      this.cancelSwipe = false;
      if (this.toolWindow?.phase === 'cancelled') this.toolWindow = null;
    }
    if (this.cancelSwipe || this.toolWindow?.phase === 'cancelled') { this.cancelSwipe = false; this.toolWindow = null; this.host.clearInjection(); _abort(true); return; }
    this.macroSuppressed = false;
    const chat = this.host.chat();
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const current = () => epoch === this.epoch && chatKey === this.chatKey;
    if (this.toolContinuation && genType === 'normal') {
      const continuation = this.toolContinuation;
      this.toolContinuation = null;
      this.currentAttemptId = continuation.attemptId;
      this.pendingInjection = continuation.injection;
      this.setInjection(continuation.injection);
      this.bindReplyIdentity(continuation.attemptId, genType, chat.length);
      await this.armLoreForAttempt(continuation.attemptId);
      if (!current()) return;
      this.status = 'Writing';
      return;
    }
    if ((genType === 'normal' || genType === 'continue') && this.toolWindow && ['followup_pending', 'failed_pending', 'malformed_pending'].includes(this.toolWindow.phase)) {
      const window = this.toolWindow;
      window.phase = window.phase === 'followup_pending' ? 'followup_writing' : window.phase === 'failed_pending' ? 'failed_writing' : 'malformed_writing';
      const ruling = (this.record.attempts[window.attemptId]?.injectedText ?? this.pendingInjection).split('[Director NPC-action checkpoint]')[0] ?? '';
      this.setInjection([ruling, permitFollowupBlock(window.permit, window.error)].filter(Boolean).join('\n\n'));
      await this.armLoreForAttempt(window.attemptId);
      if (!current()) return;
      this.currentAttemptId = window.attemptId;
      this.bindReplyIdentity(window.attemptId, genType, chat.length);
      this.status = 'Writing';
      await this.persist();
      return;
    }
    // ST auto-continue resumes the same unfinished writer attempt.
    if (genType === 'continue' && this.currentAttemptId && this.record.attempts[this.currentAttemptId]?.status === 'writing') {
      this.setInjection(this.record.attempts[this.currentAttemptId]!.injectedText);
      await this.armLoreForAttempt(this.currentAttemptId);
      return;
    }
    const prefix = (genType === 'swipe' || genType === 'continue') && !chat.at(-1)?.is_user ? chat.slice(0, -1) : chat;
    // A regenerate uses the source confirmed before SillyTavern deleted the
    // selected reply, and the Director's own rewrite uses the reply it checked:
    // a lookup by cursor alone would pick the newest ruling instead.
    const regenerate = genType === 'regenerate' && this.regenerateSource?.cursor === this.cursorOf(prefix) ? this.regenerateSource : null;
    this.regenerateSource = null;
    const ownSwipe = genType === 'swipe' ? this.ownAutomaticSwipe() : null;
    let source = (regenerate ? this.record.attempts[regenerate.sourceId] : null)
      ?? (ownSwipe ? this.record.attempts[ownSwipe.sourceId] : null)
      ?? this.attemptAt(prefix, prefix.length < chat.length ? chat.length - 1 : undefined);
    if (!this.record.pending && !source && genType !== 'continue') {
      await this.prepareReplyRetry(true, prefix, false);
      if (!current()) return;
    }
    const pending = this.record.pending;
    if (pending && pending.epoch === this.epoch) {
      if (!this.matchesFrozenSpeaker(this.record.attempts[pending.attemptId])) { _abort(true); return; }
      const boundPrefix = this.pendingForSwipe ? prefix : chat;
      const cursor = this.preparedInputCursor ?? this.cursorOf(boundPrefix);
      this.preparedInputCursor = null;
      this.pendingForSwipe = false;
      const prepared = this.preparedTool?.attemptId === pending.attemptId ? this.preparedTool : null;
      this.apply({ type: 'bind', attemptId: pending.attemptId, cursorBefore: cursor, epoch: this.epoch, injectedText: this.pendingInjection, toolOffered: Boolean(prepared?.available) });
      this.toolWindow = prepared?.available ? {
        requestId: prepared.requestId, attemptId: prepared.attemptId, speakerActorId: prepared.speakerActorId,
        baseCursor: cursor, stateRevision: prepared.snapshot.stateRevision, chatLengthAtBind: boundPrefix.length,
        priorReplyText: boundPrefix.length < chat.length ? stripResultFooter(chat[boundPrefix.length]?.mes ?? '') : undefined,
        allowedEvidenceRefs: prepared.allowedEvidenceRefs, snapshot: { ...prepared.snapshot, cursorBefore: cursor },
        actorNames: prepared.actorNames, phase: 'initial', permit: null, error: null, used: false,
      } : null;
      this.currentAttemptId = pending.attemptId;
      this.bindReplyIdentity(pending.attemptId, genType, boundPrefix.length);
      const bound = this.record.attempts[pending.attemptId];
      if (bound) bound.generationType = genType;
      this.setInjection(bound?.injectedText ?? '');
      await this.armLoreForAttempt(pending.attemptId);
      if (!current()) return;
      this.preparedDeadline = null;
      this.status = 'Writing';
      await this.persist();
      return;
    }
    if (!source || source.unadjudicated) { this.clearGeneration('no frozen exchange'); return; }
    if (!this.matchesFrozenSpeaker(source)) { _abort(true); return; }
    const cursor = source.cursorBefore ?? this.cursorOf(prefix);
    if (genType !== 'continue' && !(await this.confirmRetry(source, cursor, genType !== 'regenerate'))) {
      this.host.clearInjection();
      // SillyTavern deleted a regenerated reply before this interceptor: never abort
      // it in this chat (a failed Roll again already fell back to Keep).
      if (genType !== 'regenerate' || !current()) _abort(true);
      return;
    }
    if (!current()) { _abort(true); return; }
    const retry = this.explicitRetry?.sourceId === source.attemptId ? this.explicitRetry : null;
    const resolutionId = regenerate ? regenerate.resolutionId : retry ? retry.resolutionId : source.resolutionId;
    const permitId = regenerate ? regenerate.permitId : retry ? retry.permitId : source.permitId;
    const active = this.settings.modules.decisions && resolutionId ? this.record.resolutions[resolutionId] : null;
    const permit = this.settings.modules.decisions && permitId ? this.record.permits[permitId] : null;
    const names = Object.fromEntries(Object.values(this.record.actors).map(a => [a.actorId, a.name]));
    const binding = active ? bindingBlock({ action: active.action, outcome: active.outcome, instruction: instructionForResolution(active),
      actorName: names[active.action.actingActorId ?? active.action.playerActorId] ?? active.action.playerActorId,
      speakerName: source.actorId ? names[source.actorId] ?? null : null, playerName: this.host.playerName(),
      targetNames: active.action.targetActorIds.map(id => names[id] ?? id), npcActionPolicy: permit ? 'permitted' : 'defer' }) : '';
    const automatic = ownSwipe && ownSwipe.sourceId === source.attemptId && !ownSwipe.cancelled ? ownSwipe : null;
    const injected = [binding, this.frozenState(source), permit ? permitFollowupBlock(permit) : '',
      this.settings.modules.pacing ? pacingBlock(source.frozenPacing ?? null, this.settings.handBackBeats !== false, this.host.dynamicResponseEnabled()) : '',
      this.settings.modules.replyCheck ? source.replyNudge ?? '' : '',
      this.settings.reactions.enabled && !permit ? this.reactionBlock(source.reaction) : '',
      this.settings.modules.decisions ? 'The Director tool is closed for this reply; do not call it.' : '',
      automatic ? `(OOC: ${automatic.correction})` : ''].filter(Boolean).join('\n\n');
    const attemptId = newId('att');
    this.apply({ type: 'regeneration_attempt', attemptId, resolutionId: resolutionId ?? null, permitId: permitId ?? null,
      reaction: permit ? null : source.reaction, cursorBefore: cursor, epoch: this.epoch,
      generationType: genType, actorId: source.actorId, injectedText: injected, unadjudicated: false, now: Date.now() });
    const regenerated = this.record.attempts[attemptId];
    if (regenerated) for (const key of ['loreCursor', 'storyBefore', 'storyAfter', 'frozenLorePlan', 'frozenStateBlock', 'frozenSpeaker', 'judgeErrors', 'judgeFailedStages', 'stageRecords', 'turnKind', 'inputText', 'frozenPacing', 'replyNudge', 'frozenPackId', 'decisionsApplied', 'replayTrimmed'] as const) {
      Object.assign(regenerated, { [key]: structuredClone(source[key]) });
    }
    if (regenerated && automatic) {
      regenerated.replyCorrection = automatic.correction;
      regenerated.rerolledByCheck = automatic.reason;
      regenerated.replyOriginalSwipe = automatic.originalSwipe;
      automatic.attemptId = attemptId;
      this.recoverJudgeStage('reply_rewrite');
    }
    if (retry) {
      const decisionEntry = this.record.inspector.find(entry => entry.id === retry.inspectorId);
      if (decisionEntry && decisionEntry.attemptId === null) decisionEntry.attemptId = attemptId;
      if (regenerated) regenerated.requestUsage = mergeRequestUsage(source.requestUsage, decisionEntry?.requestUsage);
    }
    else if (regenerated) regenerated.requestUsage = mergeRequestUsage(source.requestUsage);
    this.inspect({ kind: 'wording_regeneration', attemptId, resolutionId: active?.resolutionId ?? null, outcome: active?.outcome ?? null,
      injectedText: injected, networkCalls: 0, message: `Reused this exchange's decisions for ${genType}.` });
    this.currentAttemptId = attemptId;
    this.bindReplyIdentity(attemptId, genType, prefix.length);
    this.approvedSwipeCursor = null;
    this.explicitRetry = null;
    this.toolWindow = null;
    this.preparedTool = null;
    this.pendingInjection = injected;
    this.setInjection(injected);
    await this.armLoreForAttempt(attemptId);
    if (!current()) return;
    this.status = 'Writing';
    await this.persist();
  }

  private reactionBlock(reaction: ReactionResult | null | undefined): string {
    if (!reaction) return '';
    const name = this.record?.actors[reaction.actorId]?.name ?? reaction.actorId;
    return `[Director NPC reaction — preserve on wording swipes]\n${name}: ${reaction.kind} → ${reaction.outcome}. ${reaction.instruction}\nThis chosen response is already decided; do not roll or call the tool again for this same response. It is a direction for the reply, not proof that an event occurred. Respect established motives and knowledge and leave the player's choices open. A separate new uncertain consequential action still requires the Director tool before prose; its kept ruling supersedes this reaction.`;
  }

  private setInjection(text: string): void {
    if (text && text.trim()) this.host.setInjection(text, 0, 'system');
    else this.host.clearInjection();
  }

  // ---- host events ------------------------------------------------------------

  private bindReplyIdentity(attemptId: string, type: string, prefixLength: number): void {
    const existing = type === 'swipe' || type === 'continue' ? this.host.chat()[prefixLength] ?? null : null;
    let end!: () => void;
    const ended = new Promise<void>(resolve => { end = resolve; });
    this.replyBinding = { attemptId, index: prefixLength, message: existing,
      swipeId: existing?.swipe_id ?? 0, rejected: this.replyBinding?.attemptId === attemptId ? this.replyBinding.rejected : new Set(), ended, end };
    this.completionCandidate = null;
  }

  private captureReplyIdentity(): void {
    const binding = this.replyBinding;
    if (!binding || binding.message) return;
    const message = this.host.chat()[binding.index];
    if (message && !message.is_user && !message.is_system && !binding.rejected.has(message)) {
      binding.message = message;
      binding.swipeId = message.swipe_id ?? 0;
    }
  }

  private releaseWriterWaiters(): void {
    const waiters = [...this.writerIdleWaiters];
    this.writerIdleWaiters.clear();
    // Let the host finish unblocking and enqueue its final message first.
    setTimeout(() => { for (const resolve of waiters) resolve(); }, 0);
  }

  private async onGenerationStarted(type: string, _params: Record<string, unknown> | undefined): Promise<void> {
    if (_params?.dryRun || !['normal', 'swipe', 'regenerate', 'continue'].includes(type)) {
      // Readers are empty for a quiet, impersonate or dry-run prompt, but only
      // until its own data is built: another extension may run one inside the
      // listeners of the generation whose card fields or prompt come next.
      const frame: Controller['suppressions'][number] = { suppressed: this.macroSuppressed, dry: Boolean(_params?.dryRun), nested: this.buildingGeneration };
      this.suppressions.push(frame);
      this.macroSuppressed = true;
      if (!_params?.dryRun) { this.suspendInjection(frame); return; }
      const attempt = this.currentAttemptId ? this.record?.attempts[this.currentAttemptId] : null;
      const correction = attempt?.replyCorrection ? `(OOC: ${attempt.replyCorrection})` : '';
      const live = this.host.currentInjection();
      if (attempt && correction && live.includes(correction)) {
        // Restore exactly what was live; a closed-tool follow-up adds a tool-result line.
        this.dryRunRestore = { attemptId: attempt.attemptId, epoch: this.epoch, text: live };
        this.setInjection(live.replace(`\n\n${correction}`, '').replace(correction, '').trim());
      }
      return;
    }
    this.macroSuppressed = false;
    // A Director generation starts building its prompt: earlier suppressing
    // generations are over, and ones started before its interceptor are nested.
    this.suppressions = [];
    this.nestedEnds = 0;
    this.buildingGeneration = true;
    this.regenerateSource = null;
    // A Cancel only ever targets the next swipe generation.
    if (type !== 'swipe') this.cancelSwipe = false;
    const automatic = this.automaticReply;
    // The rewrite's tool follow-up is still the rewrite, even after a cancel cleared
    // our generation state; its interceptor writes or aborts it.
    if (type === 'normal' && automatic?.toolFollowUp && automatic.chatKey === this.chatKey) {
      automatic.toolFollowUp = false;
      automatic.followUpPending = true;
      return;
    }
    const recursion = this.toolContinuation || (this.toolWindow && ['cancelled', 'followup_pending', 'failed_pending', 'malformed_pending'].includes(this.toolWindow.phase));
    if (recursion || (type === 'continue' && this.currentAttemptId)) return;
    const ownSwipe = type === 'swipe' && automatic && !automatic.started && automatic.chatKey === this.chatKey
      && this.host.chat().at(-1) === automatic.message && automatic.message.swipe_id === automatic.nextSwipe;
    if (ownSwipe) automatic.started = true;
    else {
      if (automatic) automatic.preserveUserChanges = true;
      this.cancelReplyCheck();
      // A new user generation can never inherit a prior automatic cancellation. Until
      // the dispatch's MESSAGE_SWIPED arrives, though, the cancelled identity stays, so
      // that swipe is still recognised as the Director's own (its dispatch clears it).
      if (automatic?.swipeObserved) this.automaticReply = null;
    }
    this.toolWindow = null;
    this.completionCandidate = null;
    this.replyBinding?.end();
    this.replyBinding = null;
    if (this.currentAttemptId) this.clearGeneration('replaced by a new generation');
    if (!this.record || !this.settings.enabled || this.record.paused || this.host.isAutoDirectorEnabled()) return;
    if (['swipe', 'regenerate', 'continue'].includes(type)) {
      const chat = this.host.chat();
      const hasReply = chat.length > 0 && !chat.at(-1)!.is_user && !chat.at(-1)!.is_system;
      const prefix = hasReply ? chat.slice(0, -1) : chat;
      const source = (ownSwipe ? this.record.attempts[automatic.sourceId] : null) ?? this.attemptAt(prefix, hasReply ? chat.length - 1 : undefined);
      this.macroUpcomingCursor = null;
      if (source) {
        if (type === 'regenerate') {
          // SillyTavern deletes the selected reply after this event; the interceptor
          // can then only look up by cursor, so remember the source kept here.
          const cursor = source.cursorBefore ?? this.cursorOf(prefix);
          if (!(await this.confirmRetry(source, cursor, false))) return;
          this.approvedSwipeCursor = cursor;
          const retry = this.explicitRetry?.sourceId === source.attemptId ? this.explicitRetry : null;
          this.regenerateSource = { sourceId: source.attemptId, cursor,
            resolutionId: retry ? retry.resolutionId : source.resolutionId, permitId: retry ? retry.permitId : source.permitId ?? null };
        }
        this.macroUpcomingAttemptId = source.attemptId;
      }
    } else if (!this.macroUpcomingCursor || this.macroUpcomingCursor !== this.sendInputCursor()) {
      // Only the Director's resend of this exact exchange keeps its preview.
      this.macroUpcomingAttemptId = null;
      this.macroUpcomingCursor = null;
    }
  }

  /**
   * Takes the Director block out of a quiet or impersonate prompt. SillyTavern
   * builds the Director generation's own prompt after its interceptor, so the
   * block is put back (`resumeInjection`) once the quiet prompt is built.
   */
  private suspendInjection(frame: Controller['suppressions'][number]): void {
    const live = this.host.currentInjection();
    if (!live) return;
    this.host.clearInjection();
    frame.restore = { text: live, version: this.host.injectionVersion() };
  }

  /** Puts a suspended block back, unless the Director wrote (or cleared) its injection meanwhile. */
  private resumeInjection(frame: Controller['suppressions'][number]): void {
    const restore = frame.restore;
    frame.restore = undefined;
    if (restore && this.host.injectionVersion() === restore.version) this.setInjection(restore.text);
  }

  /** The input cursor a 'normal' generation starting now will answer (the composer becomes the user message). */
  private sendInputCursor(): string {
    const chat = this.host.chat();
    const text = this.host.composerText();
    return this.cursorOf(text.trim() ? [...chat, { name: this.host.playerName(), is_user: true, is_system: false, mes: text }] : chat);
  }

  private clearGeneration(reason: string): void {
    this.macroUpcomingAttemptId = null;
    this.macroUpcomingCursor = null;
    this.dryRunRestore = null;
    this.replyBinding?.end();
    this.completionCandidate = null;
    const id = this.currentAttemptId ?? this.record?.pending?.attemptId;
    if (id) this.apply({ type: 'cancel', attemptId: id, epoch: this.epoch, reason });
    this.currentAttemptId = null;
    this.pendingForSwipe = false;
    this.pendingInjection = '';
    this.preparedDeadline = null;
    this.preparedTool = null;
    if (this.toolWindow?.phase !== 'cancelled') this.toolWindow = null;
    this.toolContinuation = null;
    this.explicitRetry = null;
    this.host.clearInjection();
    if (this.status === 'Writing' || this.status === 'Frozen') this.status = 'Ready';
  }

  private async onGenerationStopped(): Promise<void> {
    this.cancelReplyCheck(false);
    void this.host.armLore(null);
    this.continueRemaining = 0;
    this.regenerateSource = null;
    this.inFlight?.abort(new Error('generation stopped'));
    const window = this.toolWindow;
    if (window && (this.inFlight || window.phase === 'cancelled')) window.phase = 'cancelled';
    this.captureReplyIdentity();
    const binding = this.replyBinding;
    const partialMessage = binding?.message;
    const partial = binding && partialMessage && !binding.rejected.has(partialMessage) && window?.phase !== 'cancelled'
      && this.record?.attempts[binding.attemptId]?.status === 'writing'
      && (!partialMessage.swipes || (partialMessage.swipe_id ?? 0) < partialMessage.swipes.length) ? binding.attemptId : null;
    this.clearGeneration('generation stopped by the user');
    if (partial && this.record?.attempts[partial]) {
      this.record.attempts[partial]!.status = 'writing';
      this.completionCandidate = partial;
    }
    this.releaseWriterWaiters();
    await this.persist();
    this.refreshStatus();
  }

  private onGenerationEnded(): void {
    const frame = this.suppressions.at(-1);
    if (frame && !frame.dry) {
      // A quiet or impersonate generation ended before its data was built.
      this.suppressions.pop();
      this.macroSuppressed = frame.suppressed;
      this.resumeInjection(frame);
      if (frame.nested) return;
    } else if (this.nestedEnds > 0) {
      // The end of a generation nested in the one still building its prompt: not ours.
      this.nestedEnds -= 1;
      return;
    }
    this.buildingGeneration = false;
    this.regenerateSource = null;
    this.macroUpcomingAttemptId = null;
    this.macroUpcomingCursor = null;
    this.dryRunRestore = null;
    this.releaseWriterWaiters();
    this.replyBinding?.end();
    void this.host.armLore(null);
    if (this.toolContinuation || (this.toolWindow && ['cancelled', 'followup_pending', 'failed_pending', 'malformed_pending'].includes(this.toolWindow.phase))) return;
    this.captureReplyIdentity();
    const id = this.currentAttemptId;
    this.completionCandidate = id;
    this.currentAttemptId = null;
    this.pendingForSwipe = false;
    this.preparedTool = null;
    this.host.clearInjection();
    if (this.record?.pending) this.apply({ type: 'cancel', attemptId: this.record.pending.attemptId, epoch: this.epoch, reason: 'writer returned before binding' });
    this.status = 'Ready';
  }

  private queueMessageReceived(mesId: number, type: string): void {
    if (!['normal', 'swipe', 'regenerate', 'continue', 'appendFinal'].includes(type)) return;
    const attemptId = this.currentAttemptId ?? this.completionCandidate;
    if (!attemptId) return;
    const binding = this.replyBinding;
    const message = this.host.chat()[mesId];
    if (!binding || binding.attemptId !== attemptId || mesId !== binding.index
      || (binding.message && binding.message !== message) || (message?.swipe_id ?? 0) !== binding.swipeId) return;
    if (!binding.message) binding.message = message ?? null;
    // A real completion, not an empty or '...' tool intermediary (a tool call
    // with prose clears this again). Set before the deferred acceptance, so
    // typing while SillyTavern still saves never discards a complete rewrite.
    if (this.automaticReply?.attemptId === attemptId && !this.automaticReply.cancelled
      && !['', '...'].includes(stripResultFooter(String(message?.mes ?? '')).trim())) this.automaticReply.finished = true;
    const phaseAtEvent = this.toolWindow?.attemptId === attemptId ? this.toolWindow.phase : null;
    const writerSettled = this.writerSettled;
    const nativeEnded = !writerSettled && this.host.isGenerating() ? binding.ended : null;
    let task!: Promise<void>;
    task = new Promise<void>(resolve => setTimeout(resolve, 0))
      .then(() => writerSettled)
      .then(() => nativeEnded)
      .then(() => { if (message && !binding.rejected.has(message) && this.host.chat()[mesId] === message
        && (message.swipe_id ?? 0) === binding.swipeId) return this.completeMessage(mesId, type, attemptId, phaseAtEvent); })
      .catch(error => console.error('[RP Director] deferred message completion failed', error))
      .finally(() => this.messageTasks.delete(task));
    this.messageTasks.add(task);
  }

  private async waitForMessageTasks(_attemptId?: string): Promise<void> {
    while (this.messageTasks.size > 0) await Promise.all([...this.messageTasks]);
  }

  private async completeMessage(mesId: number, type: string, attemptId: string, phaseAtEvent: ToolWindowPhase | null): Promise<void> {
    if (!this.record || !['normal', 'swipe', 'regenerate', 'continue', 'appendFinal'].includes(type)) return;
    const attempt = this.record.attempts[attemptId];
    if (!attempt || attempt.status !== 'writing') return;
    // saveReply emits MESSAGE_RECEIVED before SillyTavern inspects a tool call.
    // If the tool was used after an event emitted in the initial phase, that
    // event belongs to the intermediary response and is never observed/committed.
    if (phaseAtEvent === 'initial' && this.toolWindow?.attemptId === attemptId && this.toolWindow.used) return;
    const chat = this.host.chat();
    const message = chat[mesId];
    if (!message || message.is_system || message.is_user || ['', '...'].includes(stripResultFooter(String(message.mes ?? '')).trim())) return;
    const cursorAfter = this.cursorOf(chat.slice(0, mesId + 1));
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const variantId = newId('var');
    const operationId = `complete:${attemptId}:${mesId}:${swipeId}`;
    const actorId = message.original_avatar ? this.actorMap().byAvatar[message.original_avatar] ?? null : null;
    this.host.writeMarker(mesId, { v: variantId, a: attemptId, r: attempt.resolutionId });
    const notices = this.apply({ type: 'completed', attemptId, epoch: this.epoch, operationId, variantId, hostMessageRef: mesId, hostVariantRef: swipeId, cursorAfter, now: Date.now(), actorId });
    void notices;
    if (attempt.storyAfter) this.record.story = withSnapshot(this.record.story, cursorAfter, structuredClone(attempt.storyAfter));
    if (this.completionCandidate === attemptId) this.completionCandidate = null;
    this.refreshWorkflowBadge(mesId);
    // Only a reply that was offered (or used) the tool shows the tool works again.
    if (!attempt.toolError && (attempt.toolStatus === 'offered' || attempt.toolStatus === 'permitted')) this.recoverJudgeStage('tool');
    if (this.currentAttemptId === attemptId) {
      this.currentAttemptId = null;
      this.host.clearInjection();
    }
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    await this.persist();
    if (epoch !== this.epoch || chatKey !== this.chatKey || this.currentAttemptId || this.inFlight) return;
    this.status = 'Ready';
    this.refreshStatus();
    this.scheduleReplyCheck(mesId, attemptId);
  }

  /** Values belong to the generation under construction, never the last badge. */
  macroState(): DirectorMacroState {
    try {
      if (this.macroSuppressed || !this.settings.enabled || !this.record || this.record.paused || this.host.isAutoDirectorEnabled()) return { active: false, modules: {} };
      const id = this.currentAttemptId ?? this.record.pending?.attemptId ?? this.macroUpcomingAttemptId;
      let attempt = id ? this.record.attempts[id] : null;
      const preview = id === this.macroUpcomingAttemptId && !this.currentAttemptId && !this.record.pending;
      if (!attempt || (!preview && !['prepared', 'writing'].includes(attempt.status))) return { active: false, modules: {} };
      if (preview && this.explicitRetry?.sourceId === id) attempt = { ...attempt, resolutionId: this.explicitRetry.resolutionId, permitId: this.explicitRetry.permitId };
      const correction = preview ? this.automaticReply?.sourceId === id && !this.automaticReply.cancelled ? this.automaticReply.correction : '' : attempt.replyCorrection;
      const output = attempt.status === 'prepared' ? this.pendingInjection : preview
        ? [this.frozenState(attempt), this.settings.modules.pacing ? pacingBlock(attempt.frozenPacing, this.settings.handBackBeats !== false, this.host.dynamicResponseEnabled()) : '',
          this.settings.reactions.enabled && !attempt.permitId ? this.reactionBlock(attempt.reaction) : '', this.settings.modules.replyCheck ? attempt.replyNudge : '', correction].filter(Boolean).join('\n\n')
        : attempt.injectedText ?? '';
      const hasBlock = (header: string) => output.includes(header);
      // Records from before 0.8 phase 3b keep no failed-stage list (as the badge's retry test).
      const decisionFailed = attempt.judgeFailedStages === undefined
        ? Boolean(attempt.judgeErrors?.length) && !attempt.resolutionId && !attempt.permitId
        : attempt.judgeFailedStages.some(stage => ['move', 'route', 'ruling'].includes(stage));
      const move = attempt.stageRecords?.find(stage => stage.stage === 'move')?.result.answers.move;
      const noMove = move?.type === 'choice' && ['NONE', 'ROUTINE'].includes(move.choice);
      // Attempts saved before 0.8 phase 3c have no decisionsApplied, and compaction has
      // removed their move answer: an adjudicated turn whose decision stages did not fail counts.
      const applied = attempt.decisionsApplied ?? !attempt.unadjudicated;
      const modules = {
        decisions: Boolean(this.settings.modules.decisions && (attempt.resolutionId || attempt.permitId || (!decisionFailed && (applied || noMove)))),
        speaker: Boolean(this.settings.modules.speaker && attempt.frozenSpeaker?.selected && !attempt.judgeFailedStages?.includes('speaker')),
        meters: Boolean(this.settings.modules.meters && hasBlock('[Director character state — judged from play]')),
        secrets: Boolean(this.settings.modules.secrets && hasBlock('[Director knowledge boundaries]')),
        lore: Boolean(this.settings.modules.lore && attempt.frozenLorePlan?.force.length),
        pacing: Boolean(this.settings.modules.pacing && (hasBlock('[Director pacing — preserve on wording swipes]') || hasBlock('[Director hand-back — preserve on wording swipes]'))),
        reactions: Boolean(this.settings.reactions.enabled && hasBlock('[Director NPC reaction — preserve on wording swipes]')),
        replyCheck: Boolean(this.settings.modules.replyCheck && ((correction && output.includes(correction)) || (attempt.replyNudge && output.includes(attempt.replyNudge)))),
      };
      if (!Object.values(modules).some(Boolean)) return { active: false, modules: {} };
      const pack = attempt.frozenPackId ? packById(attempt.frozenPackId) : this.chatPack();
      const badge = buildWorkflowBadge({ attempt, record: this.record, pack,
        resolution: attempt.resolutionId ? this.record.resolutions[attempt.resolutionId] : null,
        permit: attempt.permitId ? this.record.permits[attempt.permitId] : null });
      const result = modules.decisions ? badge.results[0] : undefined;
      const meters: Record<string, Record<string, string>> = {};
      if (modules.meters) for (const [actorId, levels] of Object.entries(attempt.storyAfter?.meters ?? {})) {
        const words: Record<string, string> = {};
        for (const definition of pack.meters) {
          const level = levels[definition.key];
          if (level !== undefined && definition.levels[level] && (attempt.storyAfter?.assessed === undefined || attempt.storyAfter.assessed[actorId]?.[definition.key] === true)) words[definition.key] = definition.levels[level]!;
        }
        meters[actorId] = words;
      }
      // Actor IDs remain reliable; display names are aliases only when unique.
      for (const [actorId, words] of Object.entries(meters)) {
        const name = this.record.actors[actorId]?.name;
        if (name && Object.values(this.record.actors).filter(actor => actor.name.toLowerCase() === name.toLowerCase()).length === 1
          && !Object.keys(meters).some(id => id.toLowerCase() === name.toLowerCase())) meters[name] = words;
      }
      return { active: true, modules, outcome: result?.outcome, odds: result?.odds ?? undefined, roll: result?.draw ?? undefined,
        scene: modules.pacing ? attempt.frozenPacing?.scene ?? undefined : undefined, pack: pack.id, meters };
    } catch { return { active: false, modules: {} }; }
  }

  getMacro(key: string): string { return resolveDirectorMacro(this.macroState(), key); }

  setSpeakerByName(name: string): void {
    const key = name.trim().toLowerCase();
    if (key === 'auto') { this.setSpeakerOverride(null); return; }
    if (key === 'yield') { this.setSpeakerOverride(YIELD); return; }
    const actors = this.actorsForUi().filter(actor => !actor.disabled && actor.name.toLowerCase() === key);
    if (key === this.host.playerName().toLowerCase() && !actors.length) { this.setSpeakerOverride(YIELD); return; }
    if (actors.length !== 1 || key === this.host.playerName().toLowerCase()) throw new Error('Choose one enabled character by their exact name, yield, or auto.');
    this.setSpeakerOverride(actors[0]!.actorId);
  }

  private cancelReplyCheck(stopWriter = true): void {
    const automatic = this.automaticReply;
    if (automatic && !automatic.cancelled && !automatic.finished) {
      automatic.cancelled = true;
      this.approvedSwipeCursor = null;
      const attempt = automatic.attemptId ? this.record?.attempts[automatic.attemptId] : null;
      if (attempt?.status === 'writing') {
        // Stop emits ENDED synchronously and later MESSAGE_RECEIVED for its
        // fragment. Cancel before either callback can accept that fragment.
        this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: this.epoch, reason: 'automatic reply cancelled' });
        this.clearGeneration('automatic reply cancelled');
        this.refreshWorkflowBadges(Math.max(0, this.host.chat().indexOf(automatic.message)));
        if (stopWriter) this.host.stopGeneration();
      }
    }
    this.replyCheckAbort?.abort(new Error('reply check cancelled'));
    this.replyCheckAbort = null;
    if (this.replyCheckTimer !== null) clearTimeout(this.replyCheckTimer);
    this.replyCheckTimer = null;
  }

  private scheduleReplyCheck(mesId: number, attemptId: string): void {
    if (!this.settings.modules.replyCheck) return;
    this.cancelReplyCheck();
    // Completion must leave the writer's task queue before an automatic swipe
    // can start; otherwise the replacement waits on its own completion.
    const abort = new AbortController();
    this.replyCheckAbort = abort;
    this.replyCheckTimer = setTimeout(() => {
      this.replyCheckTimer = null;
      void this.checkReply(mesId, attemptId, abort);
    }, 0);
  }

  private async checkReply(mesId: number, attemptId: string, abort: AbortController): Promise<void> {
    const epoch = this.epoch, chatKey = this.chatKey;
    const message = this.host.chat()[mesId];
    const attempt = this.record?.attempts[attemptId];
    if (!message || !attempt || attempt.replyCheck) return;
    const swipeId = message.swipe_id ?? 0;
    const text = message.mes;
    const composer = this.host.composerText();
    const cursor = this.cursorOf(this.host.chat());
    const valid = () => !abort.signal.aborted && this.settings.enabled && this.settings.modules.replyCheck && !this.record?.paused
      && epoch === this.epoch && chatKey === this.chatKey && this.host.chatKey() === chatKey
      && this.host.chat().at(-1) === message && (message.swipe_id ?? 0) === swipeId && message.mes === text
      && this.cursorOf(this.host.chat()) === cursor && this.host.composerText() === composer;
    const timeout = setTimeout(() => abort.abort(new JudgeWaitBudget()), Math.max(0, this.settings.waitForJudgeSeconds) * 1000);
    const receipts: RequestUsage[] = [];
    let usageRecorded = false;
    try {
      if (!valid()) return;
      const resolution = this.settings.modules.decisions && attempt.resolutionId ? this.record?.resolutions[attempt.resolutionId] : null;
      const permit = this.settings.modules.decisions && attempt.permitId ? this.record?.permits[attempt.permitId] : null;
      const names = Object.fromEntries(Object.values(this.record!.actors).map(actor => [actor.actorId, actor.name]));
      const ruling = replyCheckRuling(resolution ? { action: resolution.action, outcome: resolution.outcome,
        instruction: instructionForResolution(resolution), actorName: names[resolution.action.actingActorId ?? resolution.action.playerActorId] ?? resolution.action.playerActorId,
        speakerName: attempt.actorId ? names[attempt.actorId] ?? null : null, playerName: this.host.playerName(),
        targetNames: resolution.action.targetActorIds.map(id => names[id] ?? id),
        npcActionPolicy: permit ? 'permitted' : attempt.toolStatus === 'offered' ? 'checkpoint' : 'defer' } : null, permit ?? null);
      const questions = visibleJudgeData(replyCheckQuestions(this.host.playerName(), ruling));
      const prefix = this.host.chat().slice(0, mesId);
      let latestUser = prefix.length - 1;
      while (latestUser >= 0 && !prefix[latestUser]!.is_user) latestUser--;
      const state = replyCheckState({ player: this.host.playerName(), latestInput: latestUser >= 0 ? prefix[latestUser]!.mes : '',
        previousReplies: prefix.filter(item => !item.is_user && !item.is_system).slice(-5).map(item => ({ name: item.name, text: item.mes })),
        reply: { name: message.name, text }, maxChars: STAGED_MAX_STATE_CHARS });
      if (JSON.stringify(state).length > STAGED_MAX_STATE_CHARS) throw new Error('Reply check context exceeds the character budget');
      const result = await withinBudget(this.usageProvider(this.provider(), 'reply_check', receipts).evaluate({ requestId: newId('req'), phase: 'guide', questions,
        snapshot: { chatId: chatKey!, cursorBefore: cursor, stateRevision: 0, scopeId: 'reply-check', profileRevision: this.profile.revision,
          catalogRevision: 'reply-check:1', actorBindingRevision: '', state } }, abort.signal), abort.signal);
      if (!valid()) return;
      const checked = validateStageAnswers('speaker', questions, result);
      if (!Object.keys(checked.result.answers).length) throw new Error(checked.errors.map(error => error.message).join('; '));
      this.recoverJudgeStage('reply_check');
      const previous = prefix.filter(item => !item.is_user && !item.is_system).slice(-5).flatMap(item => {
        const index = this.host.chat().indexOf(item);
        const marker = this.host.readMarker(index);
        const check = marker ? this.record?.attempts[marker.a]?.replyCheck : null;
        return check ? [check] : [];
      });
      const assessment = assessReply(checked.result.answers, this.settings.replyCheckThresholds, previous);
      const live = this.record?.attempts[attemptId];
      if (!live) return;
      live.replyCheck = assessment;
      live.requestUsage = mergeRequestUsage(live.requestUsage, receipts);
      this.inspect({ kind: 'info', attemptId, questions, stateSent: state, answers: result.answers,
        providerKind: result.provider, requestedModel: result.requestedModel, returnedModel: result.returnedModel,
        durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts), message: `Reply check: ${assessment.reason ?? (assessment.nudge ? 'nudge next turn' : 'passed')}.` });
      usageRecorded = true;
      this.refreshWorkflowBadge(mesId);
      await this.persist();
      if (!valid() || !assessment.reason || latestUser < 0 || composer.trim() || this.host.isGroup() || !this.host.swipesEnabled()) return;
      const turnKey = this.cursorOf(prefix.slice(0, latestUser + 1));
      if (this.record?.replyCheckRerolls?.includes(turnKey)) return;
      // Wait for the original writer's cleanup, and for a user swipe's endSwipe()
      // (it may still be saving, then clamps swipe_id), while remaining cancellable:
      // our slash-command swipe bypasses SillyTavern's one-swipe-at-a-time guard.
      const idle = async () => {
        await this.writerSettled;
        while (valid() && this.host.swipeState() !== 'none') await new Promise(resolve => setTimeout(resolve, 20));
        return valid() && !this.host.isGenerating() && !this.inFlight && !this.currentAttemptId;
      };
      if (!(await idle())) return;
      this.record!.replyCheckRerolls = [...(this.record!.replyCheckRerolls ?? []), turnKey];
      await this.persist();
      if (!(await idle())) return;
      const automatic = { sourceId: attemptId, message, chatKey, reason: assessment.reason,
        correction: replyCorrection(assessment.reason, this.host.playerName()), originalSwipe: swipeId,
        nextSwipe: message.swipes?.length ?? 1, attemptId: null as string | null, swipeObserved: false, started: false, finished: false, cancelled: false, preserveUserChanges: false,
        toolFollowUp: false, followUpPending: false };
      this.automaticReply = automatic;
      this.macroUpcomingAttemptId = attemptId;
      this.macroUpcomingCursor = null;
      this.approvedSwipeCursor = live.cursorBefore;
      clearTimeout(timeout);
      try { await this.host.swipeRight(); }
      catch (error) {
        if (!automatic.cancelled && epoch === this.epoch && chatKey === this.chatKey) {
          this.reportJudgeError('reply_rewrite', `The rewrite could not start: ${(error as Error).message}`, { attemptId });
          await this.persist();
        }
      } finally {
        if (this.automaticReply === automatic) this.automaticReply = null;
        this.approvedSwipeCursor = null;
        // Its Generate never started (a failed start, or another generation took
        // over): the preview published for it must not outlive the dispatch.
        if (!automatic.started && !automatic.preserveUserChanges && this.macroUpcomingAttemptId === attemptId) this.macroUpcomingAttemptId = null;
        // A cancelled rewrite loses its fragment. Any unfinished one leaves the
        // user on the wording they were answering (endSwipe() clamps to the last).
        if ((automatic.cancelled || !automatic.finished) && !automatic.preserveUserChanges && automatic.chatKey === this.chatKey && this.host.chatKey() === chatKey) {
          const changed = await this.host.discardAutomaticSwipe(automatic.message, automatic.nextSwipe, automatic.originalSwipe, automatic.cancelled);
          if (changed || automatic.cancelled) await this.persist();
        }
      }
    } catch (error) {
      if (epoch === this.epoch && chatKey === this.chatKey && (!abort.signal.aborted || abort.signal.reason instanceof JudgeWaitBudget)) {
        const live = this.record?.attempts[attemptId];
        if (live) live.replyCheckError = (error as Error).message;
        this.reportJudgeError('reply_check', `Reply check unavailable: ${(error as Error).message}`, { attemptId });
        this.refreshWorkflowBadge(mesId);
        await this.persist();
      }
    } finally {
      clearTimeout(timeout);
      if (!usageRecorded && receipts.length && epoch === this.epoch && chatKey === this.chatKey) {
        const live = this.record?.attempts[attemptId];
        if (live) live.requestUsage = mergeRequestUsage(live.requestUsage, receipts);
        this.inspect({ kind: 'info', attemptId, message: 'Reply-check request usage; no automatic action applied.', networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts) });
        this.refreshWorkflowBadge(mesId);
        await this.persist();
      }
      if (this.replyCheckAbort === abort) {
        this.replyCheckAbort = null;
        this.approvedSwipeCursor = null;
      }
    }
  }

  private refreshWorkflowBadge(mesId: number, suppliedChain?: readonly string[]): boolean {
    if (!this.record) return false;
    const marker = this.host.readMarker(mesId);
    const variant = marker ? this.record.variants[marker.v] : null;
    const chain = suppliedChain ?? this.chainNow();
    const matches = Boolean(marker && variant?.attemptId === marker.a && variant.cursorAfter === chain[mesId + 1]
      && (this.record.attempts[marker.a]?.hostVariantRef ?? 0) === (this.host.chat()[mesId]?.swipe_id ?? 0));
    const attempt = matches && marker ? this.record.attempts[marker.a] : null;
    const saved = this.host.readWorkflowBadge(mesId);
    if (attempt && saved?.attemptId === attempt.attemptId
      && ['actorNames', 'move', 'route', 'writerInstruction', 'speaker', 'meterChanges', 'reveals', 'lore'].every(key => Object.hasOwn(saved, key))) {
      // Details describe that reply, even if the pack, actor names or secrets
      // have since changed or their old history has been compacted.
      return this.host.writeWorkflowBadge(mesId, { ...saved,
        ...(attempt.replyCheck ? { replyCheck: structuredClone(attempt.replyCheck) } : {}),
        ...(attempt.replyCheckError ? { replyCheckError: attempt.replyCheckError } : {}),
        ...(attempt.replyOriginalSwipe !== undefined ? { replyOriginalSwipe: attempt.replyOriginalSwipe } : {}),
        ...(attempt.requestUsage ? { requestUsage: structuredClone(attempt.requestUsage) } : {}) });
    }
    return this.host.writeWorkflowBadge(mesId, attempt ? buildWorkflowBadge({ attempt, record: this.record, pack: this.chatPack(),
      resolution: attempt.resolutionId ? this.record.resolutions[attempt.resolutionId] : null,
      permit: attempt.permitId ? this.record.permits[attempt.permitId] : null }) : null);
  }

  private refreshWorkflowBadges(from: number): void {
    const chain = this.chainNow();
    for (let index = from; index < this.host.chat().length; index++) {
      this.refreshWorkflowBadge(index, chain);
    }
  }

  canRerollSelected(): boolean {
    if (!this.record || !this.settings.modules.decisions) return false;
    const attempt = this.selectedAttempt();
    return Boolean((attempt?.resolutionId && this.record.resolutions[attempt.resolutionId]) || (attempt?.permitId && this.record.permits[attempt.permitId]));
  }

  private async onMessageSent(_mesId: number): Promise<void> {
    this.refreshStatus();
  }

  private async onMessageSwiped(mesId: number): Promise<void> {
    const automatic = this.automaticReply;
    const ownSwipe = automatic && !automatic.swipeObserved && this.host.chat()[mesId] === automatic.message
      && this.host.chat()[mesId]?.swipe_id === automatic.nextSwipe;
    if (ownSwipe) automatic.swipeObserved = true;
    if (!ownSwipe) this.cancelReplyCheck();
    // Keep the dispatch identity even if typing or another generation cancelled it
    // during the animation. SillyTavern still calls Generate unless a generation is
    // running; the interceptor consumes this cancel, and the dispatch clears it.
    if (ownSwipe && automatic.cancelled) return;
    if (!this.record || !this.settings.enabled || this.record.paused || this.pendingForSwipe) return;
    const chat = this.host.chat();
    const message = chat[mesId];
    if (!message) return;
    const newSwipe = Array.isArray(message.swipes) && (message.swipe_id ?? 0) >= message.swipes.length;
    if (!newSwipe) { this.refreshWorkflowBadges(mesId); return; }
    if (this.decidingNewSend) return;
    // A new swipe supersedes a Cancel armed for an earlier swipe whose Generate never came.
    if (!ownSwipe) this.cancelSwipe = false;
    const prefix = chat.slice(0, mesId);
    // The Director's own rewrite keeps the reply it checked, never the cursor's newest ruling.
    const source = (ownSwipe ? this.record.attempts[automatic.sourceId] : null) ?? this.attemptAt(prefix, mesId);
    const epoch = this.epoch;
    if (source) {
      if (!(await this.confirmRetry(source, source.cursorBefore ?? this.cursorOf(prefix)))) { if (!this.host.isGenerating()) this.cancelSwipe = true; return; }
      this.approvedSwipeCursor = source.cursorBefore ?? this.cursorOf(prefix);
    } else await this.prepareReplyRetry(true, prefix, false);
    if (epoch !== this.epoch || this.host.chat()[mesId] !== message) { this.cancelSwipe = true; return; }
    // SillyTavern calls Generate('swipe') only if nothing is generating when this
    // event returns; nothing armed for a swipe that never generates may outlive it.
    if (this.host.isGenerating()) { this.disarmSkippedSwipe(); return; }
    this.macroUpcomingAttemptId = source?.attemptId ?? null;
    this.macroUpcomingCursor = null;
    await this.persist();
    this.refreshStatus();
  }

  /** Clears what a swipe armed when SillyTavern skipped its generation; a new roll is never dropped silently. */
  private disarmSkippedSwipe(): void {
    if (this.explicitRetry) {
      this.inspect({ kind: 'info', attemptId: this.explicitRetry.sourceId, message: 'The new decision was not used: another reply started before its swipe.' });
      this.host.toast('warning', 'Another reply started, so the new roll was not used.');
    }
    this.cancelSwipe = false;
    this.approvedSwipeCursor = null;
    this.explicitRetry = null;
    this.pendingForSwipe = false;
    this.preparedInputCursor = null;
    if (this.record?.pending) this.apply({ type: 'cancel', attemptId: this.record.pending.attemptId, epoch: this.epoch, reason: 'the swipe was not generated' });
    if (this.status === 'Frozen') this.status = 'Ready';
    this.refreshStatus();
  }

  async regenerateSelected(): Promise<void> {
    if (this.settings.enabled && this.record && !this.record.paused && this.replyInProgress()) {
      this.host.toast('warning', 'Wait for the current reply to finish.');
      return;
    }
    this.cancelReplyCheck();
    if (!this.settings.enabled || !this.record || this.record.paused || this.host.isGenerating()) return;
    try { await this.host.swipeRight(this.attemptSpeakerIndex(this.selectedAttempt())); }
    finally { this.pendingForSwipe = false; this.explicitRetry = null; this.approvedSwipeCursor = null; }
  }

  async retryJudge(): Promise<boolean> {
    if (this.decisionCommandUnavailable()) return false;
    this.cancelReplyCheck();
    const source = this.selectedAttempt();
    if (source && !(source.judgeFailedStages?.some(s => ['move', 'route', 'ruling'].includes(s))
      || (source.judgeFailedStages === undefined && source.judgeErrors?.length && !source.resolutionId))) return false;
    return this.prepareReplyRetry(false, undefined, true);
  }

  /** Reassess the exchange answered by this reply, including explicit Next turns. */
  private async prepareReplyRetry(nativeSwipePending: boolean, suppliedPrefix?: HostChatMessage[], replay = false): Promise<boolean> {
    if (!this.record || !this.settings.enabled || this.record.paused || this.inFlight) return false;
    if (!nativeSwipePending && this.host.isGenerating()) return false;
    const chat = this.host.chat();
    const reply = suppliedPrefix ? chat[suppliedPrefix.length] : chat.at(-1);
    let prefix = suppliedPrefix ?? (chat.at(-1)?.is_user ? chat : chat.slice(0, -1));
    const source = this.attemptAt(prefix, reply ? prefix.length : undefined);
    if (source && replayIsTrimmed(this.record, source)) { this.host.toast('info', 'This turn is too old to reassess.'); return false; }
    if (source?.cursorBefore) {
      const boundIndex = cursorChain(this.record.seedId, this.host.fingerprintMessages(prefix)).indexOf(source.cursorBefore);
      if (boundIndex >= 0) prefix = prefix.slice(0, boundIndex);
    }
    const last = prefix.at(-1);
    const nextTurn = source?.turnKind === 'director_next' && source.inputText === '';
    const text = nextTurn ? '' : source?.inputText ?? (last?.is_user ? last.mes ?? '' : '');
    if (!nextTurn && (!text.trim() || text.trim().startsWith('/'))) return false;
    const reactionSettings = structuredClone(this.settings.reactions);
    const modules: TurnModules = { ...this.settings.modules, reactions: reactionSettings.enabled };
    if (!Object.values(modules).some(Boolean)) return false;
    const actors = this.bindActors();
    const candidates = actors.order.map(actorId => ({ actorId, exclusions: actors.byId[actorId]!.disabled ? ['disabled'] : [] }));
    const eligible = candidates.filter(candidate => candidate.exclusions.length === 0).map(candidate => candidate.actorId);
    const names = Object.fromEntries(actors.order.map(id => [id, actors.byId[id]!.name]));
    names[PLAYER_ACTOR_ID] = this.host.playerName();
    const selectedActor = source?.actorId ?? (reply?.original_avatar ? actors.byAvatar[reply.original_avatar] ?? null : eligible[0] ?? null);
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const cursor = this.cursorOf(prefix);
    this.status = 'Deciding';
    this.decidingMessage = last ?? null;
    this.notify();
    try {
      await this.stagedTurn({ kind: nextTurn ? 'director_next' : 'director_send', composerText: text, epoch, chatKey, actors, isGroup: this.host.isGroup(),
        candidates, eligible, names, explicit: selectedActor, nativeSpeaker: !selectedActor, lastSpeakerActorId: selectedActor,
        modules, reactionSettings, transcriptPrefix: nextTurn ? prefix : prefix.slice(0, -1), boundPrefix: prefix, swipe: true, nativeSwipePending,
        retrySource: source ?? undefined, replay,
        changed: () => this.cursorOf(this.host.chat().slice(0, prefix.length)) !== cursor,
      });
      return epoch === this.epoch && chatKey === this.chatKey;
    } finally { this.decidingMessage = null; if (!nativeSwipePending) { this.pendingForSwipe = false; this.preparedDeadline = null; } }
  }

  /**
   * SillyTavern spliced a swipe out: every later swipe of that message moved down
   * one place. Their attempts follow them (a badge matches its swipe by index),
   * and a rewrite's "original reply" index follows its original.
   */
  private onSwipeDeleted(details: unknown): void {
    const { messageId, swipeId } = (details ?? {}) as { messageId?: unknown; swipeId?: unknown };
    const message = typeof messageId === 'number' ? this.host.chat()[messageId] : undefined;
    if (!this.record || !message || typeof swipeId !== 'number' || !Array.isArray(message.swipe_info)) return;
    for (let index = swipeId; index < message.swipe_info.length; index++) {
      const marker = message.swipe_info[index]?.extra?.[VARIANT_MARKER_KEY] as { v?: unknown; a?: unknown } | undefined;
      const attempt = typeof marker?.a === 'string' ? this.record.attempts[marker.a] : undefined;
      if (!attempt || attempt.variantId !== marker!.v) continue;
      attempt.hostVariantRef = index;
      if (typeof attempt.replyOriginalSwipe === 'number' && attempt.replyOriginalSwipe >= 0) {
        if (attempt.replyOriginalSwipe > swipeId) attempt.replyOriginalSwipe -= 1;
        else if (attempt.replyOriginalSwipe === swipeId) attempt.replyOriginalSwipe = -1;
      }
    }
  }

  private async onHeadChanged(reason: 'edit' | 'delete' | 'unknown', mesId: number | null): Promise<void> {
    const automatic = this.automaticReply;
    if (automatic && reason === 'edit' && mesId !== null && automatic.message === this.host.chat()[mesId]) automatic.preserveUserChanges = true;
    this.cancelReplyCheck();
    if (!this.record) return;
    if (reason === 'edit') this.record = rebaseRecordCursors(this.record, this.host.chat(), this.host.fingerprintMessages(this.host.chat()), true);
    if (!this.decidingNewSend && this.decidingMessage && (!this.host.chat().includes(this.decidingMessage) || (mesId !== null && this.host.chat()[mesId] === this.decidingMessage))) this.inFlight?.abort(new Error('message being decided changed'));
    const chain = this.chainNow();
    if (reason === 'edit' && mesId !== null && !this.host.chat()[mesId]?.is_user) {
      const source = this.attemptAt(this.host.chat().slice(0, mesId), mesId);
      if (source && source.storyAfter === undefined && source.variantId) {
        const savedCursor = this.record.variants[source.variantId]?.cursorAfter;
        const saved = savedCursor ? snapshotAt(this.record.story, [savedCursor]) : null;
        if (saved) source.storyAfter = structuredClone(saved);
      }
      if (source?.storyAfter) this.record.story = withSnapshot(this.record.story, chain[mesId + 1]!, structuredClone(source.storyAfter));
      const marker = this.host.readMarker(mesId);
      const variant = marker ? this.record.variants[marker.v] : null;
      if (source && variant?.attemptId === source.attemptId) variant.cursorAfter = chain[mesId + 1]!;
    }
    this.apply({ type: 'head_changed' , cursor: chain.at(-1)!, chain, reason });
    this.refreshWorkflowBadges(mesId ?? 0);
    await this.persist();
    this.refreshStatus();
  }

  /** Only these explicit actions may replace a frozen decision. */
  async reroll(generateSwipe = true): Promise<boolean> {
    if (this.decisionCommandUnavailable()) return false;
    if (!this.canRerollSelected()) { this.host.toast('warning', 'There is no ruling to roll again.'); return false; }
    return this.changeDecision(false, generateSwipe);
  }

  async reassess(generateSwipe = true): Promise<boolean> {
    if (this.decisionCommandUnavailable()) return false;
    if (!this.canRerollSelected()) {
      if (!this.host.chat().some(message => message.is_user)) { this.host.toast('warning', 'There is no message to reassess.'); return false; }
      return generateSwipe ? this.prepareReplyRetry(false) : false;
    }
    return this.changeDecision(true, generateSwipe);
  }

  private decisionCommandUnavailable(): boolean {
    const message = !this.record ? 'Open a chat first.' : !this.settings.enabled ? 'The Director is off.'
      : this.record.paused ? 'The Director is paused in this chat.' : !this.settings.modules.decisions ? 'Director decisions are off.'
      : this.replyInProgress() ? 'Wait for the current reply to finish.' : '';
    if (message) this.host.toast('warning', message);
    return Boolean(message);
  }

  /**
   * A reply, swipe or automatic rewrite is still being written or saved. During
   * a swipe's animation is_send_press is still false, and our own swipes bypass
   * SillyTavern's one-swipe-at-a-time guard, so both are checked here.
   */
  private replyInProgress(): boolean {
    return this.host.isGenerating() || Boolean(this.inFlight) || Boolean(this.automaticReply) || this.host.swipeState() !== 'none';
  }

  /** `quietFailure`: the caller tells the user itself (a native regenerate keeps its result). */
  private async changeDecision(reassess: boolean, generateSwipe: boolean, suppliedSource?: GenerationAttempt, quietFailure = false): Promise<boolean> {
    this.cancelReplyCheck();
    if (!this.record || !this.settings.enabled || !this.settings.modules.decisions || this.record.paused || (!suppliedSource && this.host.isGenerating()) || this.inFlight) return false;
    const source = suppliedSource ?? this.selectedAttempt();
    if (!source) return false;
    const previous = source.resolutionId ? this.record.resolutions[source.resolutionId] : null;
    const previousPermit = source.permitId ? this.record.permits[source.permitId] : null;
    if ((reassess || (previous && previous.method !== 'sample') || (previousPermit && (previousPermit.profile ?? this.profile).resolutionMethod !== 'sample'))
      && replayIsTrimmed(this.record, source)) { if (!quietFailure) this.host.toast('info', 'This turn is too old to reassess.'); return false; }
    if (!previous && !previousPermit) return false;
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const cursor = this.cursorOf(this.host.chat());
    const marker = this.host.readMarker(this.host.chat().length - 1);
    // A decision that dispatches its own swipe must not race another reply or swipe
    // (a W3 Roll again runs inside the user's swipe and dispatches nothing).
    const idle = () => !generateSwipe || (!this.automaticReply && this.host.swipeState() === 'none');
    const current = () => epoch === this.epoch && chatKey === this.chatKey && cursor === this.cursorOf(this.host.chat())
      && marker?.v === this.host.readMarker(this.host.chat().length - 1)?.v && this.settings.enabled && !this.record?.paused && idle();
    const abort = new AbortController();
    this.inFlight = abort;
    const timer = setTimeout(() => abort.abort(new JudgeWaitBudget()), Math.max(0, this.settings.waitForJudgeSeconds) * 1000);
    let next: FrozenResolution | null = null;
    let permit: TurnPermit | null = null;
    let networkCalls = 0;
    const receipts: RequestUsage[] = [];
    let usageRecorded = false;
    try {
      if (previous) {
        let answer = previous.assessment;
        let result: EvaluationResult | null = null;
        const shouldAssess = reassess || previous.method !== 'sample';
        if (shouldAssess) {
          const questionId = previous.action.move ? 'ruling' : this.profile.drivingQuestionId;
          const question = previous.action.move ? this.stagedRulingQuestion(previous.action.move)
            : questionId === 'gain_score' ? attemptScoreQuestion(previous.action) : attemptNoulQuestion(previous.action);
          const questions = { [questionId]: question };
          result = await withinBudget(this.usageProvider(this.provider(), 'reassess', receipts).evaluate({ requestId: newId('req'), phase: 'guide', snapshot: { ...previous.snapshot, state: visibleJudgeData(previous.snapshot.state) }, questions: visibleJudgeData(questions) }, abort.signal), abort.signal);
          networkCalls = receipts.length;
          const checked = validateStageAnswers('ruling', questions, result);
          answer = checked.result.answers[questionId] ?? null;
          if (!answer) throw new StagedError('ruling', checked.errors[0]?.message ?? 'No valid reassessment', checked.errors[0]?.type ?? 'invalid_answers');
        }
        if (!answer) throw new StagedError('ruling', 'This reply has no saved assessment', 'invalid_answers');
        const signal = normaliseSignal(answer);
        if (!signal.ok) throw new StagedError('ruling', signal.error, 'invalid_answers');
        const method = shouldAssess ? this.profile.resolutionMethod : 'sample';
        const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method,
          signal: signal.signal, draw: method === 'sample' ? randomDraw().u : null });
        if (!resolved.ok) throw new StagedError('ruling', resolved.error, 'invalid_answers');
        next = freeze({ ...previous, resolutionId: newId('res'), previousResolutionId: previous.resolutionId,
          generation: previous.generation + 1, assessment: answer, decisionSource: 'provider', method,
          band: resolved.value.band, def: resolved.value.def, outcome: resolved.value.outcome, draw: resolved.value.draw,
          requestedModel: result?.requestedModel ?? previous.requestedModel, returnedModel: result?.returnedModel ?? previous.returnedModel, now: Date.now() });
        if (previous.replayTrimmed) next.replayTrimmed = true;
      }
      if (previousPermit) {
        const profile = previousPermit.profile ?? this.profile;
        const names = Object.fromEntries(Object.values(this.record.actors).map(a => [a.actorId, a.name]));
        if (reassess || profile.resolutionMethod !== 'sample') {
          if (!previousPermit.proposal || !previousPermit.snapshot) throw new Error('This NPC result has no saved question');
          const result = await withinBudget(adjudicateTurnProposal({ proposal: previousPermit.proposal, snapshot: previousPermit.snapshot,
            profile, provider: this.usageProvider(this.planningProvider(this.provider()), 'npc_reassess', receipts), actorNames: names, playerName: this.host.playerName(), signal: abort.signal }), abort.signal);
          permit = result.permit;
          permit.previousPermitId = previousPermit.permitId;
          networkCalls = receipts.length;
        } else permit = rerollPermit(previousPermit, profile, names, this.host.playerName());
      }
      if (!current() || abort.signal.aborted) return false;
      if (reassess || (previous && previous.method !== 'sample') || (previousPermit && (previousPermit.profile ?? this.profile).resolutionMethod !== 'sample')) this.recoverJudgeStage('reassess');
      if (next && previous) this.apply({ type: 'reroll', previousResolutionId: previous.resolutionId, resolution: next, now: Date.now() });
      if (permit) this.apply({ type: 'store_permit', permit });
      const inspectorId = newId('ins');
      this.explicitRetry = { sourceId: source.attemptId, resolutionId: next?.resolutionId ?? source.resolutionId, permitId: permit?.permitId ?? source.permitId ?? null, inspectorId };

      this.inspect({ id: inspectorId, kind: 'reroll', resolutionId: next?.resolutionId ?? null, outcome: next?.outcome ?? null, draw: next?.draw ?? null,
        networkCalls, requestUsage: mergeRequestUsage(receipts), message: `${reassess ? 'Reassessed' : 'Rerolled'} the selected reply; the new decision will be used on a new swipe.` });
      usageRecorded = true;
      await this.persist();
      // Deadline ends before the writer starts. The original swipe stays intact.
      clearTimeout(timer);
      if (this.inFlight === abort) this.inFlight = null;
      if (generateSwipe) {
        if (!idle() || this.host.isGenerating()) {
          // Another reply started while the decision was saved: say so, never drop the draw silently.
          this.explicitRetry = null;
          this.inspect({ kind: 'info', attemptId: source.attemptId, message: 'The new decision was not used: another reply started before its swipe.' });
          this.host.toast('warning', 'Wait for the current reply to finish.');
          return false;
        }
        try { await this.host.swipeRight(this.attemptSpeakerIndex(source)); } finally { this.explicitRetry = null; this.pendingForSwipe = false; }
      }
      return true;
    } catch (error) {
      if (current()) {
        const failure = stageError('ruling', error);
        this.reportJudgeError(failure.type, `Decision unchanged: ${failure.message}`, {}, 'reassess', !quietFailure);
        await this.persist();
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (this.inFlight === abort) this.inFlight = null;
      if (!usageRecorded && receipts.length && epoch === this.epoch && chatKey === this.chatKey) {
        this.inspect({ kind: 'info', attemptId: source.attemptId, message: 'Reassessment request usage; the decision stayed unchanged.', networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts) });
        await this.persist();
      }
      this.refreshStatus();
    }
  }

  // ---- table test -------------------------------------------------------------

  /**
   * Sends the edited (not yet applied) table through one judge call on the
   * selected connection and reports whether every answer came back in the
   * expected format. Nothing is frozen and no chat state changes.
   */
  async testTable(table: PolicyTable, method: 'threshold' | 'sample'): Promise<TableTestReport> {
    const v = validateTable(table);
    if (!v.ok) return localFailure(v.errors);
    const kind = this.settings.connection.kind;
    const connectionAtStart = JSON.stringify(this.settings.connection);
    if (kind === 'mock' || kind === 'rules') return localOnly(kind);
    let provider: DecisionProvider;
    try { provider = this.provider(); } catch (e) { return transportFailure('connection', (e as Error).message, null); }
    const request = buildTableTestRequest(table, this.profile.drivingQuestionId, newId('req'));
    const abort = new AbortController();
    const started = Date.now();
    const receipts: RequestUsage[] = [];
    let report: TableTestReport;
    try {
      const result = await this.usageProvider(provider, 'table_test', receipts).evaluate(request, abort.signal);
      this.lastWorkingConnection = connectionAtStart;
      report = evaluateTableTest(table, method, request, result);
      this.inspect({ kind: 'info', message: `Table test: ${report.headline}`, questions: request.questions, stateSent: request.snapshot.state, answers: result.answers, providerKind: result.provider, requestedModel: result.requestedModel, returnedModel: result.returnedModel, durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts) });
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'error';
      report = transportFailure(code, (e as Error).message, Date.now() - started);
      this.inspect({ kind: 'error', message: `Table test failed: ${code}: ${(e as Error).message}`, questions: request.questions, stateSent: request.snapshot.state, providerKind: provider.kind, networkCalls: receipts.length, requestUsage: mergeRequestUsage(receipts) });
    }
    await this.persist();
    return report;
  }

  // ---- settings ---------------------------------------------------------------

  setEnabled(enabled: boolean): void {
    this.cancelReplyCheck();
    this.settings.enabled = enabled;
    this.host.saveSettings();
    if (enabled) {
      this.host.takeOverAuto();
      this.registerWriterTool();
      void this.loadChat();
    }
    if (!enabled) {
      this.inFlight?.abort(new Error('disabled'));
      this.inFlight = null;
      this.toolWindow = null;
      this.preparedTool = null;
        if (this.record) this.apply({ type: 'abort_epoch', epoch: this.epoch, reason: 'Director disabled' });
      this.epoch += 1;
      this.currentAttemptId = null;
      this.host.clearInjection();
      void this.persist();
    }
    this.refreshStatus();
  }

  setSpeakerOverride(value: string | null): void {
    this.speakerOverride = value;
    this.notify();
  }

  setActorPolicy(value: ActorPolicy): void {
    const allowed: ActorPolicy[] = ['player_favorable', 'player_attempts', 'contested', 'any_declared_actor'];
    if (!allowed.includes(value)) return;
    const id = this.profile.id;
    this.settings.profileOverrides[id] = { ...(this.settings.profileOverrides[id] ?? {}), actorPolicy: value };
    this.host.saveSettings();
    this.reloadProfile();
  }

  setActionDraft(draft: ActionDraft | null): void {
    this.actionDraft = draft;
    this.actionDraftRevision += 1;
    this.notify();
  }
}
