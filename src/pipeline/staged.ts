/**
 * Staged decision pipeline (docs/STAGED-JEV-PLAN.md §1), host-independent.
 *
 *   S  speaker          own request, in parallel with A (may later carry cards)
 *   A  move selection   verbatim passage of the latest message (+ count, + reaction triggers)
 *   B  routing          owner / target / family / action specification / antecedent
 *   C  lore             caller-started (src/lore) beside S and A; the ruling awaits it
 *   D  evidence         code only: the family's admissible projection
 *   E  ruling           one Noul on the specified change
 *
 * Questions inside one request are independent; anything that depends on an
 * answer goes in a later request. A and B are public-only (no cards), so they
 * can safely feed detection routing. Freezing, dice and writer injection stay
 * with the caller, which reuses the existing resolver and attempt machinery.
 */
import type { Answer, EvaluationResult, Json, Question } from '../types.ts';
import type { GenrePack } from '../pack/pack.ts';
import { familyByKey } from '../pack/pack.ts';
import { candidateSpans, sentenceSpans, stripOutOfCharacterSegments, visibleText } from './spans.ts';
import type { Span } from './spans.ts';
import { countQuestion, moveQuestion, routeQuestions, rulingQuestion } from './questions.ts';
import type { NoulQuestion } from './questions.ts';
import { deriveRoute } from './route.ts';
import type { MoveRoute } from './route.ts';
import { judgeProjection } from './evidence.ts';
import type { EvidenceActor, LoreEvidence, Projection } from './evidence.ts';
import { validateAnswer } from '../validate.ts';
import { freezePacing, pacingQuestions, PACING_QUESTION_IDS } from '../pacing.ts';
import type { FrozenPacing, PacingOptions } from '../pacing.ts';

export type StageId = 'pack' | 'speaker' | 'pacing' | 'move' | 'state' | 'lore' | 'route' | 'ruling';
export type StageErrorType = 'network' | 'timeout' | 'refusal' | 'invalid_answers' | 'context_budget';
export interface StageFailure { stage: StageId; type: StageErrorType; message: string; questionId?: string }

export class StagedError extends Error {
  readonly stage: StageId;
  readonly type: StageErrorType;
  constructor(stage: StageId, message: string, type: StageErrorType = 'invalid_answers') {
    super(message);
    this.stage = stage;
    this.type = type;
  }
}

/** A single vocabulary for failed requests and invalid answers in Activity. */
export function stageError(stage: StageId, error: unknown): StageFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StagedError) return { stage, type: error.type, message };
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  let type: StageErrorType = 'network';
  if (code === 'refusal' || /refus(?:al|ed|e)/i.test(message)) type = 'refusal';
  else if (['timeout', 'aborted'].includes(code) || /timed?\s*out|timeout|deadline|abort|wait budget.*expir/i.test(message)) type = 'timeout';
  else if (code === 'too_large' || /context.*(?:budget|large|limit)|(?:budget|limit).*context/i.test(message)) type = 'context_budget';
  else if (['malformed', 'truncated', 'unsupported'].includes(code) || /invalid|malformed|missing.*answer/i.test(message)) type = 'invalid_answers';
  return { stage, type, message };
}

/** Keep valid independent answers; never invent a missing or rejected answer. */
export function validateStageAnswers(stage: StageId, questions: Record<string, Question>, result: EvaluationResult): { result: EvaluationResult; errors: StageFailure[] } {
  if (!result || !result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)
    || !result.errors || typeof result.errors !== 'object' || Array.isArray(result.errors) || !Array.isArray(result.unresolvedQuestionIds)) {
    throw new StagedError(stage, 'The judge returned an invalid answer batch.');
  }
  const answers: Record<string, Answer> = {};
  const errors: Record<string, string> = {};
  const failures: StageFailure[] = [];
  const unknownErrors = Object.keys(result.errors).filter(id => !Object.hasOwn(questions, id));
  const batchError = unknownErrors.length ? unknownErrors.map(id => result.errors[id]).join('; ') : null;
  for (const [id, question] of Object.entries(questions)) {
    const raw = result.answers[id];
    const validation = validateAnswer(question, raw, raw?.provenance ?? 'model_reported');
    const reason = batchError ?? result.errors[id] ?? (result.unresolvedQuestionIds.includes(id) ? 'The answer was unresolved.' : null)
      ?? (validation.ok ? null : validation.error);
    if (reason !== null) {
      errors[id] = reason;
      const failure = stageError(stage, reason);
      if (failure.type === 'network') failure.type = 'invalid_answers';
      failures.push({ ...failure, message: `${id}: ${reason}`, questionId: id });
    } else if (validation.ok) answers[id] = validation.answer;
  }
  return { result: { ...result, answers, errors, unresolvedQuestionIds: Object.keys(errors) }, errors: failures };
}

export interface StagedEnv {
  evaluate(stage: StageId, questions: Record<string, Question>, state: Json): Promise<EvaluationResult>;
}

export interface StagedInput {
  pack: GenrePack;
  playerId: string;
  /** Player and NPCs; cards are authorial text used only by E when admissible. */
  actors: Record<string, EvidenceActor>;
  eligibleNpcIds: string[];
  latestInput: string;
  transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[];
  modules: { speaker: boolean; decisions: boolean; reactions: boolean };
  /** Built by the caller when a speaker must be chosen; null otherwise. */
  speakerQuestion: Question | null;
  /** Reaction trigger questions keyed by NPC id (public evidence only). */
  reactionQuestions: Record<string, Question>;
  /** Scene and hand-back choices ride in the existing parallel speaker request. */
  pacing?: PacingOptions;
  /** An explicit user-authored move replaces selection/routing, never the evidence firewall. */
  manual?: { text: string; ownerId: string; targetId: string | null; familyKey: string };
  maxChars: number;
  /** Judged meters for the ruling's evidence; awaited only when a ruling is needed. */
  meters?: () => Promise<Record<string, Record<string, string>>>;
  /** Lore chosen for this turn (stage C, started beside S and A); failure omits lore, preserving independent stages. */
  lore?: () => Promise<LoreEvidence[]>;
  /** Characters of lore a ruling may read. */
  maxLoreChars?: number;
  /** Successful answers of this same attempt. Only a failed-stage retry supplies these. */
  replay?: StageRecord[];
}

export interface StageRecord {
  stage: StageId;
  questions: Record<string, Question>;
  state: Json;
  result: EvaluationResult;
}

/** Reuse valid independent answers and request only missing ones on a retry. */
export async function evaluateStageWithReplay(
  stage: StageId, questions: Record<string, Question>, state: Json,
  replay: StageRecord[] | undefined, evaluate: StagedEnv['evaluate'],
): Promise<EvaluationResult> {
  const frozen: Record<string, Answer> = {};
  let source: EvaluationResult | undefined;
  for (const record of replay ?? []) {
    // Before 0.8 phase 3c, a 1:1 pacing-only request was saved as stage 'speaker'.
    if (record.stage !== stage && !(stage === 'pacing' && record.stage === 'speaker')) continue;
    for (const [id, question] of Object.entries(questions)) {
      if (JSON.stringify(record.questions[id]) !== JSON.stringify(question) || record.result.errors[id] || record.result.unresolvedQuestionIds.includes(id)) continue;
      const answer = record.result.answers[id];
      const validated = validateAnswer(question, answer, answer?.provenance ?? 'model_reported');
      if (validated.ok) { frozen[id] = validated.answer; source = record.result; }
    }
  }
  const pending = Object.fromEntries(Object.entries(questions).filter(([id]) => !Object.hasOwn(frozen, id)));
  if (!source) return evaluate(stage, questions, state);
  if (!Object.keys(pending).length) return { ...source, answers: frozen, errors: {}, unresolvedQuestionIds: [], inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 0 };
  try {
    const fresh = await evaluate(stage, pending, state);
    return { ...fresh, answers: { ...fresh.answers, ...frozen } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...source, answers: frozen, errors: Object.fromEntries(Object.keys(pending).map(id => [id, message])), unresolvedQuestionIds: Object.keys(pending), inputTokens: null, outputTokens: null, durationMs: 0, transportAttempts: 0 };
  }
}

export interface StagedOutput {
  outcome: 'no_move' | 'unruled' | 'handoff' | 'ruled';
  records: StageRecord[];
  errors: StageFailure[];
  speakerAnswer: Answer | null;
  reactionAnswers: Record<string, Answer>;
  pacing: FrozenPacing | null;
  move: { span: Span; count: 'one' | 'multiple' | null } | null;
  route: MoveRoute | null;
  antecedentText: string | null;
  ruling: { answer: Answer; question: NoulQuestion; projection: Projection } | null;
}

/** How many sentences of the last NPC message are offered as antecedents. */
export const MAX_ANTECEDENTS = 60;

function publicState(input: StagedInput): Json {
  const actors: Record<string, Json> = {};
  for (const [id, actor] of Object.entries(input.actors)) actors[id] = { name: visibleText(actor.name), control: actor.control };
  const build = (messages: StagedInput['transcript']): Json => ({
    actors,
    playerActorId: input.playerId,
    latestInput: input.latestInput,
    recentAcceptedMessages: messages.map(m => ({ actorId: m.actorId, role: m.role, text: visibleText(m.text) })),
  });
  let messages = input.transcript.slice();
  let state = build(messages);
  while (JSON.stringify(state).length > input.maxChars && messages.length > 0) {
    messages = messages.slice(1);
    state = build(messages);
  }
  return state;
}

function antecedentCandidates(input: StagedInput): { id: string; text: string }[] {
  const last = [...input.transcript].reverse().find(m => m.role === 'assistant');
  if (!last) return [];
  return sentenceSpans(visibleText(last.text)).slice(-MAX_ANTECEDENTS).map((span, i) => ({ id: `a${i + 1}`, text: span.text }));
}

const choiceOf = (answer: Answer | undefined): string | null => answer?.type === 'choice' ? answer.choice : null;

export async function runStaged(input: StagedInput, env: StagedEnv): Promise<StagedOutput> {
  // Sanitize the current message as well as the older transcript. The selected
  // passage and every question must come from the same public-only text.
  input = { ...input, latestInput: stripOutOfCharacterSegments(visibleText(input.latestInput)) };
  const records: StageRecord[] = [];
  const out: StagedOutput = { outcome: 'no_move', records, errors: [], speakerAnswer: null, reactionAnswers: {}, pacing: null, move: null, route: null, antecedentText: null, ruling: null };
  const call = async (stage: StageId, questions: Record<string, Question>, state: Json) => {
    try {
      if (JSON.stringify(state).length > input.maxChars) throw new StagedError(stage, 'The judge context exceeds its character budget.', 'context_budget');
      if (Object.keys(questions).length > 16) throw new StagedError(stage, 'The judge request exceeds 16 questions.');
      const validated = validateStageAnswers(stage, questions, await evaluateStageWithReplay(stage, questions, state, input.replay, env.evaluate));
      records.push({ stage, questions, state, result: validated.result });
      // Pacing rides in a group's speaker request; its invalid answers are pacing
      // failures, never a failure of a valid speaker answer.
      out.errors.push(...validated.errors.map(failure => failure.questionId && PACING_QUESTION_IDS.includes(failure.questionId) ? { ...failure, stage: 'pacing' as const } : failure));
      return validated.result;
    } catch (error) {
      out.errors.push(stageError(stage, error));
      return null;
    }
  };

  const shared = publicState(input);
  const ooc = !input.latestInput.trim();
  const manual = input.modules.decisions && !ooc ? input.manual : undefined;
  const spans = input.modules.decisions && !manual && !ooc ? candidateSpans(input.latestInput) : [];
  const aQuestions: Record<string, Question> = {};
  if (input.modules.decisions && spans.length > 0) {
    aQuestions.move = moveQuestion(spans, input.pack);
    aQuestions.move_count = countQuestion(input.pack);
  }
  const reactionIds = new Map<string, string>();
  if (input.modules.reactions) {
    Object.entries(input.reactionQuestions).forEach(([npcId, question], index) => {
      const id = `npc_reaction_${index + 1}`;
      reactionIds.set(id, npcId);
      aQuestions[id] = question;
    });
  }

  // S and A are independent. Large groups split their reaction questions into
  // independent requests, each inside the server plugin's 16-question cap.
  const entries = Object.entries(aQuestions);
  const batches: Record<string, Question>[] = [];
  for (let i = 0; i < entries.length; i += 16) batches.push(Object.fromEntries(entries.slice(i, i + 16)));
  const sQuestions: Record<string, Question> = {};
  if (input.modules.speaker && input.speakerQuestion) sQuestions.speaker = input.speakerQuestion;
  if (input.pacing) Object.assign(sQuestions, pacingQuestions(input.pacing.handBack));
  const [speakerResult, ...aResults] = await Promise.all([
    Object.keys(sQuestions).length ? call(sQuestions.speaker ? 'speaker' : 'pacing', sQuestions, shared) : Promise.resolve(null),
    ...batches.map(questions => call('move', questions, shared)),
  ]);
  if (speakerResult) out.speakerAnswer = speakerResult.answers.speaker ?? null;
  if (speakerResult && input.pacing) out.pacing = freezePacing(speakerResult.answers, input.pacing);
  for (const result of aResults) if (result) for (const [questionId, npcId] of reactionIds) if (result.answers[questionId]) out.reactionAnswers[npcId] = result.answers[questionId]!;
  const npcIds = Object.keys(input.actors).filter(id => id !== input.playerId);
  let span: Span;
  let route: MoveRoute;
  let antecedents: { id: string; text: string }[] = [];
  if (manual) {
    const text = visibleText(manual.text);
    const validTarget = manual.targetId === null || ['SELF', 'SEVERAL', 'SCENE'].includes(manual.targetId) || Object.hasOwn(input.actors, manual.targetId);
    if (!text || !Object.hasOwn(input.actors, manual.ownerId) || !validTarget || !familyByKey(input.pack, manual.familyKey)) {
      out.outcome = 'unruled';
      out.errors.push({ stage: 'route', type: 'invalid_answers', message: 'The manual move has no valid text, owner, target or family.' });
      return out;
    }
    span = { id: 'manual', kind: 'whole', text, start: 0, end: text.length };
    out.move = { span, count: 'one' };
    route = deriveRoute({ owner: manual.ownerId, target: manual.targetId ?? 'UNRESOLVED', family: manual.familyKey, specification: 'SPECIFIED_HERE', antecedent: 'NONE' }, { playerId: input.playerId, npcIds, pack: input.pack });
  } else {
    if (!aQuestions.move) return out;
    const aResult = aResults[0];
    if (!aResult) { out.outcome = 'unruled'; return out; }
    const selected = choiceOf(aResult.answers.move);
    if (!selected) { out.outcome = 'unruled'; return out; }
    if (selected === 'NONE' || selected === 'ROUTINE') return out;
    const selectedSpan = spans.find(s => s.id === selected);
    if (!selectedSpan) { out.outcome = 'unruled'; return out; }
    span = selectedSpan;
    const count = choiceOf(aResult.answers.move_count);
    out.move = { span, count: count === 'one' || count === 'multiple' ? count : null };
    if (!out.move.count) { out.outcome = 'unruled'; return out; }

    // B: routing, on the selected public passage.
    const actorNames: Record<string, string> = { [input.playerId]: visibleText(input.actors[input.playerId]?.name ?? input.playerId) };
    for (const id of npcIds) actorNames[id] = visibleText(input.actors[id]!.name);
    antecedents = antecedentCandidates(input);
    const routeState = { ...(shared as Record<string, Json>), move: { passage: span.text } } as Json;
    const bResult = await call('route', routeQuestions({ actorNames, playerId: input.playerId, pack: input.pack, antecedents }), routeState);
    if (!bResult) { out.outcome = 'unruled'; return out; }
    route = deriveRoute({
      owner: choiceOf(bResult.answers.owner), target: choiceOf(bResult.answers.target), family: choiceOf(bResult.answers.family),
      specification: choiceOf(bResult.answers.action_specification), antecedent: choiceOf(bResult.answers.antecedent),
    }, { playerId: input.playerId, npcIds, pack: input.pack });
  }
  out.route = route;
  out.antecedentText = route.antecedentId ? antecedents.find(a => a.id === route.antecedentId)?.text ?? null : null;
  if (route.route === 'UNRULED') { out.outcome = 'unruled'; return out; }
  if (route.route === 'HANDOFF') { out.outcome = 'handoff'; return out; }

  // D + E: admissible evidence, then one probability.
  const family = familyByKey(input.pack, route.familyKey!)!;
  const optionalEvidence = async <T>(stage: StageId, read: (() => Promise<T>) | undefined): Promise<T | undefined> => {
    try { return await read?.(); }
    catch (error) { out.errors.push(stageError(stage, error)); return undefined; }
  };
  const [meters, lore] = await Promise.all([optionalEvidence('state', input.meters), optionalEvidence('lore', input.lore)]);
  const projection = judgeProjection({
    pack: input.pack, family, playerId: input.playerId, ownerId: route.ownerId!, targetId: route.targetId,
    actors: input.actors, transcript: input.transcript, latestInput: input.latestInput,
    move: { passage: span.text, antecedent: out.antecedentText }, meters, lore, maxLoreChars: input.maxLoreChars, maxChars: input.maxChars,
  });
  const question = rulingQuestion({ family, pack: input.pack, hasAntecedent: out.antecedentText !== null });
  const eResult = await call('ruling', { ruling: question }, projection.state);
  const answer = eResult?.answers.ruling;
  if (!answer || answer.type !== 'noul') { out.outcome = 'unruled'; return out; }
  out.ruling = { answer, question, projection };
  out.outcome = 'ruled';
  return out;
}
