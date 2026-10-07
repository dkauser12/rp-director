import type { DirectorSettings } from './types.ts';

export const DEFAULT_PACING_TEXTS: DirectorSettings['pacingTexts'] = {
  combat: 'Use short beats and one exchange; do not end the fight or skip time.',
  conversation: 'Answer with small actions and no time skips; start a major event only when the scene’s own systems call for it.',
  travel: 'Keep travel brief without skipping time, and stop at the first moment {{user}} must decide.',
  intimate: 'Stay in the moment without skipping ahead or ending the scene.',
  downtime: '',
};

export const REPLY_CHECK_FIELDS = [
  { key: 'speaksForUser', label: 'Writes for {{user}} (0–4)', max: 4, value: 2.85 },
  { key: 'followsRuling', label: 'Follows the ruling (0–1)', max: 1, value: 0.35 },
  { key: 'responds', label: 'Responds to {{user}} (0–2)', max: 2, value: 0.4 },
  { key: 'repeats', label: 'Repetition (0–4)', max: 4, value: 3 },
] as const;

/** Preserve text deliberately left blank and reject non-finite imported thresholds. */
export function normalizeUiPreferences(saved: Record<string, unknown> = {}): Pick<DirectorSettings, 'pacingTexts' | 'replyCheckThresholds' | 'handBackBeats'> {
  const texts = saved.pacingTexts as Partial<DirectorSettings['pacingTexts']> | null;
  const thresholds = saved.replyCheckThresholds as Partial<DirectorSettings['replyCheckThresholds']> | null;
  return {
    handBackBeats: typeof saved.handBackBeats === 'boolean' ? saved.handBackBeats : true,
    pacingTexts: Object.fromEntries(Object.entries(DEFAULT_PACING_TEXTS).map(([key, value]) => [key,
      texts && typeof texts[key as keyof typeof texts] === 'string' ? texts[key as keyof typeof texts] : value])) as DirectorSettings['pacingTexts'],
    replyCheckThresholds: Object.fromEntries(REPLY_CHECK_FIELDS.map(field => {
      const value = thresholds?.[field.key];
      return [field.key, typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(field.max, value)) : field.value];
    })) as DirectorSettings['replyCheckThresholds'],
  };
}
