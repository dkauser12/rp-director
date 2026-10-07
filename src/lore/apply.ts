/**
 * Applies a lore plan to SillyTavern's freshly loaded World Info lists, inside
 * its WORLDINFO_ENTRIES_LOADED event (world-info.js getSortedEntries), before
 * the scan. Managed books lose their keyword-activated entries; constant and
 * chosen entries stay, because the scan only activates entries still in its
 * list. The chosen entries themselves are force-activated separately with
 * SillyTavern's processed copies (see Host.armLore).
 *
 * The lists are rebuilt by SillyTavern on every load, so removing from them
 * never touches the cached books. Returns how many entries were removed.
 */
import type { LorePlan } from './settings.ts';

interface LoadedEntry { world?: unknown; uid?: unknown; constant?: unknown }

/** Change only the processed entry copy used by this prompt, never its book. */
export function placeLorePick<T extends { position?: unknown; depth?: unknown }>(entry: T, nearEnd = true): T {
  // SillyTavern world_info_position.atDepth is 4; depth 1 keeps the prefix stable.
  return nearEnd ? { ...entry, position: 4, depth: 1 } : { ...entry };
}

export function applyLorePlan(lists: unknown[], plan: LorePlan): number {
  let removed = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i] as LoadedEntry | null;
      if (!entry || typeof entry !== 'object') continue;
      if (plan.force.has(`${String(entry.world)}.${String(entry.uid)}`)) continue;
      if (plan.managed.has(String(entry.world)) && entry.constant !== true) { list.splice(i, 1); removed += 1; }
    }
  }
  return removed;
}

/** What one real World Info scan put into the prompt, per book. */
export interface LoreActivation {
  at: number;
  books: Record<string, { entries: number; chars: number; picked: number }>;
}

/**
 * Summarises SillyTavern's WORLD_INFO_ACTIVATED payload (every entry the scan
 * activated, keyword and forced alike) so the lore panel can show what each
 * book costs a reply. `picked` counts the Director's own forced entries.
 */
export function summarizeActivation(entries: unknown[], forced: Set<string> | null, at = Date.now()): LoreActivation {
  const books: LoreActivation['books'] = {};
  for (const raw of entries) {
    const entry = raw as { world?: unknown; uid?: unknown; content?: unknown } | null;
    if (!entry || typeof entry !== 'object' || typeof entry.world !== 'string') continue;
    const book = books[entry.world] ??= { entries: 0, chars: 0, picked: 0 };
    book.entries += 1;
    book.chars += typeof entry.content === 'string' ? entry.content.length : 0;
    if (forced?.has(`${entry.world}.${String(entry.uid)}`)) book.picked += 1;
  }
  return { at, books };
}
