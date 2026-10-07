/** Index-based cursor migration. An edit changes prose, never a frozen decision. */
import { cursorChain, extendCursor } from './identity.ts';
import type { FingerprintMessage } from './identity.ts';
import { stripResultFooter } from './result-footer.ts';
import { snapshotAt } from './story.ts';
import type { DirectorChatRecord, GenerationAttempt, StorySnapshot } from './types.ts';

interface CursorMessage {
  mes?: string;
  is_user?: boolean;
  is_system?: boolean;
  swipe_id?: number;
  swipes?: string[];
  extra?: Record<string, unknown>;
  swipe_info?: { extra?: Record<string, unknown> }[];
}

function marker(extra: Record<string, unknown> | undefined): string | null {
  const value = extra?.rpd as { v?: unknown } | undefined;
  return typeof value?.v === 'string' ? value.v : null;
}

/**
 * Recover saved chain anchors for records written before transcriptCursors was
 * introduced. Host indexes are used only during this explicit edit/load repair.
 */
function savedChain(record: DirectorChatRecord, current: string[], messages: CursorMessage[]): string[] {
  if (record.transcriptCursors?.length === current.length) return [...record.transcriptCursors];
  const saved = [...current];
  for (const attempt of Object.values(record.attempts)) {
    const index = attempt.hostMessageRef;
    if (index === null || !messages[index] || index < 0) continue;
    const selected = marker(messages[index]!.extra);
    if (selected && attempt.variantId !== selected) continue;
    const variant = attempt.variantId ? record.variants[attempt.variantId] : null;
    if (attempt.cursorBefore) saved[inputIndex(messages, index, attempt) + (attempt.turnKind === 'director_next' ? 0 : 1)] = attempt.cursorBefore;
    if (variant?.cursorAfter) saved[index + 1] = variant.cursorAfter;
  }
  return saved;
}

function inputIndex(messages: CursorMessage[], replyIndex: number, attempt: GenerationAttempt): number {
  if (attempt.turnKind === 'director_next') return replyIndex;
  let toolSuffix = false;
  for (let i = replyIndex - 1; i >= 0; i--) {
    if (messages[i]?.is_system || Array.isArray(messages[i]?.extra?.tool_invocations)) { toolSuffix = true; continue; }
    if (messages[i]?.is_user && !messages[i]?.is_system) return i;
    // 0.7 Next has no explicit turnKind; its immediately preceding ordinary
    // reply is its input. Tool intermediary prose is part of the user's turn.
    if (attempt.turnKind === undefined && !toolSuffix) return replyIndex;
  }
  return replyIndex;
}

/** 0.7.1 stored turn N's judged state before user N, rather than after reply N. */
function migrateLegacyStory(record: DirectorChatRecord, oldChain: string[], messages: CursorMessage[]): void {
  if (!record.legacyStoryLayout) return;
  const oldStory = structuredClone(record.story);
  const moves = new Map<string, string[]>();
  for (const attempt of Object.values(record.attempts)) {
    const index = attempt.hostMessageRef;
    const variant = attempt.variantId ? record.variants[attempt.variantId] : null;
    if (index === null || !messages[index] || !variant?.cursorAfter || attempt.storyAfter !== undefined) continue;
    const beforeInput = inputIndex(messages, index, attempt);
    const key = oldChain[beforeInput];
    if (!key) continue;
    const after = oldStory.history[key] ?? oldStory.history[oldStory.historyAliases?.[key] ?? ''];
    if (!after) continue;
    attempt.storyBefore = structuredClone(snapshotAt(oldStory, oldChain.slice(0, beforeInput)));
    attempt.storyAfter = structuredClone(after);
    moves.set(key, [...(moves.get(key) ?? []), variant.cursorAfter]);
  }
  const history: Record<string, StorySnapshot> = {};
  for (const [key, snapshot] of Object.entries(oldStory.history)) {
    const targets = moves.get(key);
    if (targets) for (const target of targets) history[target] = structuredClone(snapshot);
    else history[key] = snapshot;
  }
  record.story.history = history;
  // Legacy builds did not have aliases, but tolerate imported records with them.
  if (oldStory.historyAliases) {
    record.story.historyAliases = Object.fromEntries(Object.entries(oldStory.historyAliases)
      .flatMap(([key, target]) => (moves.get(key) ?? [key]).map(next => [next, moves.get(target)?.[0] ?? target])));
  }
  delete record.legacyStoryLayout;
}

/**
 * Rebase every downstream saved identity once on MESSAGE_EDITED, and recover an
 * edit made outside the extension on load. Unselected swipes get their own hash
 * under the new parent, so their distinct frozen snapshots never collapse.
 */
export function rebaseRecordCursors(input: DirectorChatRecord, messages: CursorMessage[], fingerprints: FingerprintMessage[], edited = false): DirectorChatRecord {
  const record = structuredClone(input);
  const chain = cursorChain(record.seedId, fingerprints);
  const prior = savedChain(record, chain, messages);
  migrateLegacyStory(record, prior, messages);
  const firstChanged = prior.findIndex((cursor, index) => cursor !== chain[index]) - 1;
  const changedMarker = firstChanged >= 0 ? marker(messages[firstChanged]?.extra) : null;
  const selectedKnownSwipe = changedMarker && record.variants[changedMarker]?.cursorAfter === chain[firstChanged + 1];
  const mismatch = (firstChanged >= 0 && !selectedKnownSwipe) || messages.some((message, index) => {
    const id = marker(message.extra);
    const variant = id ? record.variants[id] : null;
    return variant?.cursorAfter && variant.cursorAfter !== chain[index + 1];
  });
  if (!edited && !mismatch) {
    record.transcriptCursors = chain;
    return record;
  }
  const replacements = new Map<string, string>();
  for (let i = 0; i < Math.min(prior.length, chain.length); i++) if (prior[i] !== chain[i]) replacements.set(prior[i]!, chain[i]!);
  for (const attempt of Object.values(record.attempts)) {
    const index = attempt.hostMessageRef;
    if (index === null || !messages[index] || !fingerprints[index]) continue;
    const variant = attempt.variantId ? record.variants[attempt.variantId] : null;
    const userIndex = inputIndex(messages, index, attempt);
    const boundIndex = userIndex + (attempt.turnKind === 'director_next' || userIndex === index ? 0 : 1);
    if (attempt.cursorBefore) replacements.set(attempt.cursorBefore, chain[boundIndex]!);
    const resolution = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
    if (resolution?.snapshot.cursorBefore) replacements.set(resolution.snapshot.cursorBefore, chain[userIndex]!);
    if (attempt.loreCursor) replacements.set(attempt.loreCursor, chain[userIndex]!);
    if (!variant?.cursorAfter) continue;
    const swipe = attempt.hostVariantRef;
    const text = swipe === null ? undefined : messages[index]!.swipes?.[swipe];
    const after = text === undefined ? chain[index + 1]! : extendCursor(chain[index]!, { ...fingerprints[index]!, text: stripResultFooter(text) });
    replacements.set(variant.cursorAfter, after);
    // Complete legacy attempts freeze their original snapshot during migration;
    // older 0.8 attempts can recover it from their own saved reply cursor.
    if (attempt.storyAfter === undefined) {
      const saved = snapshotAt(record.story, [variant.cursorAfter]);
      if (saved) attempt.storyAfter = structuredClone(saved);
    }
  }
  const cursor = (value: string | null | undefined) => value ? replacements.get(value) ?? value : value;
  for (const attempt of Object.values(record.attempts)) {
    attempt.cursorBefore = cursor(attempt.cursorBefore) ?? null;
    if (attempt.loreCursor) attempt.loreCursor = cursor(attempt.loreCursor);
  }
  for (const variant of Object.values(record.variants)) {
    variant.cursorBefore = cursor(variant.cursorBefore) ?? null;
    variant.cursorAfter = cursor(variant.cursorAfter) ?? null;
  }
  for (const resolution of Object.values(record.resolutions)) {
    resolution.cursorBefore = cursor(resolution.cursorBefore) ?? null;
    resolution.snapshot.cursorBefore = cursor(resolution.snapshot.cursorBefore) ?? '';
  }
  for (const permit of Object.values(record.permits)) {
    permit.baseCursor = cursor(permit.baseCursor)!;
    if (permit.snapshot) permit.snapshot.cursorBefore = cursor(permit.snapshot.cursorBefore) ?? '';
  }
  const rekey = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(values).map(([key, value]) => [cursor(key)!, value]));
  record.story.history = rekey(record.story.history);
  record.story.lore = rekey(record.story.lore);
  if (record.story.historyAliases) record.story.historyAliases = Object.fromEntries(Object.entries(record.story.historyAliases).map(([key, target]) => [cursor(key)!, cursor(target)!]));
  if (record.replyCheckRerolls) record.replyCheckRerolls = [...new Set(record.replyCheckRerolls.map(key => cursor(key)!))];
  record.transcriptCursors = chain;
  return record;
}
