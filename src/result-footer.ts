import { normaliseSignal } from './resolver.ts';
import type { Answer, DirectorChatRecord } from './types.ts';

interface ResultLine {
  kind: string;
  actor: string;
  action: string;
  outcome: string;
  method: string | null;
  /** The saved driving signal, not confidence or a calibrated success chance. */
  support: number | null;
  roll: number | null;
}

function supportOf(answer: Answer | null | undefined): number | null {
  if (!answer) return null;
  const normalized = normaliseSignal(answer);
  return normalized.ok ? normalized.signal.x : null;
}

/** Formats only rulings actually attached to this attempt, including its kept NPC permit. */
export function formatResultFooter(record: DirectorChatRecord | null, attemptId: string): string {
  const attempt = record?.attempts[attemptId];
  if (!record || !attempt || attempt.attemptId !== attemptId) return '';
  const results: ResultLine[] = [];
  const nameOf = (id: string) => record.actors[id]?.name || id;
  if (!attempt.unadjudicated) {
    const frozen = attempt.resolutionId ? record.resolutions[attempt.resolutionId] : null;
    if (frozen) results.push({
      kind: 'action',
      actor: nameOf(frozen.action.actingActorId ?? frozen.action.playerActorId),
      action: frozen.action.attemptedAction,
      outcome: frozen.outcome,
      method: frozen.method,
      support: supportOf(frozen.assessment),
      roll: frozen.draw ?? null,
    });
    const permit = attempt.permitId ? record.permits[attempt.permitId] : null;
    for (const action of permit?.actions ?? []) results.push({
      kind: 'action',
      actor: nameOf(action.actingActorId),
      action: action.method,
      outcome: action.outcome,
      method: action.methodUsed ?? null,
      support: supportOf(action.assessment),
      roll: action.draw ?? null,
    });
    if (attempt.reaction) results.push({
      kind: attempt.reaction.kind,
      actor: nameOf(attempt.reaction.actorId),
      action: 'NPC reaction',
      outcome: attempt.reaction.outcome,
      method: 'sample',
      support: null,
      roll: attempt.reaction.draw,
    });
  }
  const status = attempt.unadjudicated ? 'unadjudicated' : results.some(result => result.kind === 'action') ? 'ruled' : results.length ? 'directed' : 'no_ruling';
  // Keep the payload one JSON line, and prevent names or actions from creating
  // markup or an apparent closing delimiter. JSON.parse restores these characters.
  const json = JSON.stringify({ status, results }).replace(/"(?:\\.|[^"\\])*"/g,
    value => value.replace(/[<>&\[\]\u2028\u2029]/g,
      character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
  return `[RP_DIRECTOR]\n${json}\n[/RP_DIRECTOR]`;
}

/** Reserved standalone blocks are metadata even after Continue appends more prose. */
export function stripResultFooter(text: string): string {
  return text.replace(/(?:\r?\n){0,2}^\[RP_DIRECTOR\]\r?\n\{[^\r\n]*\}\r?\n\[\/RP_DIRECTOR\]/gm, '');
}

/** Replace earlier blocks rather than duplicating them on a rerender or continuation. */
export function withResultFooter(text: string, footer: string): string {
  const prose = stripResultFooter(text);
  if (!footer) return prose;
  const body = prose.trimEnd();
  return body ? `${body}\n\n${footer}` : footer;
}
