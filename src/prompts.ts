/**
 * Prompt blocks injected before the writer (plan §5.5, §7).
 *
 * The binding block states the frozen outcome as a hard constraint. Its body
 * is the outcome's own instruction, written by the player in the policy table.
 * The advisory block, when a profile enables it, is a separate section; turning
 * advisory influence to zero removes only the advisory section and never the
 * frozen constraint.
 */
import type { ActionSpec, Outcome } from './types.ts';

export interface BindingBlockInput {
  action: ActionSpec;
  /** Outcome column name from the profile's table. */
  outcome: Outcome;
  /** The outcome's instruction to the writer. Placeholders are filled here. */
  instruction: string;
  actorName?: string;
  speakerName: string | null;
  playerName: string;
  targetNames: string[];
  npcActionPolicy?: 'defer' | 'checkpoint' | 'permitted';
}

/** Placeholders an outcome instruction may use. */
export const INSTRUCTION_PLACEHOLDERS = ['gain', 'action', 'target', 'player', 'speaker'] as const;

export function fillPlaceholders(text: string, values: Record<(typeof INSTRUCTION_PLACEHOLDERS)[number], string>): string {
  return String(text ?? '').replace(/\{\{\s*(gain|action|target|player|speaker)\s*\}\}/gi, (_, key: string) => values[key.toLowerCase() as keyof typeof values] ?? '');
}

/** Placeholder values for one action, shared by the writer's block and the review popup so both read the same. */
export function placeholderValues(action: Pick<ActionSpec, 'requestedGain' | 'attemptedAction'>, targetNames: string[], speakerName: string | null, playerName: string): Record<(typeof INSTRUCTION_PLACEHOLDERS)[number], string> {
  const target = targetNames.length ? targetNames.join(' and ') : (speakerName ?? 'the other character');
  return { gain: action.requestedGain, action: action.attemptedAction, target, player: playerName, speaker: speakerName ?? target };
}

export function bindingBlock(input: BindingBlockInput): string {
  const { action, outcome } = input;
  const instruction = fillPlaceholders(input.instruction, placeholderValues(action, input.targetNames, input.speakerName, input.playerName)).trim();
  const lines: string[] = [];
  lines.push('[Director ruling — binding for this reply]');
  lines.push('This declared exchange is already adjudicated. Do not roll dice or run another check for it.');
  lines.push(`Acting character: ${input.actorName ?? input.playerName}.`);
  lines.push(`Attempt (${action.templateId.replace(/_/g, ' ')}): ${action.attemptedAction}`);
  lines.push(`Bounded intended result: ${action.requestedGain}`);
  if (action.failureStake) {
    const detail = action.failureStake.detail.trim().replace(/[.!?]+$/, '');
    lines.push(`Failure-stakes boundary: ${action.failureStake.kind.replace(/_/g, ' ')}${detail ? ` — ${detail}` : ''}. Do not invent a larger consequence than this boundary permits.`);
  }
  lines.push(`Ruling: ${outcome}.`);
  if (action.additionalAttemptsPolicy === 'defer_after_first') lines.push('The user bundled multiple consequential attempts. Apply this ruling only to the first primary attempt. Do not complete the later attempts in this reply; leave them pending in the fiction.');
  if (instruction) lines.push(instruction);
  if ((input.npcActionPolicy ?? 'defer') === 'defer') lines.push('Do not invent and resolve a new uncertain consequential NPC skill action in this same reply. NPCs may react, apply already-established capabilities, create pressure, or set up a later contest, but a new uncertain NPC attempt must remain unresolved for a future turn.');
  if (input.npcActionPolicy === 'checkpoint') lines.push('A separate Director checkpoint below governs any newly planned uncertain consequential NPC action. Follow it before prose; do not decide that action yourself.');
  if (input.npcActionPolicy === 'permitted') lines.push('Apply only the separate attempt-scoped turn permit below. Do not add another consequential NPC action.');
  if (input.speakerName) lines.push(`Reply as ${input.speakerName}. Do not write voluntary actions, speech, thoughts, feelings, consent, or decisions for ${input.playerName}; when an NPC acts against the player, describe only what reaches or is imposed on the player's body and leave the player's reaction open.`);
  return lines.join('\n');
}

export interface AdvisoryBlockInput {
  influence: number;
  notes: string[];
}

export function advisoryBlock(input: AdvisoryBlockInput): string {
  if (!(input.influence > 0) || input.notes.length === 0) return '';
  const lines = ['[Director guidance — advisory]'];
  for (const note of input.notes) lines.push('- ' + note);
  return lines.join('\n');
}

export function combinedBlock(binding: string, advisory: string): string {
  return [binding, advisory].filter(s => s && s.trim()).join('\n\n');
}
