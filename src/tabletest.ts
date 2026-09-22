/**
 * "Test table": one judge call that proves the edited table works end to end
 * with the selected connection, in the spirit of SillyTavern's connection test.
 *
 * During play the judge never reads the table; it returns one number and code
 * applies the table. The test therefore checks three things with three
 * independent questions in a single batch:
 *   1. the driving question (Noul or Score) comes back in the expected format
 *      and resolves through the edited table to one of its outcome columns;
 *   2. the outcome names survive a round trip as Choice option names;
 *   3. the band ids survive a round trip as Choice option names.
 * Questions 2 and 3 also ask the model to read the table that is sent in
 * `state`, which gives a checkable expected answer. A wrong reading is
 * reported but does not fail the test, because play never depends on it.
 */
import type { EvaluationRequest, EvaluationResult, Json, Question } from './types.ts';
import type { PolicyTable } from './table.ts';
import { validateTable } from './table.ts';
import { normaliseSignal, resolveOutcome } from './resolver.ts';
import { gainNoulQuestion, gainScoreQuestion } from './questions.ts';

export const TABLE_TEST_SIGNAL = 'table_signal';
export const TABLE_TEST_OUTCOME = 'table_outcome';
export const TABLE_TEST_BAND = 'table_band';
/** Fixed roll used to demonstrate dice mode in the report; never stored. */
export const TABLE_TEST_DRAW = 0.5;

export type TableTestStatus = 'pass' | 'fail' | 'local_only';

export interface TableTestReport {
  status: TableTestStatus;
  headline: string;
  lines: string[];
  networkCalls: number;
  durationMs: number | null;
  model: string | null;
}

export interface TableProbe {
  bandIndex: number;
  bandId: string;
  x: number;
  expectedOutcome: string;
}

/** Probe point: the midpoint of the middle band, so the expected band and outcome are unambiguous. */
export function pickProbe(table: PolicyTable): TableProbe {
  const bandIndex = Math.floor(table.bands.length / 2);
  const band = table.bands[bandIndex]!;
  const x = Math.round(((band.lowerInclusive + band.upper) / 2) * 1e6) / 1e6;
  return { bandIndex, bandId: band.id, x, expectedOutcome: band.thresholdOutcome };
}

export function buildTableTestRequest(table: PolicyTable, drivingQuestionId: 'gain_noul' | 'gain_score', requestId: string): EvaluationRequest {
  const probe = pickProbe(table);
  const state: Json = {
    scopeId: 'table-test',
    note: 'Synthetic test scene. Nothing here comes from a real chat.',
    facts: { permitPresented: false, passageAlreadyGranted: false, knownGateRule: 'A permit or captain authorization is required.' },
    action: {
      attemptedAction: 'The player asks the gate guard to grant immediate passage without presenting a permit.',
      requestedGain: 'The guard grants permission to pass the gate now.',
      applicability: 'favorable',
    },
    policyTable: {
      reading: 'Bands are half-open intervals [from, to); the last band also includes 1.',
      outcomes: table.outcomes.map(o => ({ name: o.name, records: o.records })),
      bands: table.bands.map(b => ({ id: b.id, from: b.lowerInclusive, to: b.upper, thresholdOutcome: b.thresholdOutcome })),
    },
    probe: { x: probe.x, bandId: probe.bandId },
  };
  const questions: Record<string, Question> = {
    [TABLE_TEST_SIGNAL]: drivingQuestionId === 'gain_score' ? gainScoreQuestion() : gainNoulQuestion(),
    [TABLE_TEST_OUTCOME]: {
      type: 'choice',
      instructions: 'In state.policyTable.bands, find the band whose id equals state.probe.bandId. Which outcome name is that band\'s thresholdOutcome? Answer with exactly one of the supplied option names.',
      criteria: Object.fromEntries(table.outcomes.map(o => [o.name, `Outcome column "${o.name}".`])),
    },
  };
  if (table.bands.length >= 2) {
    questions[TABLE_TEST_BAND] = {
      type: 'choice',
      instructions: 'state.policyTable.bands lists intervals [from, to), and the last band also includes 1. Which band id contains the number state.probe.x? Answer with exactly one of the supplied option names.',
      criteria: Object.fromEntries(table.bands.map(b => [b.id, `From ${b.lowerInclusive} to ${b.upper}.`])),
    };
  }
  return {
    requestId,
    phase: 'guide',
    snapshot: { chatId: 'table-test', cursorBefore: 'table-test', stateRevision: 0, scopeId: 'table-test', profileRevision: 'table-test', catalogRevision: '', actorBindingRevision: '', state },
    questions,
  };
}

export function localFailure(errors: string[]): TableTestReport {
  return { status: 'fail', headline: 'Table is not valid yet. Nothing was sent.', lines: errors, networkCalls: 0, durationMs: null, model: null };
}

export function localOnly(kind: string): TableTestReport {
  return {
    status: 'local_only',
    headline: 'Local checks passed. No model was contacted.',
    lines: [`The ${kind} connection has no model behind it. Choose Jev, OpenRouter, or Structured output to test the round trip.`],
    networkCalls: 0,
    durationMs: null,
    model: null,
  };
}

export function transportFailure(code: string, message: string, durationMs: number | null): TableTestReport {
  return { status: 'fail', headline: 'The judge call failed.', lines: [`${code}: ${message}`], networkCalls: 1, durationMs, model: null };
}

/** Pure evaluation of a finished call against the edited table. */
export function evaluateTableTest(table: PolicyTable, method: 'threshold' | 'sample', request: EvaluationRequest, result: EvaluationResult): TableTestReport {
  const v = validateTable(table);
  if (!v.ok) return localFailure(v.errors);
  const lines: string[] = [];
  const problems: string[] = [];
  const probe = pickProbe(table);

  for (const id of Object.keys(request.questions)) {
    if (!result.answers[id]) problems.push(`${id}: ${result.errors[id] ?? 'no answer returned'}`);
  }

  const signal = result.answers[TABLE_TEST_SIGNAL];
  if (signal) {
    const normalised = normaliseSignal(signal);
    if (!normalised.ok) {
      problems.push(`${TABLE_TEST_SIGNAL}: ${normalised.error}`);
    } else {
      const resolved = resolveOutcome({ bands: table.bands, outcomes: table.outcomes, method, signal: normalised.signal, draw: method === 'sample' ? TABLE_TEST_DRAW : null });
      if (!resolved.ok) problems.push(`table lookup: ${resolved.error}`);
      else {
        const raw = signal.type === 'noul' ? `Noul ${signal.noul}` : signal.type === 'score' ? `Score ${signal.score}` : 'signal';
        const roll = method === 'sample' ? ` with a sample roll of ${TABLE_TEST_DRAW}` : '';
        lines.push(`Signal: ${raw} → x = ${normalised.signal.x.toFixed(4)} → band ${resolved.value.band.id} → ${resolved.value.outcome}${roll}.`);
      }
    }
  }

  const outcomeAnswer = result.answers[TABLE_TEST_OUTCOME];
  if (outcomeAnswer && outcomeAnswer.type === 'choice') {
    const matches = outcomeAnswer.choice === probe.expectedOutcome;
    lines.push(`Outcome names: accepted as option names; the model returned "${outcomeAnswer.choice}".`);
    if (!matches) lines.push(`Note: reading band ${probe.bandId} from the table, the expected name was "${probe.expectedOutcome}". Play does not depend on this, because the table is applied in code.`);
  } else if (outcomeAnswer) {
    problems.push(`${TABLE_TEST_OUTCOME}: expected a choice answer`);
  }

  const bandAnswer = result.answers[TABLE_TEST_BAND];
  if (request.questions[TABLE_TEST_BAND]) {
    if (bandAnswer && bandAnswer.type === 'choice') {
      const matches = bandAnswer.choice === probe.bandId;
      lines.push(`Band ids: accepted as option names; the model returned "${bandAnswer.choice}" for x = ${probe.x}.`);
      if (!matches) lines.push(`Note: the band containing ${probe.x} is ${probe.bandId}. Play does not depend on this.`);
    } else if (bandAnswer) {
      problems.push(`${TABLE_TEST_BAND}: expected a choice answer`);
    }
  } else {
    lines.push('Band ids: a single band needs no option test.');
  }

  const model = result.returnedModel ?? result.requestedModel;
  const tokens = result.inputTokens !== null || result.outputTokens !== null ? `, tokens ${result.inputTokens ?? '—'} in / ${result.outputTokens ?? '—'} out` : '';
  const timing = `One judge call, ${Math.round(result.durationMs)} ms${model ? `, model ${model}` : ''}${tokens}.`;

  if (problems.length) {
    return { status: 'fail', headline: 'The judge replied, but not in the expected format.', lines: [...problems, ...lines, timing], networkCalls: 1, durationMs: result.durationMs, model };
  }
  return { status: 'pass', headline: 'Valid. The table and the judge work together.', lines: [...lines, timing], networkCalls: 1, durationMs: result.durationMs, model };
}
