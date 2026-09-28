/**
 * The lore stage for one turn, host-independent. Public and private books are
 * walked in separate requests: a request that lists private entries may not
 * decide anything a discovery ruling reads (evidence rule 1 of the staged
 * plan), so discovery only ever sees picks made from public candidates alone.
 */
import type { Json } from '../types.ts';
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
  cutShort: boolean;
  failedWorlds: string[];
}

/** Messages of recent scene the lore stage reads. */
export const LORE_SCENE_MESSAGES = 8;

/** The public scene the lore questions are asked about: names, the latest input, recent visible text. */
export function loreSceneState(transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[], latestInput: string, names: Record<string, string>, maxChars: number): Json {
  const build = (messages: typeof transcript): Json => ({
    latestInput,
    recentAcceptedMessages: messages.map(m => ({ speaker: names[m.actorId] ?? m.actorId, role: m.role, text: visibleText(m.text) })),
  });
  let messages = transcript.slice(-LORE_SCENE_MESSAGES);
  let state = build(messages);
  while (JSON.stringify(state).length > maxChars && messages.length > 1) {
    messages = messages.slice(1);
    state = build(messages);
  }
  return state;
}

export async function runLoreStage(books: LoreBookInput[], evaluate: (partition: 'public' | 'private') => LoreEvaluate, beam: BeamSettings): Promise<LoreStageResult> {
  const publicTrees = books.filter(b => b.public).map(b => b.tree);
  const privateTrees = books.filter(b => !b.public).map(b => b.tree);
  const empty = { refs: [], steps: [], requests: 0, cutShort: false, failedWorlds: [] as string[] };
  const [pub, priv] = await Promise.all([
    publicTrees.length ? selectLore(publicTrees, evaluate('public'), beam, { idPrefix: 'lore_public' }) : Promise.resolve(empty),
    privateTrees.length ? selectLore(privateTrees, evaluate('private'), beam, { idPrefix: 'lore' }) : Promise.resolve(empty),
  ]);
  const refs = [...pub.refs, ...priv.refs].sort((a, b) => b.score - a.score).slice(0, beam.maxEntries);
  const trees = new Map(books.map(b => [b.tree.world, b]));
  const evidence: LoreEvidence[] = [...pub.refs, ...priv.refs].sort((a, b) => b.score - a.score).map(ref => {
    const book = trees.get(ref.world)!;
    return { book: ref.world, title: ref.title, text: book.tree.entries.get(ref.uid)?.content ?? '', public: book.public };
  }).filter(item => item.text.trim().length > 0);
  return { refs, steps: [...pub.steps, ...priv.steps], requests: pub.requests + priv.requests, evidence, cutShort: pub.cutShort || priv.cutShort, failedWorlds: [...pub.failedWorlds, ...priv.failedWorlds] };
}
