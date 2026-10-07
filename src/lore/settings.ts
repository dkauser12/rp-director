/** Lore settings: per-book modes, visibility and beam limits. Pure; never touches the host. */
import type { LoreBookMode, LoreBookSettings, LoreSettings } from '../types.ts';
import { DEFAULT_BEAM } from './select.ts';

export const LORE_MODES: readonly LoreBookMode[] = ['off', 'judge', 'assist', 'managed'];

export function defaultLoreSettings(): LoreSettings {
  return {
    books: {},
    defaultMode: 'assist',
    placeNearEnd: true,
    maxEntries: 5,
    width: DEFAULT_BEAM.width,
    minProbability: DEFAULT_BEAM.minProbability,
    maxDepth: DEFAULT_BEAM.maxDepth,
    judgeChars: 12000,
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const isMode = (value: unknown): value is LoreBookMode => typeof value === 'string' && (LORE_MODES as readonly string[]).includes(value);

function bounded(value: unknown, min: number, max: number, fallback: number, integer = true): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.round(clamped) : clamped;
}

/** Loads lore settings from untrusted storage; never throws. */
export function normalizeLoreSettings(raw: unknown): LoreSettings {
  const base = defaultLoreSettings();
  const saved = object(raw);
  if (!saved) return base;
  const books: Record<string, LoreBookSettings> = {};
  for (const [name, value] of Object.entries(object(saved.books) ?? {})) {
    const book = object(value);
    if (!book || !name.trim()) continue;
    books[name] = { mode: isMode(book.mode) ? book.mode : base.defaultMode, public: book.public === true };
  }
  return {
    books,
    defaultMode: isMode(saved.defaultMode) ? saved.defaultMode : base.defaultMode,
    placeNearEnd: saved.placeNearEnd !== false,
    maxEntries: bounded(saved.maxEntries, 1, 20, base.maxEntries),
    width: bounded(saved.width, 1, 6, base.width),
    minProbability: bounded(saved.minProbability, 0.01, 0.9, base.minProbability, false),
    maxDepth: bounded(saved.maxDepth, 1, 6, base.maxDepth),
    judgeChars: bounded(saved.judgeChars, 1000, 40000, base.judgeChars),
  };
}

export function bookSettings(settings: LoreSettings, world: string): LoreBookSettings {
  return settings.books[world] ?? { mode: settings.defaultMode, public: false };
}

/**
 * The mode the Director actually applies. When TunnelVision is switched on and
 * manages a book, TunnelVision already removes it from keyword scanning (and
 * with it the entries the Director would activate), so the Director only reads
 * that book for rulings.
 */
export function effectiveMode(settings: LoreSettings, world: string, tunnelVisionManages: boolean): LoreBookMode {
  const mode = bookSettings(settings, world).mode;
  if (tunnelVisionManages && (mode === 'assist' || mode === 'managed')) return 'judge';
  return mode;
}

/** What the writer's World Info scan should do for one generation. */
export interface LorePlan {
  /** Emit selected entries in-chat at depth 1 rather than their authored position. */
  nearEnd?: boolean;
  /** `${world}.${uid}` of entries to activate. */
  force: Set<string>;
  /** Books whose keyword activation is switched off (constant entries stay). */
  managed: Set<string>;
}

export function lorePlan(refs: { world: string; uid: number }[], modeOf: (world: string) => LoreBookMode, books: string[], failed: string[] = [], nearEnd = true): LorePlan {
  const force = new Set<string>();
  for (const ref of refs) {
    const mode = modeOf(ref.world);
    if (mode === 'assist' || mode === 'managed') force.add(`${ref.world}.${ref.uid}`);
  }
  // A book the judge could not walk keeps its keyword lore, even when managed.
  const managed = new Set(books.filter(world => modeOf(world) === 'managed' && !failed.includes(world)));
  return { force, managed, nearEnd };
}
