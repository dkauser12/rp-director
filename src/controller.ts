/**
 * Controller: pre-pass → freeze → write → accept → (observe, later).
 *
 * Owns the per-chat record, the epoch, and the one in-flight decision. Every
 * state change goes through the reducer in state.ts; every host touch goes
 * through host.ts. Nothing here calls a provider more than once per turn.
 */
import type {
  ActionSpec, ActorPolicy, Answer, Applicability, DecisionProvider, LoreBookMode, DecisionSnapshot, DirectorChatRecord, DirectorProfile, DirectorSettings,
  EvaluationResult, FailureStakeKind, FrozenResolution, GenerationType, InspectorEntry,
  Json, ObservationRequest, Outcome, Question, ResolutionScope, SpeakerDecision, StagedMove, TurnPermit,
} from './types.ts';
import { YIELD } from './types.ts';
import { Host, jsonSafe } from './host.ts';
import type { HostActor, HostChatMessage } from './host.ts';
import { actorIdFor, newId, prefixCursor, cursorChain, randomDraw, PLAYER_LABEL } from './identity.ts';
import { applyEvent, normalizeRecord, activeResolutionForCursor, provisionalAttempts, emptyState } from './state.ts';
import type { DirectorEvent } from './state.ts';
import { gateAction, normaliseSignal, resolveOutcome, freeze, defOfResolution, instructionForResolution } from './resolver.ts';
import type { PolicyTable } from './table.ts';
import { validateTable } from './table.ts';
import { buildTableTestRequest, evaluateTableTest, localFailure, localOnly, transportFailure } from './tabletest.ts';
import type { TableTestReport } from './tabletest.ts';
import { decideSpeaker } from './speaker.ts';
import type { SpeakerCandidate } from './speaker.ts';
import { autoAttemptFamilyQuestion, autoAttemptGateQuestion, autoAttemptNoulQuestion, attemptNoulQuestion, attemptScoreQuestion, buildState, checkBatch, speakerQuestion } from './questions.ts';
import type { BuiltState } from './questions.ts';
import { bindingBlock, advisoryBlock, combinedBlock, fillPlaceholders, placeholderValues } from './prompts.ts';
import { AUTOMATIC_GAIN, declareAction, templateById } from './templates.ts';
import { effectiveProfile } from './profiles.ts';
import { createMockProvider, createRulesProvider, createJevProvider, createOpenRouterDecisionsProvider, createStructuredProvider, createDirectFetchTransport, ProviderError } from './providers.ts';
import { interpretAutomaticAttempt } from './auto.ts';
import {
  DIRECTOR_TOOL_NAME, DIRECTOR_TOOL_DESCRIPTION, TURN_PROPOSAL_SCHEMA, adjudicateTurnProposal, permitFollowupBlock,
  toolPlanningBlock, validateTurnProposal, writerPermit,
} from './director-tool.ts';
import type { ToolProposalErrorCode } from './director-tool.ts';
import {
  buildObservationRegistry, createDecisionObservationProvider, createLocalObservationProvider,
  createStructuredObservationProvider,
} from './observer.ts';
import type { ObservationProvider } from './observer.ts';
import { rerollPermit, reviewPermit } from './roll-review.ts';
import { recoverInterruptedObservations } from './migration.ts';
import { formatResultFooter, stripResultFooter } from './result-footer.ts';
import { chooseReaction, reactionQuestion } from './npc-reaction.ts';
import type { ReactionKind, ReactionResult, ReactionSettings } from './npc-reaction.ts';
import { runStaged, StagedError } from './pipeline/staged.ts';
import type { StagedOutput, StageId } from './pipeline/staged.ts';
import type { EvidenceActor } from './pipeline/evidence.ts';
import { rulingQuestion } from './pipeline/questions.ts';
import { familyByKey, meterLabel } from './pack/pack.ts';
import type { GenrePack } from './pack/pack.ts';
import { hasPack, listPacks, loadLocalPacks, packById } from './pack/packs.ts';
import { packQuestion } from './pipeline/pack-pick.ts';
import { applyStateAnswers, meterFacts, stateBlock, stateEvidence, stateQuestions } from './pipeline/character-state.ts';
import { knownByAt, levelsAt, loreAt, snapshotAt, withLore, withSnapshot } from './story.ts';
import { buildTree, selectable } from './lore/tree.ts';
import { loreSceneState, runLoreStage } from './lore/stage.ts';
import type { LoreBookInput, LoreStageResult } from './lore/stage.ts';
import { bookSettings, effectiveMode, lorePlan } from './lore/settings.ts';

export type DirectorStatus = 'Off' | 'No chat' | 'Ready' | 'Deciding' | 'Frozen' | 'Writing' | 'Review rolls' | 'Observing' | 'Provisional' | 'Stale' | 'Paused' | 'Error';

export interface ActionDraft {
  templateId: string;
  actingActorId: string;
  targetActorIds: string[];
  attemptedAction: string;
  requestedGain: string;
  applicability: Applicability;
  uncertainConsequential: boolean;
  opposed: boolean;
  resolutionScope: ResolutionScope;
  persistentFactKey: string;
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

interface TurnModules { speaker: boolean; decisions: boolean; reactions: boolean; meters: boolean; secrets: boolean; lore: boolean }

/** Characters of public scene the lore questions carry. */
const LORE_STATE_CHARS = 24000;

/** One turn's lore stage: its result, the books it could draw on, or why it failed. */
interface LoreTurn {
  result: LoreStageResult | null;
  books: string[];
  error: string | null;
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
}

/** Everything the shared end of a turn needs, from either pipeline. */
interface TurnFinish {
  /** story.lore key of this turn's picks, or null when lore did not run. */
  loreCursor: string | null;
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
}

type ToolWindowPhase = 'initial' | 'reviewing' | 'cancelled' | 'followup_pending' | 'followup_writing' | 'failed_pending' | 'failed_writing' | 'malformed_pending' | 'malformed_writing';
type PendingSwipeMode = 'reuse' | 'adopt' | 'bypass' | 'cancel';

interface ToolWindow {
  requestId: string;
  attemptId: string;
  speakerActorId: string;
  baseCursor: string;
  stateRevision: number;
  chatLengthAtBind: number;
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
  private observerInFlight = new Map<string, AbortController>();
  private pendingSwipeMode: PendingSwipeMode | null = null;
  private nativeTurnBusy = false;
  private sceneTransitionPending = false;
  private swipeSource: { epoch: number; chatKey: string | null; message: ReturnType<Host['chat']>[number]; index: number; swipe: number; baseCursor: string; resolutionId: string | null; permitId: string | null; reaction: ReactionResult | null } | null = null;

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
    void loadLocalPacks().then(result => { if (result.warnings.length) console.warn('[RP Director] local packs:', ...result.warnings); this.notify(); });
    const sub = (event: string, handler: (...args: unknown[]) => unknown) => this.unsubscribe.push(this.host.on(event, handler));
    sub('CHAT_CHANGED', () => void this.onChatChanged());
    sub('GENERATION_STARTED', (type, params) => void this.onGenerationStarted(String(type), params as Record<string, unknown> | undefined));
    sub('GENERATION_STOPPED', () => void this.onGenerationStopped());
    sub('GENERATION_ENDED', () => this.onGenerationEnded());
    sub('MESSAGE_RECEIVED', (mesId, type) => { this.queueMessageReceived(Number(mesId), String(type ?? 'normal')); });
    if (this.host.ctx().eventTypes.CHARACTER_MESSAGE_RENDERED) sub('CHARACTER_MESSAGE_RENDERED', async mesId => {
      if (this.settings.enabled && this.refreshResultFooter(Number(mesId))) await this.persist();
    });
    sub('MESSAGE_SENT', (mesId) => this.onMessageSent(Number(mesId)));
    sub('MESSAGE_SWIPED', (mesId) => this.onMessageSwiped(Number(mesId)));
    sub('MESSAGE_EDITED', (mesId) => void this.onHeadChanged('edit', Number(mesId)));
    sub('MESSAGE_DELETED', () => void this.onHeadChanged('delete', null));
    sub('MESSAGE_SWIPE_DELETED', () => void this.onHeadChanged('unknown', null));
    this.loreHooked = this.host.installLoreHook();
    this.host.onLoreActivation = () => this.notify();
    this.registerWriterTool();
    this.unsubscribe.push(this.host.interceptNativeSend(
      () => this.settings.enabled && !this.host.isAutoDirectorEnabled(),
      () => this.directorSend(),
    ));
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
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.host.unregisterFunctionTool(DIRECTOR_TOOL_NAME);
    this.host.removeLoreHook();
    for (const controller of this.observerInFlight.values()) controller.abort(new Error('Director destroyed'));
    this.observerInFlight.clear();
    this.toolWindow = null;
    this.preparedTool = null;
    this.pendingSwipeMode = null;
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

  private fail(message: string, extra: Partial<InspectorEntry> = {}): void {
    this.lastError = message;
    this.status = 'Error';
    this.inspect({ kind: 'error', message, ...extra });
    this.host.toast('error', message);
    this.notify();
  }

  private checkDecisionContext(built: BuiltState): boolean {
    const size = `${built.serializedCharacters}/${this.profile.budgets.maxSerializedCharacters} characters`;
    if (built.overBudget) {
      this.fail(`Judge context exceeds the limit (${size}) even after removing older messages. Shorten the message or manual attempt, or review the saved facts in Inspector. No decision was requested.`);
      return false;
    }
    if (built.exclusions.length) {
      this.inspect({ kind: 'info', message: `Judge context (${size}): ${built.exclusions.join('; ')}.` });
    }
    return true;
  }

  refreshStatus(): void {
    if (!this.settings.enabled) { this.status = 'Off'; this.notify(); return; }
    if (!this.record) { this.status = 'No chat'; this.notify(); return; }
    if (this.status === 'Deciding' || this.status === 'Writing' || this.status === 'Review rolls' || this.status === 'Paused' || this.status === 'Error') { this.notify(); return; }
    if (Object.values(this.record.attempts).some(attempt => attempt.status === 'observing')) this.status = 'Observing';
    else if (provisionalAttempts(this.record).length > 0) this.status = 'Provisional';
    else if (this.record.pending) this.status = 'Frozen';
    else if (this.record.projection.status === 'stale') this.status = 'Stale';
    else this.status = 'Ready';
    this.notify();
  }

  clearError(): void {
    if (this.status === 'Error' || this.status === 'Paused') this.status = 'Ready';
    this.lastError = null;
    this.refreshStatus();
  }

  // ---- chat load --------------------------------------------------------------

  async loadChat(): Promise<void> {
    this.chatKey = this.host.chatKey();
    this.speakerOverride = null;
    this.actionDraft = null;
    this.actionDraftRevision += 1;
    this.currentAttemptId = null;
    this.pendingInjection = '';
    this.toolWindow = null;
    this.preparedTool = null;
    this.pendingSwipeMode = null;
    this.swipeSource = null;
    for (const controller of this.observerInFlight.values()) controller.abort(new Error('chat loaded'));
    this.observerInFlight.clear();
    this.host.clearInjection();
    if (!this.settings.enabled) {
      this.record = null;
      this.status = 'Off';
      this.notify();
      return;
    }
    if (!this.chatKey) {
      this.record = null;
      this.status = 'No chat';
      this.notify();
      return;
    }
    const recovered = recoverInterruptedObservations(normalizeRecord(this.host.readRecord(), this.host.seedId(), this.profile.revision));
    this.record = recovered.record;
    if (recovered.recoveredVariantIds.length) this.inspect({ kind: 'restore', message: `Prepared ${recovered.recoveredVariantIds.length} legacy or interrupted observation(s) for retry; accepted history was retained.` });
    this.bindActors();
    const chain = this.chainNow();
    const head = chain[chain.length - 1]!;
    if (Object.keys(this.record.checkpoints).length === 0) {
      this.apply({ type: 'set_baseline', cursor: head, state: emptyState(), reason: 'first Director use in this chat' });
      this.inspect({ kind: 'info', message: 'Baseline set at the current transcript head. Earlier state was not reconstructed.' });
    } else {
      this.apply({ type: 'head_changed', cursor: head, chain, reason: 'load' });
      const pending = this.record.pending;
      if (pending) {
        this.apply({ type: 'cancel', attemptId: pending.attemptId, epoch: pending.epoch, reason: 'reload before the writer started; the frozen resolution stays available' });
        this.inspect({ kind: 'info', message: 'An interrupted decision was found after reload. Its ruling remains in history. Send again when ready; a wording swipe can reuse an existing ruling.' });
      }
      for (const attempt of Object.values(this.record.attempts)) {
        if (attempt.status === 'writing' || attempt.status === 'prepared') this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: attempt.epoch, reason: 'reload during generation' });
      }
    }
    this.status = 'Ready';
    this.refreshResultFooters(0, chain);
    await this.persist();
    if (this.hasRepairableSelectedFailure() && this.canAdoptEmptyBaseline()) await this.repairSelectedBranch();
    this.refreshStatus();
  }

  private async onChatChanged(): Promise<void> {
    this.epoch += 1;
    void this.host.armLore(null);
    this.inFlight?.abort(new Error('chat changed'));
    this.inFlight = null;
    for (const controller of this.observerInFlight.values()) controller.abort(new Error('chat changed'));
    this.observerInFlight.clear();
    this.toolWindow = null;
    this.preparedTool = null;
    this.pendingSwipeMode = null;
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

  /**
   * User messages extend the accepted prefix without changing tracked state.
   * Walks back over trailing user messages and copies the nearest checkpoint
   * forward so the generation's predecessor state is known.
   */
  private ensurePredecessor(prefix: ReturnType<Host['chat']>): void {
    if (!this.record) return;
    const seed = this.record.seedId;
    const fp = this.host.fingerprintMessages(prefix);
    const chain = cursorChain(seed, fp);
    const head = chain[chain.length - 1]!;
    if (this.record.checkpoints[head]) return;
    // Find the nearest earlier prefix that has a checkpoint, crossing only user messages.
    let i = fp.length;
    while (i > 0 && fp[i - 1]!.role === 'user' && !this.record.checkpoints[chain[i]!]) i -= 1;
    const parentCursor = chain[i]!;
    if (!this.record.checkpoints[parentCursor]) return;
    for (let j = i + 1; j <= fp.length; j++) {
      this.apply({ type: 'extend_checkpoint', cursor: chain[j]!, parentCursor: chain[j - 1]! });
    }
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
      if (this.hasRepairableSelectedFailure()) await this.repairSelectedBranch();
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

  /** Finite continuation: re-selects after each accepted reply up to the profile cap; stops on YIELD, provisional, stale, or Stop. */
  async directorContinue(cap = 3): Promise<void> {
    this.continueRemaining = Math.max(1, Math.min(cap, 3));
    while (this.continueRemaining > 0) {
      this.continueRemaining -= 1;
      const before = this.record ? Object.keys(this.record.attempts).length : 0;
      await this.directorTurn('director_next');
      if (!this.record) break;
      const after = Object.keys(this.record.attempts).length;
      if (after === before) break; // yielded, paused, or failed
      if (this.status === 'Observing' || this.status === 'Stale' || this.status === 'Paused' || this.status === 'Error') break;
    }
    this.continueRemaining = 0;
  }

  stopContinue(): void {
    this.continueRemaining = 0;
    this.host.stopGeneration();
  }

  private async guardTurn(): Promise<boolean> {
    if (!this.settings.enabled) { this.host.toast('warning', 'RP Director is disabled.'); return false; }
    if (this.host.isAutoDirectorEnabled()) { this.host.toast('warning', 'The legacy RP Director Auto is active. Enable RP Director to take over.'); return false; }
    if (!this.record || !this.chatKey) { this.host.toast('warning', 'No chat is open.'); return false; }
    if (this.host.isGenerating()) { this.host.toast('warning', 'A generation is already running.'); return false; }
    if (this.host.isAutoMode()) { this.host.toast('warning', 'Group auto mode is on. Turn it off before using Director.'); return false; }
    if (provisionalAttempts(this.record).length > 0) { this.host.toast('warning', 'The selected reply is still being observed or awaits commit. Wait for observation, then try again.'); return false; }
    if (this.record.projection.status === 'stale') { this.host.toast('warning', 'Tracked state needs repair. Choose Repair selected branch from the Director menu.'); return false; }
    if (this.record.projection.status === 'unknown') {
      if (!this.canAdoptEmptyBaseline()) { this.host.toast('warning', 'This branch has no saved Director state. Restore a tracked swipe or explicitly reset tracking at this message.'); return false; }
      const chain = this.chainNow();
      this.apply({ type: 'set_baseline', cursor: chain[chain.length - 1]!, state: this.record.projection.state, reason: 'no checkpoint matched the transcript head' });
      this.inspect({ kind: 'info', message: 'No checkpoint matched the current transcript; a baseline was set from the last known state.' });
    }
    if (this.profile.mode === 'binding' && !this.settings.bindingConfirmedAt) {
      const ok = await this.host.confirm('Binding outcomes and frozen swipes',
        '<p>Director uses normal <b>Send and Enter</b> to decide consequential attempts before the writer runs. A ruled outcome is <b>preserved across wording swipes and regenerations</b>. Explicit rerolls or reassessments change the ruling. Newly planned NPC actions pause for your review when the writer calls the Director tool.</p><p>The observer checks the reply; its validated changes commit when you continue from that reply or choose <b>Commit reply</b>. Disable RP Director in Extensions to return to ordinary chat.</p>');
      if (!ok) { this.host.toast('info', 'Cancelled; nothing was generated. Confirm next time, or disable RP Director in Extensions for ordinary chat.'); return false; }
      this.settings.bindingConfirmedAt = new Date().toISOString();
      this.host.saveSettings();
    }
    return true;
  }

  private async directorTurn(kind: 'director_send' | 'director_next'): Promise<void> {
    if (!(await this.commitCurrentVariant('next Director turn'))) return;
    if (!(await this.guardTurn())) return;
    const record = this.record!;
    const composerText = kind === 'director_send' ? this.host.composerText() : '';
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const declarationRevision = this.actionDraftRevision;
    const profileRevisionAtStart = this.profile.revision;
    const reactionSettings = structuredClone(this.settings.reactions);
    const reactionSettingsAtStart = JSON.stringify(reactionSettings);
    const sceneIdAtStart = record.projection.state.sceneId;
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

    if (!modules.speaker && !modules.decisions && !modules.reactions && !modules.meters && !modules.secrets && !modules.lore) {
      // Every suite is off: the Director stands aside for this turn.
      this.inspect({ kind: 'info', message: 'Every Director module is off; native generation with no Director request or injection.' });
      await this.persist();
      try { await this.host.generate(null); } catch (e) { console.warn(e); }
      return;
    }

    this.status = 'Deciding';
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
    if (!isGroup && eligible.length === 1) explicit = eligible[0]!;
    // With the Speaker module off, the host's own group activation picks the replier.
    const nativeSpeaker = isGroup && !explicit && !modules.speaker;
    const changed = (): boolean => this.actionDraftRevision !== declarationRevision || this.profile.revision !== profileRevisionAtStart
      || this.record?.projection.state.sceneId !== sceneIdAtStart || JSON.stringify(this.settings.reactions) !== reactionSettingsAtStart;

    const manual = modules.decisions && this.actionDraft ? this.buildDeclaredAction(actors) : null;
    if (this.settings.pipeline === 'staged' && !manual && composerText.trim()) {
      await this.stagedTurn({ kind, composerText, epoch, chatKey, actors, isGroup, candidates, eligible, names, explicit, nativeSpeaker, lastSpeakerActorId, modules, reactionSettings, changed });
      return;
    }

    // Legacy pipeline: one batch (speaker, automatic gate/family/Noul, reaction triggers).
    let action = manual ?? (modules.decisions ? this.buildAutomaticAction(composerText, record.projection.state.sceneId) : null);
    const established = record.projection.state.variables;
    const gate = gateAction(action, established, this.profile.outcomes, {
      actorPolicy: this.profile.actorPolicy,
      playerActorId: PLAYER_ACTOR_ID,
      currentSceneId: record.projection.state.sceneId,
      settledGains: record.projection.state.settledGains,
    });
    const questions: Record<string, Question> = {};
    const needSpeaker = modules.speaker && isGroup && !explicit && eligible.length > 0;
    if (needSpeaker) questions.speaker = speakerQuestion(eligible, names, this.profile.speakers.includeYield, composerText.trim() || null);
    const needGain = modules.decisions && gate.kind === 'adjudicate';
    const drivingId = this.profile.drivingQuestionId;
    if (needGain && action) {
      if (manual) questions[drivingId] = drivingId === 'gain_score' ? attemptScoreQuestion(action) : attemptNoulQuestion(action);
      else {
        questions.attempt_gate = autoAttemptGateQuestion();
        questions.attempt_family = autoAttemptFamilyQuestion();
        questions[drivingId] = autoAttemptNoulQuestion();
      }
    }

    const reactionQuestions = new Map<string, string>();
    if (reactionSettings.enabled && !manual && composerText.trim()) {
      const remaining = Math.max(0, this.profile.budgets.maxQuestions - Object.keys(questions).length);
      const candidates = explicit ? [explicit].filter(id => eligible.includes(id)) : eligible;
      for (const [index, id] of candidates.slice(0, remaining).entries()) {
        const questionId = `npc_reaction_${index + 1}`;
        reactionQuestions.set(id, questionId);
        questions[questionId] = reactionQuestion(id);
      }
    }

    const recent = this.host.chat().filter(m => !m.is_system).slice(-this.profile.budgets.maxRecentMessages).map(m => ({
      actorId: m.is_user ? PLAYER_ACTOR_ID : (actors.byAvatar[m.original_avatar ?? ''] ?? `name:${m.name}`),
      role: m.is_user ? 'user' as const : 'assistant' as const,
      text: m.is_user ? m.mes ?? '' : stripResultFooter(m.mes ?? ''),
    }));
    // Automatic detection cannot safely distinguish card truth from observer
    // knowledge before the independent family answer exists. Omit raw cards.
    const publicCards: Record<string, string> = {};
    const built = buildState({
      scopeId: 'shared-public',
      actors: record.actors,
      eligibleActorIds: eligible,
      publicCards,
      facts: jsonSafe(established) as Record<string, never>,
      action,
      latestInput: composerText,
      recentMessages: recent,
      sceneId: record.projection.state.sceneId,
      acceptedReplyCount: record.projection.state.sceneReplyCount,
      maxRecentMessages: this.profile.budgets.maxRecentMessages,
      maxSerializedCharacters: this.profile.budgets.maxSerializedCharacters,
    });
    if (!this.checkDecisionContext(built)) { await this.persist(); return; }
    const snapshot: DecisionSnapshot = {
      chatId: chatKey!,
      cursorBefore: this.chainNow().at(-1)!,
      stateRevision: record.projection.state.revision,
      scopeId: 'shared-public',
      profileRevision: this.profile.revision,
      catalogRevision: '',
      actorBindingRevision: actors.order.join(','),
      state: built.state,
    };

    let result: EvaluationResult | null = null;
    let networkCalls = 0;
    if (Object.keys(questions).length > 0) {
      const check = checkBatch(questions, this.profile.budgets.maxQuestions, Object.keys(questions).map(() => 'shared-public'));
      if (!check.ok) { this.fail('Batch rejected: ' + check.errors.join('; ')); return; }
      let provider: DecisionProvider;
      try { provider = this.provider(); } catch (e) { this.fail(`Connection error: ${(e as Error).message}`); return; }
      if (this.isNetworkProvider()) networkCalls = 1;
      const abort = new AbortController();
      this.inFlight = abort;
      const requestId = newId('req');
      try {
        result = await provider.evaluate({ requestId, phase: 'guide', snapshot, questions }, abort.signal);
      } catch (e) {
        this.inFlight = null;
        if (epoch !== this.epoch || this.chatKey !== chatKey) {
          console.debug('[RP Director] decision aborted by a chat switch; no record touched');
          return;
        }
        const msg = e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message;
        if (needGain) {
          this.status = 'Paused';
          this.inspect({ kind: 'error', message: `Binding provider failed before freeze; paused (no advisory downgrade, no fallback). ${msg}`, questions, stateSent: built.state, providerKind: provider.kind, networkCalls, actionId: action?.actionId ?? null });
          this.host.toast('error', `Provider failed before the outcome was frozen: ${msg}. Nothing was generated. Retry, rule manually, or fix the connection.`);
          await this.persist();
          this.notify();
          return;
        }
        if (needSpeaker) {
          this.status = 'Paused';
          this.inspect({ kind: 'error', message: `Speaker provider failed: ${msg}. Pick a speaker explicitly or retry.`, questions, stateSent: built.state, providerKind: provider.kind, networkCalls });
          this.host.toast('error', `Speaker assessment failed: ${msg}. Choose a speaker in the bar and try again.`);
          await this.persist();
          this.notify();
          return;
        }
        this.inspect({ kind: 'info', message: `Optional NPC reaction unavailable; continuing without it. ${msg}`, questions, stateSent: built.state, networkCalls });
      }
      this.inFlight = null;
      if (epoch !== this.epoch || this.chatKey !== chatKey) {
        this.inspect({ kind: 'error', message: 'Decision result arrived after the chat changed; discarded.' });
        return;
      }
      if (kind === 'director_send' && this.host.composerText() !== composerText) {
        this.status = 'Ready';
        this.inspect({ kind: 'error', message: 'Composer text changed while deciding; preparation discarded (nothing was frozen).', questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls });
        this.host.toast('warning', 'Your message changed while Director was deciding. Press Send again.');
        await this.persist();
        return;
      }
      if (changed()) {
        this.status = 'Ready';
        this.inspect({ kind: 'error', message: 'The declared attempt, actor policy, profile, reactions, or scene changed while deciding; the result was discarded before freeze.', questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls });
        this.host.toast('warning', 'The attempt or scene changed while the Director was deciding. Review it and send again.');
        await this.persist();
        return;
      }
    }

    if (action && needGain && !manual) {
      const interpreted = interpretAutomaticAttempt(action, result?.answers ?? {}, result?.errors ?? {});
      if (!interpreted.ok) {
        this.status = 'Paused';
        this.fail(`${interpreted.error}. Nothing was generated.`, { questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls });
        return;
      }
      action = interpreted.action;
    }

    // Speaker.
    let speaker: SpeakerDecision | null;
    if (!isGroup) {
      speaker = { questionId: null, eligibleActorIds: eligible, raw: null, adjusted: null, selected: eligible[0] ?? YIELD, source: eligible.length ? 'single' : 'yield', tieBroken: false };
    } else if (nativeSpeaker) {
      speaker = null;
    } else {
      const decided = decideSpeaker({
        candidates, explicitActorId: explicit, includeYield: this.profile.speakers.includeYield, priors: this.profile.speakers.priors,
        repetitionFactor: this.profile.speakers.repetitionFactor, lastSpeakerActorId, answer: result?.answers.speaker ?? null, questionId: needSpeaker ? 'speaker' : null,
      });
      if (!decided.ok) {
        this.status = 'Paused';
        this.inspect({ kind: 'error', message: `Speaker could not be resolved: ${decided.error}`, questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls, providerKind: result?.provider ?? null });
        this.host.toast('warning', `Speaker unresolved: ${decided.error}. Choose a speaker in the bar.`);
        await this.persist();
        this.notify();
        return;
      }
      speaker = decided.decision;
    }

    // Outcome.
    let resolution: FrozenResolution | null = null;
    let bandId: string | null = null;
    if (gate.kind === 'rules' && action) {
      const settled = gate.outcome;
      resolution = freeze({
        resolutionId: newId('res'), previousResolutionId: null, action, snapshot, assessment: null, decisionSource: 'rules', policyRevision: this.profile.revision,
        band: null, method: 'rules', draw: null, outcome: settled.name, def: settled, cursorBefore: null, generation: 1, providerKind: null, requestedModel: null, returnedModel: null, now: Date.now(),
      });
    } else if (needGain && action) {
      const answer = result?.answers[drivingId] ?? null;
      const answerError = result?.errors[drivingId];
      if (!answer) {
        this.status = 'Paused';
        this.inspect({ kind: 'error', message: `No valid assessment for ${drivingId}: ${answerError ?? 'missing'}. Paused before freeze; no effect and no fallback.`, questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls, providerKind: result?.provider ?? null, actionId: action.actionId, applicability: action.applicability });
        this.host.toast('error', `The provider gave no valid answer for the outcome question (${answerError ?? 'missing'}). Paused; nothing generated.`);
        await this.persist();
        this.notify();
        return;
      }
      if (this.profile.mode === 'binding') {
        const sig = normaliseSignal(answer);
        if (!sig.ok) { this.status = 'Paused'; this.fail(`Assessment invalid: ${sig.error}`, { questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls }); return; }
        const draw = this.profile.resolutionMethod === 'sample' ? randomDraw().u : null;
        const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: this.profile.resolutionMethod, signal: sig.signal, draw });
        if (!resolved.ok) { this.status = 'Paused'; this.fail(`Outcome could not be resolved: ${resolved.error}`, { questions, answers: result?.answers ?? null, stateSent: built.state, networkCalls }); return; }
        bandId = resolved.value.band.id;
        resolution = freeze({
          resolutionId: newId('res'), previousResolutionId: null, action, snapshot, assessment: answer, decisionSource: 'provider', policyRevision: this.profile.revision,
          band: resolved.value.band, method: resolved.value.method, draw: resolved.value.draw, outcome: resolved.value.outcome, def: resolved.value.def, cursorBefore: null, generation: 1,
          providerKind: result?.provider ?? null, requestedModel: result?.requestedModel ?? null, returnedModel: result?.returnedModel ?? null, now: Date.now(),
        });
      }
    }

    let reaction: ReactionResult | null = null;
    const reactionAnswer = speaker ? result?.answers[reactionQuestions.get(speaker.selected) ?? ''] : undefined;
    // A concrete action owns this turn's consequences; reactions cannot compete.
    if (!action && reactionSettings.enabled && speaker && speaker.selected !== YIELD && reactionAnswer?.type === 'choice'
      && ['resolve', 'secret', 'exposure'].includes(reactionAnswer.choice)) {
      try { reaction = chooseReaction(reactionAnswer.choice as ReactionKind, reactionSettings, speaker.selected, randomDraw().u); }
      catch (error) { this.inspect({ kind: 'info', message: `NPC reaction skipped: ${(error as Error).message}` }); }
    }

    const advisoryNotes: string[] = [];
    if (this.profile.mode === 'advisory' && action && result?.answers[drivingId]) {
      const a = result.answers[drivingId]!;
      const sig = normaliseSignal(a);
      if (sig.ok) advisoryNotes.push(`Support for the requested gain "${action.requestedGain}" is assessed at ${sig.signal.x.toFixed(2)} on a 0–1 scale (${a.provenance}). Treat this as guidance about plausibility, not a ruling.`);
    }
    const speakerLabel = speaker ? names[speaker.selected] ?? speaker.selected : 'chosen by SillyTavern';
    const fallbackMessage = gate.kind === 'skip' ? `No adjudication (${gate.reason.replace(/_/g, ' ')}). Speaker ${speakerLabel}.`
      : action && this.profile.mode === 'advisory' ? `Advisory: gain support assessed, no binding outcome. Speaker ${speakerLabel}.`
      : `Speaker ${speakerLabel}; no action declared.`;
    await this.finishTurn({
      kind, composerText, epoch, actors, isGroup, names, speaker,
      preparedAction: resolution ? action : (gate.kind === 'skip' ? action : null),
      resolution, bandId, reaction, snapshot, established, decisionsOn: modules.decisions, disarmDeclaration: Boolean(action), advisoryNotes,
      questions: Object.keys(questions).length ? questions : null, answers: result?.answers ?? null, stateSent: built.state, result, networkCalls,
      actionId: action?.actionId ?? null, applicability: action?.applicability ?? null, fallbackMessage, messageSuffix: '', stateBlock: '',
      loreCursor: null,
    });
  }

  /**
   * Staged pipeline (docs/STAGED-JEV-PLAN.md): Speaker ∥ A (move) → B (routing)
   * → E (ruling), then the same freeze and writer path as legacy.
   */
  private async stagedTurn(c: StagedTurnContext): Promise<void> {
    const record = this.record!;
    const established = record.projection.state.variables;
    const npcs = c.eligible;
    const playerName = c.names[PLAYER_ACTOR_ID]!;
    const actorsIn: Record<string, EvidenceActor> = { [PLAYER_ACTOR_ID]: { name: playerName, control: 'user' } };
    for (const id of npcs) {
      const actor = c.actors.byId[id]!;
      actorsIn[id] = { name: actor.name, control: 'npc', card: this.host.cardText(actor.avatar) };
    }
    const transcript = this.host.chat().filter(m => !m.is_system).slice(-this.profile.budgets.maxRecentMessages).map(m => ({
      actorId: m.is_user ? PLAYER_ACTOR_ID : (c.actors.byAvatar[m.original_avatar ?? ''] ?? `name:${m.name}`),
      role: m.is_user ? 'user' as const : 'assistant' as const,
      text: m.is_user ? m.mes ?? '' : stripResultFooter(m.mes ?? ''),
    }));
    const needSpeaker = c.modules.speaker && c.isGroup && !c.explicit && npcs.length > 0;
    const reactionTargets = c.modules.reactions ? (c.explicit ? [c.explicit].filter(id => npcs.includes(id)) : npcs).slice(0, STAGED_MAX_REACTION_TRIGGERS) : [];
    const chain = this.chainNow();
    const cursorBefore = chain.at(-1)!;
    let provider: DecisionProvider;
    try { provider = this.provider(); } catch (e) { this.fail(`Connection error: ${(e as Error).message}`); return; }
    let networkCalls = 0;
    const abort = new AbortController();
    this.inFlight = abort;
    let catalogRevision = 'pack:pending';
    const snapshotBase = () => ({
      chatId: c.chatKey!, cursorBefore, stateRevision: record.projection.state.revision, scopeId: 'shared-public',
      profileRevision: this.profile.revision, catalogRevision, actorBindingRevision: c.actors.order.join(','),
    });
    const ask = async (stage: StageId, questions: Record<string, Question>, state: Json): Promise<EvaluationResult> => {
      const check = checkBatch(questions, STAGED_MAX_QUESTIONS, Object.keys(questions).map(() => 'shared-public'));
      if (!check.ok) throw new StagedError(stage, `batch rejected: ${check.errors.join('; ')}`);
      if (this.isNetworkProvider()) networkCalls += 1;
      return provider.evaluate({ requestId: newId('req'), phase: 'guide', snapshot: { ...snapshotBase(), state }, questions }, abort.signal);
    };
    const characters = npcs.slice(0, STATE_MAX_CHARACTERS).map(id => ({ id, name: c.names[id]!, card: actorsIn[id]!.card }));
    const notes: string[] = [];
    // Stage C: lore, started now beside the pack pick, S and A; a ruling awaits it.
    const loreRun = c.modules.lore ? this.startLore(c, transcript, ask) : null;

    // Genre pack: chosen once per chat, by the user or, on Auto, by the judge.
    let pack = this.chatPack();
    if (record.story.packId === 'auto' && (c.modules.decisions || c.modules.meters)) {
      try {
        const pick = await ask('pack', { pack: packQuestion(listPacks()) }, stateEvidence({ transcript, latestInput: c.composerText, characters, secrets: [], playerName, maxChars: STAGED_MAX_STATE_CHARS }));
        const answer = pick.answers.pack;
        if (answer?.type === 'choice' && hasPack(answer.choice) && this.record === record) {
          record.story = { ...record.story, packId: answer.choice, packSource: 'judge' };
          pack = packById(answer.choice);
          notes.push(`Pack for this chat: ${pack.label} (picked by the judge).`);
        }
      } catch (e) {
        notes.push(`Pack pick failed (${(e as Error).message}); used ${pack.label} this turn.`);
      }
    }
    catalogRevision = `pack:${pack.id}@${pack.version}`;

    // Character state: judged in its own private request, beside the move stages.
    const story = record.story;
    const stateNpcs = characters.map(({ id, name }) => ({ id, name }));
    const before = levelsAt(story, chain, pack, stateNpcs.map(n => n.id));
    const knownBefore = knownByAt(story, chain);
    const wantMeters = c.modules.meters && pack.meters.length > 0 && stateNpcs.length > 0;
    const wantSecrets = c.modules.secrets && story.secrets.length > 0;
    const built = wantMeters || wantSecrets ? stateQuestions({
      pack: wantMeters ? pack : { ...pack, meters: [] }, npcs: stateNpcs, levels: before.levels, assessed: before.assessed, playerName,
      secrets: wantSecrets ? story.secrets : [], knownBy: knownBefore, actorNames: { ...c.names, player: playerName }, maxQuestions: STAGED_MAX_QUESTIONS,
    }) : null;
    let stateError: string | null = null;
    const stateRun: Promise<EvaluationResult | null> = built && Object.keys(built.questions).length
      ? ask('state', built.questions, stateEvidence({ transcript, latestInput: c.composerText, characters, secrets: wantSecrets ? story.secrets : [], playerName, maxChars: STAGED_MAX_STATE_CHARS }))
        .catch((e: unknown) => { stateError = e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message; return null; })
      : Promise.resolve(null);
    const judged = stateRun.then(result => applyStateAnswers(built?.index ?? {}, result?.answers ?? {}, before.levels, knownBefore));
    const metersForRuling = wantMeters ? () => judged.then(state => meterFacts(pack, state.meters, playerName)) : undefined;

    let out: StagedOutput;
    try {
      out = await runStaged({
        pack, playerId: PLAYER_ACTOR_ID, actors: actorsIn, eligibleNpcIds: npcs, latestInput: c.composerText, transcript,
        facts: jsonSafe(established) as Record<string, Json>, modules: c.modules,
        speakerQuestion: needSpeaker ? speakerQuestion(npcs, c.names, this.profile.speakers.includeYield, c.composerText.trim() || null) : null,
        reactionQuestions: Object.fromEntries(reactionTargets.map(id => [id, reactionQuestion(id)])),
        maxChars: STAGED_MAX_STATE_CHARS,
        meters: metersForRuling,
        lore: loreRun ? () => loreRun.then(turn => turn.result?.evidence ?? []) : undefined,
        maxLoreChars: this.settings.lore.judgeChars,
      }, { evaluate: ask });
    } catch (e) {
      // Stop anything still running for this turn, the lore walk included.
      abort.abort(new Error('staged turn stopped'));
      if (this.inFlight === abort) this.inFlight = null;
      if (c.epoch !== this.epoch || this.chatKey !== c.chatKey) return;
      const stage = e instanceof StagedError ? e.stage : 'decision';
      const msg = e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message;
      this.status = 'Paused';
      this.inspect({ kind: 'error', message: `Staged ${stage} stage stopped before anything was frozen; nothing was generated. ${msg}`, networkCalls, providerKind: provider.kind });
      this.host.toast('error', `Director could not complete the ${stage} stage: ${msg}. Nothing was generated.`);
      await this.persist();
      this.notify();
      return;
    }
    const stateResult = await stateRun;
    const judgedState = await judged;
    const loreTurn = loreRun ? await loreRun : null;
    if (loreTurn) { const note = loreNote(loreTurn); if (note) notes.push(note); }
    if (stateError) notes.push(`Character state kept from before (the judge request failed: ${stateError}).`);
    else if (judgedState.changes.length) notes.push(`State: ${judgedState.changes.join('; ')}.`);
    if (stateResult && built) out.records.push({ stage: 'state', questions: built.questions, state: null, result: stateResult });
    if (this.inFlight === abort) this.inFlight = null;
    const loreSteps = loreTurn?.result?.steps ?? [];
    const questions = Object.assign({}, ...out.records.map(r => r.questions), ...loreSteps.map(step => step.questions)) as Record<string, Question>;
    const answers = Object.assign({}, ...out.records.map(r => r.result.answers), ...loreSteps.flatMap(step => step.results.map(r => r.answers))) as Record<string, Answer>;
    const stateSent: Json = out.ruling?.projection.state ?? out.records.filter(r => r.state !== null).at(-1)?.state ?? null;
    const lastResult = out.records.at(-1)?.result ?? null;
    if (c.epoch !== this.epoch || this.chatKey !== c.chatKey) {
      this.inspect({ kind: 'error', message: 'Decision result arrived after the chat changed; discarded.' });
      return;
    }
    if (c.kind === 'director_send' && this.host.composerText() !== c.composerText) {
      this.status = 'Ready';
      this.inspect({ kind: 'error', message: 'Composer text changed while deciding; preparation discarded (nothing was frozen).', questions, answers, stateSent, networkCalls });
      this.host.toast('warning', 'Your message changed while Director was deciding. Press Send again.');
      await this.persist();
      return;
    }
    if (c.changed()) {
      this.status = 'Ready';
      this.inspect({ kind: 'error', message: 'The profile, reactions, or scene changed while deciding; the result was discarded before freeze.', questions, answers, stateSent, networkCalls });
      this.host.toast('warning', 'The scene or settings changed while the Director was deciding. Send again.');
      await this.persist();
      return;
    }

    // The judged state belongs to this point of the transcript; swipes reuse it.
    // The lore chosen for this turn; swipes and continues of its reply reuse it.
    if (loreTurn?.result) record.story = withLore(record.story, cursorBefore, { at: Date.now(), refs: loreTurn.result.refs, requests: loreTurn.result.requests, books: loreTurn.books, failed: loreTurn.result.failedWorlds });
    if (stateResult) record.story = withSnapshot(record.story, cursorBefore, { at: Date.now(), meters: wantMeters ? judgedState.meters : (snapshotAt(record.story, chain)?.meters ?? {}), knownBy: judgedState.knownBy });
    const shownLevels = Object.fromEntries(Object.entries(judgedState.meters).filter(([npc]) => stateResult || before.assessed[npc]));
    const writerState = stateBlock({ pack, levels: wantMeters ? shownLevels : {}, names: c.names, playerName, secrets: record.story.secrets, knownBy: judgedState.knownBy, meters: wantMeters, secretsOn: wantSecrets });

    // Speaker: an NPC who owns the move (an order or a hand-off) writes the reply.
    let speaker: SpeakerDecision | null;
    if (!c.isGroup) {
      speaker = { questionId: null, eligibleActorIds: npcs, raw: null, adjusted: null, selected: npcs[0] ?? YIELD, source: npcs.length ? 'single' : 'yield', tieBroken: false };
    } else if (c.nativeSpeaker) {
      speaker = null;
    } else {
      const decided = decideSpeaker({
        candidates: c.candidates, explicitActorId: c.explicit, includeYield: this.profile.speakers.includeYield, priors: this.profile.speakers.priors,
        repetitionFactor: this.profile.speakers.repetitionFactor, lastSpeakerActorId: c.lastSpeakerActorId, answer: out.speakerAnswer, questionId: needSpeaker ? 'speaker' : null,
      });
      if (!decided.ok) {
        this.status = 'Paused';
        this.inspect({ kind: 'error', message: `Speaker could not be resolved: ${decided.error}`, questions, answers, stateSent, networkCalls, providerKind: lastResult?.provider ?? null });
        this.host.toast('warning', `Speaker unresolved: ${decided.error}. Choose a speaker in the bar.`);
        await this.persist();
        this.notify();
        return;
      }
      speaker = decided.decision;
    }
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
    if (out.outcome === 'ruled' && route && out.move && out.ruling) {
      const declared = this.stagedAction(out, record.projection.state.sceneId, pack);
      const gate = gateAction(declared, established, this.profile.outcomes, {
        actorPolicy: this.profile.actorPolicy, playerActorId: PLAYER_ACTOR_ID, currentSceneId: record.projection.state.sceneId, settledGains: record.projection.state.settledGains,
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
        if (!sig.ok) { this.status = 'Paused'; this.fail(`Assessment invalid: ${sig.error}`, { questions, answers, stateSent, networkCalls }); return; }
        const draw = this.profile.resolutionMethod === 'sample' ? randomDraw().u : null;
        const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: this.profile.resolutionMethod, signal: sig.signal, draw });
        if (!resolved.ok) { this.status = 'Paused'; this.fail(`Outcome could not be resolved: ${resolved.error}`, { questions, answers, stateSent, networkCalls }); return; }
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
      kind: c.kind, composerText: c.composerText, epoch: c.epoch, actors: c.actors, isGroup: c.isGroup, names: c.names, speaker,
      preparedAction: action, resolution, bandId, reaction, snapshot: { ...snapshotBase(), state: stateSent }, established,
      decisionsOn: c.modules.decisions, disarmDeclaration: false, advisoryNotes,
      questions: Object.keys(questions).length ? questions : null, answers, stateSent, result: lastResult, networkCalls,
      actionId: action?.actionId ?? null, applicability: action?.applicability ?? null, fallbackMessage, messageSuffix, stateBlock: writerState,
      loreCursor: loreTurn?.result ? cursorBefore : null,
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
        const state = loreSceneState(transcript, c.composerText, c.names, LORE_STATE_CHARS);
        const result = await runLoreStage(inputs, () => questions => ask('lore', questions, state), {
          width: settings.width, minProbability: settings.minProbability, maxEntries: settings.maxEntries, maxDepth: settings.maxDepth,
        });
        return { result, books, error: null };
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
    if (!attemptId || !this.settings.modules.lore || !this.record) return;
    const cursor = this.record.attempts[attemptId]?.loreCursor;
    const found = cursor ? this.record.story.lore[cursor] : undefined;
    if (!found) return;
    const settings = this.settings.lore;
    await this.host.armLore(lorePlan(found.refs, world => effectiveMode(settings, world, this.host.tunnelVisionManages(world)), found.books, found.failed));
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

  /** Shared end of a turn for both pipelines: writer injection, prepared attempt, generation. */
  private async finishTurn(t: TurnFinish): Promise<void> {
    const { kind, composerText, epoch, actors, isGroup, names, speaker, resolution, reaction } = t;
    const speakerId = speaker ? speaker.selected : null;
    const speakerName = speakerId && speakerId !== YIELD ? names[speakerId] ?? null : null;
    const playerName = this.host.playerName();
    const attemptId = newId('att');
    const toolRequestId = newId('toolreq');
    const writerTool = this.host.writerToolCapability('normal');
    const toolAvailable = t.decisionsOn && speakerId !== null && this.toolRegistered && writerTool.supported && !this.host.isAutoDirectorEnabled();
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
      npcActionPolicy: toolAvailable ? 'checkpoint' : 'defer',
    }) : '';
    const advisory = advisoryBlock({ influence: this.profile.advisoryInfluence, notes: t.advisoryNotes });
    const planning = t.decisionsOn ? toolPlanningBlock({ attemptId, requestId: toolRequestId, speakerActorId: speakerId ?? '', evidenceRefs, toolAvailable }) : '';
    const transition = this.sceneTransitionPending ? '[Scene transition requested]\nBegin a new scene from the established fiction and the latest user direction. Do not choose voluntary actions or decisions for the player. The Director scene identity has advanced.' : '';
    const injected = [combinedBlock(binding, advisory), t.stateBlock, transition, this.reactionBlock(reaction), planning].filter(Boolean).join('\n\n');
    this.sceneTransitionPending = false;

    if (speakerId === YIELD) {
      this.inspect({ kind: 'yield', message: 'Director yielded: no NPC reply.', questions: t.questions, answers: t.answers, stateSent: t.stateSent, speaker, networkCalls: t.networkCalls, providerKind: t.result?.provider ?? null, durationMs: t.result?.durationMs ?? null, inputTokens: t.result?.inputTokens ?? null, outputTokens: t.result?.outputTokens ?? null, actionId: t.actionId, applicability: t.applicability });
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
    if (prepared) prepared.loreCursor = t.loreCursor;
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
    this.inspect({
      kind, attemptId, resolutionId: resolution?.resolutionId ?? null, actionId: t.actionId, applicability: t.applicability,
      questions: t.questions, stateSent: t.stateSent, answers: t.answers, speaker, policyBandId: t.bandId,
      draw: resolution?.draw ?? null, outcome: resolution?.outcome ?? null, injectedText: injected || null, providerKind: t.result?.provider ?? null,
      requestedModel: t.result?.requestedModel ?? null, returnedModel: t.result?.returnedModel ?? null, durationMs: t.result?.durationMs ?? null,
      inputTokens: t.result?.inputTokens ?? null, outputTokens: t.result?.outputTokens ?? null, networkCalls: t.networkCalls,
      message: resolution ? `Frozen ${resolution.outcome} (${resolution.method}${t.bandId ? ', band ' + t.bandId : ''}) for ${names[resolution.action.actingActorId ?? PLAYER_ACTOR_ID] ?? resolution.action.actingActorId ?? playerName}; reply speaker ${speakerName ?? speakerId ?? 'chosen by SillyTavern'}.${t.messageSuffix}`
        : reaction ? `NPC ${reaction.kind}: ${reaction.outcome} for ${names[reaction.actorId] ?? reaction.actorId}; sampled from configured weights, preserved across wording swipes.${t.messageSuffix}`
        : t.fallbackMessage,
    });
    this.pendingInjection = injected;
    this.status = resolution ? 'Frozen' : 'Ready';
    await this.persist();

    const actor = speakerId ? actors.byId[speakerId] : undefined;
    const forceIndex = isGroup && actor ? this.host.resolveIndex(actor.avatar) : null;
    if (isGroup && speakerId && (forceIndex === null || forceIndex < 0)) {
      this.apply({ type: 'cancel', attemptId, epoch, reason: 'actor binding could not be re-resolved to a host character' });
      this.fail(`Could not re-resolve ${speakerId} to a host character; repair the group before generating.`);
      await this.persist();
      return;
    }
    this.status = 'Writing';
    this.notify();
    let settleWriter!: () => void;
    const writerSettled = new Promise<void>(resolve => { settleWriter = resolve; });
    this.writerSettled = writerSettled;
    try {
      try { await this.host.generate(forceIndex); }
      finally { settleWriter(); if (this.writerSettled === writerSettled) this.writerSettled = null; }
    } catch (e) {
      console.warn('[RP Director] generate failed', e);
    } finally {
      await this.waitForMessageTasks(attemptId);
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
      meters: pack.meters.filter(m => Number.isInteger(values[m.key])).map(m => ({ label: meterLabel(m, PLAYER_LABEL), level: m.levels[values[m.key]!]!, rank: `${values[m.key]! + 1} of ${m.levels.length}` })),
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

  /** The judged state that applies at the end of this cursor chain, as writer text (swipes reuse it). */
  private storyBlockAt(chain: string[]): string {
    if (!this.record) return '';
    const snap = snapshotAt(this.record.story, chain);
    if (!snap) return '';
    const names: Record<string, string> = {};
    for (const a of Object.values(this.record.actors)) names[a.actorId] = a.name;
    return stateBlock({
      pack: this.chatPack(), levels: snap.meters, names, playerName: this.host.playerName(), secrets: this.record.story.secrets,
      knownBy: knownByAt(this.record.story, chain), meters: this.settings.modules.meters, secretsOn: this.settings.modules.secrets && this.record.story.secrets.length > 0,
    });
  }

  /** A ruling's instruction with its placeholders filled exactly as the writer's binding block fills them. */
  private filledInstruction(resolution: FrozenResolution, speakerActorId: string | null): string {
    const names = Object.fromEntries(Object.values(this.record?.actors ?? {}).map(actor => [actor.actorId, actor.name]));
    const speakerName = speakerActorId ? names[speakerActorId] ?? null : null;
    const targets = resolution.action.targetActorIds.map(id => names[id] ?? id);
    return fillPlaceholders(instructionForResolution(resolution), placeholderValues(resolution.action, targets, speakerName, this.host.playerName())).trim();
  }

  private buildDeclaredAction(actors: ActorMap): ActionSpec | null {
    const draft = this.actionDraft;
    if (!draft) return null;
    const validActor = (id: string) => id === PLAYER_ACTOR_ID || Boolean(actors.byId[id]);
    return declareAction({
      actionId: newId('act'), templateId: draft.templateId, actingActorId: validActor(draft.actingActorId) ? draft.actingActorId : PLAYER_ACTOR_ID,
      playerActorId: PLAYER_ACTOR_ID, targetActorIds: draft.targetActorIds.filter(validActor), attemptedAction: draft.attemptedAction,
      requestedGain: draft.requestedGain, applicability: draft.applicability, uncertainConsequential: draft.uncertainConsequential,
      opposed: draft.opposed, resolutionScope: draft.resolutionScope, sceneId: this.record?.projection.state.sceneId ?? 1,
      persistentFactKey: draft.persistentFactKey, failureStake: { kind: draft.failureStakeKind, detail: draft.failureStakeDetail }, availableEvidence: draft.availableEvidence,
    });
  }

  private buildAutomaticAction(composerText: string, sceneId: number): ActionSpec | null {
    const text = composerText.trim();
    if (!text) return null;
    return declareAction({
      actionId: newId('act'),
      // Replaced by the independent family Choice after the batch returns.
      templateId: 'acquire_secure',
      actingActorId: PLAYER_ACTOR_ID,
      playerActorId: PLAYER_ACTOR_ID,
      targetActorIds: [],
      attemptedAction: text,
      requestedGain: AUTOMATIC_GAIN,
      applicability: 'favorable',
      uncertainConsequential: true,
      opposed: false,
      resolutionScope: 'attempt',
      sceneId,
      persistentFactKey: '',
      failureStake: { kind: 'other', detail: 'Failure must move the scene without erasing established progress or inventing a disproportionate consequence.' },
      availableEvidence: 'Use only observer-visible evidence in the accepted scene and latest user message.',
    });
  }

  // ---- plan-only writer tool -------------------------------------------------

  private shouldOfferWriterTool(): boolean {
    if (!this.settings.enabled || !this.toolRegistered || this.host.isAutoDirectorEnabled()) return false;
    const window = this.toolWindow;
    if (!window || window.phase !== 'initial' || window.used || this.currentAttemptId !== window.attemptId) return false;
    const attempt = this.record?.attempts[window.attemptId];
    if (!attempt || attempt.status !== 'writing' || attempt.actorId !== window.speakerActorId || attempt.cursorBefore !== window.baseCursor) return false;
    return this.host.writerToolCapability('normal').supported;
  }

  private toolFailure(window: ToolWindow, code: ToolProposalErrorCode | 'recursive_tool_call' | 'provider_failed' | 'stale_context' | 'prose_before_tool', message: string, malformed = false): string {
    window.error = `${code}: ${message}`;
    window.phase = malformed ? 'malformed_pending' : 'failed_pending';
    this.apply({ type: 'tool_result', attemptId: window.attemptId, permit: null, status: malformed ? 'malformed' : 'failed', error: window.error });
    this.inspect({ kind: 'tool_checkpoint', attemptId: window.attemptId, message: `Tool checkpoint refused: ${window.error}`, networkCalls: 0 });
    void this.persist();
    return JSON.stringify({ schemaVersion: 1, ok: false, code, message, attemptId: window.attemptId, retryAllowed: false });
  }

  private async onToolCall(raw: unknown): Promise<string> {
    const window = this.toolWindow;
    if (!window || window.phase !== 'initial' || this.currentAttemptId !== window.attemptId) {
      return JSON.stringify({ schemaVersion: 1, ok: false, code: 'recursive_tool_call', message: 'No active initial Director tool window. Continue without another tool call.', retryAllowed: false });
    }
    if (window.used) return this.toolFailure(window, 'recursive_tool_call', 'Only one Director tool call is allowed per writer attempt.');
    window.used = true;

    const priorProse = this.host.assistantProseSince(window.chatLengthAtBind);
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
    try { provider = this.planningProvider(this.provider()); } catch (error) { return this.toolFailure(window, 'provider_failed', (error as Error).message); }
    const controller = new AbortController();
    this.inFlight = controller;
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    const started = Date.now();
    const frozenProfile = structuredClone(this.profile);
    const stillCurrent = () => epoch === this.epoch && chatKey === this.chatKey && this.toolWindow === window
      && this.settings.enabled && !this.host.isAutoDirectorEnabled()
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
      const adjudicated = await adjudicateTurnProposal(adjudicationInput);
      if (!stillCurrent() || controller.signal.aborted) return JSON.stringify({ ok: false, code: 'cancelled' });
      window.phase = 'reviewing';
      this.status = 'Review rolls';
      this.notify();
      const kept = await reviewPermit({
        initial: adjudicated.permit, signal: controller.signal, isCurrent: stillCurrent, method: frozenProfile.resolutionMethod,
        choose: permit => this.host.reviewRolls(permit, window.actorNames, frozenProfile.resolutionMethod, controller.signal),
        reroll: async permit => frozenProfile.resolutionMethod === 'sample'
          ? rerollPermit(permit, frozenProfile, window.actorNames, adjudicationInput.playerName)
          : (await adjudicateTurnProposal(adjudicationInput)).permit,
      });
      if (this.inFlight === controller) this.inFlight = null;
      if (!kept || !stillCurrent()) {
        window.phase = 'cancelled';
        if (epoch === this.epoch && chatKey === this.chatKey) {
          this.apply({ type: 'cancel', attemptId: window.attemptId, epoch, reason: 'tool result review cancelled or context changed' });
          this.host.stopGeneration();
          this.status = 'Ready';
          await this.persist();
        }
        return JSON.stringify({ ok: false, code: 'cancelled', message: 'Generation cancelled; no roll accepted.' });
      }
      window.permit = kept;
      window.phase = 'followup_pending';
      this.status = 'Writing';
      const priorReaction = this.record?.attempts[window.attemptId]?.reaction;
      if (priorReaction) this.pendingInjection = this.pendingInjection.replace(this.reactionBlock(priorReaction), '').trim();
      this.apply({ type: 'tool_result', attemptId: window.attemptId, permit: kept, status: 'permitted', error: null });
      this.inspect({
        kind: 'tool_checkpoint', attemptId: window.attemptId, message: `Kept ${kept.actions.length} NPC result(s), after ${kept.reviewHistory?.length ?? 0} reroll/reassessment(s). Review elapsed ${Date.now() - started} ms.`,
        questions: adjudicated.questions, stateSent: adjudicated.snapshot.state, answers: adjudicated.evaluation.answers,
        providerKind: adjudicated.evaluation.provider, requestedModel: adjudicated.evaluation.requestedModel, returnedModel: adjudicated.evaluation.returnedModel,
        durationMs: adjudicated.evaluation.durationMs, inputTokens: adjudicated.evaluation.inputTokens, outputTokens: adjudicated.evaluation.outputTokens,
        networkCalls: this.isNetworkProvider() ? 1 : 0,
      });
      await this.persist();
      return JSON.stringify({ schemaVersion: 1, ok: true, permit: writerPermit(kept) });
    } catch (error) {
      if (this.inFlight === controller) this.inFlight = null;
      if (!stillCurrent() || controller.signal.aborted) {
        window.phase = 'cancelled';
        return JSON.stringify({ ok: false, code: 'cancelled' });
      }
      if (window.phase === 'reviewing') {
        window.phase = 'cancelled';
        this.host.stopGeneration();
        this.host.toast('error', `Roll review stopped: ${(error as Error).message}`);
        return JSON.stringify({ ok: false, code: 'review_failed' });
      }
      const message = error instanceof ProviderError ? `${error.code}: ${error.message}` : (error as Error).message;
      return this.toolFailure(window, 'provider_failed', message);
    }
  }

  /** Mock mode remains useful for headed QA even though its canned ids predate planned_N questions. */
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

  private activePermitForCursor(cursor: string): TurnPermit | null {
    if (!this.record) return null;
    let best: TurnPermit | null = null;
    for (const permit of Object.values(this.record.permits)) {
      if (permit.baseCursor !== cursor) continue;
      if (!best || permit.createdAt > best.createdAt) best = permit;
    }
    return best;
  }

  // ---- interceptor ------------------------------------------------------------

  /** Host generate_interceptor. Injects the prepared block; never issues a network call. */
  async interceptor(_chat: unknown, _contextSize: number, _abort: (immediately: boolean) => void, type: string): Promise<void> {
    void this.host.armLore(null);
    // SillyTavern passes prompt copies. Result annotations are not story evidence.
    if (Array.isArray(_chat)) {
      for (const message of _chat) {
        if (message && !message.is_user && typeof message.mes === 'string') message.mes = stripResultFooter(message.mes);
      }
    }
    if (this.toolWindow?.phase === 'cancelled') { _abort(true); this.host.clearInjection(); return; }
    if (type === 'swipe' && this.pendingSwipeMode === 'cancel') { this.pendingSwipeMode = null; _abort(true); this.host.clearInjection(); return; }
    if (!this.settings.enabled || !this.record || this.host.isAutoDirectorEnabled()) { this.host.clearInjection(); return; }
    const genType = (['normal', 'swipe', 'regenerate', 'continue'].includes(type) ? type : null) as GenerationType | null;
    if (!genType) { this.host.clearInjection(); return; }
    const chat = this.host.chat();
    const swipeMode = genType === 'swipe' ? this.pendingSwipeMode : null;
    const source = genType === 'swipe' ? this.swipeSource : null;
    if (source && (source.epoch !== this.epoch || source.chatKey !== this.chatKey || chat[source.index] !== source.message || source.message.swipe_id !== source.swipe)) { _abort(true); return; }
    if (genType === 'swipe') this.pendingSwipeMode = null;
    if (swipeMode === 'cancel') { _abort(true); this.host.clearInjection(); return; }

    // SillyTavern recursively starts a normal generation after a non-stealth
    // tool result. Keep the same attempt and inject only the frozen permit (or
    // typed failure); never create a second Director decision in that recursion.
    if (genType === 'normal' && this.toolWindow && ['followup_pending', 'failed_pending', 'malformed_pending'].includes(this.toolWindow.phase)) {
      const window = this.toolWindow;
      if (window.phase === 'followup_pending') window.phase = 'followup_writing';
      else if (window.phase === 'failed_pending') window.phase = 'failed_writing';
      else window.phase = 'malformed_writing';
      const followup = permitFollowupBlock(window.permit, window.error);
      const ruling = this.pendingInjection.split('[Director NPC-action checkpoint]')[0] ?? '';
      this.setInjection([ruling, followup].filter(Boolean).join('\n\n'));
      await this.armLoreForAttempt(window.attemptId);
      this.currentAttemptId = window.attemptId;
      this.status = 'Writing';
      await this.persist();
      return;
    }

    const replacing = genType === 'swipe' || genType === 'regenerate' || genType === 'continue';
    const replacementMarker = replacing ? this.host.readMarker(chat.length - 1) : null;
    const replacementVariant = replacementMarker ? this.record.variants[replacementMarker.v] : null;
    const replacementAttempt = replacementMarker && replacementVariant?.cursorAfter === this.cursorOf(chat)
      ? this.record.attempts[replacementMarker.a] ?? null : null;
    if (replacing) {
      const oldAttempt = replacementAttempt;
      if (oldAttempt && (oldAttempt.status === 'observing' || oldAttempt.status === 'provisional')) {
        if (oldAttempt.variantId) this.observerInFlight.get(oldAttempt.variantId)?.abort(new Error('wording swipe'));
        this.apply({ type: 'reject', attemptId: oldAttempt.attemptId });
      }
    }

    const prefix = genType === 'swipe' || genType === 'continue' ? chat.slice(0, -1) : chat;
    // A non-stealth tool invocation is a visible system message between the
    // base cursor and final reply. For wording swipes, the variant marker is
    // therefore the authoritative link back to the original pre-tool prefix.
    const cursor = source?.baseCursor ?? replacementAttempt?.cursorBefore ?? this.cursorOf(prefix);
    if (!replacementAttempt?.cursorBefore) this.ensurePredecessor(prefix);
    const pending = this.record.pending;

    if (pending && pending.epoch === this.epoch && genType === 'normal') {
      const prepared = this.preparedTool?.attemptId === pending.attemptId ? this.preparedTool : null;
      const toolOffered = Boolean(prepared?.available);
      this.apply({ type: 'bind', attemptId: pending.attemptId, cursorBefore: cursor, epoch: this.epoch, injectedText: this.pendingInjection, toolOffered });
      if (prepared?.available) {
        this.toolWindow = {
          requestId: prepared.requestId,
          attemptId: prepared.attemptId,
          speakerActorId: prepared.speakerActorId,
          baseCursor: cursor,
          stateRevision: prepared.snapshot.stateRevision,
          chatLengthAtBind: chat.length,
          allowedEvidenceRefs: prepared.allowedEvidenceRefs,
          snapshot: { ...prepared.snapshot, cursorBefore: cursor },
          actorNames: prepared.actorNames,
          phase: 'initial',
          permit: null,
          error: null,
          used: false,
        };
      } else {
        this.toolWindow = null;
      }
      this.currentAttemptId = pending.attemptId;
      this.setInjection(this.pendingInjection);
      await this.armLoreForAttempt(pending.attemptId);
      this.status = 'Writing';
      await this.persist();
      return;
    }
    if (pending) {
      this.apply({ type: 'cancel', attemptId: pending.attemptId, epoch: pending.epoch, reason: `a ${genType} generation started instead of the prepared Director turn` });
    }

    const actorAvatar = genType === 'swipe' || genType === 'continue' ? chat.at(-1)?.original_avatar ?? null : null;
    const actorId = actorAvatar ? this.actorMap().byAvatar[actorAvatar] ?? null : null;
    const active = source ? (source.resolutionId ? this.record.resolutions[source.resolutionId] ?? null : null) : activeResolutionForCursor(this.record, cursor);
    const permit = source ? (source.permitId ? this.record.permits[source.permitId] ?? null : null) : this.activePermitForCursor(cursor);
    const reaction = source ? source.reaction : replacementAttempt?.reaction ?? null;
    const attemptId = newId('att');
    if (swipeMode !== 'bypass' && (active || permit)) {
      const names: Record<string, string> = {};
      for (const a of Object.values(this.record.actors)) names[a.actorId] = a.name;
      const binding = active ? bindingBlock({ action: active.action, outcome: active.outcome, instruction: instructionForResolution(active), actorName: names[active.action.actingActorId ?? active.action.playerActorId] ?? active.action.actingActorId ?? active.action.playerActorId, speakerName: actorId ? names[actorId] ?? null : null, playerName: this.host.playerName(), targetNames: active.action.targetActorIds.map(id => names[id] ?? id), npcActionPolicy: permit ? 'permitted' : 'defer' }) : '';
      const injected = [binding, this.storyBlockAt(cursorChain(this.record.seedId, this.host.fingerprintMessages(prefix))), permit ? permitFollowupBlock(permit) : '', this.reactionBlock(reaction)].filter(Boolean).join('\n\n');
      this.apply({ type: 'regeneration_attempt', attemptId, resolutionId: active?.resolutionId ?? null, permitId: permit?.permitId ?? null, reaction, cursorBefore: cursor, epoch: this.epoch, generationType: genType, actorId, injectedText: injected, unadjudicated: false, now: Date.now() });
      this.inspect({ kind: 'wording_regeneration', attemptId, resolutionId: active?.resolutionId ?? null, actionId: active?.actionId ?? null, outcome: active?.outcome ?? null, policyBandId: active?.policyBand?.id ?? null, draw: active?.draw ?? null, injectedText: injected, networkCalls: 0, message: `Wording ${genType}: reused ${active ? `frozen ${active.outcome}` : 'the frozen turn permit'}${permit ? ` and permit ${permit.permitId}` : ''}; no tool or decision call.` });
      this.setInjection(injected);
    } else if (swipeMode !== 'bypass' && (swipeMode === 'adopt' || swipeMode === 'reuse' || (replacementAttempt && !replacementAttempt.unadjudicated))) {
      const injected = ['[Director-managed wording swipe]\nThis is a new wording of the selected reply. No outcome reroll was requested. Preserve established facts, do not invent and resolve a new uncertain consequential NPC action, do not roll dice for a new action, and do not output state or metadata blocks.', this.storyBlockAt(cursorChain(this.record.seedId, this.host.fingerprintMessages(prefix))), this.reactionBlock(reaction)].filter(Boolean).join('\n\n');
      this.apply({ type: 'regeneration_attempt', attemptId, resolutionId: null, permitId: null, reaction, cursorBefore: cursor, epoch: this.epoch, generationType: genType, actorId, injectedText: injected, unadjudicated: false, now: Date.now() });
      this.inspect({ kind: 'wording_regeneration', attemptId, injectedText: injected, networkCalls: 0, message: `Director-managed ${genType}: no frozen ruling applied and no new consequential NPC action permitted.` });
      this.setInjection(injected);
    } else {
      this.apply({ type: 'regeneration_attempt', attemptId, resolutionId: null, cursorBefore: cursor, epoch: this.epoch, generationType: genType, actorId, injectedText: '', unadjudicated: true, now: Date.now() });
      this.inspect({ kind: 'native_bypass', attemptId, networkCalls: 0, message: `Native ${genType} generation without a Director decision (unadjudicated).` });
      this.host.clearInjection();
    }
    // A regenerated reply is written with the lore of the attempt it replaces.
    const regenerated = this.record.attempts[attemptId];
    if (regenerated && !regenerated.unadjudicated) {
      const sourceMarker = source ? this.host.readMarker(source.index) : null;
      regenerated.loreCursor = replacementAttempt?.loreCursor ?? (sourceMarker ? this.record.attempts[sourceMarker.a]?.loreCursor : null) ?? null;
      await this.armLoreForAttempt(attemptId);
    }
    this.currentAttemptId = attemptId;
    this.swipeSource = null;
    this.toolWindow = null;
    this.preparedTool = null;
    this.status = 'Writing';
    await this.persist();
  }

  private reactionBlock(reaction: ReactionResult | null | undefined): string {
    if (!reaction) return '';
    const name = this.record?.actors[reaction.actorId]?.name ?? reaction.actorId;
    return `[Director NPC reaction — preserve on wording swipes]\n${name}: ${reaction.kind} → ${reaction.outcome}. ${reaction.instruction}\nThis chosen response is already decided; do not roll or call the tool again for this same response. It is a direction for the reply, not proof that an event occurred. Respect established motives and knowledge and leave the player's choices open. A separate new uncertain consequential action still requires the Director tool before prose; its kept ruling supersedes this reaction.`;
  }

  private setInjection(text: string): void {
    if (text && text.trim()) this.host.setInjection(text, this.profile.injection.depth, this.profile.injection.role);
    else this.host.clearInjection();
  }

  // ---- host events ------------------------------------------------------------

  private async onGenerationStarted(type: string, params: Record<string, unknown> | undefined): Promise<void> {
    void params;
    if (!this.record) return;
    if (!['normal', 'swipe', 'regenerate', 'continue'].includes(type)) return;
    let changed = false;
    for (const attempt of Object.values(this.record.attempts)) {
      if (attempt.status === 'writing' && attempt.attemptId !== this.currentAttemptId) {
        this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: attempt.epoch, reason: 'a new generation started before this attempt completed' });
        changed = true;
      }
      if (attempt.status === 'writing' && attempt.attemptId === this.currentAttemptId && this.record.pending === null && attempt.generationType !== type) {
        // A previous interceptor-created attempt that never completed; the new generation replaces it.
        this.apply({ type: 'cancel', attemptId: attempt.attemptId, epoch: attempt.epoch, reason: 'replaced by a new generation' });
        this.currentAttemptId = null;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async onGenerationStopped(): Promise<void> {
    void this.host.armLore(null);
    this.continueRemaining = 0;
    this.inFlight?.abort(new Error('generation stopped'));
    if (!this.record || !this.currentAttemptId) return;
    const id = this.currentAttemptId;
    this.currentAttemptId = null;
    if (this.toolWindow) this.toolWindow.phase = 'cancelled';
    this.preparedTool = null;
    this.apply({ type: 'cancel', attemptId: id, epoch: this.epoch, reason: 'generation stopped by the user' });
    this.host.clearInjection();
    this.status = 'Ready';
    await this.persist();
    this.refreshStatus();
  }

  private onGenerationEnded(): void {
    void this.host.armLore(null);
    // Streaming emits this before MESSAGE_RECEIVED; only the injection is cleared here.
    if (!this.toolWindow || !['followup_pending', 'failed_pending', 'malformed_pending'].includes(this.toolWindow.phase)) this.host.clearInjection();
  }

  private queueMessageReceived(mesId: number, type: string): void {
    const attemptId = this.currentAttemptId;
    if (!attemptId) return;
    const phaseAtEvent = this.toolWindow?.attemptId === attemptId ? this.toolWindow.phase : null;
    const writerSettled = this.writerSettled;
    let task!: Promise<void>;
    task = new Promise<void>(resolve => setTimeout(resolve, 0))
      .then(() => writerSettled)
      .then(() => this.completeMessage(mesId, type, attemptId, phaseAtEvent))
      .catch(error => console.error('[RP Director] deferred message completion failed', error))
      .finally(() => this.messageTasks.delete(task));
    this.messageTasks.add(task);
  }

  private async waitForMessageTasks(_attemptId?: string): Promise<void> {
    while (this.messageTasks.size > 0) await Promise.all([...this.messageTasks]);
  }

  private async completeMessage(mesId: number, type: string, attemptId: string, phaseAtEvent: ToolWindowPhase | null): Promise<void> {
    if (!this.record || type === 'first_message') return;
    const attempt = this.record.attempts[attemptId];
    if (!attempt || attempt.status !== 'writing') return;
    // saveReply emits MESSAGE_RECEIVED before SillyTavern inspects a tool call.
    // If the tool was used after an event emitted in the initial phase, that
    // event belongs to the intermediary response and is never observed/committed.
    if (phaseAtEvent === 'initial' && this.toolWindow?.attemptId === attemptId && this.toolWindow.used) return;
    const chat = this.host.chat();
    const message = chat[mesId];
    if (!message || message.is_system || message.is_user || !stripResultFooter(String(message.mes ?? '')).trim()) return;
    const cursorAfter = this.cursorOf(chat.slice(0, mesId + 1));
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const variantId = newId('var');
    const operationId = `complete:${attemptId}:${mesId}:${swipeId}`;
    const actorId = message.original_avatar ? this.actorMap().byAvatar[message.original_avatar] ?? null : null;
    this.host.writeMarker(mesId, { v: variantId, a: attemptId, r: attempt.resolutionId });
    const notices = this.apply({ type: 'completed', attemptId, epoch: this.epoch, operationId, variantId, hostMessageRef: mesId, hostVariantRef: swipeId, cursorAfter, now: Date.now(), actorId, observerRequired: true });
    void notices;
    this.refreshResultFooter(mesId);
    this.currentAttemptId = null;
    this.host.clearInjection();
    await this.persist();
    const after = this.record.attempts[attemptId];
    if (after?.status !== 'observing') return;
    if (after.toolStatus === 'malformed') {
      this.apply({ type: 'observation_failed', attemptId, variantId, error: after.toolError ?? 'writer emitted prose before its required tool call' });
      this.status = 'Stale';
      await this.persist();
      this.host.toast('error', 'The reply used the Director tool after prose. It was preserved, but no state was committed; swipe to retry.');
      this.refreshStatus();
      return;
    }
    this.status = 'Observing';
    this.notify();
    await this.observeVariant(attemptId, variantId, mesId);
    this.refreshStatus();
  }

  private refreshResultFooter(mesId: number, cursorAfter?: string): boolean {
    if (!this.record) return false;
    const marker = this.host.readMarker(mesId);
    if (!marker) return false;
    const variant = this.record.variants[marker.v];
    const matches = variant?.attemptId === marker.a && variant.cursorAfter === (cursorAfter ?? this.cursorOf(this.host.chat().slice(0, mesId + 1)));
    return this.host.writeResultFooter(mesId, matches ? formatResultFooter(this.record, marker.a) : '');
  }

  private refreshResultFooters(from: number, chain: string[]): void {
    for (let index = from; index < this.host.chat().length; index++) this.refreshResultFooter(index, chain[index + 1]);
  }

  private observationProvider(): ObservationProvider {
    const connection = this.settings.connection;
    const timeoutMs = this.profile.budgets.deadlineMs;
    if (connection.kind === 'mock' || connection.kind === 'rules') return createLocalObservationProvider();
    const observerProfileId = this.settings.observerConnection.stProfileId;
    if (observerProfileId) return createStructuredObservationProvider({ transport: this.host.stProfileTransport(observerProfileId), model: null, timeoutMs });
    if (connection.kind === 'jev' || (connection.kind === 'openrouter' && (!connection.model || /^(?:~)?typesafe\/jev/.test(connection.model)))) return createDecisionObservationProvider(this.provider());
    if (connection.kind === 'openrouter') return createStructuredObservationProvider({ transport: this.host.openRouterTransport(), model: connection.model, timeoutMs });
    if (connection.kind === 'structured') {
      const transport = connection.stProfileId
        ? this.host.stProfileTransport(connection.stProfileId)
        : createDirectFetchTransport({ baseUrl: connection.baseUrl, getApiKey: () => sessionStorage.getItem(STRUCTURED_KEY_STORAGE) });
      return createStructuredObservationProvider({ transport, model: connection.model || null, timeoutMs });
    }
    return createLocalObservationProvider();
  }

  private stateAtCursor(cursor: string | null) {
    if (!this.record) return null;
    if (cursor && this.record.checkpoints[cursor]) return structuredClone(this.record.checkpoints[cursor]!.stateAfter);
    if (cursor && this.record.projection.cursor === cursor) return structuredClone(this.record.projection.state);
    return null;
  }

  private async observeVariant(attemptId: string, variantId: string, mesId: number): Promise<void> {
    if (!this.record || !this.chatKey) return;
    const attempt = this.record.attempts[attemptId];
    const variant = this.record.variants[variantId];
    const message = this.host.chat()[mesId];
    if (!attempt || !variant || !message || attempt.status !== 'observing' || !variant.cursorAfter || !attempt.cursorBefore) return;
    const priorState = this.stateAtCursor(attempt.cursorBefore);
    if (!priorState) {
      this.apply({ type: 'observation_failed', attemptId, variantId, error: 'the predecessor checkpoint is unavailable' });
      await this.persist();
      return;
    }
    const permit = attempt.permitId ? this.record.permits[attempt.permitId] ?? null : null;
    const expectedRulings: ObservationRequest['expectedRulings'] = [];
    const preResolution = attempt.resolutionId ? this.record.resolutions[attempt.resolutionId] ?? null : null;
    if (preResolution) expectedRulings.push({
      resolutionId: preResolution.resolutionId,
      actingActorId: preResolution.action.actingActorId ?? preResolution.action.playerActorId,
      boundedResult: preResolution.action.requestedGain,
      outcome: preResolution.outcome,
      instruction: this.filledInstruction(preResolution, attempt.actorId ?? null),
    });
    for (const permitted of permit?.actions ?? []) expectedRulings.push({
      resolutionId: permitted.resolutionId,
      actingActorId: permitted.actingActorId,
      boundedResult: permitted.boundedResult,
      outcome: permitted.outcome,
      instruction: permitted.instruction,
    });
    const expectedResolutionIds = expectedRulings.map(ruling => ruling.resolutionId);
    const actorId = attempt.actorId ?? 'unknown';
    const request: ObservationRequest = {
      schemaVersion: 1,
      requestId: newId('obsreq'),
      attemptId,
      variantId,
      baseCursor: attempt.cursorBefore,
      cursorAfter: variant.cursorAfter,
      stateRevision: priorState.revision,
      acceptedSpan: { id: `span:${variantId}`, actorId, role: 'assistant', text: stripResultFooter(String(message.mes ?? '')), accepted: true },
      expectedResolutionIds,
      expectedRulings,
      permit,
      priorState,
      registry: buildObservationRegistry({ state: priorState, actorIds: Object.keys(this.record.actors), expectedResolutionIds, permit }),
    };
    const abort = new AbortController();
    this.observerInFlight.set(variantId, abort);
    const epoch = this.epoch;
    const chatKey = this.chatKey;
    let provider: ObservationProvider;
    try { provider = this.observationProvider(); } catch (error) {
      this.apply({ type: 'observation_failed', attemptId, variantId, error: `observer setup failed: ${(error as Error).message}` });
      await this.persist();
      return;
    }
    try {
      const observation = await provider.observe(request, abort.signal);
      this.observerInFlight.delete(variantId);
      if (epoch !== this.epoch || chatKey !== this.chatKey || !this.record || this.record.attempts[attemptId]?.status !== 'observing') return;
      const liveMessage = this.host.chat()[mesId];
      if (!liveMessage || this.cursorOf(this.host.chat().slice(0, mesId + 1)) !== variant.cursorAfter || this.host.readMarker(mesId)?.v !== variantId) return;
      this.apply({ type: 'observation_ready', attemptId, variantId, observation });
      this.inspect({
        kind: 'observer', attemptId, resolutionId: attempt.resolutionId, message: `Observed reply: ${observation.realizedResolutionIds.length} realized ruling${observation.realizedResolutionIds.length === 1 ? '' : 's'}, ${observation.operations.length} factual operation${observation.operations.length === 1 ? '' : 's'}${observation.unresolved.length ? `, ${observation.unresolved.length} unresolved` : ''}.`,
        stateSent: jsonSafe(request), providerKind: observation.providerKind === 'local' ? null : observation.providerKind,
        requestedModel: observation.requestedModel, returnedModel: observation.returnedModel, durationMs: observation.durationMs,
        inputTokens: observation.inputTokens, outputTokens: observation.outputTokens, networkCalls: observation.providerKind === 'local' ? 0 : 1,
      });
      await this.persist();
    } catch (error) {
      this.observerInFlight.delete(variantId);
      if (abort.signal.aborted || epoch !== this.epoch || chatKey !== this.chatKey || !this.record || this.record.attempts[attemptId]?.status !== 'observing') return;
      const messageText = error instanceof ProviderError ? `${error.code}: ${error.message}` : (error as Error).message;
      this.apply({ type: 'observation_failed', attemptId, variantId, error: messageText });
      this.inspect({ kind: 'observer', attemptId, resolutionId: attempt.resolutionId, message: `Observer failed; reply preserved and prior state retained: ${messageText}`, stateSent: jsonSafe(request), networkCalls: provider.kind === 'local' ? 0 : 1 });
      this.status = 'Stale';
      await this.persist();
      this.host.toast('warning', 'The reply was preserved, but state tracking is stale because the post-reply observer failed.');
    }
  }

  /** Next user input implicitly accepts the currently selected observed variant. */
  private async onMessageSent(mesId: number): Promise<void> {
    if (!this.settings.enabled || this.host.isAutoDirectorEnabled()) return;
    await this.waitForMessageTasks();
    if (!this.record) return;
    const committed = await this.commitCurrentVariant('next user message');
    if (!committed) {
      this.host.toast('warning', 'Your message was sent, but Director state could not advance because the selected reply was not safely observed. State tracking is stale until repaired or a known swipe is restored.');
      return;
    }
    const prefix = this.host.chat().slice(0, mesId + 1);
    this.ensurePredecessor(prefix);
    await this.persist();
    this.refreshStatus();
  }

  private async commitCurrentVariant(reason: string): Promise<boolean> {
    if (!this.record) return true;
    const cursor = this.record.projection.cursor;
    const variant = Object.values(this.record.variants).find(candidate => candidate.cursorAfter === cursor && candidate.acceptance === 'pending');
    if (!variant) return this.record.projection.status !== 'stale';
    const liveMessages = this.host.chat();
    const index = this.record.attempts[variant.attemptId]?.hostMessageRef;
    if (typeof index !== 'number' || this.host.readMarker(index)?.v !== variant.variantId || this.cursorOf(liveMessages.slice(0, index + 1)) !== variant.cursorAfter) return false;
    if (variant.observerStatus === 'pending') {
      this.status = 'Observing';
      this.host.toast('info', 'The reply is still being checked. Try again when Director shows Ready to continue or Ready with an outcome.');
      this.notify();
      return false;
    }
    if (variant.observerStatus !== 'ready' || !variant.observation) {
      this.status = 'Stale';
      this.lastError = variant.observerError ?? 'The selected reply has no valid observation.';
      this.notify();
      return false;
    }
    this.apply({ type: 'commit_observation', variantId: variant.variantId, operationId: `commit-observation:${variant.variantId}`, now: Date.now() });
    const accepted = this.record.variants[variant.variantId]?.acceptance === 'accepted';
    if (!accepted) {
      this.status = 'Stale';
      this.lastError = 'The observation commit was refused because its predecessor state changed.';
      this.notify();
      return false;
    }
    this.inspect({ kind: 'acceptance', attemptId: variant.attemptId, resolutionId: variant.resolutionId, networkCalls: 0, message: `Implicitly accepted selected reply on ${reason}; observer deltas committed once.` });
    this.status = 'Ready';
    await this.persist();
    return true;
  }

  async commitReply(): Promise<void> {
    const ok = await this.commitCurrentVariant('explicit Commit reply');
    if (ok) this.host.toast('success', 'Selected reply committed.');
    this.refreshStatus();
  }

  private selectedVariantRecord() {
    if (!this.record) return null;
    const marker = this.host.readMarker(this.host.chat().length - 1);
    const variant = marker ? this.record.variants[marker.v] ?? null : null;
    return variant?.cursorAfter === this.cursorOf(this.host.chat()) ? variant : null;
  }

  canRerollSelected(): boolean {
    if (!this.record) return false;
    const variant = this.selectedVariantRecord();
    if (!variant) return false;
    const attempt = this.record.attempts[variant.attemptId];
    return Boolean(attempt?.resolutionId && this.record.resolutions[attempt.resolutionId]);
  }

  canRepairSelected(): boolean {
    return Boolean(this.record && this.record.projection.status === 'stale');
  }

  private hasRepairableSelectedFailure(): boolean {
    const variant = this.selectedVariantRecord();
    return Boolean(variant?.observerStatus === 'failed');
  }

  private canAdoptEmptyBaseline(): boolean {
    const state = this.record?.projection.state;
    return Boolean(state && JSON.stringify(state) === JSON.stringify(emptyState()));
  }

  async retryObservation(): Promise<void> {
    if (!this.record || this.host.isGenerating()) return;
    const cursor = this.record.projection.cursor;
    const variant = Object.values(this.record.variants).find(candidate => candidate.cursorAfter === cursor && candidate.observerStatus === 'failed');
    if (!variant) { this.host.toast('info', 'The selected reply has no failed observation to retry.'); return; }
    const attempt = this.record.attempts[variant.attemptId];
    if (!attempt || attempt.hostMessageRef === null) return;
    this.apply({ type: 'retry_observation', attemptId: attempt.attemptId, variantId: variant.variantId });
    this.status = 'Observing';
    await this.persist();
    await this.observeVariant(attempt.attemptId, variant.variantId, attempt.hostMessageRef);
    this.refreshStatus();
  }

  /**
   * Repair the selected branch at the seam a swipe actually needs. When the
   * failed variant has no predecessor checkpoint, baseline that predecessor
   * from the preserved fail-closed state, then retry observation. Generic
   * imported/edit staleness still falls back to a head baseline.
   */
  async repairSelectedBranch(): Promise<void> {
    if (!this.record || this.host.isGenerating() || this.inFlight) return;
    const variant = this.selectedVariantRecord();
    const attempt = variant ? this.record.attempts[variant.attemptId] ?? null : null;
    if (variant?.observerStatus === 'failed' && attempt?.cursorBefore && attempt.hostMessageRef !== null) {
      if (!this.record.checkpoints[attempt.cursorBefore]) {
        if (!this.canAdoptEmptyBaseline()) { this.host.toast('warning', 'This swipe has no predecessor state. Restore a tracked swipe or explicitly reset tracking; later facts cannot be copied backwards.'); return; }
        this.apply({ type: 'set_baseline', cursor: attempt.cursorBefore, state: this.record.projection.state, reason: 'user repaired the selected swipe predecessor' });
        this.inspect({ kind: 'restore', attemptId: attempt.attemptId, resolutionId: attempt.resolutionId, networkCalls: 0, message: 'Repair: established a predecessor baseline for the selected swipe from the preserved fail-closed state.' });
      }
      this.apply({ type: 'retry_observation', attemptId: attempt.attemptId, variantId: variant.variantId });
      this.status = 'Observing';
      await this.persist();
      await this.observeVariant(attempt.attemptId, variant.variantId, attempt.hostMessageRef);
      this.refreshStatus();
      if (this.record.variants[variant.variantId]?.observerStatus === 'ready') this.host.toast('success', 'Selected swipe repaired. Continue normally to commit it.');
      return;
    }
    const epoch = this.epoch;
    const cursor = this.chainNow().at(-1)!;
    if (!(await this.host.confirm('Reset tracking at the selected message', '<p>Discard the current tracked facts for this branch and start an empty baseline at the selected message? Chat text and saved swipes are preserved.</p>'))) return;
    if (epoch !== this.epoch || cursor !== this.chainNow().at(-1)) return;
    this.apply({ type: 'set_baseline', cursor, state: emptyState(), reason: 'explicit reset of tracking at selected message' });
    this.status = 'Ready';
    await this.persist();
    this.refreshStatus();
  }

  private async onMessageSwiped(mesId: number): Promise<void> {
    if (!this.record || !this.settings.enabled || this.host.isAutoDirectorEnabled()) return;
    const chat = this.host.chat();
    const message = chat[mesId];
    if (!message) return;
    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    if (Array.isArray(message.swipes) && swipeId >= message.swipes.length) {
      const marker = this.host.readMarker(mesId);
      const variant = marker ? this.record.variants[marker.v] : null;
      const matches = variant?.cursorAfter === this.cursorOf(chat.slice(0, mesId + 1));
      const priorAttempt = matches && marker ? this.record.attempts[marker.a] ?? null : null;
      const baseCursor = priorAttempt?.cursorBefore ?? this.cursorOf(chat.slice(0, mesId));
      const source = { epoch: this.epoch, chatKey: this.chatKey, message, index: mesId, swipe: swipeId, baseCursor, resolutionId: priorAttempt?.resolutionId ?? null, permitId: priorAttempt?.permitId ?? null, reaction: priorAttempt?.reaction ? structuredClone(priorAttempt.reaction) : null };
      this.swipeSource = source;
      const prefixAtPrompt = this.cursorOf(chat.slice(0, mesId));
      const isCurrent = () => source.epoch === this.epoch && source.chatKey === this.chatKey && this.settings.enabled && !this.host.isAutoDirectorEnabled()
        && this.host.chat()[mesId] === message && message.swipe_id === swipeId && this.cursorOf(this.host.chat().slice(0, mesId)) === prefixAtPrompt;
      const active = source.resolutionId ? this.record.resolutions[source.resolutionId] : null;
      const permit = source.permitId ? this.record.permits[source.permitId] : null;
      if (active || permit) {
        const canReroll = Boolean(active || permit?.profile);
        const choice = await this.host.chooseSwipeAction('ruled', canReroll);
        if (!isCurrent()) { this.pendingSwipeMode = 'cancel'; return; }
        if (choice === 'cancel') { this.pendingSwipeMode = 'cancel'; return; }
        if (choice === 'reroll') {
          if (active && !(await this.reroll(false))) { this.pendingSwipeMode = 'cancel'; return; }
          if (permit && !(await this.reviewStoredPermit(permit, isCurrent))) { this.pendingSwipeMode = 'cancel'; return; }
          if (!isCurrent()) { this.pendingSwipeMode = 'cancel'; return; }
        }
        this.pendingSwipeMode = 'reuse';
      } else if (priorAttempt && !priorAttempt.unadjudicated) {
        // The selected reply was Director-managed but legitimately needed no ruling.
        this.pendingSwipeMode = 'reuse';
      } else {
        const choice = await this.host.chooseSwipeAction('native');
        if (!isCurrent() || choice === 'cancel') { this.pendingSwipeMode = 'cancel'; return; }
        this.pendingSwipeMode = choice === 'bypass' ? 'bypass' : 'adopt';
        if (this.pendingSwipeMode === 'adopt' && !this.record.checkpoints[baseCursor]) {
          if (!this.canAdoptEmptyBaseline()) {
            this.pendingSwipeMode = 'cancel';
            this.host.toast('warning', 'The predecessor has no tracked state. Restore a tracked swipe or reset tracking explicitly before generating.');
            return;
          }
          this.apply({ type: 'set_baseline', cursor: baseCursor, state: this.record.projection.state, reason: 'user adopted the native swipe predecessor into Director tracking' });
          this.inspect({ kind: 'restore', attemptId: priorAttempt?.attemptId ?? null, networkCalls: 0, message: 'Native swipe adopted: established its predecessor as the Director baseline before generation.' });
          await this.persist();
        }
        if (this.pendingSwipeMode === 'adopt' && !(await this.prepareAdoptedSwipe(source, isCurrent))) this.pendingSwipeMode = 'cancel';
      }
      return;
    }
    const marker = this.host.readMarker(mesId);
    const chain = this.chainNow();
    const cursorAfterVariant = this.cursorOf(chat.slice(0, mesId + 1));
    if (marker && this.record.variants[marker.v]) {
      this.apply({ type: 'select_variant', variantId: marker.v, cursorAfter: cursorAfterVariant, chain });
      this.inspect({ kind: 'restore', attemptId: marker.a, resolutionId: marker.r, networkCalls: 0, message: `Restored variant ${marker.v} (${this.record.projection.status}); no provider or writer call.` });
    } else {
      this.apply({ type: 'head_changed', cursor: chain.at(-1)!, chain, reason: 'unknown' });
    }
    this.refreshResultFooters(mesId, chain);
    await this.persist();
    this.refreshStatus();
  }

  private async onHeadChanged(reason: 'edit' | 'delete' | 'unknown', mesId: number | null): Promise<void> {
    if (!this.record) return;
    const chain = this.chainNow();
    const head = chain.at(-1)!;
    if (reason === 'edit' && mesId !== null && mesId === this.host.chat().length - 1 && this.record.checkpoints[head]) {
      // Editing the last message to text that already has a checkpoint (e.g. undo) is a plain restore.
      this.apply({ type: 'head_changed', cursor: head, chain, reason: 'load' });
    } else {
      this.apply({ type: 'head_changed', cursor: head, chain, reason });
    }
    if (this.record.projection.status === 'stale') {
      this.inspect({ kind: 'restore', networkCalls: 0, message: `Transcript changed (${reason}); tracked state is stale. Set a baseline to continue, or swipe/undo back to a known variant.` });
    } else {
      this.inspect({ kind: 'restore', networkCalls: 0, message: `Transcript changed (${reason}); projection ${this.record.projection.status} at ${head}.` });
    }
    this.refreshResultFooters(mesId ?? 0, chain);
    await this.persist();
    this.refreshStatus();
  }

  // ---- acceptance -------------------------------------------------------------

  provisional(): { attemptId: string; resolution: FrozenResolution | null; outcome: Outcome | null } | null {
    if (!this.record) return null;
    const a = provisionalAttempts(this.record)[0];
    if (!a) return null;
    const r = a.resolutionId ? this.record.resolutions[a.resolutionId] ?? null : null;
    return { attemptId: a.attemptId, resolution: r, outcome: r?.outcome ?? null };
  }

  async accept(): Promise<void> {
    await this.commitReply();
  }

  private async prepareAdoptedSwipe(source: NonNullable<Controller['swipeSource']>, isCurrent: () => boolean): Promise<boolean> {
    if (!this.record || !isCurrent()) return false;
    const predecessor = this.record.checkpoints[source.baseCursor]?.stateAfter;
    if (!predecessor) {
      this.fail('The swipe predecessor has no saved state. Repair the selected branch or restore a tracked swipe first.');
      await this.persist();
      return false;
    }
    const priorState = structuredClone(predecessor);
    const prefix = this.host.chat().slice(0, source.index);
    const latestUser = [...prefix].reverse().find(message => message.is_user);
    let action = this.buildAutomaticAction(latestUser?.mes ?? '', priorState.sceneId);
    if (!action) return true; // Greeting: no player action to adjudicate.
    const actors = this.bindActors();
    const built = buildState({ scopeId: 'shared-public', actors: this.record.actors, eligibleActorIds: actors.order, publicCards: {},
      facts: jsonSafe(priorState.variables) as Record<string, never>, action, latestInput: latestUser?.mes ?? '',
      recentMessages: prefix.filter(message => !message.is_system).slice(-this.profile.budgets.maxRecentMessages).map(message => ({
        actorId: message.is_user ? PLAYER_ACTOR_ID : actors.byAvatar[message.original_avatar ?? ''] ?? `name:${message.name}`, role: message.is_user ? 'user' as const : 'assistant' as const, text: message.is_user ? message.mes : stripResultFooter(message.mes),
      })), sceneId: priorState.sceneId, acceptedReplyCount: priorState.sceneReplyCount,
      maxRecentMessages: this.profile.budgets.maxRecentMessages, maxSerializedCharacters: this.profile.budgets.maxSerializedCharacters });
    if (!this.checkDecisionContext(built)) { await this.persist(); return false; }
    const snapshot: DecisionSnapshot = { chatId: this.chatKey!, cursorBefore: source.baseCursor, stateRevision: priorState.revision,
      scopeId: 'shared-public', profileRevision: this.profile.revision, catalogRevision: '', actorBindingRevision: actors.order.join(','), state: built.state };
    const id = this.profile.drivingQuestionId;
    const questions = { attempt_gate: autoAttemptGateQuestion(), attempt_family: autoAttemptFamilyQuestion(), [id]: autoAttemptNoulQuestion() };
    const abort = new AbortController(); this.inFlight = abort;
    try {
      const result = await this.provider().evaluate({ requestId: newId('req'), phase: 'guide', snapshot, questions }, abort.signal);
      if (!isCurrent() || this.profile.revision !== snapshot.profileRevision) return false;
      if (this.record.checkpoints[source.baseCursor]?.stateAfter.revision !== priorState.revision) {
        this.host.toast('warning', 'The swipe predecessor changed while Director was deciding. Try the swipe again.');
        return false;
      }
      const interpreted = interpretAutomaticAttempt(action, result.answers, result.errors);
      if (!interpreted.ok) throw new Error(interpreted.error);
      action = interpreted.action;
      if (!action || this.profile.mode !== 'binding') return true;
      const signal = normaliseSignal(result.answers[id]!);
      if (!signal.ok) throw new Error(signal.error);
      const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: this.profile.resolutionMethod,
        signal: signal.signal, draw: this.profile.resolutionMethod === 'sample' ? randomDraw().u : null });
      if (!resolved.ok) throw new Error(resolved.error);
      const resolution = freeze({ resolutionId: newId('res'), previousResolutionId: null, action, snapshot, assessment: result.answers[id]!,
        decisionSource: 'provider', policyRevision: this.profile.revision, band: resolved.value.band, method: resolved.value.method, draw: resolved.value.draw,
        outcome: resolved.value.outcome, def: resolved.value.def, cursorBefore: source.baseCursor, generation: 1, providerKind: result.provider,
        requestedModel: result.requestedModel, returnedModel: result.returnedModel, now: Date.now() });
      this.apply({ type: 'store_resolution', resolution });
      source.resolutionId = resolution.resolutionId;
      this.inspect({ kind: 'wording_regeneration', resolutionId: resolution.resolutionId, questions, answers: result.answers, stateSent: built.state,
        outcome: resolution.outcome, networkCalls: this.isNetworkProvider() ? 1 : 0, message: 'Adopted native swipe: adjudicated the preceding user attempt before generation.' });
      await this.persist();
      return true;
    } catch (error) { if (isCurrent()) this.host.toast('error', `Swipe decision failed: ${(error as Error).message}`); return false; }
    finally { if (this.inFlight === abort) this.inFlight = null; }
  }

  private async reviewStoredPermit(previous: TurnPermit, isCurrent: () => boolean): Promise<boolean> {
    const profile = previous.profile;
    if (!profile) return false;
    const names = Object.fromEntries(Object.values(this.record?.actors ?? {}).map(actor => [actor.actorId, actor.name]));
    const abort = new AbortController();
    this.inFlight = abort;
    const redraw = async (permit: TurnPermit) => {
      if (profile.resolutionMethod === 'sample') return rerollPermit(permit, profile, names, this.host.playerName());
      if (!previous.proposal || !previous.snapshot) throw new Error('Stored permit has no proposal for reassessment.');
      return (await adjudicateTurnProposal({ proposal: previous.proposal, snapshot: previous.snapshot, profile, provider: this.planningProvider(this.provider()), actorNames: names, playerName: this.host.playerName(), signal: abort.signal })).permit;
    };
    try {
      const initial = await redraw(previous);
      const permit = await reviewPermit({ initial, method: profile.resolutionMethod, signal: abort.signal, isCurrent,
        choose: permit => this.host.reviewRolls(permit, names, profile.resolutionMethod, abort.signal), reroll: redraw });
      if (!permit || !isCurrent()) return false;
      permit.previousPermitId = previous.permitId;
      this.apply({ type: 'store_permit', permit });
      if (this.swipeSource) this.swipeSource.permitId = permit.permitId;
      await this.persist();
      return true;
    } catch (error) {
      if (isCurrent()) this.host.toast('error', `Roll review failed: ${(error as Error).message}`);
      return false;
    } finally { if (this.inFlight === abort) this.inFlight = null; }
  }

  async reject(): Promise<void> {
    const p = this.provisional();
    if (!p || !this.record) return;
    this.apply({ type: 'reject', attemptId: p.attemptId });
    this.inspect({ kind: 'acceptance', attemptId: p.attemptId, resolutionId: p.resolution?.resolutionId ?? null, outcome: p.outcome, networkCalls: 0, message: 'Rejected: no effects committed. Swipe for a wording retry with the same ruling, or Reroll.' });
    this.status = 'Ready';
    this.host.toast('info', 'Rejected. Swipe to regenerate the wording under the same ruling, or press Reroll for a new resolution.');
    await this.persist();
    this.refreshStatus();
  }

  /** Explicit reroll: a new linked resolution for the same action at the same prefix, then a wording swipe. */
  async reroll(generateSwipe = true): Promise<boolean> {
    if (!this.record) return false;
    if (this.host.isGenerating()) { this.host.toast('warning', 'Wait for the current generation to finish.'); return false; }
    const chat = this.host.chat();
    const last = chat.length - 1;
    const marker = this.host.readMarker(last);
    const attempt = marker ? this.record.attempts[marker.a] : null;
    const cursor = attempt?.cursorBefore ?? this.cursorOf(chat.slice(0, -1));
    const resolutionId = this.swipeSource?.resolutionId ?? this.selectedVariantRecord()?.resolutionId;
    const previous = resolutionId ? this.record.resolutions[resolutionId] ?? null : null;
    if (!previous) { this.host.toast('warning', 'The selected reply has no active Director ruling to reroll.'); return false; }
    const rerollEpoch = this.epoch;
    const rerollCursor = this.cursorOf(chat);

    let next: FrozenResolution;
    let networkCalls = 0;
    let answers: Record<string, Answer> | null = null;
    if (previous.method === 'sample' && previous.assessment && previous.policyBand && defOfResolution(previous)) {
      const signal = normaliseSignal(previous.assessment);
      if (!signal.ok) return false;
      const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: 'sample', signal: signal.signal, draw: randomDraw().u });
      if (!resolved.ok) return false;
      next = freeze({ ...previous, resolutionId: newId('res'), previousResolutionId: previous.resolutionId, generation: previous.generation + 1,
        band: resolved.value.band, def: resolved.value.def, outcome: resolved.value.outcome, draw: resolved.value.draw, now: Date.now() });
    } else if (previous.decisionSource === 'provider') {
      const questionId = this.profile.drivingQuestionId;
      const questions: Record<string, Question> = { [questionId]: previous.action.pipeline === 'staged' && previous.action.move ? this.stagedRulingQuestion(previous.action.move) : questionId === 'gain_score' ? attemptScoreQuestion(previous.action) : attemptNoulQuestion(previous.action) };
      let provider: DecisionProvider;
      try { provider = this.provider(); } catch (e) { this.fail(`Connection error: ${(e as Error).message}`); return false; }
      if (this.isNetworkProvider()) networkCalls = 1;
      this.status = 'Deciding';
      this.notify();
      const abort = new AbortController();
      this.inFlight = abort;
      const epoch = this.epoch;
      const chatKey = this.chatKey;
      let result: EvaluationResult;
      try {
        result = await provider.evaluate({ requestId: newId('req'), phase: 'guide', snapshot: previous.snapshot, questions }, abort.signal);
      } catch (e) {
        this.inFlight = null;
        if (epoch !== this.epoch || this.chatKey !== chatKey) return false;
        this.status = 'Paused';
        const msg = e instanceof ProviderError ? `${e.code}: ${e.message}` : (e as Error).message;
        this.inspect({ kind: 'error', message: `Reroll provider failed; previous resolution kept. ${msg}`, networkCalls, providerKind: provider.kind });
        this.host.toast('error', `Reroll failed: ${msg}. The previous ruling stands.`);
        await this.persist();
        this.notify();
        return false;
      }
      this.inFlight = null;
      if (epoch !== this.epoch || this.chatKey !== chatKey) return false;
      answers = result.answers;
      const answer = result.answers[questionId];
      if (!answer) { this.status = 'Paused'; this.fail(`Reroll got no valid assessment (${result.errors[questionId] ?? 'missing'}); previous ruling kept.`, { networkCalls }); return false; }
      const sig = normaliseSignal(answer);
      if (!sig.ok) { this.status = 'Paused'; this.fail(`Reroll assessment invalid: ${sig.error}`, { networkCalls }); return false; }
      const draw = this.profile.resolutionMethod === 'sample' ? randomDraw().u : null;
      const resolved = resolveOutcome({ bands: this.profile.bands, outcomes: this.profile.outcomes, method: this.profile.resolutionMethod, signal: sig.signal, draw });
      if (!resolved.ok) { this.status = 'Paused'; this.fail(`Reroll could not resolve: ${resolved.error}`, { networkCalls }); return false; }
      next = freeze({
        resolutionId: newId('res'), previousResolutionId: previous.resolutionId, action: previous.action, snapshot: previous.snapshot, assessment: answer, decisionSource: 'provider',
        policyRevision: this.profile.revision, band: resolved.value.band, method: resolved.value.method, draw: resolved.value.draw, outcome: resolved.value.outcome, def: resolved.value.def,
        cursorBefore: previous.cursorBefore, generation: previous.generation + 1, providerKind: result.provider, requestedModel: result.requestedModel, returnedModel: result.returnedModel, now: Date.now(),
      });
    } else {
      next = freeze({ ...previous, resolutionId: newId('res'), previousResolutionId: previous.resolutionId, generation: previous.generation + 1, now: Date.now(), band: previous.policyBand, def: defOfResolution(previous), outcomeTier: previous.outcomeTier, outcomeNote: previous.outcomeNote });
    }
    if (rerollEpoch !== this.epoch || rerollCursor !== this.cursorOf(this.host.chat())) return false;
    const preview: TurnPermit = {
      schemaVersion: 1, permitId: next.resolutionId, attemptId: attempt?.attemptId ?? 'preview', speakerActorId: attempt?.actorId ?? '', baseCursor: cursor,
      stateRevision: next.snapshot.stateRevision, compactState: { sceneId: next.action.sceneId ?? 1, revision: next.snapshot.stateRevision }, constraints: [], createdAt: Date.now(),
      actions: [{ proposalId: next.actionId, resolutionId: next.resolutionId, actingActorId: next.action.actingActorId ?? next.action.playerActorId,
        targetActorIds: next.action.targetActorIds, family: 'acquire_secure', method: next.action.attemptedAction, boundedResult: next.action.requestedGain,
        failureStake: next.action.failureStake ?? { kind: 'other', detail: '' }, opposed: next.action.opposed ?? false,
        outcome: next.outcome, instruction: this.filledInstruction(next, attempt?.actorId ?? null), recordedValue: next.outcomeRecords ?? '', finalForScope: next.outcomeFinal ?? false,
        scope: 'attempt', assessment: next.assessment ?? undefined, draw: next.draw }],
    };
    const abortReview = new AbortController();
    this.inFlight = abortReview;
    const names = Object.fromEntries(Object.values(this.record.actors).map(actor => [actor.actorId, actor.name]));
    const choice = await this.host.reviewRolls(preview, names, previous.method === 'sample' ? 'sample' : 'threshold', abortReview.signal);
    if (this.inFlight === abortReview) this.inFlight = null;
    if (choice === 'cancel' || abortReview.signal.aborted || rerollEpoch !== this.epoch || rerollCursor !== this.cursorOf(this.host.chat())) return false;
    if (choice === 'reroll') return this.reroll(generateSwipe);
    this.apply({ type: 'reroll', previousResolutionId: previous.resolutionId, resolution: next, now: Date.now() });
    if (this.swipeSource) this.swipeSource.resolutionId = next.resolutionId;
    this.inspect({ kind: 'reroll', resolutionId: next.resolutionId, actionId: next.actionId, outcome: next.outcome, policyBandId: next.policyBand?.id ?? null, draw: next.draw, answers, networkCalls, providerKind: next.providerKind, message: `Reroll: ${previous.outcome} → ${next.outcome} (${next.method}${next.outcome === previous.outcome ? ', unchanged result' : ''}); linked to ${previous.resolutionId}.` });
    this.status = 'Frozen';
    await this.persist();
    this.host.toast('info', `Rerolled: ${next.outcome}${next.outcome === previous.outcome ? ' (same result)' : ''}.${generateSwipe ? ' Generating a new swipe…' : ''}`);
    if (generateSwipe) {
      try { await this.host.swipeRight(); } catch (e) { console.warn('[RP Director] swipe failed', e); }
    }
    this.refreshStatus();
    return true;
  }

  async setBaseline(): Promise<void> {
    if (!this.record) return;
    const chain = this.chainNow();
    this.apply({ type: 'set_baseline', cursor: chain.at(-1)!, state: this.record.projection.state, reason: 'user set the current state as a new baseline' });
    this.inspect({ kind: 'info', networkCalls: 0, message: 'Baseline set at the current head by the user; earlier state was not reconstructed.' });
    this.status = 'Ready';
    await this.persist();
    this.refreshStatus();
  }

  async startNewScene(): Promise<void> {
    if (!this.record || this.nativeTurnBusy || this.host.nativeSendBlocked()) return;
    this.nativeTurnBusy = true;
    try { await this.newSceneAndContinue(); } finally { this.nativeTurnBusy = false; }
  }

  private async newSceneAndContinue(): Promise<void> {
    if (!this.record) return;
    if (this.hasRepairableSelectedFailure()) await this.repairSelectedBranch();
    if (!(await this.commitCurrentVariant('new scene'))) return;
    if (this.host.isGenerating() || this.inFlight) { this.host.toast('warning', 'Wait for the current decision or generation to finish.'); return; }
    if (provisionalAttempts(this.record).length > 0) { this.host.toast('warning', 'Wait for the reply to finish being checked, then try New scene & continue again.'); return; }
    if (this.record.projection.status !== 'current') { this.host.toast('warning', 'The tracked state must be current before starting a new scene.'); return; }
    const cursor = this.chainNow().at(-1)!;
    this.apply({ type: 'start_scene', cursor, reason: 'user started a new scene' });
    this.actionDraft = null;
    this.actionDraftRevision += 1;
    this.sceneTransitionPending = true;
    this.inspect({ kind: 'info', networkCalls: 0, message: `Started scene ${this.record.projection.state.sceneId}. Scene-scoped rulings from earlier scenes no longer settle new attempts.` });
    await this.persist();
    this.host.toast('success', `Scene ${this.record.projection.state.sceneId} started. Continuing through Director…`);
    this.refreshStatus();
    await this.directorTurn(this.host.composerText().trim() ? 'director_send' : 'director_next');
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
    if (kind === 'mock' || kind === 'rules') return localOnly(kind);
    let provider: DecisionProvider;
    try { provider = this.provider(); } catch (e) { return transportFailure('connection', (e as Error).message, null); }
    const request = buildTableTestRequest(table, this.profile.drivingQuestionId, newId('req'));
    const abort = new AbortController();
    const started = Date.now();
    let report: TableTestReport;
    try {
      const result = await provider.evaluate(request, abort.signal);
      report = evaluateTableTest(table, method, request, result);
      this.inspect({ kind: 'info', message: `Table test: ${report.headline}`, questions: request.questions, stateSent: request.snapshot.state, answers: result.answers, providerKind: result.provider, requestedModel: result.requestedModel, returnedModel: result.returnedModel, durationMs: result.durationMs, inputTokens: result.inputTokens, outputTokens: result.outputTokens, networkCalls: 1 });
    } catch (e) {
      const code = e instanceof ProviderError ? e.code : 'error';
      report = transportFailure(code, (e as Error).message, Date.now() - started);
      this.inspect({ kind: 'error', message: `Table test failed: ${code}: ${(e as Error).message}`, questions: request.questions, stateSent: request.snapshot.state, providerKind: provider.kind, networkCalls: 1 });
    }
    await this.persist();
    return report;
  }

  // ---- settings ---------------------------------------------------------------

  setEnabled(enabled: boolean): void {
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
      for (const controller of this.observerInFlight.values()) controller.abort(new Error('disabled'));
      this.observerInFlight.clear();
      this.toolWindow = null;
      this.preparedTool = null;
      this.pendingSwipeMode = null;
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
