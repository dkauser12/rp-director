/**
 * One optional behavioral reaction on an otherwise unruled turn.
 * The caller must suppress this when a concrete action ruling exists: a
 * reaction must never supply a competing result for an adjudicated action.
 * Jev selects the trigger only; configured weights and a supplied draw select
 * the reaction. This module performs no network calls and draws no randomness.
 */
import type { Question } from './types.ts';

export type ReactionKind = 'resolve' | 'secret' | 'exposure' | 'initiative';

export interface ReactionSettings {
  enabled: boolean;
  weights: Record<ReactionKind, Record<string, number>>;
}

export interface ReactionResult {
  readonly kind: ReactionKind;
  readonly actorId: string;
  readonly outcome: string;
  readonly draw: number;
  readonly instruction: string;
}

interface ReactionOption {
  readonly id: string;
  readonly label: string;
  readonly instruction: string;
}

interface ReactionGroup {
  readonly id: ReactionKind;
  readonly label: string;
  readonly options: readonly ReactionOption[];
}

const BOUNDARY = ' Apply this only to the selected NPC and the established trigger. Do not decide the player\'s actions, feelings, consent, or response. Do not invent a new consequential action or override an established outcome.';

/** Stable choice labels shared by settings controls and result displays. */
export const NPC_REACTION_GROUPS: readonly ReactionGroup[] = Object.freeze([
  {
    id: 'resolve' as const,
    label: 'NPC resolve',
    options: [
      { id: 'press', label: 'Press the objective', instruction: 'The NPC maintains the already-established objective and makes its stakes or reasons clearer through dialogue or a non-consequential reaction. Do not intensify force or settle a new contested action.' },
      { id: 'change_tactic', label: 'Change tactic', instruction: 'The NPC changes the conversational approach to the same established objective, without deciding whether the player agrees or starting a new contested action.' },
      { id: 'concede', label: 'Concede a point', instruction: 'The NPC voluntarily concedes one limited point under discussion while retaining the established objective. Do not grant unrelated rewards or decide the player\'s response.' },
      { id: 'withdraw', label: 'Withdraw for now', instruction: 'The NPC stops pressing the current objective for now. Preserve only consequences already established; do not invent a punishment, debt, or player decision.' },
    ],
  },
  {
    id: 'secret' as const,
    label: 'Secret handling',
    options: [
      { id: 'hold', label: 'Hold the secret', instruction: 'The NPC keeps the already-established secret undisclosed in this reply. Do not erase an earlier disclosure, remove visible evidence, or invent a new secret.' },
      { id: 'slip', label: 'Let a clue slip', instruction: 'The NPC gives one observable clue tied to the already-established secret. A clue does not establish that anyone noticed or understood it; leave discovery unresolved. Do not invent secret information.' },
      { id: 'reveal', label: 'Reveal deliberately', instruction: 'The NPC deliberately communicates a bounded piece of information that is already established and already known to that NPC, for an established reason. Do not invent information or decide the player\'s interpretation or response.' },
    ],
  },
  {
    id: 'exposure' as const,
    label: 'Exposure',
    options: [
      { id: 'unnoticed', label: 'Unnoticed', instruction: 'Resolve only the currently unresolved witnessing opportunity: the established potential witness does not notice this act now. Do not erase evidence or knowledge, or contradict any earlier witnessing.' },
      { id: 'suspicion', label: 'Suspicion', instruction: 'Resolve only the currently unresolved witnessing opportunity: an established potential witness visibly reacts to an observable tell without knowing more than that tell supports. Do not invent a witness, secret knowledge, or retroactive discovery.' },
      { id: 'witnessed', label: 'Witnessed', instruction: 'Resolve only the currently unresolved witnessing opportunity: an established potential witness observes the currently perceptible act. Grant no knowledge beyond what is observable; do not invent a witness or contradict an already-settled outcome.' },
    ],
  },
  {
    // Chosen by routing, not by a trigger question: the player handed this NPC the initiative.
    id: 'initiative' as const,
    label: 'Handed the initiative',
    options: [
      { id: 'takes_lead', label: 'Takes the lead', instruction: 'The player handed the NPC the initiative, and the NPC takes it now: the NPC decides how to act, within what the player invited. Describe what the NPC does and what reaches the player.' },
      { id: 'raises_stakes', label: 'Takes it and raises the stakes', instruction: 'The player handed the NPC the initiative, and the NPC takes it on the NPC\'s own terms: acting on it while adding one condition, price or consequence that makes the moment matter more, within the NPC\'s established aims.' },
      { id: 'hands_back', label: 'Hands it back with a condition', instruction: 'The player handed the NPC the initiative, and the NPC hands it back: the NPC stays engaged but names one specific thing the player must do or say first. Keep the scene moving; do not stall it.' },
      { id: 'declines', label: 'Declines for now', instruction: 'The player handed the NPC the initiative, and the NPC declines it for now, making the reason visible and carrying on with the NPC\'s own aims. Do not punish the player or end the scene.' },
    ],
  },
].map(group => Object.freeze({
  ...group,
  options: Object.freeze(group.options.map(option => Object.freeze({ ...option, instruction: option.instruction + BOUNDARY }))),
})));

/** Illustrative defaults; users may edit the relative weights. */
export function defaultReactionSettings(): ReactionSettings {
  return {
    enabled: true,
    weights: {
      resolve: { press: 40, change_tactic: 40, concede: 15, withdraw: 5 },
      secret: { hold: 75, slip: 20, reveal: 5 },
      exposure: { unnoticed: 60, suspicion: 30, witnessed: 10 },
      initiative: { takes_lead: 40, raises_stakes: 25, hands_back: 25, declines: 10 },
    },
  };
}

/** Keeps valid saved groups; old or malformed groups receive fresh defaults. */
export function normalizeReactionSettings(existing: unknown): ReactionSettings {
  const settings = defaultReactionSettings();
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return settings;
  const saved = existing as Record<string, unknown>;
  if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled;
  if (!saved.weights || typeof saved.weights !== 'object' || Array.isArray(saved.weights)) return settings;
  const weights = saved.weights as Record<string, unknown>;
  for (const group of NPC_REACTION_GROUPS) {
    try { settings.weights[group.id] = checkedWeights(group, weights[group.id]); }
    catch { /* A malformed group must not discard other valid saved groups. */ }
  }
  return settings;
}

export function reactionQuestion(actorId?: string): Question {
  return {
    type: 'choice',
    instructions: (actorId ? `Assess only the NPC with actor ID ${JSON.stringify(actorId)} in state.actors. Ignore triggers belonging only to other actors. ` : '') + 'Using state.latestInput and the visible recent exchange in state.recentAcceptedMessages, select at most one concrete NPC reaction trigger. Detect a trigger only; do not choose an outcome or set its odds. Select the first clearly established trigger if more than one applies. Choose none when the evidence is absent, ambiguous, already settled, or would require inventing an objective, secret, witness, or arbitrary escalation. Do not infer a secret from a private thought or infer that another actor knows it. A trigger never grants control over the player\'s actions, feelings, consent, or response.',
    criteria: {
      none: 'No concrete unresolved trigger is established in the latest player message and visible exchange, or the event has already been resolved.',
      resolve: 'The player resists, refuses, or deflects an NPC objective that the visible exchange already shows that NPC actively pursuing; a behavioral response remains open.',
      secret: 'The visible exchange establishes pressure on a specific existing secret held by an NPC who already knows it, and whether that NPC discloses it remains unresolved. Do not invent secret content.',
      exposure: 'The assessed NPC is present as a potential witness to a current perceptible act, with an established opportunity to observe it; whether this NPC notices remains unresolved. Do not choose this for a witness other than the assessed NPC.',
    },
  };
}

function checkedWeights(group: ReactionGroup, value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Missing NPC reaction weights for ${group.id}`);
  const weights = value as Record<string, unknown>;
  const keys = Object.keys(weights);
  if (keys.length !== group.options.length || keys.some(key => !group.options.some(option => option.id === key))) {
    throw new Error(`NPC reaction weights for ${group.id} must use exactly its catalog outcome keys`);
  }
  let total = 0;
  const clean: Record<string, number> = {};
  for (const option of group.options) {
    const weight = weights[option.id];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) throw new Error(`Invalid NPC reaction weight for ${group.id}.${option.id}`);
    clean[option.id] = weight;
    total += weight;
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error(`NPC reaction weights for ${group.id} must have a finite positive total`);
  return clean;
}

/** Selects from exact catalog keys using a supplied uniform draw in [0, 1). */
export function chooseReaction(kind: ReactionKind, settings: ReactionSettings, actorId: string, draw: number): ReactionResult {
  if (!settings?.enabled) throw new Error('NPC reactions are disabled');
  const group = NPC_REACTION_GROUPS.find(candidate => candidate.id === kind);
  if (!group) throw new Error(`Unknown NPC reaction kind: ${String(kind)}`);
  if (typeof actorId !== 'string' || !actorId.trim()) throw new Error('NPC reaction requires an actor ID');
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('NPC reaction draw must be finite and in [0, 1)');
  const weights = checkedWeights(group, settings.weights?.[kind]);
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const target = draw * total;
  let cumulative = 0;
  let selected: ReactionOption | undefined;
  for (const option of group.options) {
    const weight = weights[option.id]!;
    if (weight === 0) continue;
    selected = option;
    cumulative += weight;
    if (target < cumulative) break;
  }
  // The last positive option also handles floating-point rounding at the edge.
  return Object.freeze({ kind, actorId, outcome: selected!.id, draw, instruction: selected!.instruction });
}
