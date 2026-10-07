/**
 * Character state (the Meters and Secrets modules), judged by the decision
 * model, never written by the writer. Each turn one private request asks, per
 * character and meter, which level fits now (at most one level from the last
 * judged level), and, per secret, whether the latest exchange revealed it to
 * anyone new. Code applies the answers; the writer only reads the result.
 * The request carries cards and secret text, so it never hosts a question
 * that feeds move selection, routing or a detection ruling.
 */
import type { Answer, Json, SecretRecord } from '../types.ts';
import type { GenrePack } from '../pack/pack.ts';
import { meterLabel } from '../pack/pack.ts';
import type { ChoiceQuestion } from './questions.ts';
import { visibleText } from './spans.ts';

export interface StateNpc { id: string; name: string }

export type StateIndexEntry =
  | { kind: 'meter'; npcId: string; npcName: string; key: string; levels: string[]; allowed: string[] }
  | { kind: 'reveal'; secretId: string; candidates: string[] };

export interface StateQuestionInput {
  pack: GenrePack;
  npcs: StateNpc[];
  levels: Record<string, Record<string, number>>;
  assessed: Record<string, Record<string, boolean> | boolean>;
  playerName: string;
  secrets: SecretRecord[];
  knownBy: Record<string, string[]>;
  /** Actor id -> name, including 'player'. */
  actorNames: Record<string, string>;
  maxQuestions: number;
}

/** Card text kept per character in the state request. */
export const STATE_CARD_CHARS = 3000;

const rank = (i: number, n: number) => `${i + 1} of ${n}`;

export function stateQuestions(input: StateQuestionInput): { questions: Record<string, ChoiceQuestion>; index: Record<string, StateIndexEntry> } {
  const questions: Record<string, ChoiceQuestion> = {};
  const index: Record<string, StateIndexEntry> = {};
  const room = () => Object.keys(questions).length < input.maxQuestions;
  input.npcs.forEach((npc, n) => {
    for (const meter of input.pack.meters) {
      if (!room()) return;
      const current = input.levels[npc.id]?.[meter.key] ?? meter.initial;
      const status = input.assessed[npc.id];
      const first = !(typeof status === 'boolean' ? status : status?.[meter.key]);
      const allowed = first ? meter.levels : meter.levels.filter((_, i) => Math.abs(i - current) <= 1);
      const label = meterLabel(meter, input.playerName);
      const scale = `Levels, lowest to highest: ${meter.levels.join(', ')}.`;
      const instructions = first
        ? `Judge ${npc.name}'s ${label}. ${meter.about} ${scale} No level has been judged yet. Using ${npc.name}'s character description in state.characters and the story so far in state.recentAcceptedMessages and state.latestInput, choose the level that fits ${npc.name} now.`
        : `Judge ${npc.name}'s ${label}. ${meter.about} ${scale} Before the latest exchange ${npc.name} was "${meter.levels[current]}". Keep the previous level unless something in the latest exchange (the last messages in state.recentAcceptedMessages and state.latestInput) would realistically move it for someone with ${npc.name}'s character (state.characters). Choose the level that fits ${npc.name} now.`;
      const id = `meter_${n + 1}_${meter.key}`;
      questions[id] = { type: 'choice', instructions, criteria: Object.fromEntries(allowed.map(level => [level, `${level} (${rank(meter.levels.indexOf(level), meter.levels.length)})`])) };
      index[id] = { kind: 'meter', npcId: npc.id, npcName: npc.name, key: meter.key, levels: [...meter.levels], allowed: [...allowed] };
    }
  });
  const present = ['player', ...input.npcs.map(n => n.id)];
  input.secrets.forEach((secret, s) => {
    if (!room()) return;
    const knowers = input.knownBy[secret.id] ?? secret.holders;
    const candidates = present.filter(id => !knowers.includes(id));
    if (!candidates.length) return;
    const names = (ids: string[]) => ids.map(id => input.actorNames[id] ?? id).join(', ') || 'no one yet';
    const criteria: Record<string, string> = { KEEP: 'No one new learned it.' };
    for (const id of candidates) criteria[id] = `${input.actorNames[id] ?? id} learned it.`;
    if (candidates.length > 1) criteria.EVERYONE = 'Everyone present learned it.';
    const id = `reveal_${s + 1}`;
    questions[id] = {
      type: 'choice',
      instructions: `The secret state.secrets["${secret.id}"] is known to ${names(knowers)}. Did the latest exchange (the last messages in state.recentAcceptedMessages and state.latestInput) reveal it to anyone else present? Count only what was actually said, shown or found in the scene; hints and suspicion are not learning it. Choose KEEP if no one new learned it.`,
      criteria,
    };
    index[id] = { kind: 'reveal', secretId: secret.id, candidates };
  });
  return { questions, index };
}

export interface StateEvidenceInput {
  transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[];
  latestInput: string;
  characters: { id: string; name: string; card?: string }[];
  secrets: SecretRecord[];
  playerName: string;
  maxChars: number;
}

export function stateEvidence(input: StateEvidenceInput): Json {
  const characters: Record<string, Json> = {};
  for (const c of input.characters) {
    const card = visibleText(String(c.card ?? ''));
    characters[c.id] = { name: visibleText(c.name), card: card.length > STATE_CARD_CHARS ? `${card.slice(0, STATE_CARD_CHARS)}…` : card };
  }
  const secrets: Record<string, Json> = {};
  for (const s of input.secrets) secrets[s.id] = { text: visibleText(s.text) };
  const build = (messages: StateEvidenceInput['transcript']): Json => ({
    playerName: visibleText(input.playerName),
    characters,
    secrets,
    latestInput: visibleText(input.latestInput),
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

/** Applies judged answers. A missing or out-of-bound answer keeps the previous value. */
export function applyStateAnswers(
  index: Record<string, StateIndexEntry>,
  answers: Record<string, Answer>,
  previousLevels: Record<string, Record<string, number>>,
  previousKnownBy: Record<string, string[]>,
  previousAssessed?: Record<string, Record<string, boolean>>,
): { meters: Record<string, Record<string, number>>; assessed: Record<string, Record<string, boolean>>; knownBy: Record<string, string[]>; changes: string[] } {
  const meters = structuredClone(previousLevels);
  const assessed = structuredClone(previousAssessed ?? Object.fromEntries(Object.entries(previousLevels).map(([npc, values]) => [npc, Object.fromEntries(Object.keys(values).map(key => [key, true]))])));
  const knownBy = structuredClone(previousKnownBy);
  const changes: string[] = [];
  for (const [id, entry] of Object.entries(index)) {
    const answer = answers[id];
    const chosen = answer?.type === 'choice' ? answer.choice : null;
    if (entry.kind === 'meter') {
      meters[entry.npcId] ??= {};
      const before = meters[entry.npcId]![entry.key];
      if (!chosen || !entry.allowed.includes(chosen)) continue;
      const after = entry.levels.indexOf(chosen);
      meters[entry.npcId]![entry.key] = after;
      (assessed[entry.npcId] ??= {})[entry.key] = true;
      if (before !== undefined && before !== after) changes.push(`${entry.npcName}: ${entry.key} ${entry.levels[before]} → ${chosen}`);
    } else {
      if (!chosen || chosen === 'KEEP') continue;
      const learners = chosen === 'EVERYONE' ? entry.candidates : entry.candidates.includes(chosen) ? [chosen] : [];
      if (!learners.length) continue;
      knownBy[entry.secretId] = [...new Set([...(knownBy[entry.secretId] ?? []), ...learners])];
      changes.push(`secret ${entry.secretId} now known to ${learners.join(', ')}`);
    }
  }
  return { meters, assessed, knownBy, changes };
}

export interface StateBlockInput {
  pack: GenrePack;
  levels: Record<string, Record<string, number>>;
  assessed?: Record<string, Record<string, boolean>>;
  names: Record<string, string>;
  playerName: string;
  secrets: SecretRecord[];
  knownBy: Record<string, string[]>;
  meters: boolean;
  secretsOn: boolean;
}

/** What the writer is told. Empty when there is nothing to say. */
export function stateBlock(input: StateBlockInput): string {
  const parts: string[] = [];
  const lines = input.meters ? Object.entries(input.levels).map(([npc, values]) => {
    const described = input.pack.meters.filter(m => Number.isInteger(values[m.key]) && (input.assessed === undefined || input.assessed[npc]?.[m.key] === true))
      .map(m => `${meterLabel(m, input.playerName)} ${m.levels[values[m.key]!]} (${rank(values[m.key]!, m.levels.length)})`);
    return described.length ? `${input.names[npc] ?? npc}: ${described.join('; ')}.` : '';
  }).filter(Boolean) : [];
  if (lines.length) parts.push(['[Director character state — judged from play]', ...lines, 'Play each character at these levels. They change only through what happens in the scene.'].join('\n'));
  const nameOf = (id: string) => (id === 'player' ? input.playerName : input.names[id] ?? id);
  const secretLines = input.secretsOn ? input.secrets.map(s => {
    const who = (input.knownBy[s.id] ?? s.holders).map(nameOf);
    return `- Known only to ${who.length ? who.join(' and ') : 'no one'}: ${s.text}`;
  }) : [];
  if (secretLines.length) parts.push(['[Director knowledge boundaries]', ...secretLines, 'Characters who do not know a secret must not act on it or show that they know it. Those who know it decide for themselves whether to use it.'].join('\n'));
  return parts.join('\n\n');
}

/** Meter values as evidence for a ruling (change families only). */
export function meterFacts(pack: GenrePack, levels: Record<string, Record<string, number>>, playerName: string, assessed?: Record<string, Record<string, boolean>>): Record<string, Record<string, string>> {
  const facts: Record<string, Record<string, string>> = {};
  for (const [npc, values] of Object.entries(levels)) {
    facts[npc] = {};
    for (const meter of pack.meters) {
      const value = values[meter.key];
      if (Number.isInteger(value) && (assessed === undefined || assessed[npc]?.[meter.key] === true)) facts[npc]![meterLabel(meter, playerName)] = `${meter.levels[value!]} (${rank(value!, meter.levels.length)})`;
    }
  }
  return facts;
}
