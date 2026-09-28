/**
 * Genre pack: everything genre-specific that the staged pipeline asks the
 * judge. Stage builders read only from a pack, so a genre changes by data,
 * never by editing question text. Resolution mode, module switches and the
 * outcome table are deliberately not pack data.
 *
 * A pack also defines its meters: plain-language scales (regard, loyalty,
 * suspicion…) that the judge assesses from play. Meters are never counters and
 * never written by the writer model; see src/pipeline/character-state.ts.
 */

export type ActorKind = 'player' | 'npc' | 'faction';
export type FamilyKind = 'change' | 'discovery';
/**
 * `lore` is lorebook text chosen by the lore stage. Discovery may list it, but
 * only entries from books the user has declared public ever reach a discovery
 * ruling (the firewall is applied by visibility, see pipeline/evidence.ts).
 */
export type EvidenceSource = 'transcript' | 'owner_card' | 'target_card' | 'meters' | 'state' | 'lore';

export const EVIDENCE_SOURCES: readonly EvidenceSource[] = ['transcript', 'owner_card', 'target_card', 'meters', 'state', 'lore'];
/** Sources that carry authorial truth or inner feelings; never admissible for discovery. */
export const PRIVATE_SOURCES: readonly EvidenceSource[] = ['owner_card', 'target_card', 'meters'];

export interface PackFamily {
  key: string;
  label: string;
  /** What moves belong to this family; read by routing. */
  definition: string;
  /** Discovery families carry the detection firewall and cannot be reclassified. */
  kind: FamilyKind;
  /** One sentence the ruling applies: what success means for this family. */
  successSemantics: string;
  /** Allowlist of evidence the ruling may see (intersected with the firewall). */
  evidence: EvidenceSource[];
}

/** A scale the judge places each character on, from what happens in play. */
export interface MeterDef {
  key: string;
  /** Shown to the writer and in settings; {{player}} becomes the player's name. */
  label: string;
  /** What the meter measures, for the judge. */
  about: string;
  /** 3 to 7 plain-language levels, lowest first. */
  levels: string[];
  /** Level index used until the first assessment. */
  initial: number;
}

export interface GenrePack {
  id: string;
  version: number;
  label: string;
  /** One or two sentences shown in settings. */
  description: string;
  actors: { kinds: ActorKind[]; rulableOwners: ActorKind[] };
  /** What counts as a checkable move, and what never does. */
  gate: { include: string[]; exclude: string[] };
  /** Added to the core protections; a pack can never remove one. */
  protected: string[];
  families: PackFamily[];
  meters: MeterDef[];
}

/** Always applied, whatever the pack says. */
export const CORE_PROTECTED: readonly string[] = Object.freeze([
  'The player\'s voluntary speech, actions, feelings, consent and decisions are the player\'s own; never decide them.',
  'Do not assume feelings, attraction, trust or willingness beyond what the supplied evidence shows.',
]);

export const RESERVED_KEYS = new Set(['NONE', 'UNSUPPORTED', 'UNRESOLVED', 'ROUTINE']);
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Shared gate lines every built-in pack uses. */
export const HANDOFF_LINE = 'An explicit hand-off: the player invites, orders or dares a character to act, or gives them the initiative.';
export const ROUTINE_LINE = 'Actions that are routine or effectively certain for whoever performs them, such as a ruler\'s everyday command to their own servants or a practised task done in calm conditions.';
export const SMALL_TALK_LINE = 'Ordinary conversation, the player\'s own feelings, wants or decisions, observation, out-of-character remarks, trivial activity, and anything the scene has already settled.';

export const DEFAULT_PACK: GenrePack = deepFreeze({
  id: 'default',
  version: 3,
  label: 'General',
  description: 'Works for most roleplay. Rules physical, social and stealth attempts with seven broad kinds of move; tracks how each character regards the player.',
  actors: { kinds: ['player', 'npc'], rulableOwners: ['player', 'npc'] },
  gate: {
    include: [
      'An attempt to change the situation where failure is genuinely possible and would materially change what happens: overcoming an obstacle, contesting opposition, evading, concealing or deceiving, discovering a hidden fact, pressing someone for specific conduct, or securing access, information, possession or a commitment.',
      HANDOFF_LINE,
    ],
    exclude: [SMALL_TALK_LINE, ROUTINE_LINE],
  },
  protected: [],
  families: [
    { key: 'overcome_operate', label: 'Overcome / operate', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'state'],
      definition: 'Overcome an obstacle, or operate, repair, treat, craft, break or create something.',
      successSemantics: 'The concrete method, given the actor\'s established competence, tools and conditions, produces the specified result now.' },
    { key: 'contest_impose', label: 'Contest / impose', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters', 'state'],
      definition: 'Actively overcome opposition: attack, grapple, restrain, seize, interrupt, force or outmanoeuvre.',
      successSemantics: 'The acting side overcomes the active opposition in this one exchange; the same contest is not resolved twice.' },
    { key: 'evade_resist', label: 'Evade / resist', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters', 'state'],
      definition: 'Escape, dodge, withstand, keep control, or avoid an imposed consequence.',
      successSemantics: 'The actor avoids or withstands the specified consequence in this exchange.' },
    { key: 'conceal_deceive', label: 'Conceal / deceive', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters', 'state'],
      definition: 'Lie, hide, sneak, take something unnoticed, disguise, misdirect or keep up an alibi.',
      successSemantics: 'The concealment or deception holds now against the named observers, judged by what they could perceive or verify.' },
    { key: 'detect_discover', label: 'Detect / discover', kind: 'discovery', evidence: ['transcript', 'lore', 'state'],
      definition: 'Notice, search, investigate, read a tell, catch a lie, or establish a hidden fact from visible cues.',
      successSemantics: 'The observer establishes the specified fact now from cues visible in the scene and their own public capabilities; hidden truth that nothing in the scene has shown is not evidence.' },
    { key: 'influence_negotiate', label: 'Influence / negotiate', kind: 'change', evidence: ['transcript', 'lore', 'target_card', 'meters', 'state'],
      definition: 'Seek one specific, immediate conduct from someone through a request, bargain, argument, threat or pressure.',
      successSemantics: 'The target chooses the specified conduct now, given their established interests, boundaries and leverage; what the player says or offers is evidence about how the target may respond.' },
    { key: 'acquire_secure', label: 'Acquire / secure', kind: 'change', evidence: ['transcript', 'lore', 'owner_card', 'target_card', 'meters', 'state'],
      definition: 'Secure bounded access, information, possession, permission or a commitment.',
      successSemantics: 'The specified access, information, possession or commitment is secured now.' },
  ],
  meters: [
    { key: 'regard', label: 'regard for {{player}}', about: 'How the character feels about the player right now: warmth, respect and trust together.', levels: ['hostile', 'cold', 'neutral', 'warm', 'devoted'], initial: 2 },
  ],
}) as GenrePack;

export function protectedLines(pack: GenrePack): string[] {
  return [...CORE_PROTECTED, ...pack.protected.filter(line => typeof line === 'string' && line.trim())];
}

export function familyByKey(pack: GenrePack, key: string): PackFamily | null {
  return pack.families.find(f => f.key === key) ?? null;
}

export function meterLabel(meter: MeterDef, playerName: string): string {
  return meter.label.replace(/\{\{\s*player\s*\}\}/gi, playerName);
}

const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

export function validatePack(pack: GenrePack): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!pack || typeof pack !== 'object') return { ok: false, errors: ['pack must be an object'] };
  if (!KEY.test(String(pack.id ?? ''))) errors.push('id must be lowercase letters, digits and underscores');
  if (!Number.isInteger(pack.version) || pack.version < 1) errors.push('version must be a positive integer');
  if (!text(pack.label, 80)) errors.push('label is required (up to 80 characters)');
  if (!text(pack.description, 300)) errors.push('description is required (up to 300 characters)');
  const kinds = pack.actors?.kinds ?? [];
  const owners = pack.actors?.rulableOwners ?? [];
  if (!kinds.includes('player')) errors.push('actors.kinds must include player');
  if (!owners.includes('player')) errors.push('actors.rulableOwners must include player');
  for (const owner of owners) if (!kinds.includes(owner)) errors.push(`actors.rulableOwners has ${owner}, which is not in actors.kinds`);
  if (!Array.isArray(pack.gate?.include) || pack.gate.include.length === 0 || !pack.gate.include.every(line => text(line, 600))) errors.push('gate.include needs at least one criterion (up to 600 characters each)');
  if (!Array.isArray(pack.gate?.exclude) || !pack.gate.exclude.every(line => text(line, 600))) errors.push('gate.exclude must be a list of criteria');
  if (!Array.isArray(pack.protected) || !pack.protected.every(line => text(line, 600))) errors.push('protected must be a list of sentences');
  const families = Array.isArray(pack.families) ? pack.families : [];
  if (families.length === 0 || families.length > 250) errors.push('families: between 1 and 250 are required');
  const seen = new Set<string>();
  for (const family of families) {
    const key = String(family?.key ?? '');
    if (RESERVED_KEYS.has(key)) { errors.push(`family key ${key} is reserved`); continue; }
    if (!KEY.test(key)) { errors.push(`family key "${key}" must be lowercase letters, digits and underscores`); continue; }
    if (seen.has(key)) errors.push(`duplicate family ${key}`);
    seen.add(key);
    if (!text(family.label, 80)) errors.push(`${key}: label is required`);
    if (!text(family.definition, 600)) errors.push(`${key}: definition is required (up to 600 characters)`);
    if (!text(family.successSemantics, 600)) errors.push(`${key}: successSemantics is required (up to 600 characters)`);
    if (family.kind !== 'change' && family.kind !== 'discovery') errors.push(`${key}: kind must be change or discovery`);
    const evidence = Array.isArray(family.evidence) ? family.evidence : [];
    for (const source of evidence) if (!EVIDENCE_SOURCES.includes(source)) errors.push(`${key}: unknown evidence source ${String(source)}`);
    if (!evidence.includes('transcript')) errors.push(`${key}: evidence must include transcript`);
    if (family.kind === 'discovery') for (const source of evidence) if (PRIVATE_SOURCES.includes(source)) errors.push(`${key}: a discovery family may not read ${source}`);
  }
  const meters = Array.isArray(pack.meters) ? pack.meters : null;
  if (!meters) errors.push('meters must be a list (it may be empty)');
  else {
    if (meters.length > 4) errors.push('at most 4 meters');
    const meterKeys = new Set<string>();
    for (const meter of meters) {
      const key = String(meter?.key ?? '');
      if (!KEY.test(key)) { errors.push(`meter key "${key}" must be lowercase letters, digits and underscores`); continue; }
      if (meterKeys.has(key)) errors.push(`duplicate meter ${key}`);
      meterKeys.add(key);
      if (!text(meter.label, 80)) errors.push(`meter ${key}: label is required`);
      if (!text(meter.about, 300)) errors.push(`meter ${key}: about is required (up to 300 characters)`);
      const levels = Array.isArray(meter.levels) ? meter.levels : [];
      if (levels.length < 3 || levels.length > 7) errors.push(`meter ${key}: needs 3 to 7 levels`);
      if (!levels.every(level => text(level, 40))) errors.push(`meter ${key}: every level needs a short name`);
      if (new Set(levels).size !== levels.length) errors.push(`meter ${key}: level names must be unique`);
      if (!Number.isInteger(meter.initial) || meter.initial < 0 || meter.initial >= levels.length) errors.push(`meter ${key}: initial must be a level index`);
    }
  }
  return { ok: errors.length === 0, errors };
}
