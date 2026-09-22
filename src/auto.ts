/** Pure interpretation of the automatic gate/family answers. */
import type { ActionSpec, Answer, AttemptFamily } from './types.ts';

export type AutomaticAttemptResult =
  | { ok: true; action: ActionSpec | null; reason: 'none' | 'trivial_or_certain' | 'one_consequential' | 'multiple_consequential' }
  | { ok: false; error: string };

const FAMILIES: AttemptFamily[] = [
  'overcome_operate', 'contest_impose', 'evade_resist', 'conceal_deceive',
  'detect_discover', 'influence_negotiate', 'acquire_secure',
];

export function interpretAutomaticAttempt(
  candidate: ActionSpec,
  answers: Record<string, Answer>,
  errors: Record<string, string> = {},
): AutomaticAttemptResult {
  const gate = answers.attempt_gate;
  if (!gate || gate.type !== 'choice') return { ok: false, error: `automatic check gate unresolved: ${errors.attempt_gate ?? 'missing'}` };
  if (gate.choice === 'none' || gate.choice === 'trivial_or_certain') return { ok: true, action: null, reason: gate.choice };
  if (gate.choice !== 'one_consequential' && gate.choice !== 'multiple_consequential') return { ok: false, error: `automatic check gate returned unsupported option ${gate.choice}` };

  const family = answers.attempt_family;
  if (!family || family.type !== 'choice' || !FAMILIES.includes(family.choice as AttemptFamily)) {
    return { ok: false, error: `automatic attempt family unresolved: ${errors.attempt_family ?? (family?.type === 'choice' ? family.choice : 'missing')}` };
  }
  const action = structuredClone(candidate);
  action.templateId = family.choice;
  if (gate.choice === 'multiple_consequential') action.additionalAttemptsPolicy = 'defer_after_first';
  return { ok: true, action, reason: gate.choice };
}
