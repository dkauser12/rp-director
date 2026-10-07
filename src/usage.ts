import type { EvaluationResult, RequestUsage } from './types.ts';

export function reportedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function requestUsage(result: EvaluationResult, stage: string): RequestUsage {
  return { requestId: result.requestId, stage, costUsd: reportedNumber(result.costUsd),
    inputTokens: reportedNumber(result.inputTokens), outputTokens: reportedNumber(result.outputTokens),
    durationMs: reportedNumber(result.durationMs) };
}

export function failedRequestUsage(requestId: string, stage: string, durationMs: number): RequestUsage {
  return { requestId, stage, costUsd: null, inputTokens: null, outputTokens: null, durationMs: reportedNumber(durationMs) };
}

export function isRequestUsage(value: unknown): value is RequestUsage {
  if (!value || typeof value !== 'object') return false;
  const item = value as RequestUsage;
  return typeof item.requestId === 'string' && typeof item.stage === 'string'
    && [item.costUsd, item.inputTokens, item.outputTokens, item.durationMs].every(number => number === null || reportedNumber(number) !== null);
}

/** Reused answers and cloned wording badges cannot charge the same request twice. */
export function mergeRequestUsage(...groups: readonly (readonly RequestUsage[] | undefined)[]): RequestUsage[] {
  const unique = new Map<string, RequestUsage>();
  for (const group of groups) for (const item of group ?? []) if (isRequestUsage(item)) unique.set(item.requestId, { ...item });
  return [...unique.values()];
}

export function summarizeUsage(records: readonly RequestUsage[]) {
  const unique = mergeRequestUsage(records);
  const sum = (key: 'costUsd' | 'inputTokens' | 'outputTokens' | 'durationMs') => {
    const known = unique.flatMap(item => item[key] === null ? [] : [item[key]]);
    return known.length ? known.reduce((total, number) => total + number, 0) : null;
  };
  return { requests: unique.length, costUsd: sum('costUsd'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    durationMs: sum('durationMs'), unreportedCostRequests: unique.filter(item => item.costUsd === null).length };
}

export function costLabel(costUsd: number | null, unreportedRequests = 0): string {
  if (costUsd === null) return 'cost not reported';
  const amount = costUsd > 0 && costUsd < 0.00005 ? '$<0.0001' : `$${costUsd.toFixed(4)}`;
  return unreportedRequests ? `${amount} reported · ${unreportedRequests} cost${unreportedRequests === 1 ? '' : 's'} not reported` : amount;
}

export function usageLabel(records: readonly RequestUsage[], fallbackRequests: number | null = null): string {
  const totals = summarizeUsage(records);
  const requests = Math.max(totals.requests, fallbackRequests ?? 0);
  return `Requests: ${requests || (fallbackRequests === 0 ? 0 : 'not recorded')} · ${costLabel(totals.costUsd, totals.unreportedCostRequests + requests - totals.requests)} · Tokens in/out: ${totals.inputTokens ?? 'not reported'}/${totals.outputTokens ?? 'not reported'}`;
}
