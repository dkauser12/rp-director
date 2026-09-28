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
import { candidateSpans, sentenceSpans, visibleText } from './spans.ts';
import type { Span } from './spans.ts';
import { countQuestion, moveQuestion, routeQuestions, rulingQuestion } from './questions.ts';
import type { NoulQuestion } from './questions.ts';
import { deriveRoute } from './route.ts';
import type { MoveRoute } from './route.ts';
import { judgeProjection } from './evidence.ts';
import type { EvidenceActor, LoreEvidence, Projection } from './evidence.ts';

export type StageId = 'pack' | 'speaker' | 'move' | 'state' | 'lore' | 'route' | 'ruling';

export class StagedError extends Error {
  readonly stage: StageId;
  constructor(stage: StageId, message: string) {
    super(message);
    this.stage = stage;
  }
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
  facts: Record<string, Json>;
  modules: { speaker: boolean; decisions: boolean; reactions: boolean };
  /** Built by the caller when a speaker must be chosen; null otherwise. */
  speakerQuestion: Question | null;
  /** Reaction trigger questions keyed by NPC id (public evidence only). */
  reactionQuestions: Record<string, Question>;
  maxChars: number;
  /** Judged meters for the ruling's evidence; awaited only when a ruling is needed. */
  meters?: () => Promise<Record<string, Record<string, string>>>;
  /** Lore chosen for this turn (stage C, started by the caller beside S and A); awaited only when a ruling is needed. Must not throw. */
  lore?: () => Promise<LoreEvidence[]>;
  /** Characters of lore a ruling may read. */
  maxLoreChars?: number;
}

export interface StageRecord {
  stage: StageId;
  questions: Record<string, Question>;
  state: Json;
  result: EvaluationResult;
}

export interface StagedOutput {
  outcome: 'no_move' | 'unruled' | 'handoff' | 'ruled';
  records: StageRecord[];
  speakerAnswer: Answer | null;
  reactionAnswers: Record<string, Answer>;
  move: { span: Span; count: 'one' | 'multiple' | null } | null;
  route: MoveRoute | null;
  antecedentText: string | null;
  ruling: { answer: Answer; question: NoulQuestion; projection: Projection } | null;
}

/** How many sentences of the last NPC message are offered as antecedents. */
export const MAX_ANTECEDENTS = 60;

function publicState(input: StagedInput): Json {
  const actors: Record<string, Json> = {};
  for (const [id, actor] of Object.entries(input.actors)) actors[id] = { name: actor.name, control: actor.control };
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
  const records: StageRecord[] = [];
  const out: StagedOutput = { outcome: 'no_move', records, speakerAnswer: null, reactionAnswers: {}, move: null, route: null, antecedentText: null, ruling: null };
  const call = async (stage: StageId, questions: Record<string, Question>, state: Json) => {
    const result = await env.evaluate(stage, questions, state);
    records.push({ stage, questions, state, result });
    return result;
  };

  const shared = publicState(input);
  const spans = input.modules.decisions ? candidateSpans(input.latestInput) : [];
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

  // S and A are independent; run them side by side.
  const [speakerResult, aResult] = await Promise.all([
    input.modules.speaker && input.speakerQuestion ? call('speaker', { speaker: input.speakerQuestion }, shared) : Promise.resolve(null),
    Object.keys(aQuestions).length ? call('move', aQuestions, shared) : Promise.resolve(null),
  ]);
  if (speakerResult) out.speakerAnswer = speakerResult.answers.speaker ?? null;
  if (aResult) for (const [questionId, npcId] of reactionIds) if (aResult.answers[questionId]) out.reactionAnswers[npcId] = aResult.answers[questionId]!;
  if (!aResult || !aQuestions.move) return out;

  const selected = choiceOf(aResult.answers.move);
  if (!selected) throw new StagedError('move', `move selection returned no valid answer (${aResult.errors.move ?? 'missing'})`);
  if (selected === 'NONE' || selected === 'ROUTINE') return out;
  const span = spans.find(s => s.id === selected);
  if (!span) throw new StagedError('move', `move selection returned an unknown passage ${selected}`);
  const count = choiceOf(aResult.answers.move_count);
  out.move = { span, count: count === 'one' || count === 'multiple' ? count : null };

  // B: routing, on the selected passage.
  const npcIds = Object.keys(input.actors).filter(id => id !== input.playerId);
  const actorNames: Record<string, string> = { [input.playerId]: input.actors[input.playerId]?.name ?? input.playerId };
  for (const id of npcIds) actorNames[id] = input.actors[id]!.name;
  const antecedents = antecedentCandidates(input);
  const routeState = { ...(shared as Record<string, Json>), move: { passage: span.text } } as Json;
  const bResult = await call('route', routeQuestions({ actorNames, playerId: input.playerId, pack: input.pack, antecedents }), routeState);
  const route = deriveRoute({
    owner: choiceOf(bResult.answers.owner),
    target: choiceOf(bResult.answers.target),
    family: choiceOf(bResult.answers.family),
    specification: choiceOf(bResult.answers.action_specification),
    antecedent: choiceOf(bResult.answers.antecedent),
  }, { playerId: input.playerId, npcIds, pack: input.pack });
  out.route = route;
  out.antecedentText = route.antecedentId ? antecedents.find(a => a.id === route.antecedentId)?.text ?? null : null;
  if (route.route === 'UNRULED') { out.outcome = 'unruled'; return out; }
  if (route.route === 'HANDOFF') { out.outcome = 'handoff'; return out; }

  // D + E: admissible evidence, then one probability.
  const family = familyByKey(input.pack, route.familyKey!)!;
  const [meters, lore] = await Promise.all([
    input.meters ? input.meters() : Promise.resolve(undefined),
    input.lore ? input.lore() : Promise.resolve(undefined),
  ]);
  const projection = judgeProjection({
    pack: input.pack, family, playerId: input.playerId, ownerId: route.ownerId!, targetId: route.targetId,
    actors: input.actors, transcript: input.transcript, latestInput: input.latestInput, facts: input.facts,
    move: { passage: span.text, antecedent: out.antecedentText }, meters, lore, maxLoreChars: input.maxLoreChars, maxChars: input.maxChars,
  });
  const question = rulingQuestion({ family, pack: input.pack, hasAntecedent: out.antecedentText !== null });
  const eResult = await call('ruling', { ruling: question }, projection.state);
  const answer = eResult.answers.ruling;
  if (!answer || answer.type !== 'noul') throw new StagedError('ruling', `the ruling returned no valid probability (${eResult.errors.ruling ?? 'missing'})`);
  out.ruling = { answer, question, projection };
  out.outcome = 'ruled';
  return out;
}
