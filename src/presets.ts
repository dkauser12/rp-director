/**
 * Ready-made policy tables by genre. A preset is only a starting point: it
 * fills the editor's draft, and every name, instruction, recorded value and
 * number stays editable. Nothing in the code depends on these names.
 *
 * Columns run from worst to best for the player. Instructions may use
 * {{gain}}, {{action}}, {{target}}, {{player}} and {{speaker}}.
 */
import type { ActorPolicy, OutcomeDef, PolicyBand } from './types.ts';
import { DEFAULT_OUTCOMES, validateTable } from './table.ts';

export interface TablePreset {
  id: string;
  label: string;
  description: string;
  outcomes: OutcomeDef[];
  bands: PolicyBand[];
  /** Optional local recommendation applied with the table, never on discovery. */
  actorPolicy?: ActorPolicy;
  resolutionMethod?: 'threshold' | 'sample';
}

export interface LocalPresetLoadResult {
  loaded: string[];
  warnings: string[];
}

/** Builds rows from `[upper, thresholdOutcome, weights-in-column-order]`. */
function rows(outcomes: OutcomeDef[], spec: [number, string, number[]][]): PolicyBand[] {
  let lower = 0;
  return spec.map(([upper, thresholdOutcome, weights], i) => {
    const band: PolicyBand = {
      id: `b${i}`,
      lowerInclusive: lower,
      upper,
      upperInclusive: i === spec.length - 1,
      thresholdOutcome,
      sampleWeights: Object.fromEntries(outcomes.map((o, c) => [o.name, weights[c] ?? 0])),
    };
    lower = upper;
    return band;
  });
}

const standardOutcomes: OutcomeDef[] = structuredClone(DEFAULT_OUTCOMES);

const adventureOutcomes: OutcomeDef[] = [
  { name: 'blocked', instruction: 'The attempt fails and this route is closed: {{target}} will not give {{gain}} this way again. Make the refusal definite and in character, and let the scene move on from it.', records: 'blocked', final: true },
  { name: 'setback', instruction: 'The attempt fails and costs something concrete right now: time, position, a resource, or {{target}}\'s goodwill. {{gain}} is not given. Show the cost in the scene and do not soften it.', records: 'setback', final: false },
  { name: 'not_yet', instruction: '{{gain}} is not given in this reply. Questioning, waiting, a condition, or pointing to another route are all fine. Nothing {{player}} already has is lost.', records: '', final: false },
  { name: 'foothold', instruction: 'Only a concrete partial step toward {{gain}} happens: a condition named, a door half opened, a lead. The gain itself is not delivered.', records: 'partial', final: false },
  { name: 'success', instruction: '{{gain}} is delivered exactly as declared and nothing beyond it. No bonus loot, information, or loyalty, and no narration of {{player}}\'s choices.', records: 'achieved', final: true },
];

const datingOutcomes: OutcomeDef[] = [
  { name: 'turned_off', instruction: '{{target}} is put off by this. Interest cools noticeably and {{gain}} is refused. Show the chill in behavior, not in a speech, and do not resolve it in this reply.', records: 'cooled', final: false },
  { name: 'deflected', instruction: '{{target}} sidesteps: changes the subject, teases, or stalls. {{gain}} is not given in this reply and nothing is lost.', records: '', final: false },
  { name: 'warming', instruction: '{{target}} does not give {{gain}} yet but visibly warms: a smaller concession, a lingering moment, or an opening for next time.', records: 'partial', final: false },
  { name: 'yes', instruction: '{{target}} gives {{gain}} exactly as asked, in their own voice and on their own terms. Nothing more is conceded than what was asked, and {{player}}\'s reactions are left to the player.', records: 'achieved', final: true },
];

const romComOutcomes: OutcomeDef[] = [
  { name: 'backfires', instruction: 'The attempt backfires in an embarrassing, comic way. {{gain}} is not given, and a new complication or misunderstanding now exists that {{player}} will have to deal with. Keep it light; the embarrassment is the cost.', records: 'complicated', final: false },
  { name: 'interrupted', instruction: 'Something or someone interrupts before {{target}} can answer. {{gain}} is neither given nor refused. End the beat on the interruption.', records: '', final: false },
  { name: 'mixed_signal', instruction: '{{target}} half-gives: a partial, ambiguous version of {{gain}} that can be read two ways. Do not resolve the ambiguity in this reply.', records: 'partial', final: false },
  { name: 'lands', instruction: 'It works. {{target}} gives {{gain}} exactly as asked, with a beat of genuine warmth under the comedy. Nothing beyond what was asked.', records: 'achieved', final: true },
];

const politicalOutcomes: OutcomeDef[] = [
  { name: 'exposed', instruction: 'The attempt fails and is noticed by someone who can use it. {{gain}} is refused, and {{player}}\'s position is weaker than before: a rival learns of the move, a favor is burned, or leverage shifts. State the concrete political cost.', records: 'exposed', final: false },
  { name: 'refused', instruction: '{{target}} refuses plainly and gives a reason rooted in their own interests. {{gain}} is not given, and this same request will not be reconsidered; only a different offer can reopen it.', records: 'refused', final: true },
  { name: 'stalled', instruction: '{{target}} neither agrees nor refuses: they ask for time, defer to others, or name no terms yet. {{gain}} is not given in this reply.', records: '', final: false },
  { name: 'conditional', instruction: '{{target}} will give {{gain}} only for a price they name now: a concession, a vote, a public stance. The gain is not delivered until {{player}} meets it.', records: 'partial', final: false },
  { name: 'secured', instruction: '{{target}} commits to {{gain}} exactly as asked. Make the commitment explicit and attributable. No additional support or loyalty is implied.', records: 'achieved', final: true },
];

export const TABLE_PRESETS: TablePreset[] = [
  {
    id: 'standard',
    label: 'Standard (no failure)',
    description: 'The starter table: not yet, a partial step, or the full gain. A failed attempt only delays.',
    outcomes: standardOutcomes,
    bands: rows(standardOutcomes, [
      [0.25, 'deferred', [0.9, 0.1, 0]],
      [0.5, 'deferred', [0.7, 0.25, 0.05]],
      [0.75, 'progress_only', [0.35, 0.45, 0.2]],
      [1, 'achieved', [0.1, 0.2, 0.7]],
    ]),
  },
  {
    id: 'adventure',
    label: 'Adventure RP',
    description: 'Real failure: a route can be blocked for good, and a bad attempt costs something. Footholds and clean successes at the top.',
    outcomes: adventureOutcomes,
    bands: rows(adventureOutcomes, [
      [0.1, 'blocked', [0.5, 0.35, 0.15, 0, 0]],
      [0.25, 'setback', [0.15, 0.45, 0.3, 0.1, 0]],
      [0.5, 'not_yet', [0.05, 0.2, 0.45, 0.25, 0.05]],
      [0.75, 'foothold', [0, 0.1, 0.25, 0.45, 0.2]],
      [1, 'success', [0, 0.05, 0.1, 0.2, 0.65]],
    ]),
  },
  {
    id: 'dating_sim',
    label: 'Dating sim',
    description: 'Interest can cool. Deflection loses nothing, warming is partial progress, and a yes is exactly what was asked.',
    outcomes: datingOutcomes,
    bands: rows(datingOutcomes, [
      [0.2, 'turned_off', [0.55, 0.4, 0.05, 0]],
      [0.5, 'deflected', [0.15, 0.6, 0.2, 0.05]],
      [0.75, 'warming', [0.05, 0.3, 0.45, 0.2]],
      [1, 'yes', [0, 0.1, 0.25, 0.65]],
    ]),
  },
  {
    id: 'rom_com',
    label: 'Rom-com',
    description: 'Failure is a comic complication, not a loss. Interruptions and mixed signals in the middle, a clean landing at the top.',
    outcomes: romComOutcomes,
    bands: rows(romComOutcomes, [
      [0.2, 'backfires', [0.5, 0.35, 0.15, 0]],
      [0.45, 'interrupted', [0.25, 0.4, 0.3, 0.05]],
      [0.75, 'mixed_signal', [0.1, 0.25, 0.45, 0.2]],
      [1, 'lands', [0.05, 0.1, 0.25, 0.6]],
    ]),
  },
  {
    id: 'political_sim',
    label: 'Political sim',
    description: 'A failed move can be exposed and weaken your position, or be refused for good. Stalls, priced deals, and explicit commitments above that.',
    outcomes: politicalOutcomes,
    bands: rows(politicalOutcomes, [
      [0.1, 'exposed', [0.45, 0.4, 0.15, 0, 0]],
      [0.3, 'refused', [0.15, 0.45, 0.3, 0.1, 0]],
      [0.55, 'stalled', [0.05, 0.2, 0.45, 0.25, 0.05]],
      [0.8, 'conditional', [0, 0.1, 0.25, 0.45, 0.2]],
      [1, 'secured', [0, 0.05, 0.1, 0.25, 0.6]],
    ]),
  },
];

export function presetById(id: string): TablePreset | null {
  const p = TABLE_PRESETS.find(x => x.id === id);
  return p ? structuredClone(p) : null;
}

/**
 * What loading a preset puts in the editor. The resolution method is the
 * player's own mode choice, so a preset never changes it; a preset written for
 * the other method is reported instead.
 */
export function presetDraft(preset: TablePreset, currentMethod: 'threshold' | 'sample'): { table: { outcomes: OutcomeDef[]; bands: PolicyBand[] }; method: 'threshold' | 'sample'; note: string | null } {
  const label = (m: 'threshold' | 'sample') => m === 'sample' ? 'dice (sample)' : 'threshold';
  const note = preset.resolutionMethod && preset.resolutionMethod !== currentMethod
    ? `This preset was written for ${label(preset.resolutionMethod)}; your resolution method stays ${label(currentMethod)}.`
    : null;
  return { table: structuredClone({ outcomes: preset.outcomes, bands: preset.bands }), method: currentMethod, note };
}

const ACTOR_POLICIES: ActorPolicy[] = ['player_favorable', 'player_attempts', 'contested', 'any_declared_actor'];

/**
 * Validates and registers local-only preset data. This is the seam used by
 * profiles/local/presets.json, which is gitignored so personal policy never
 * leaks into the distributable project or bundle.
 */
export function registerLocalPresets(raw: unknown): LocalPresetLoadResult {
  const loaded: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { loaded, warnings: ['local preset document must be an object'] };
  const doc = raw as { schemaVersion?: unknown; presets?: unknown };
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.presets)) return { loaded, warnings: ['local preset document needs schemaVersion 1 and a presets array'] };
  for (const [index, candidate] of doc.presets.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { warnings.push(`preset ${index + 1}: must be an object`); continue; }
    const p = candidate as Partial<TablePreset>;
    const id = String(p.id ?? '');
    const allowedKeys = new Set(['id', 'label', 'description', 'outcomes', 'bands', 'actorPolicy', 'resolutionMethod']);
    const extraKeys = Object.keys(candidate).filter(key => !allowedKeys.has(key));
    if (extraKeys.length) { warnings.push(`preset ${id || index + 1}: unsupported fields ${extraKeys.join(', ')}`); continue; }
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) { warnings.push(`preset ${index + 1}: invalid id`); continue; }
    if (TABLE_PRESETS.some(existing => existing.id === id)) { warnings.push(`preset ${id}: duplicate id`); continue; }
    if (typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80) { warnings.push(`preset ${id}: invalid label`); continue; }
    if (typeof p.description !== 'string' || !p.description.trim() || p.description.length > 300) { warnings.push(`preset ${id}: invalid description`); continue; }
    const table = { outcomes: Array.isArray(p.outcomes) ? p.outcomes : [], bands: Array.isArray(p.bands) ? p.bands : [] } as { outcomes: OutcomeDef[]; bands: PolicyBand[] };
    const outcomeKeys = new Set(['name', 'instruction', 'records', 'final']);
    const bandKeys = new Set(['id', 'lowerInclusive', 'upper', 'upperInclusive', 'thresholdOutcome', 'sampleWeights']);
    if (table.outcomes.some(outcome => !outcome || typeof outcome !== 'object' || Object.keys(outcome).some(key => !outcomeKeys.has(key)))) { warnings.push(`preset ${id}: outcome fields are not declarative`); continue; }
    if (table.bands.some(band => !band || typeof band !== 'object' || Object.keys(band).some(key => !bandKeys.has(key)))) { warnings.push(`preset ${id}: band fields are not declarative`); continue; }
    const validation = validateTable(table);
    if (!validation.ok) { warnings.push(`preset ${id}: ${validation.errors.join('; ')}`); continue; }
    if (p.actorPolicy !== undefined && !ACTOR_POLICIES.includes(p.actorPolicy)) { warnings.push(`preset ${id}: invalid actorPolicy`); continue; }
    if (p.resolutionMethod !== undefined && p.resolutionMethod !== 'threshold' && p.resolutionMethod !== 'sample') { warnings.push(`preset ${id}: invalid resolutionMethod`); continue; }
    TABLE_PRESETS.push(structuredClone({
      id,
      label: p.label.trim(),
      description: p.description.trim(),
      outcomes: table.outcomes,
      bands: table.bands,
      actorPolicy: p.actorPolicy,
      resolutionMethod: p.resolutionMethod,
    }));
    loaded.push(id);
  }
  return { loaded, warnings };
}

/** Missing local data is normal. Invalid data is ignored and reported. */
export async function loadLocalPresets(fetcher: typeof fetch = fetch): Promise<LocalPresetLoadResult> {
  try {
    const url = new URL('./profiles/local/presets.json', import.meta.url);
    const response = await fetcher(url.href, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 404) return { loaded: [], warnings: [] };
    if (!response.ok) return { loaded: [], warnings: [`local preset fetch failed: HTTP ${response.status}`] };
    const text = await response.text();
    if (text.length > 65536) return { loaded: [], warnings: ['local preset document exceeds 64 KiB'] };
    return registerLocalPresets(JSON.parse(text));
  } catch (error) {
    return { loaded: [], warnings: [`local preset load failed: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
