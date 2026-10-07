import type { HostChatMessage } from './host.ts';
import type { InspectorEntry, RequestUsage } from './types.ts';
import type { WorkflowBadge } from './workflow-badge.ts';
import { mergeRequestUsage } from './usage.ts';

export interface ActivityTurn {
  messageId: number;
  swipeId: number;
  badge: WorkflowBadge | null;
  entries: InspectorEntry[];
}

/** Badge copies keep the individual receipts available after inspector history is trimmed. */
export function activityUsage(turn: Pick<ActivityTurn, 'badge' | 'entries'>): RequestUsage[] {
  return mergeRequestUsage(turn.badge?.requestUsage, ...turn.entries.map(entry => entry.requestUsage));
}

/** Selected swipes are the visible history; an alternative never becomes a second turn. */
export function activityTurns(chat: readonly HostChatMessage[], readBadge: (id: number) => WorkflowBadge | null, entries: readonly InspectorEntry[]): ActivityTurn[] {
  const messageIds: number[] = [];
  for (let id = chat.length - 1; id >= 0 && messageIds.length < 20; id--) {
    const message = chat[id]!;
    if (!message.is_user && !message.is_system && message.mes?.trim()) messageIds.push(id);
  }
  return messageIds.reverse().map(messageId => {
    const message = chat[messageId]!;
    const badge = readBadge(messageId);
    return { messageId, swipeId: message.swipe_id ?? 0, badge,
      entries: badge ? entries.filter(entry => entry.attemptId === badge.attemptId) : [] };
  });
}

export function activityMetrics(entries: readonly InspectorEntry[]): { requests: number | null; durationMs: number | null } {
  const durations = entries.flatMap(entry => entry.durationMs === null ? [] : [entry.durationMs]);
  return { requests: entries.length ? entries.reduce((total, entry) => total + entry.networkCalls, 0) : null,
    durationMs: durations.length ? durations.reduce((total, duration) => total + duration, 0) : null };
}

/** Display-only substitution; saved sentences and writer instructions remain untouched. */
export function playerUiText(text: string, playerName?: string): string {
  if (!playerName?.trim() || playerName === '{{user}}') return text;
  const escaped = playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`, 'gu'), '{{user}}');
}
