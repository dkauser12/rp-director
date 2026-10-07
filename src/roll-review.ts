import type { DirectorProfile, TurnPermit } from './types.ts';
import { newId, randomDraw } from './identity.ts';
import { normaliseSignal, resolveOutcome } from './resolver.ts';
import { fillPlaceholders } from './prompts.ts';

/** Resample frozen assessments with the same table; never ask a model for new dice. */
export function rerollPermit(previous: TurnPermit, profile: DirectorProfile, names: Record<string, string>, playerName: string, draw = () => randomDraw().u): TurnPermit {
  if (profile.resolutionMethod !== 'sample') throw new Error('Threshold outcomes require reassessment, not a random reroll.');
  const permit = structuredClone(previous);
  permit.previousPermitId = previous.permitId;
  permit.permitId = newId('permit');
  permit.createdAt = Date.now();
  delete permit.reviewedAt;
  permit.actions = previous.actions.map(action => {
    if (!action.assessment) throw new Error('This legacy permit has no stored assessment for a reroll.');
    const signal = normaliseSignal(action.assessment);
    if (!signal.ok) throw new Error(signal.error);
    const result = resolveOutcome({ bands: profile.bands, outcomes: profile.outcomes, method: 'sample', signal: signal.signal, draw: draw() });
    if (!result.ok) throw new Error(result.error);
    return {
      ...structuredClone(action), resolutionId: newId('res'), outcome: result.value.outcome,
      instruction: fillPlaceholders(result.value.def.instruction, {
        gain: action.boundedResult, action: action.method,
        target: action.targetActorIds.map(id => names[id] ?? id).join(' and ') || 'the immediate obstacle',
        player: playerName, speaker: names[previous.speakerActorId] ?? previous.speakerActorId,
      }),
      recordedValue: result.value.def.records, finalForScope: result.value.def.final,
      draw: result.value.draw, policyBand: structuredClone(result.value.band), outcomeDefinition: structuredClone(result.value.def),
    };
  });
  return permit;
}


export type RollReviewChoice = 'keep' | 'reroll' | 'cancel';

/** User review is independent of the judge deadline; Stop/chat changes cancel it. */
export async function reviewPermit(input: {
  initial: TurnPermit;
  choose: (permit: TurnPermit) => Promise<RollReviewChoice>;
  reroll: (permit: TurnPermit) => Promise<TurnPermit>;
  isCurrent: () => boolean;
  signal: AbortSignal;
  method: 'sample' | 'threshold';
}): Promise<TurnPermit | null> {
  let permit = structuredClone(input.initial);
  while (!input.signal.aborted && input.isCurrent()) {
    const choice = await input.choose(structuredClone(permit));
    if (choice === 'cancel' || input.signal.aborted || !input.isCurrent()) return null;
    if (choice === 'keep') return permit;
    permit = await input.reroll(permit);
  }
  return null;
}
