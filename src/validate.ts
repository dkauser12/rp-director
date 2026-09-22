/**
 * Answer validation for the decision-provider layer.
 *
 * Every provider funnels its raw output through `validateAnswer` before it can
 * become an `Answer`. Anything malformed, out of range, nonfinite, an unknown
 * option, or the wrong primitive is rejected with a human-readable message so
 * the caller can mark the question unresolved instead of inventing a value.
 *
 * Invariants enforced here (from the v3 brief):
 * - A Noul answer never carries confidence: it is normalized to `null` even if
 *   the raw answer had one, and never inferred from distance to 0.5.
 * - A missing optional field (probabilities, confidence) is `null`, never a
 *   fabricated zero or a fabricated distribution.
 * - The score legend is always rebuilt from the question's criteria; whatever
 *   legend the raw answer carried is ignored.
 */

import type { Answer, Question, Provenance } from './types.ts';

const SUM_TOLERANCE = 1e-6;
const EXPECTATION_TOLERANCE = 1e-6;

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Finite and 0 <= x <= 1. */
export function isUnitInterval(x: unknown): x is number {
  return isFiniteNumber(x) && x >= 0 && x <= 1;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Short, safe rendering of an offending value for error messages. */
function describe(x: unknown): string {
  let text: string;
  if (typeof x === 'string') {
    text = JSON.stringify(x);
  } else if (typeof x === 'number' || typeof x === 'boolean' || x === null || x === undefined) {
    text = String(x);
  } else {
    try {
      text = JSON.stringify(x) ?? String(x);
    } catch {
      text = Object.prototype.toString.call(x);
    }
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * A probability distribution over exactly `keys` (any order): every value is a
 * finite number in [0, 1] and the values sum to 1 within 1e-6.
 */
export function validateProbabilities(
  keys: string[],
  raw: unknown,
): { ok: true; value: Record<string, number> } | { ok: false; error: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `probabilities must be an object keyed by option, got ${describe(raw)}` };
  }
  const expected = new Set(keys);
  const missing = keys.filter((k) => !Object.hasOwn(raw, k));
  const extra = Object.keys(raw).filter((k) => !expected.has(k));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.map((k) => JSON.stringify(k)).join(', ')}`);
    if (extra.length > 0) parts.push(`unexpected ${extra.map((k) => JSON.stringify(k)).join(', ')}`);
    return { ok: false, error: `probabilities keys do not match the options (${parts.join('; ')})` };
  }
  const value: Record<string, number> = {};
  let sum = 0;
  for (const key of keys) {
    const p = raw[key];
    if (!isUnitInterval(p)) {
      return { ok: false, error: `probability for ${JSON.stringify(key)} must be a finite number in [0, 1], got ${describe(p)}` };
    }
    value[key] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    return { ok: false, error: `probabilities must sum to 1 (sum is ${sum})` };
  }
  return { ok: true, value };
}

export type ValidationResult = { ok: true; answer: Answer } | { ok: false; error: string };

function validateConfidence(raw: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (!isUnitInterval(raw)) {
    return { ok: false, error: `confidence must be a finite number in [0, 1] or null, got ${describe(raw)}` };
  }
  return { ok: true, value: raw };
}

/**
 * Coerce the structured-baseline bare shapes (a bare option string for choice,
 * a bare number for noul/score) into the Jev wire object shape, or return the
 * raw value untouched when it is already an object (or something invalid).
 */
function liftBareShape(question: Question, raw: unknown): unknown {
  if (question.type === 'choice' && typeof raw === 'string') return { choice: raw };
  if (question.type === 'noul' && typeof raw === 'number') return { noul: raw };
  if (question.type === 'score' && typeof raw === 'number') return { score: raw };
  return raw;
}

/**
 * Validate one raw answer against its question. Accepts the Jev wire object
 * shape and the structured-baseline bare shapes. Provenance is passed through.
 */
export function validateAnswer(question: Question, raw: unknown, provenance: Provenance): ValidationResult {
  const lifted = liftBareShape(question, raw);
  if (!isPlainObject(lifted)) {
    const accepted = question.type === 'choice' ? 'an object or an option key string' : 'an object or a number';
    return { ok: false, error: `${question.type} answer must be ${accepted}, got ${describe(raw)}` };
  }
  if (lifted.type !== undefined && lifted.type !== question.type) {
    return { ok: false, error: `answer type ${describe(lifted.type)} does not match question type ${JSON.stringify(question.type)}` };
  }

  switch (question.type) {
    case 'choice':
      return validateChoice(question, lifted, provenance);
    case 'score':
      return validateScore(question, lifted, provenance);
    case 'noul':
      return validateNoul(lifted, provenance);
    default: {
      const never: never = question;
      return { ok: false, error: `unsupported question type ${describe((never as { type?: unknown }).type)}` };
    }
  }
}

function validateChoice(
  question: Extract<Question, { type: 'choice' }>,
  raw: Record<string, unknown>,
  provenance: Provenance,
): ValidationResult {
  if (!isPlainObject(question.criteria)) {
    return { ok: false, error: 'choice question has no option criteria' };
  }
  const optionKeys = Object.keys(question.criteria);
  if (optionKeys.length === 0) {
    return { ok: false, error: 'choice question has no options' };
  }
  const choice = raw.choice;
  if (typeof choice !== 'string') {
    return { ok: false, error: `choice must be an option key string, got ${describe(choice)}` };
  }
  if (!Object.hasOwn(question.criteria, choice)) {
    return { ok: false, error: `choice ${JSON.stringify(choice)} is not one of the options: ${optionKeys.join(', ')}` };
  }

  let probabilities: Record<string, number> | null = null;
  if (raw.probabilities !== null && raw.probabilities !== undefined) {
    const result = validateProbabilities(optionKeys, raw.probabilities);
    if (!result.ok) return result;
    probabilities = result.value;
  }

  const confidence = validateConfidence(raw.confidence);
  if (!confidence.ok) return confidence;

  return {
    ok: true,
    answer: { type: 'choice', choice, probabilities, confidence: confidence.value, provenance },
  };
}

function validateScore(
  question: Extract<Question, { type: 'score' }>,
  raw: Record<string, unknown>,
  provenance: Provenance,
): ValidationResult {
  const criteria = question.criteria;
  if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every((c) => typeof c === 'string')) {
    return { ok: false, error: 'score question must have an ordered list of at least 2 string criteria' };
  }
  const levels = criteria.length;
  const maxLevel = levels - 1;

  const score = raw.score;
  if (!isFiniteNumber(score)) {
    return { ok: false, error: `score must be a finite number, got ${describe(score)}` };
  }
  if (score < 0 || score > maxLevel) {
    return { ok: false, error: `score ${score} is outside the range [0, ${maxLevel}] for ${levels} levels` };
  }

  const levelKeys = Array.from({ length: levels }, (_, i) => String(i));
  let probabilities: Record<string, number> | null = null;
  if (raw.probabilities !== null && raw.probabilities !== undefined) {
    const result = validateProbabilities(levelKeys, raw.probabilities);
    if (!result.ok) return result;
    probabilities = result.value;
    let expectation = 0;
    for (let i = 0; i < levels; i += 1) {
      expectation += i * (probabilities[String(i)] ?? 0);
    }
    if (Math.abs(expectation - score) > EXPECTATION_TOLERANCE) {
      return { ok: false, error: `score ${score} does not equal the expectation of its probabilities (${expectation})` };
    }
  }

  const legend: Record<string, string> = {};
  criteria.forEach((label, i) => {
    legend[String(i)] = label;
  });

  const confidence = validateConfidence(raw.confidence);
  if (!confidence.ok) return confidence;

  return {
    ok: true,
    answer: { type: 'score', score, legend, probabilities, confidence: confidence.value, provenance },
  };
}

function validateNoul(raw: Record<string, unknown>, provenance: Provenance): ValidationResult {
  const noul = raw.noul;
  if (!isUnitInterval(noul)) {
    return { ok: false, error: `noul must be a finite number in [0, 1], got ${describe(noul)}` };
  }
  // Noul never carries confidence, whatever the raw answer said.
  return { ok: true, answer: { type: 'noul', noul, confidence: null, provenance } };
}
