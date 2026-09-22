/**
 * The outcome policy table as editable data.
 *
 * Columns are outcomes (variable names the profile defines), rows are bands
 * of the judge's 0–1 signal. The table is applied in code; the judge never
 * reads it during play. Every operation here is pure so the settings UI and
 * the unit tests share one implementation.
 */
import type { OutcomeDef, OutcomeTier, PolicyBand } from './types.ts';
import { OUTCOME_TIERS } from './types.ts';

export const BASIS_POINTS = 10000;

/**
 * Row and column limits. The upper bound is a real one: TypeSafe's Jev accepts
 * at most 255 options in one Choice question (docs.typesafe.ai/primitives/choice,
 * read 2026-09-19), and the table test asks one Choice over the outcome names
 * and one over the band ids. A ruling needs at least two possible outcomes.
 */
export const MAX_OUTCOMES = 255;
export const MAX_BANDS = 255;
export const MIN_OUTCOMES = 2;
export const MIN_BANDS = 1;

/** Variable names: letters, digits, underscore; start with a letter. */
export const NAME_MAX_LENGTH = 40;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface PolicyTable {
  outcomes: OutcomeDef[];
  bands: PolicyBand[];
}

/** Longest instruction an outcome may carry; it is injected into the writer prompt on every ruled turn. */
export const INSTRUCTION_MAX_LENGTH = 1500;

/**
 * Starting text for the three outcomes every profile ships with. They are
 * ordinary player-editable outcomes; nothing in the code depends on these
 * names or texts. They are also what a table saved by the earlier build
 * (which had three built-in meanings) is migrated to.
 */
export const LEGACY_TIER_DEFAULTS: Record<OutcomeTier, { instruction: string; records: string; final: boolean }> = {
  deferred: {
    instruction: 'This attempt does not deliver the requested gain in this reply. Do not grant it, imply it was granted, or hand it over in an aside. Questioning, waiting, conditions, a price, or pointing to another route are all fine. Everything {{player}} had already earned stays intact; only this new request is not fulfilled now.',
    records: '',
    final: false,
  },
  progress_only: {
    instruction: 'Only a concrete partial step toward the requested gain happens in this reply, such as a condition named, a superior consulted, a hint, or a conditional maybe. The gain itself is not delivered.',
    records: 'partial',
    final: false,
  },
  achieved: {
    instruction: 'The requested gain is delivered exactly as declared and nothing beyond it. No extra privileges, secrets, or promises, no permanent change of attitude, and no narration of {{player}}\'s choices.',
    records: 'achieved',
    final: true,
  },
};

export const DEFAULT_OUTCOMES: OutcomeDef[] = (['deferred', 'progress_only', 'achieved'] as const).map(name => ({ name, ...LEGACY_TIER_DEFAULTS[name] }));

/** Reads an outcome column from saved settings, migrating the earlier `{ name, tier, note }` shape. */
export function normalizeOutcome(raw: unknown): OutcomeDef {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name : '';
  if (typeof o.instruction === 'string' || typeof o.records === 'string' || typeof o.final === 'boolean') {
    return { name, instruction: typeof o.instruction === 'string' ? o.instruction : '', records: typeof o.records === 'string' ? o.records : '', final: o.final === true };
  }
  if (isOutcomeTier(o.tier)) {
    const base = LEGACY_TIER_DEFAULTS[o.tier];
    const note = typeof o.note === 'string' && o.note.trim() ? ' ' + o.note.trim() : '';
    return { name, instruction: base.instruction + note, records: base.records, final: base.final };
  }
  return { name, instruction: '', records: '', final: false };
}

export function isOutcomeTier(x: unknown): x is OutcomeTier {
  return typeof x === 'string' && (OUTCOME_TIERS as readonly string[]).includes(x);
}

export function bandId(index: number): string {
  return `b${index}`;
}

/**
 * Turns typed text into a variable name: spaces and hyphens become
 * underscores, everything outside letters, digits and underscore is dropped.
 * Jev itself accepts any string as an option name; the stricter set keeps the
 * name usable as a JSON key, a JSON-schema enum value for other backends, and
 * a stable id in saved rulings. `final` also trims underscores at both ends.
 */
export function sanitizeName(raw: string, final = false): string {
  let s = String(raw ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[\s-]+/g, '_').replace(/[^A-Za-z0-9_]/g, '').replace(/_{2,}/g, '_').replace(/^_+/, '');
  if (final) s = s.replace(/_+$/, '');
  return s.slice(0, NAME_MAX_LENGTH);
}

export interface Validation {
  ok: boolean;
  errors: string[];
}

export function validateOutcomes(outcomes: OutcomeDef[]): Validation {
  const errors: string[] = [];
  if (!Array.isArray(outcomes) || outcomes.length < MIN_OUTCOMES) errors.push(`the table needs at least ${MIN_OUTCOMES} outcome columns`);
  if (Array.isArray(outcomes) && outcomes.length > MAX_OUTCOMES) errors.push(`the table allows at most ${MAX_OUTCOMES} outcome columns`);
  const seen = new Set<string>();
  (outcomes ?? []).forEach((o, i) => {
    const name = String(o?.name ?? '');
    if (!name) errors.push(`outcome column ${i + 1}: name is empty`);
    else if (!NAME_PATTERN.test(name)) errors.push(`outcome "${name}": use letters, digits and underscores, starting with a letter`);
    else if (name.length > NAME_MAX_LENGTH) errors.push(`outcome "${name}": longer than ${NAME_MAX_LENGTH} characters`);
    const key = name.toLowerCase();
    if (name && seen.has(key)) errors.push(`outcome "${name}": duplicate name`);
    seen.add(key);
    const label = name || `column ${i + 1}`;
    if (typeof o?.instruction !== 'string' || !o.instruction.trim()) errors.push(`outcome "${label}": say what the writer is told when this is the ruling`);
    else if (o.instruction.length > INSTRUCTION_MAX_LENGTH) errors.push(`outcome "${label}": the writer instruction is longer than ${INSTRUCTION_MAX_LENGTH} characters`);
    const records = typeof o?.records === 'string' ? o.records : '';
    if (typeof o?.records !== 'string') errors.push(`outcome "${label}": the recorded value must be text (it may be empty)`);
    else if (records && !NAME_PATTERN.test(records)) errors.push(`outcome "${label}": the recorded value "${records}" may use letters, digits and underscores, starting with a letter`);
    if (typeof o?.final !== 'boolean') errors.push(`outcome "${label}": "stands once accepted" must be on or off`);
    else if (o.final && !records) errors.push(`outcome "${label}": it can only stand once accepted if it records a value`);
  });
  return { ok: errors.length === 0, errors };
}

/** Bands must tile [0,1] in order, half-open except the last, and carry whole basis-point weights summing to one over exactly the given outcome names. */
export function validateBands(bands: PolicyBand[], outcomeNames: readonly string[] = DEFAULT_OUTCOMES.map(o => o.name)): Validation {
  const errors: string[] = [];
  if (!Array.isArray(bands) || bands.length < MIN_BANDS) return { ok: false, errors: ['policy table has no bands'] };
  if (bands.length > MAX_BANDS) errors.push(`the table allows at most ${MAX_BANDS} bands`);
  let previous = 0;
  const ids = new Set<string>();
  bands.forEach((band, i) => {
    const label = band?.id || `row ${i + 1}`;
    if (!band || typeof band.id !== 'string' || !band.id) errors.push(`band ${i}: missing id`);
    else if (ids.has(band.id)) errors.push(`band ${i}: duplicate id ${band.id}`);
    else ids.add(band.id);
    if (band.lowerInclusive !== previous) errors.push(`band ${label}: lower bound ${band?.lowerInclusive} is not contiguous with ${previous}`);
    if (!(band.upper > band.lowerInclusive && band.upper <= 1)) errors.push(`band ${label}: "to" must be above "from" and at most 1`);
    const isLast = i === bands.length - 1;
    if (band.upperInclusive !== isLast) errors.push(`band ${label}: only the final band may include its upper bound`);
    if (!outcomeNames.includes(band.thresholdOutcome)) errors.push(`band ${label}: outcome "${String(band.thresholdOutcome)}" is not one of the columns (${outcomeNames.join(', ')})`);
    const extra = Object.keys(band.sampleWeights ?? {}).filter(k => !outcomeNames.includes(k));
    if (extra.length) errors.push(`band ${label}: weights for unknown outcomes ${extra.join(', ')}`);
    const units = outcomeNames.map(k => Number(band.sampleWeights?.[k] ?? 0) * BASIS_POINTS);
    if (units.some(u => !Number.isFinite(u) || u < 0)) errors.push(`band ${label}: weights must be numbers from 0 to 1`);
    else if (units.some(u => Math.abs(u - Math.round(u)) > 1e-8)) errors.push(`band ${label}: weights must be whole basis points (multiples of 0.0001)`);
    else if (units.reduce((a, b) => a + Math.round(b), 0) !== BASIS_POINTS) errors.push(`band ${label}: weights must sum to 1 (they sum to ${(units.reduce((a, b) => a + Math.round(b), 0) / BASIS_POINTS).toFixed(4)})`);
    previous = band?.upper;
  });
  if (previous !== 1) errors.push('the last band must end at 1');
  return { ok: errors.length === 0, errors };
}

export function validateTable(table: PolicyTable): Validation {
  const o = validateOutcomes(table.outcomes);
  const names = (table.outcomes ?? []).map(x => x.name);
  const b = validateBands(table.bands, names);
  return { ok: o.ok && b.ok, errors: [...o.errors, ...b.errors] };
}

export function cloneTable(table: PolicyTable): PolicyTable {
  return structuredClone({ outcomes: table.outcomes, bands: table.bands });
}

function renumber(bands: PolicyBand[]): void {
  bands.forEach((band, i) => {
    band.id = bandId(i);
    band.upperInclusive = i === bands.length - 1;
  });
  if (bands.length) {
    bands[0]!.lowerInclusive = 0;
    bands[bands.length - 1]!.upper = 1;
  }
}

function round4(x: number): number {
  return Math.round(x * BASIS_POINTS) / BASIS_POINTS;
}

/** Index of the widest band (the later one on ties); that is the row "add row" splits. */
export function widestBandIndex(table: PolicyTable): number {
  let best = -1;
  let width = -1;
  table.bands.forEach((b, i) => {
    const w = b.upper - b.lowerInclusive;
    if (w >= width - 1e-12) { best = i; width = w; }
  });
  return best;
}

export function canAddBand(table: PolicyTable): boolean {
  if (table.bands.length >= MAX_BANDS) return false;
  const band = table.bands[widestBandIndex(table)];
  if (!band) return false;
  const mid = round4((band.lowerInclusive + band.upper) / 2);
  return mid > band.lowerInclusive && mid < band.upper;
}

export function canRemoveBand(table: PolicyTable): boolean {
  return table.bands.length > MIN_BANDS;
}

export function canAddOutcome(table: PolicyTable): boolean {
  return table.outcomes.length < MAX_OUTCOMES;
}

export function canRemoveOutcome(table: PolicyTable): boolean {
  return table.outcomes.length > MIN_OUTCOMES;
}

/** Splits the widest band at its midpoint so the rows keep tiling 0–1; the new row copies its outcome and weights. */
export function addBand(table: PolicyTable): PolicyTable {
  const next = cloneTable(table);
  if (!canAddBand(next)) return next;
  const index = widestBandIndex(next);
  const band = next.bands[index]!;
  const mid = round4((band.lowerInclusive + band.upper) / 2);
  const added: PolicyBand = { ...structuredClone(band), lowerInclusive: mid, upper: band.upper };
  band.upper = mid;
  next.bands.splice(index + 1, 0, added);
  renumber(next.bands);
  return next;
}

/** Removes a band and gives its range to the band before it (or after it, for the first row). */
export function removeBand(table: PolicyTable, index: number): PolicyTable {
  const next = cloneTable(table);
  if (!canRemoveBand(next) || index < 0 || index >= next.bands.length) return next;
  const removed = next.bands[index]!;
  if (index > 0) next.bands[index - 1]!.upper = removed.upper;
  else next.bands[1]!.lowerInclusive = removed.lowerInclusive;
  next.bands.splice(index, 1);
  renumber(next.bands);
  return next;
}

/** Moves the boundary between a band and the next one; "from" of the next row follows. */
export function setBandUpper(table: PolicyTable, index: number, value: number): PolicyTable {
  const next = cloneTable(table);
  const band = next.bands[index];
  if (!band || index === next.bands.length - 1 || !Number.isFinite(value)) return next;
  band.upper = value;
  next.bands[index + 1]!.lowerInclusive = value;
  return next;
}

export function addOutcome(table: PolicyTable): PolicyTable {
  const next = cloneTable(table);
  if (!canAddOutcome(next)) return next;
  const taken = new Set(next.outcomes.map(o => o.name.toLowerCase()));
  let n = next.outcomes.length + 1;
  while (taken.has(`outcome_${n}`)) n += 1;
  const name = `outcome_${n}`;
  next.outcomes.push({ name, instruction: '', records: '', final: false });
  for (const band of next.bands) band.sampleWeights[name] = 0;
  return next;
}

/** Drops a column. Bands that pointed at it keep the dangling name so validation names the rows to fix. */
export function removeOutcome(table: PolicyTable, index: number): PolicyTable {
  const next = cloneTable(table);
  if (!canRemoveOutcome(next) || index < 0 || index >= next.outcomes.length) return next;
  const [removed] = next.outcomes.splice(index, 1);
  if (removed) for (const band of next.bands) delete band.sampleWeights[removed.name];
  return next;
}

/** Renames a column everywhere it is referenced: weights and threshold cells follow. */
export function renameOutcome(table: PolicyTable, index: number, rawName: string): PolicyTable {
  const next = cloneTable(table);
  const def = next.outcomes[index];
  const name = sanitizeName(rawName, true);
  if (!def || !name || name === def.name) return next;
  const old = def.name;
  def.name = name;
  for (const band of next.bands) {
    if (Object.hasOwn(band.sampleWeights, old)) {
      const reordered: Record<string, number> = {};
      for (const [k, v] of Object.entries(band.sampleWeights)) reordered[k === old ? name : k] = v;
      band.sampleWeights = reordered;
    }
    if (band.thresholdOutcome === old) band.thresholdOutcome = name;
  }
  return next;
}

/** The outcome column that an already-recorded value settles on, if any: a column marked final whose recorded value matches. */
export function settledOutcome(outcomes: readonly OutcomeDef[], recorded: unknown): OutcomeDef | null {
  if (typeof recorded !== 'string' || !recorded) return null;
  return outcomes.find(o => o.final && o.records === recorded) ?? null;
}

export function weightSum(band: PolicyBand, outcomeNames: readonly string[]): number {
  return outcomeNames.reduce((a, k) => a + Math.round(Number(band.sampleWeights?.[k] ?? 0) * BASIS_POINTS), 0) / BASIS_POINTS;
}
