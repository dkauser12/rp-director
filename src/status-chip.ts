import type { DirectorStatus } from './controller.ts';

export type StatusChipState = 'off' | 'paused' | 'no-chat' | 'not-connected' | 'deciding' | 'writing' | 'ready'
  | 'timeout' | 'network' | 'refusal' | 'invalid' | 'budget' | 'writer' | 'auth' | 'error';

export interface StatusChip {
  state: StatusChipState;
  label: string;
  nextStep: string;
  tone: 'neutral' | 'active' | 'good' | 'warning';
}

export interface StatusChipInput {
  enabled: boolean;
  paused: boolean;
  hasChat: boolean;
  status: DirectorStatus;
  lastError: string | null;
  connectionConfigured: boolean;
  /** True only after a successful request using the current connection settings. */
  connectionWorking: boolean;
}

const ERROR_COPY: Record<'timeout' | 'network' | 'refusal' | 'invalid' | 'budget' | 'writer' | 'auth' | 'error', [string, string]> = {
  timeout: ['Judge timed out', 'Open the reply badge for details'],
  network: ['Connection error', 'Check the judge connection in Settings'],
  refusal: ['Judge refused', 'Try a different judge model in Settings'],
  invalid: ['Invalid answer', 'Open the reply badge for details'],
  budget: ['Context too large', 'Try a shorter message or a judge with more context'],
  writer: ['Writer error', 'Retry the reply to keep the saved result'],
  auth: ['Access denied', 'Check the judge key and model access in Settings'],
  error: ['Judge unavailable', 'Open Activity for details or try the judge again'],
};

/** Read error categories only; never expose raw provider messages in the drawer. */
function errorState(message: string): keyof typeof ERROR_COPY {
  if (/writer|tool request rejected/i.test(message)) return 'writer';
  if (/timed?\s*out|timeout|deadline|wait budget.*expir/i.test(message)) return 'timeout';
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|api.?key|authentication|access denied/i.test(message)) return 'auth';
  if (/context.*(?:budget|large|limit)|(?:budget|limit).*context|too_large|context_budget/i.test(message)) return 'budget';
  if (/refus(?:al|ed|e)/i.test(message)) return 'refusal';
  if (/invalid|malformed|missing.*answer|unresolved|settings changed/i.test(message)) return 'invalid';
  if (/network|fetch|connection|\bhttp\b|unreachable|offline/i.test(message)) return 'network';
  return 'error';
}

export function buildStatusChip(input: StatusChipInput): StatusChip {
  const chip = (state: StatusChipState, label: string, nextStep: string, tone: StatusChip['tone'] = 'neutral'): StatusChip => ({ state, label, nextStep, tone });
  if (!input.enabled) return chip('off', 'Off', 'Enable Director to use it with your next reply.');
  if (!input.hasChat) return chip('no-chat', 'No chat', 'Open a chat to use Director.');
  if (input.paused) return chip('paused', 'Paused', 'Turn off Pause for this chat to resume Director.');
  if (input.status === 'Deciding') return chip('deciding', 'Deciding', 'Wait for the judge to finish choosing this reply’s details.', 'active');
  if (input.status === 'Writing') return chip('writing', 'Writing', 'Wait for the reply to finish.', 'active');
  if (input.lastError || input.status === 'Error') {
    const state = errorState(input.lastError ?? '');
    const [label, action] = ERROR_COPY[state];
    return chip(state, label, `${action}. Your chat isn't affected.`, 'warning');
  }
  if (!input.connectionConfigured) return chip('not-connected', 'Not connected', 'Choose a judge connection in Settings.', 'warning');
  if (!input.connectionWorking) return chip('ready', 'Ready', 'Send a message to check the judge connection.');
  // Frozen is an internal lifecycle state; the public state remains Ready.
  return chip('ready', 'Ready', 'Send a message when you are ready to continue.', 'good');
}
