/**
 * The lore stage for one turn, host-independent. Public and private books are
 * walked in separate requests: a request that lists private entries may not
 * decide anything a discovery ruling reads (evidence rule 1 of the staged
 * plan), so discovery only ever sees picks made from public candidates alone.
 */
import type { Json, Question } from '../types.ts';
import type { LoreEvidence } from '../pipeline/evidence.ts';
import { visibleText } from '../pipeline/spans.ts';
import type { BeamSettings, LoreEvaluate, LoreRef, LoreStep } from './select.ts';
import { selectLore } from './select.ts';
import type { LoreTree } from './tree.ts';

export interface LoreBookInput {
  tree: LoreTree;
  public: boolean;
}

export interface LoreStageResult {
  /** The writer's picks: both partitions merged by score, capped at maxEntries. */
  refs: LoreRef[];
  steps: LoreStep[];
  requests: number;
  /** The ruling's picks: each partition capped on its own, so discovery sees public picks alone. */
  evidence: LoreEvidence[];
  /** Keep each partition's independent cap when reusing evidence next turn. */
  evidenceRefs: LoreRef[];
  cutShort: boolean;
  failedWorlds: string[];
  /** Existing picks kept their original selection scene instead of being selected again. */
  reused?: boolean;
}

export interface LoreContinuity {
  previous: { refs: LoreRef[]; evidenceRefs?: LoreRef[] };
  /** Asked only on the public scene; it must never contain private pick labels. */
  sceneQuestion: Question;
}

/** Rebuild frozen selection evidence from the loaded books without any judge call. */
export function reuseLorePicks(books: LoreBookInput[], previous: { refs: LoreRef[]; evidenceRefs?: LoreRef[] }): LoreStageResult {
  const trees = new Map(books.map(book => [book.tree.world, book]));
  const valid = (refs: LoreRef[]) => refs.filter(ref => trees.get(ref.world)?.tree.entries.has(ref.uid)).map(ref => ({ ...ref }));
  const refs = valid(previous.refs);
  const evidenceRefs = valid(previous.evidenceRefs ?? previous.refs);
  const evidence = evidenceRefs.map(ref => {
    const book = trees.get(ref.world)!;
    return { book: ref.world, title: ref.title, text: book.tree.entries.get(ref.uid)!.content, public: book.public };
  });
  return { refs, evidenceRefs, evidence, requests: 0, steps: [], cutShort: false, failedWorlds: [], reused: true };
}

export function loreSceneQuestion(): Question {
  return {
    type: 'choice',
    instructions: 'Compare state.previousScene (the scene where the current lore was originally selected) with the current public scene in state.latestInput and state.recentAcceptedMessages. Has the location, active cast, ongoing objective, or subject changed enough to need different background lore, including gradual changes since that original selection? Keep SAME for another beat of the same scene, rewording, ordinary dialogue, or out-of-character discussion. Choose CHANGED only when the public exchange establishes a material scene change. Never infer a change from hidden lore.',
    criteria: { SAME: 'The same scene continues; keep the previous lore picks.', CHANGED: 'The public scene materially changed; choose lore again.' },
  };
}

/** Messages of recent scene the lore stage reads. */
export const LORE_SCENE_MESSAGES = 8;

/** A bounded public anchor for next turn's continuity check, not another transcript copy. */
export function loreSceneAnchor(scene: Json): Json {
  const state = scene && typeof scene === 'object' && !Array.isArray(scene) ? scene : {};
  const clip = (value: Json | undefined, limit: number) => visibleText(typeof value === 'string' ? value : '').slice(-limit);
  const messages = Array.isArray(state.recentAcceptedMessages) ? state.recentAcceptedMessages.slice(-2) : [];
  return {
    latestInput: clip(state.latestInput, 1000),
    recentAcceptedMessages: messages.map(message => {
      const row = message && typeof message === 'object' && !Array.isArray(message) ? message : {};
      return { speaker: clip(row.speaker, 100), role: row.role === 'user' ? 'user' : 'assistant', text: clip(row.text, 1000) };
    }),
  };
}

/** The public scene the lore questions are asked about: names, the latest input, recent visible text. */
export function loreSceneState(transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[], latestInput: string, names: Record<string, string>, maxChars: number): Json {
  const build = (messages: typeof transcript): Json => ({
    latestInput: visibleText(latestInput),
    recentAcceptedMessages: messages.map(m => ({ speaker: visibleText(names[m.actorId] ?? m.actorId), role: m.role, text: visibleText(m.text) })),
  });
  let messages = transcript.slice(-LORE_SCENE_MESSAGES);
  let state = build(messages);
  while (JSON.stringify(state).length > maxChars && messages.length > 1) {
    messages = messages.slice(1);
    state = build(messages);
  }
  return state;
}

export async function runLoreStage(books: LoreBookInput[], evaluate: (partition: 'public' | 'private') => LoreEvaluate, beam: BeamSettings, continuity?: LoreContinuity): Promise<LoreStageResult> {
  const trees = new Map(books.map(b => [b.tree.world, b]));
  const validRefs = (refs: LoreRef[]) => refs.filter(ref => trees.get(ref.world)?.tree.entries.has(ref.uid));
  const evidenceFor = (refs: LoreRef[]): LoreEvidence[] => refs.map(ref => {
    const book = trees.get(ref.world)!;
    return { book: ref.world, title: ref.title, text: book.tree.entries.get(ref.uid)?.content ?? '', public: book.public };
  }).filter(item => item.text.trim().length > 0);
  let continuityRequests = 0;
  const continuitySteps: LoreStep[] = [];
  if (continuity) {
    const refs = validRefs(continuity.previous.refs).slice(0, beam.maxEntries);
    const evidenceRefs = validRefs(continuity.previous.evidenceRefs ?? continuity.previous.refs);
    // A removed/disabled pick needs a fresh walk; it cannot stay frozen forever.
    if (refs.length === Math.min(continuity.previous.refs.length, beam.maxEntries)) {
      let changed = false;
      let unavailable = false;
      continuityRequests = 1;
      try {
        const questions = { lore_scene: continuity.sceneQuestion };
        const result = await evaluate('public')(questions);
        continuitySteps.push({ depth: 0, questions, results: [result], frontiers: [] });
        const answer = result.answers?.lore_scene;
        unavailable = Boolean(result.errors?.lore_scene || result.unresolvedQuestionIds?.includes('lore_scene') || answer?.type !== 'choice' || !['SAME', 'CHANGED'].includes(answer.choice));
        changed = !unavailable && answer?.type === 'choice' && answer.choice === 'CHANGED';
      } catch { unavailable = true; }
      if (!changed) return { refs, evidenceRefs, evidence: evidenceFor(evidenceRefs), steps: continuitySteps, requests: 1, cutShort: false, failedWorlds: unavailable ? [...trees.keys()] : [], reused: true };
    }
  }
  const publicTrees = books.filter(b => b.public).map(b => b.tree);
  const privateTrees = books.filter(b => !b.public).map(b => b.tree);
  const empty = { refs: [], steps: [], requests: 0, cutShort: false, failedWorlds: [] as string[] };
  const [pub, priv] = await Promise.all([
    publicTrees.length ? selectLore(publicTrees, evaluate('public'), beam, { idPrefix: 'lore_public' }) : Promise.resolve(empty),
    privateTrees.length ? selectLore(privateTrees, evaluate('private'), beam, { idPrefix: 'lore' }) : Promise.resolve(empty),
  ]);
  const refs = [...pub.refs, ...priv.refs].sort((a, b) => b.score - a.score).slice(0, beam.maxEntries);
  const evidenceRefs = [...pub.refs, ...priv.refs].sort((a, b) => b.score - a.score);
  const evidence = evidenceFor(evidenceRefs);
  return { refs, evidenceRefs, steps: [...continuitySteps, ...pub.steps, ...priv.steps], requests: continuityRequests + pub.requests + priv.requests, evidence, cutShort: pub.cutShort || priv.cutShort, failedWorlds: [...pub.failedWorlds, ...priv.failedWorlds] };
}
