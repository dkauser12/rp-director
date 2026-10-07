/**
 * Evidence projection (staged stage D): what the ruling may see. Code decides
 * admissibility from the family's allowlist and the detection firewall; the
 * judge never chooses its own evidence.
 *
 * Firewall: a discovery family never sees character cards (authorial truth),
 * whatever its allowlist says. Every family sees only the visible transcript:
 * collapsed <details> blocks, which commonly hold private thoughts and
 * trackers, are removed.
 */
import type { Json } from '../types.ts';
import type { GenrePack, PackFamily } from '../pack/pack.ts';
import { visibleText } from './spans.ts';

export interface EvidenceActor {
  name: string;
  control: 'user' | 'npc';
  /** Authorial card text (description and personality). */
  card?: string;
}

export interface EvidenceInput {
  pack: GenrePack;
  family: PackFamily;
  playerId: string;
  ownerId: string;
  /** An actor id, SELF, SCENE, or null. */
  targetId: string | null;
  actors: Record<string, EvidenceActor>;
  transcript: { actorId: string; role: 'user' | 'assistant'; text: string }[];
  latestInput: string;
  move: { passage: string; antecedent: string | null };
  /** Judged meter levels by NPC id (label -> described level); read only by change families that allow meters. */
  meters?: Record<string, Record<string, string>>;
  /** Lore chosen by the lore stage, most relevant first. */
  lore?: LoreEvidence[];
  /** Total characters of lore text the ruling may see. */
  maxLoreChars?: number;
  maxChars: number;
}

export interface LoreEvidence {
  book: string;
  title: string;
  text: string;
  /** Declared public by the user: the only lore a discovery ruling may read. */
  public: boolean;
}

export const DEFAULT_MAX_LORE_CHARS = 12000;
const MAX_LORE_ENTRY_CHARS = 3000;

/** Admissible lore for a family, in order, within the character budget. */
export function admissibleLore(lore: LoreEvidence[], discovery: boolean, maxChars: number): { items: { book: string; title: string; text: string }[]; withheld: number; dropped: number } {
  let withheld = 0;
  let dropped = 0;
  let used = 0;
  const items: { book: string; title: string; text: string }[] = [];
  for (const item of lore) {
    if (discovery && !item.public) { withheld += 1; continue; }
    const visible = visibleText(item.text);
    const text = visible.length > MAX_LORE_ENTRY_CHARS ? `${visible.slice(0, MAX_LORE_ENTRY_CHARS - 1)}…` : visible;
    if (used + text.length > maxChars) { dropped += 1; continue; }
    used += text.length;
    items.push({ book: visibleText(item.book), title: visibleText(item.title), text });
  }
  return { items, withheld, dropped };
}

export interface Projection {
  state: Json;
  exclusions: string[];
  chars: number;
  overBudget: boolean;
}

function visibleValues(value: Json): Json {
  if (typeof value === 'string') return visibleText(value);
  if (Array.isArray(value)) return value.map(visibleValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visibleValues(item)]));
  return value;
}

export function judgeProjection(input: EvidenceInput): Projection {
  const exclusions: string[] = [];
  const discovery = input.family.kind === 'discovery';
  const allows = (source: string) => (input.family.evidence as string[]).includes(source);
  const cardFor = new Set<string>();
  if (!discovery) {
    if (allows('owner_card') && input.ownerId !== input.playerId && input.actors[input.ownerId]?.card) cardFor.add(input.ownerId);
    const target = input.targetId ?? '';
    if (allows('target_card') && target !== input.playerId && input.actors[target]?.card) cardFor.add(target);
  } else {
    exclusions.push('character cards withheld: discovery may use only what the scene has shown');
  }

  // Meters are inner feelings: only the characters involved in the move, never for discovery.
  const involved = [input.ownerId, input.targetId].filter((id): id is string => Boolean(id) && id !== input.playerId);
  const metersFor = new Set(!discovery && allows('meters') ? involved.filter(id => input.meters?.[id]) : []);
  const actors: Record<string, Json> = {};
  for (const [id, actor] of Object.entries(input.actors)) {
    const entry: Record<string, Json> = { name: visibleText(actor.name), control: actor.control };
    if (cardFor.has(id)) entry.authorialCharacterContext = visibleText(actor.card!);
    if (metersFor.has(id)) entry.judgedState = visibleValues(input.meters![id]!);
    actors[id] = entry;
  }
  const lore = allows('lore') && input.lore?.length
    ? admissibleLore(input.lore, discovery, Math.min(input.maxLoreChars ?? DEFAULT_MAX_LORE_CHARS, Math.floor(input.maxChars * 0.4)))
    : { items: [], withheld: 0, dropped: 0 };
  if (lore.withheld) exclusions.push(`${lore.withheld} private lore entr${lore.withheld === 1 ? 'y' : 'ies'} withheld: discovery reads only books declared public`);
  if (lore.dropped) exclusions.push(`${lore.dropped} lore entr${lore.dropped === 1 ? 'y' : 'ies'} dropped to fit the lore budget`);

  const actorRef = (id: string | null): Json => {
    if (!id) return null;
    if (id === 'SELF' || id === 'SEVERAL' || id === 'SCENE') return { id };
    return { id, name: visibleText(input.actors[id]?.name ?? id) };
  };

  const build = (messages: EvidenceInput['transcript']): Json => ({
    actors,
    playerActorId: input.playerId,
    move: {
      owner: actorRef(input.ownerId),
      target: actorRef(input.targetId),
      family: { key: input.family.key, label: input.family.label },
      passage: visibleText(input.move.passage),
      antecedent: input.move.antecedent === null ? null : visibleText(input.move.antecedent),
    },
    latestInput: visibleText(input.latestInput),
    ...(lore.items.length ? { lore: lore.items as Json } : {}),
    recentAcceptedMessages: messages.map(m => ({ actorId: m.actorId, role: m.role, text: visibleText(m.text) })),
  });

  let messages = input.transcript.slice();
  let state = build(messages);
  let chars = JSON.stringify(state).length;
  while (chars > input.maxChars && messages.length > 0) {
    messages = messages.slice(1);
    state = build(messages);
    chars = JSON.stringify(state).length;
  }
  const dropped = input.transcript.length - messages.length;
  if (dropped > 0) exclusions.push(`${dropped} oldest message${dropped === 1 ? '' : 's'} dropped to fit ${input.maxChars} characters`);
  return { state, exclusions, chars, overBudget: chars > input.maxChars };
}
