import { visibleText } from './pipeline/spans.ts';

/** A turn-wide deadline also bounds adapters that ignore AbortSignal. */
export class JudgeWaitBudget extends Error {
  readonly code = 'timeout';
  constructor() { super('The judge wait budget expired'); }
}

export function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    // Always attach both handlers, even if already cancelled: a late adapter
    // rejection must never become an unhandled promise rejection.
    work.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Last defense for question prose as well as evidence values. IDs stay stable. */
export function visibleJudgeData<T>(value: T): T {
  if (typeof value === 'string') return visibleText(value) as T;
  if (Array.isArray(value)) return value.map(item => visibleJudgeData(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visibleJudgeData(item)])) as T;
  return value;
}

/** C2's prompt-copy boundary: corrections may change only the last user message. */
export function withReplyCorrection<T extends { is_user?: boolean; mes?: string }>(messages: readonly T[], correction: string): T[] {
  const copy = [...messages];
  if (!correction.trim()) return copy;
  let index = copy.length - 1;
  while (index >= 0 && !copy[index]!.is_user) index--;
  if (index < 0) return copy;
  const message = copy[index]!;
  copy[index] = { ...message, mes: `${message.mes ?? ''}\n\n(OOC: ${correction.trim()})` };
  return copy;
}
