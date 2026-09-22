/**
 * Speaker selection (plan §6).
 *
 * Hard eligibility first, explicit user choice second, then a Choice over
 * eligible actor ids plus YIELD resolved by argmax after transparent priors
 * and a repetition factor. All-zero adjusted totals yield. Ties break by
 * stable group order. A provider that returns a choice but no distribution is
 * usable only with neutral adjustments; nonneutral weighting is refused
 * rather than fabricated.
 */
import { YIELD } from './types.ts';
import type { Answer, SpeakerDecision } from './types.ts';

export interface SpeakerCandidate {
  actorId: string;
  /** Host-side reasons a candidate is excluded; empty means eligible. */
  exclusions: string[];
}

export interface SpeakerInput {
  /** Candidates in stable group order. */
  candidates: SpeakerCandidate[];
  /** Actor id chosen explicitly by the user, or null. */
  explicitActorId: string | null;
  includeYield: boolean;
  priors: Record<string, number>;
  repetitionFactor: number;
  /** Actor id of the last assistant message, for the repetition factor. */
  lastSpeakerActorId: string | null;
  /** Provider answer for the speaker question, or null when none was asked. */
  answer: Answer | null;
  questionId: string | null;
}

export function eligibleActorIds(candidates: SpeakerCandidate[]): string[] {
  return candidates.filter(c => c.exclusions.length === 0).map(c => c.actorId);
}

/** True when priors and repetition would not change a ranking. */
export function adjustmentsAreNeutral(input: Pick<SpeakerInput, 'priors' | 'repetitionFactor'>, ids: string[]): boolean {
  const rep = Number(input.repetitionFactor);
  if (Number.isFinite(rep) && rep !== 1) return false;
  return ids.every(id => {
    const p = input.priors[id];
    return p === undefined || p === 1;
  });
}

export type SpeakerResult =
  | { ok: true; decision: SpeakerDecision }
  | { ok: false; error: string; decision: SpeakerDecision | null };

export function decideSpeaker(input: SpeakerInput): SpeakerResult {
  const eligible = eligibleActorIds(input.candidates);
  const options = input.includeYield ? [...eligible, YIELD] : [...eligible];
  const base: SpeakerDecision = {
    questionId: input.questionId,
    eligibleActorIds: eligible,
    raw: null,
    adjusted: null,
    selected: YIELD,
    source: 'yield',
    tieBroken: false,
  };

  if (eligible.length === 0) {
    return { ok: true, decision: { ...base, selected: YIELD, source: 'yield' } };
  }

  if (input.explicitActorId) {
    if (input.explicitActorId === YIELD) return { ok: true, decision: { ...base, selected: YIELD, source: 'explicit' } };
    if (!eligible.includes(input.explicitActorId)) {
      return { ok: false, error: `explicit speaker ${input.explicitActorId} is not eligible`, decision: null };
    }
    return { ok: true, decision: { ...base, selected: input.explicitActorId, source: 'explicit' } };
  }

  if (eligible.length === 1 && !input.includeYield) {
    return { ok: true, decision: { ...base, selected: eligible[0]!, source: 'single' } };
  }

  if (!input.answer) {
    return { ok: false, error: 'speaker is ambiguous and no assessment was supplied', decision: null };
  }
  if (input.answer.type !== 'choice') {
    return { ok: false, error: 'speaker assessment must be a choice', decision: null };
  }
  if (!options.includes(input.answer.choice)) {
    return { ok: false, error: `speaker choice ${input.answer.choice} is not an offered option`, decision: null };
  }

  const raw = input.answer.probabilities;
  if (!raw) {
    // Structured baseline without a distribution: usable only with neutral adjustments (M2-13).
    if (!adjustmentsAreNeutral(input, options)) {
      return { ok: false, error: 'provider returned no distribution; nonneutral priors or repetition are unsupported for this connection', decision: null };
    }
    return { ok: true, decision: { ...base, raw: null, adjusted: null, selected: input.answer.choice, source: 'provider' } };
  }

  const adjusted: Record<string, number> = {};
  let total = 0;
  for (const id of options) {
    const p = Number(raw[id] ?? 0);
    const prior = id === YIELD ? Number(input.priors[YIELD] ?? 1) : Number(input.priors[id] ?? 1);
    const rep = id !== YIELD && input.lastSpeakerActorId === id ? Number(input.repetitionFactor) : 1;
    const value = (Number.isFinite(p) ? p : 0) * (Number.isFinite(prior) ? prior : 1) * (Number.isFinite(rep) ? rep : 1);
    adjusted[id] = value > 0 ? value : 0;
    total += adjusted[id]!;
  }

  if (total <= 0) {
    return { ok: true, decision: { ...base, raw: { ...raw }, adjusted, selected: YIELD, source: 'all_zero' } };
  }
  for (const id of options) adjusted[id] = adjusted[id]! / total;

  let best: string | null = null;
  let bestValue = -1;
  let tieBroken = false;
  for (const id of options) {
    const v = adjusted[id]!;
    if (v > bestValue + 1e-12) {
      best = id;
      bestValue = v;
      tieBroken = false;
    } else if (Math.abs(v - bestValue) <= 1e-12 && best !== null) {
      // Equal value: keep the earlier option (stable group order) and record the tie.
      tieBroken = true;
    }
  }
  return { ok: true, decision: { ...base, raw: { ...raw }, adjusted, selected: best ?? YIELD, source: 'provider', tieBroken } };
}
