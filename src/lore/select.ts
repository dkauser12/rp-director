/**
 * Lore selection (staged stage C): a bounded beam down each lorebook's tree.
 *
 * One request per depth level; every open frontier (one per book or section)
 * is an independent Choice in that request. A Choice picks one option, but
 * Jev returns the whole distribution, so the beam keeps every option that is
 * clearly in the running (see `beamPicks`). Code decides everything else:
 * candidates, widths, budgets and ordering. The judge only ranks.
 *
 * Caveat kept from the plan: branch probability measures relevance, not
 * evidence strength.
 */
import type { Answer, EvaluationResult, Question } from '../types.ts';
import type { LoreEntry, LoreNode, LoreTree } from './tree.ts';
import { entriesUnder, excerpt } from './tree.ts';

export interface BeamSettings {
  /** Most options kept from one frontier. */
  width: number;
  /** An option below this probability is never kept. */
  minProbability: number;
  /** Most entries selected in total. */
  maxEntries: number;
  /** Most levels walked (requests made, at most). */
  maxDepth: number;
}

export const DEFAULT_BEAM: BeamSettings = { width: 3, minProbability: 0.15, maxEntries: 6, maxDepth: 4 };

/** The provider's per-request limit (the companion plugin allows 16). */
export const LORE_MAX_QUESTIONS = 16;
const OPTION_CHARS = 360;
/** Room for the titles of what a section holds, after its own label and summary. */
const CONTENTS_CHARS = 220;

/** Titles of the entries under a section: labels can mislead (a "Feet" entry filed under "Profile"), contents do not. */
function contents(node: LoreNode, entries: Map<number, LoreEntry> | undefined): string[] {
  const titles = entriesUnder(node).map(uid => entries?.get(uid)?.title ?? '').filter(Boolean);
  return [...new Set(titles)];
}

export interface LoreRef {
  world: string;
  uid: number;
  title: string;
  /** Product of the kept probabilities along the path. */
  score: number;
}

export interface FrontierRecord {
  questionId: string;
  world: string;
  nodeId: string;
  label: string;
  /** Option key -> node id. */
  options: Record<string, string>;
  picked: string[];
  /** Set when this section held nothing needed and a sibling was tried instead. */
  fellBackTo?: string;
  /** Set when the judge gave no valid answer for this frontier. */
  error?: string;
}

export interface LoreStep {
  depth: number;
  questions: Record<string, Question>;
  results: EvaluationResult[];
  frontiers: FrontierRecord[];
}

export interface LoreSelection {
  refs: LoreRef[];
  steps: LoreStep[];
  requests: number;
  /** True when the depth limit stopped the walk with sections still open. */
  cutShort: boolean;
  /** Books with a frontier the judge did not answer validly. */
  failedWorlds: string[];
}

export type LoreEvaluate = (questions: Record<string, Question>) => Promise<EvaluationResult>;

/**
 * The probability floor for one frontier: `minProbability`, lowered on wide
 * questions to twice the uniform share (with 26 options, 0.14 is a strong
 * signal, not noise).
 */
export function beamFloor(optionCount: number, minProbability: number): number {
  return Math.min(minProbability, 2 / (optionCount + 1));
}

/**
 * Keeps the options that are clearly in the running: at least the floor,
 * at least half the leader, and more likely than NONE; at most `width`. A
 * frontier whose most likely answer is NONE keeps nothing. Without a
 * distribution (non-Jev providers) the single choice is kept.
 */
export function beamPicks(answer: Answer | undefined, optionKeys: string[], beam: Pick<BeamSettings, 'width' | 'minProbability'>): { key: string; p: number }[] {
  if (!answer || answer.type !== 'choice') return [];
  const probabilities = answer.probabilities;
  if (!probabilities) return answer.choice !== 'NONE' && optionKeys.includes(answer.choice) ? [{ key: answer.choice, p: 1 }] : [];
  const pNone = probabilities.NONE ?? 0;
  const ranked = optionKeys.map(key => ({ key, p: probabilities[key] ?? 0 })).sort((a, b) => b.p - a.p);
  const leader = ranked[0];
  if (!leader || leader.p <= pNone) return [];
  const floor = beamFloor(optionKeys.length, beam.minProbability);
  return ranked.filter(o => o.p >= floor && o.p >= leader.p / 2 && o.p > pNone).slice(0, Math.max(1, beam.width));
}

export function frontierQuestion(world: string, node: LoreNode, isRoot: boolean, hasMove: boolean, entries?: Map<number, LoreEntry>): { question: Question; options: Record<string, string> } {
  const options: Record<string, string> = {};
  const criteria: Record<string, string> = {};
  node.children.forEach((child, index) => {
    const key = `n${index + 1}`;
    options[key] = child.id;
    const own = excerpt(child.summary ? `${child.label}: ${child.summary}` : child.label, OPTION_CHARS);
    const inside = child.children.length ? contents(child, entries) : [];
    criteria[key] = inside.length ? `${own} Includes: ${excerpt(inside.join('; '), CONTENTS_CHARS)}` : own;
  });
  criteria.NONE = isRoot ? `Nothing in the lorebook "${world}" is needed for the next reply.` : 'None of these parts is needed for the next reply.';
  const where = isRoot ? `the lorebook "${world}"` : `the section "${node.label}" of the lorebook "${world}"`;
  return {
    options,
    question: {
      type: 'choice',
      instructions: `The options are the parts of ${where}. Using the public scene in state (state.latestInput and state.recentAcceptedMessages${hasMove ? ', and the move being ruled in state.move' : ''}), choose the part the next reply most depends on to stay accurate: the people, places, objects, abilities, rules, history or relationships the scene is touching now${hasMove ? ' or the move relies on' : ''}. Choose NONE when no part is needed for this reply. Prefer what the scene is about now over background that is only loosely related.`,
      criteria,
    },
  };
}

/**
 * A section's untried alternatives. When every section picked from it turns
 * out to hold nothing the scene needs, the best alternative is tried once.
 */
interface Fallback { parent: Open; alternatives: { child: LoreNode; p: number }[]; pending: number; used: boolean }

interface Open { tree: LoreTree; node: LoreNode; score: number; fallback?: Fallback }

export interface SelectOptions {
  /** Mention the ruled move (state.move) in the question. */
  hasMove?: boolean;
  maxQuestions?: number;
  /** Question id prefix; separate walks in one turn need distinct prefixes. */
  idPrefix?: string;
}

export async function selectLore(trees: LoreTree[], evaluate: LoreEvaluate, beam: BeamSettings = DEFAULT_BEAM, options: SelectOptions = {}): Promise<LoreSelection> {
  const { hasMove = false, maxQuestions = LORE_MAX_QUESTIONS, idPrefix = 'lore' } = options;
  const steps: LoreStep[] = [];
  const leaves: Open[] = [];
  const failed = new Set<string>();
  let frontier: Open[] = trees.filter(t => t.root.children.length > 0).map(tree => ({ tree, node: tree.root, score: 1 }));
  let requests = 0;
  let depth = 0;
  while (frontier.length > 0 && depth < beam.maxDepth) {
    depth += 1;
    const records: FrontierRecord[] = [];
    const questions: Record<string, Question> = {};
    frontier.forEach((open, index) => {
      const built = frontierQuestion(open.tree.world, open.node, open.node === open.tree.root, hasMove, open.tree.entries);
      const questionId = `${idPrefix}_${depth}_${index + 1}`;
      questions[questionId] = built.question;
      records.push({ questionId, world: open.tree.world, nodeId: open.node.id, label: open.node.label, options: built.options, picked: [] });
    });
    // Independent questions, split to the provider's batch limit and sent together.
    const ids = Object.keys(questions);
    const batches: Record<string, Question>[] = [];
    for (let i = 0; i < ids.length; i += maxQuestions) batches.push(Object.fromEntries(ids.slice(i, i + maxQuestions).map(id => [id, questions[id]!])));
    requests += batches.length;
    const results = await Promise.all(batches.map(batch => evaluate(batch)));
    const answers: Record<string, Answer> = Object.assign({}, ...results.map(r => r.answers));
    const next: Open[] = [];
    const place = (item: Open) => { if (item.node.children.length > 0) next.push(item); else leaves.push(item); };
    const errors: Record<string, string> = Object.assign({}, ...results.map(r => r.errors));
    records.forEach((record, index) => {
      const open = frontier[index]!;
      const answer = answers[record.questionId];
      if (!answer || answer.type !== 'choice') {
        // Not an answer of "nothing": the book's picks are incomplete. No
        // fallback either, since nothing ranked the alternatives.
        record.error = errors[record.questionId] ?? 'no valid answer';
        failed.add(open.tree.world);
        return;
      }
      const picks = beamPicks(answer, Object.keys(record.options), beam);
      const childOf = (key: string) => open.node.children.find(c => c.id === record.options[key]);
      const picked = picks.map(pick => ({ child: childOf(pick.key), p: pick.p })).filter((x): x is { child: LoreNode; p: number } => Boolean(x.child));
      if (picked.length === 0) {
        // A dead end: once every section taken from the parent is empty, try its best alternative.
        const fallback = open.fallback;
        if (fallback && !fallback.used && --fallback.pending === 0 && fallback.alternatives.length > 0) {
          fallback.used = true;
          const alt = fallback.alternatives[0]!;
          record.fellBackTo = alt.child.id;
          place({ tree: open.tree, node: alt.child, score: fallback.parent.score * alt.p });
        }
        return;
      }
      const probabilities = answer?.type === 'choice' ? answer.probabilities : null;
      const sections = picked.filter(x => x.child.children.length > 0);
      const fallback: Fallback | undefined = probabilities && sections.length === picked.length ? {
        parent: open, pending: sections.length, used: false,
        alternatives: Object.keys(record.options)
          .filter(key => !picks.some(pick => pick.key === key))
          .map(key => ({ child: childOf(key), p: probabilities[key] ?? 0 }))
          .filter((x): x is { child: LoreNode; p: number } => Boolean(x.child) && x.p >= beamFloor(Object.keys(record.options).length, beam.minProbability) / 2 && x.p > (probabilities.NONE ?? 0))
          .sort((a, b) => b.p - a.p),
      } : undefined;
      for (const { child, p } of picked) {
        record.picked.push(child.id);
        place({ tree: open.tree, node: child, score: open.score * p, fallback });
      }
    });
    steps.push({ depth, questions, results, frontiers: records });
    frontier = next;
  }
  const refs: LoreRef[] = [];
  const seen = new Set<string>();
  for (const leaf of leaves.sort((a, b) => b.score - a.score)) {
    for (const uid of leaf.node.entryUids) {
      const key = `${leaf.tree.world}.${uid}`;
      if (seen.has(key) || refs.length >= beam.maxEntries) continue;
      const entry = leaf.tree.entries.get(uid);
      if (!entry) continue;
      seen.add(key);
      refs.push({ world: leaf.tree.world, uid, title: entry.title, score: leaf.score });
    }
  }
  return { refs, steps, requests, cutShort: frontier.length > 0, failedWorlds: [...failed] };
}
