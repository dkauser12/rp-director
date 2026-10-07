/**
 * Per-chat story state: the chat's genre pack, its secrets, and the character
 * state the judge assessed along the transcript. Snapshots are keyed by the
 * transcript cursor they were judged at, so swipes reuse them and branches
 * fall back to the nearest earlier snapshot on their own path. Pure functions.
 */
import type { LoreSelectionRecord, SecretRecord, StorySnapshot, StoryState } from './types.ts';
import type { GenrePack } from './pack/pack.ts';

/** Distinct judged snapshots kept per chat; wording aliases do not consume this limit. */
export const HISTORY_LIMIT = 400;

export function emptyStory(): StoryState {
  return { packId: 'auto', packSource: 'auto', secrets: [], history: {}, lore: {} };
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === 'string');

function normalizeSecret(raw: unknown): SecretRecord | null {
  const s = raw as Partial<SecretRecord> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || typeof s.text !== 'string' || !isStrings(s.holders)) return null;
  return { id: s.id, text: s.text, holders: [...s.holders] };
}

function normalizeSnapshot(raw: unknown): StorySnapshot | null {
  const s = raw as Partial<StorySnapshot> | null;
  if (!s || typeof s !== 'object' || typeof s.at !== 'number') return null;
  const meters: StorySnapshot['meters'] = {};
  for (const [npc, values] of Object.entries(s.meters && typeof s.meters === 'object' ? s.meters : {})) {
    if (!values || typeof values !== 'object') continue;
    meters[npc] = Object.fromEntries(Object.entries(values).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0)) as Record<string, number>;
  }
  const knownBy: StorySnapshot['knownBy'] = {};
  for (const [id, who] of Object.entries(s.knownBy && typeof s.knownBy === 'object' ? s.knownBy : {})) if (isStrings(who)) knownBy[id] = [...who];
  const assessed: NonNullable<StorySnapshot['assessed']> = {};
  if (s.assessed && typeof s.assessed === 'object' && !Array.isArray(s.assessed)) {
    for (const [npc, values] of Object.entries(s.assessed)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      assessed[npc] = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === 'boolean'));
    }
  }
  return { at: s.at, meters, knownBy, ...(s.assessed === undefined ? {} : { assessed }) };
}

/** Loads story state from untrusted metadata; never throws. */
export function normalizeStory(raw: unknown): StoryState {
  const base = emptyStory();
  const r = raw as Partial<StoryState> | null;
  if (!r || typeof r !== 'object') return base;
  const history: StoryState['history'] = {};
  if (r.history && typeof r.history === 'object' && !Array.isArray(r.history)) {
    for (const [cursor, snap] of Object.entries(r.history)) {
      const normalized = normalizeSnapshot(snap);
      if (normalized) history[cursor] = normalized;
    }
  }
  return {
    packId: typeof r.packId === 'string' && r.packId ? r.packId : base.packId,
    packSource: r.packSource === 'judge' || r.packSource === 'user' || r.packSource === 'auto' ? r.packSource : base.packSource,
    secrets: Array.isArray(r.secrets) ? r.secrets.map(normalizeSecret).filter((s): s is SecretRecord => s !== null) : [],
    history,
    ...(r.historyAliases && typeof r.historyAliases === 'object' && !Array.isArray(r.historyAliases)
      ? { historyAliases: Object.fromEntries(Object.entries(r.historyAliases).filter(([cursor, target]) => typeof target === 'string' && cursor !== target && !history[cursor] && Boolean(history[target]))) }
      : {}),
    lore: normalizeLoreHistory(r.lore),
  };
}

function normalizeLoreHistory(raw: unknown): Record<string, LoreSelectionRecord> {
  const out: Record<string, LoreSelectionRecord> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cursor, value] of Object.entries(raw)) {
    const r = value as Partial<LoreSelectionRecord> | null;
    if (!r || typeof r !== 'object' || typeof r.at !== 'number' || !Array.isArray(r.refs)) continue;
    const refs = r.refs.filter(ref => ref && typeof ref.world === 'string' && Number.isInteger(ref.uid))
      .map(ref => ({ world: ref.world, uid: ref.uid, title: typeof ref.title === 'string' ? ref.title : '', score: typeof ref.score === 'number' ? ref.score : 0 }));
    const books = Array.isArray(r.books) ? r.books.filter((b): b is string => typeof b === 'string') : [...new Set(refs.map(ref => ref.world))];
    const failed = Array.isArray(r.failed) ? r.failed.filter((b): b is string => typeof b === 'string') : [];
    const evidenceRefs = Array.isArray(r.evidenceRefs) ? r.evidenceRefs.filter(ref => ref && typeof ref.world === 'string' && Number.isInteger(ref.uid))
      .map(ref => ({ world: ref.world, uid: ref.uid, title: typeof ref.title === 'string' ? ref.title : '', score: typeof ref.score === 'number' ? ref.score : 0 })) : undefined;
    out[cursor] = { at: r.at, refs, requests: typeof r.requests === 'number' ? r.requests : 0, books, failed,
      ...(evidenceRefs ? { evidenceRefs } : {}), ...(r.scene === undefined ? {} : { scene: structuredClone(r.scene) }),
      ...(typeof r.configuration === 'string' ? { configuration: r.configuration } : {}) };
  }
  return out;
}

/**
 * The nearest lore choice within the last `lookback` cursors of a chain. For
 * display only: writing binds lore through the attempt's own loreCursor.
 */
export function loreAt(story: StoryState, chain: string[], lookback = 3): LoreSelectionRecord | null {
  for (let i = chain.length - 1; i >= Math.max(0, chain.length - lookback); i--) {
    const found = story.lore[chain[i]!];
    if (found) return found;
  }
  return null;
}

export function withLore(story: StoryState, cursor: string, record: LoreSelectionRecord): StoryState {
  const lore = { ...story.lore, [cursor]: record };
  const keys = Object.keys(lore);
  if (keys.length > HISTORY_LIMIT) {
    for (const key of keys.sort((a, b) => lore[a]!.at - lore[b]!.at).slice(0, keys.length - HISTORY_LIMIT)) delete lore[key];
  }
  return { ...story, lore };
}

/** The snapshot that applies at the end of this cursor chain: the nearest earlier one. */
export function snapshotAt(story: StoryState, chain: string[]): StorySnapshot | null {
  for (let i = chain.length - 1; i >= 0; i--) {
    const cursor = chain[i]!;
    const snap = story.history[cursor] ?? story.history[story.historyAliases?.[cursor] ?? ''];
    if (snap) return snap;
  }
  return null;
}

/** Current meter levels for these NPCs; unjudged meters start at their pack's initial level. */
export function levelsAt(story: StoryState, chain: string[], pack: GenrePack, npcIds: string[]): { levels: Record<string, Record<string, number>>; assessed: Record<string, Record<string, boolean>> } {
  const snap = snapshotAt(story, chain);
  const levels: Record<string, Record<string, number>> = {};
  const assessed: Record<string, Record<string, boolean>> = {};
  for (const npc of npcIds) {
    const saved = snap?.meters[npc];
    assessed[npc] = {};
    levels[npc] = {};
    for (const meter of pack.meters) {
      const value = saved?.[meter.key];
      assessed[npc]![meter.key] = Number.isInteger(value) && value! < meter.levels.length && (snap?.assessed === undefined || snap.assessed[npc]?.[meter.key] === true);
      levels[npc]![meter.key] = Number.isInteger(value) && value! < meter.levels.length ? value! : meter.initial;
    }
  }
  return { levels, assessed };
}

/** Who knows each secret now: its holders plus anyone it was revealed to on this branch. */
export function knownByAt(story: StoryState, chain: string[]): Record<string, string[]> {
  const snap = snapshotAt(story, chain);
  const known: Record<string, string[]> = {};
  for (const secret of story.secrets) known[secret.id] = [...new Set([...secret.holders, ...(snap?.knownBy[secret.id] ?? [])])];
  return known;
}

export function withSnapshot(story: StoryState, cursor: string, snapshot: StorySnapshot): StoryState {
  const history = { ...story.history };
  const historyAliases = { ...story.historyAliases };
  // If a cursor is replaced, its existing aliases still refer to the old frozen
  // value. Promote one alias before overwriting the canonical snapshot.
  const followers = Object.keys(historyAliases).filter(key => historyAliases[key] === cursor);
  if (history[cursor] && followers.length && JSON.stringify(history[cursor]) !== JSON.stringify(snapshot)) {
    const promoted = followers[0]!;
    history[promoted] = history[cursor]!;
    delete historyAliases[promoted];
    for (const key of followers.slice(1)) historyAliases[key] = promoted;
  }
  delete historyAliases[cursor];
  const serialized = JSON.stringify(snapshot);
  const shared = Object.keys(history).find(key => key !== cursor && JSON.stringify(history[key]) === serialized);
  if (shared) {
    delete history[cursor];
    historyAliases[cursor] = shared;
    for (const key of followers) if (historyAliases[key] === cursor) historyAliases[key] = shared;
  } else history[cursor] = snapshot;
  const keys = Object.keys(history);
  if (keys.length > HISTORY_LIMIT) {
    for (const key of keys.sort((a, b) => history[a]!.at - history[b]!.at).slice(0, keys.length - HISTORY_LIMIT)) delete history[key];
  }
  for (const [key, target] of Object.entries(historyAliases)) if (!history[target]) delete historyAliases[key];
  return { ...story, history, ...(Object.keys(historyAliases).length || story.historyAliases ? { historyAliases } : {}) };
}
