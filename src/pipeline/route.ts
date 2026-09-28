/**
 * Route derivation (staged stage B). The judge answers five independent
 * routing questions; code turns them into one route. Anything unresolved is an
 * explicit UNRULED status, never a default ruling.
 */
import type { GenrePack } from '../pack/pack.ts';
import { familyByKey } from '../pack/pack.ts';

export type Route = 'DIRECT_ATTEMPT' | 'SPECIFIED_NPC_MOVE' | 'HANDOFF' | 'UNRULED';
export type ActionSpecification = 'SPECIFIED_HERE' | 'SPECIFIED_BY_PUBLIC_REFERENCE' | 'UNSPECIFIED_INITIATIVE';

export interface RoutingAnswers {
  owner: string | null;
  target: string | null;
  family: string | null;
  specification: string | null;
  antecedent: string | null;
}

export interface MoveRoute {
  route: Route;
  reason: string;
  ownerId: string | null;
  /** An actor id, SELF, SEVERAL or SCENE; null when unresolved (the move is still ruled, without a single target). */
  targetId: string | null;
  familyKey: string | null;
  specification: ActionSpecification | null;
  antecedentId: string | null;
}

const SPECIFICATIONS: ActionSpecification[] = ['SPECIFIED_HERE', 'SPECIFIED_BY_PUBLIC_REFERENCE', 'UNSPECIFIED_INITIATIVE'];

export function deriveRoute(answers: RoutingAnswers, context: { playerId: string; npcIds: string[]; pack: GenrePack }): MoveRoute {
  const unruled = (reason: string): MoveRoute => ({
    route: 'UNRULED', reason,
    ownerId: answers.owner && answers.owner !== 'UNRESOLVED' ? answers.owner : null,
    targetId: answers.target && answers.target !== 'UNRESOLVED' ? answers.target : null,
    familyKey: answers.family && familyByKey(context.pack, answers.family) ? answers.family : null,
    specification: SPECIFICATIONS.includes(answers.specification as ActionSpecification) ? answers.specification as ActionSpecification : null,
    // The earlier passage is part of the move only when the move points back to it.
    antecedentId: answers.specification === 'SPECIFIED_BY_PUBLIC_REFERENCE' && answers.antecedent && !['NONE', 'UNRESOLVED'].includes(answers.antecedent) ? answers.antecedent : null,
  });
  for (const key of ['owner', 'target', 'family', 'specification', 'antecedent'] as const) {
    if (!answers[key]) return unruled(`the ${key} answer is missing`);
  }
  const owner = answers.owner!;
  if (owner === 'UNRESOLVED') return unruled('the owner is unresolved');
  const isPlayer = owner === context.playerId;
  const isNpc = context.npcIds.includes(owner);
  if (!isPlayer && !isNpc) return unruled(`the owner ${owner} is not a known actor`);
  const specification = answers.specification!;
  if (specification === 'UNRESOLVED' || !SPECIFICATIONS.includes(specification as ActionSpecification)) return unruled('the action specification is unresolved');

  if (specification === 'UNSPECIFIED_INITIATIVE') {
    // The character receiving the initiative acts next: the owner if it is a
    // character, otherwise the target (the judge may name the player as owner).
    const recipient = isNpc ? owner : answers.target && context.npcIds.includes(answers.target) ? answers.target : null;
    if (!recipient) return unruled('no character receives the handed-over initiative');
    return { ...unruled(''), route: 'HANDOFF', reason: 'the player handed this character the initiative', ownerId: recipient, specification: 'UNSPECIFIED_INITIATIVE' };
  }
  if (answers.family === 'UNSUPPORTED' || !familyByKey(context.pack, answers.family!)) return unruled('no supported kind of move fits');
  if (specification === 'SPECIFIED_BY_PUBLIC_REFERENCE' && (answers.antecedent === 'UNRESOLVED' || answers.antecedent === 'NONE')) return unruled('the referenced earlier passage could not be identified');
  if (isNpc && !context.pack.actors.rulableOwners.includes('npc')) return unruled('this pack does not rule on NPC-owned moves');
  const base = unruled('');
  return {
    ...base,
    route: isPlayer ? 'DIRECT_ATTEMPT' : 'SPECIFIED_NPC_MOVE',
    reason: isPlayer ? 'the player attempts the change' : 'the player directs a character to act',
    ownerId: owner,
  };
}
