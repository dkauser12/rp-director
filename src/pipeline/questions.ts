/**
 * Staged question builders. Every genre-specific word comes from the pack;
 * these builders only add the structure of each stage. Questions within one
 * request never depend on each other's answers.
 */
import type { GenrePack, PackFamily } from '../pack/pack.ts';
import { protectedLines } from '../pack/pack.ts';
import type { Span } from './spans.ts';

export interface ChoiceQuestion { type: 'choice'; instructions: string; criteria: Record<string, string> }
export interface NoulQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }

const criteriaText = (pack: GenrePack) =>
  `A move to rule on is: ${pack.gate.include.join(' ')}${pack.gate.exclude.length ? ` It is not: ${pack.gate.exclude.join(' ')}` : ''}`;

/** Stage A: which verbatim passage of the latest message is the move. */
export function moveQuestion(spans: Span[], pack: GenrePack): ChoiceQuestion {
  const criteria: Record<string, string> = {};
  for (const span of spans) criteria[span.id] = span.text;
  criteria.ROUTINE = 'The message does act, but everything in it is routine or effectively certain for whoever performs it; nothing needs a ruling.';
  criteria.NONE = 'No passage of the latest message contains a move to rule on, including out-of-character discussion or requests to pause roleplay.';
  return {
    type: 'choice',
    instructions: `Using state.latestInput and the public exchange in state.recentAcceptedMessages, select the passage of the player's latest message that states the FIRST move to rule on. ${criteriaText(pack)} Prefer the shortest passage that states the whole move; choose a longer one only when the move runs across it. Choose ROUTINE when the message only contains actions that are routine or effectively certain for whoever performs them, and NONE when it contains no attempt at all. Do not invent a goal the passage does not state.`,
    criteria,
  };
}

/** Stage A, independent of the selection: whether the message bundles moves. */
export function countQuestion(pack: GenrePack): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: `How many separate moves to rule on does the player's latest message (state.latestInput) contain? ${criteriaText(pack)} Steps toward one goal, and routine or certain actions along the way, are part of one move. Count multiple only when two or more moves would each need their own ruling.`,
    criteria: {
      one: 'At most one such move.',
      multiple: 'Two or more separate moves, each of which would need its own ruling.',
    },
  };
}

export interface RouteQuestionInput {
  /** Actor id -> display name, player first. */
  actorNames: Record<string, string>;
  playerId: string;
  pack: GenrePack;
  /** Verbatim passages of the last NPC message(s) the move may refer back to. */
  antecedents: { id: string; text: string }[];
}

/** Stage B: the adjudication address of the selected passage (state.move.passage). */
export function routeQuestions(input: RouteQuestionInput): Record<string, ChoiceQuestion> {
  const people: Record<string, string> = {};
  for (const [id, name] of Object.entries(input.actorNames)) people[id] = id === input.playerId ? `${name} (the player)` : name;
  const families: Record<string, string> = {};
  for (const family of input.pack.families) families[family.key] = `${family.label}: ${family.definition}`;
  families.UNSUPPORTED = 'None of these kinds of move fits the passage.';
  const antecedents: Record<string, string> = {};
  for (const candidate of input.antecedents) antecedents[candidate.id] = candidate.text;
  const passage = 'The selected passage of the player\'s latest message is state.move.passage; read it within state.latestInput and the public exchange.';
  return {
    owner: {
      type: 'choice',
      instructions: `${passage} Who is making this move? For a request, persuasion, pressure, a bargain or a threat, the owner is whoever is asking or pressing (usually the player), and the target is the one being asked. A character is the owner only when the player gives that character a task to carry out with their own abilities (an order or a dare, such as "pick that lock") or hands them the initiative (such as "go ahead, make me"). Choose UNRESOLVED if the passage and the public exchange do not show it.`,
      criteria: { ...people, UNRESOLVED: 'The owner cannot be told from the passage and the public exchange.' },
    },
    target: {
      type: 'choice',
      instructions: `${passage} Whom does the proposed action act on, or seek something from? SELF means the owner themselves. SEVERAL means more than one of these characters at once. SCENE means the surroundings, an object, someone not listed, or no one in particular. Choose UNRESOLVED if it cannot be told.`,
      criteria: { ...people, SELF: 'The owner themselves.', SEVERAL: 'More than one of these characters at once.', SCENE: 'The surroundings, an object, someone not listed, or no one in particular.', UNRESOLVED: 'The target cannot be told.' },
    },
    family: {
      type: 'choice',
      instructions: `${passage} Which kind of move is it? Choose by what the move tries to change, not by its tone.`,
      criteria: families,
    },
    action_specification: {
      type: 'choice',
      instructions: `${passage} Does the passage say what the owner should do or achieve?`,
      criteria: {
        SPECIFIED_HERE: 'The passage itself states the action or result.',
        SPECIFIED_BY_PUBLIC_REFERENCE: 'The passage points to an action already stated in the public exchange, such as terms, an offer, a plan or a condition someone set.',
        UNSPECIFIED_INITIATIVE: 'The passage hands the owner the initiative without saying what to do, such as "go ahead", "make me" or "your call".',
        UNRESOLVED: 'It cannot be told.',
      },
    },
    antecedent: {
      type: 'choice',
      instructions: `${passage} If the passage refers back to something said or offered earlier in the public exchange (for example "the terms you set" or "what you offered"), select that earlier passage. Choose NONE if it refers to nothing earlier.`,
      criteria: { ...antecedents, NONE: 'The passage does not refer back to an earlier passage.', UNRESOLVED: 'It refers back, but the earlier passage cannot be identified.' },
    },
  };
}

export interface RulingQuestionInput {
  family: PackFamily;
  pack: GenrePack;
  hasAntecedent: boolean;
}

/** Stage E: one probability for the specified change, on the admissible evidence only. */
export function rulingQuestion(input: RulingQuestionInput): NoulQuestion {
  const change = input.hasAntecedent
    ? 'the change proposed in state.move.passage, as specified by the earlier passage it refers to (state.move.antecedent)'
    : 'the change proposed in state.move.passage';
  return {
    type: 'noul',
    instructions: `Using only the admissible evidence in state, will the owner (state.move.owner), attempting ${change} on the target (state.move.target), achieve that specified change within this exchange? ${input.family.successSemantics} Speech is evidence when it changes the target's options or the ruled situation. Do not infer success from the attempt being declared. Do not substitute a different goal or a later opportunity. ${protectedLines(input.pack).join(' ')}`,
    criteria: {
      true: 'The specified change happens within this exchange.',
      false: 'The specified change does not happen within this exchange.',
    },
  };
}
