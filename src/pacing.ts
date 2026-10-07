/** Public-scene pacing, frozen with the turn before the writer runs. */
import type { Answer, DirectorSettings, Question } from './types.ts';

export const SCENE_TYPES = ['combat', 'conversation', 'travel', 'intimate', 'downtime'] as const;
/** Question IDs of the pacing choices, wherever they ride (a group's speaker request, or their own). */
export const PACING_QUESTION_IDS: readonly string[] = ['scene', 'hand_back'];
const DYNAMIC_RESPONSE_INSTRUCTION = 'Put <dynamic_response>a brief in-fiction cue</dynamic_response> on its own line at the very end of the reply. Replace the tag contents with a brief cue from the scene.';
export type SceneType = typeof SCENE_TYPES[number];

export interface PacingOptions {
  texts: DirectorSettings['pacingTexts'];
  handBack: boolean;
  dynamicResponse: boolean;
  playerName: string;
}

export interface FrozenPacing {
  scene: SceneType | null;
  handBack: 'HAND_BACK' | 'CONTINUE' | null;
  /** Whether Dynamic Response was enabled when this decision was made. */
  dynamicResponse: boolean;
  /** Exact text, so a later preference edit cannot change a wording swipe. */
  instruction: string;
  handBackInstruction: string;
}

/** Both choices read public state independently; neither needs the other's answer. */
export function pacingQuestions(handBack: boolean): Record<string, Question> {
  const questions: Record<string, Question> = {
    scene: {
      type: 'choice',
      instructions: 'From state.latestInput and the public scene in state.recentAcceptedMessages, choose the current scene type. Describe the scene now, not a later event or an imagined transition.',
      criteria: {
        combat: 'An immediate fight or physical clash is underway.',
        conversation: 'The scene is driven by dialogue or a social exchange.',
        travel: 'The characters are travelling or making their way somewhere.',
        intimate: 'An intimate encounter is underway.',
        downtime: 'A quiet or routine moment without an active exchange of the other kinds.',
      },
    },
  };
  if (handBack) questions.hand_back = {
    type: 'choice',
    instructions: 'From state.latestInput and the public scene in state.recentAcceptedMessages, should this reply stop at the first beat where the player (state.playerActorId) must respond or act? Judge the need for the player to choose now; do not predict their response or advance time to create a choice.',
    criteria: {
      HAND_BACK: 'The reply reaches a question, decision, offered action or immediate reaction that belongs to the player; stop at that first beat.',
      CONTINUE: 'The reply can finish its current short beat without needing the player to answer or act first.',
    },
  };
  return questions;
}

const choice = (answer: Answer | undefined): string | null => answer?.type === 'choice' ? answer.choice : null;

/** Omit invalid independent decisions rather than guessing or inventing guidance. */
export function freezePacing(answers: Record<string, Answer>, options: PacingOptions): FrozenPacing | null {
  const selected = choice(answers.scene);
  const scene = SCENE_TYPES.find(value => value === selected) ?? null;
  const selectedHandBack = options.handBack ? choice(answers.hand_back) : null;
  const handBack = selectedHandBack === 'HAND_BACK' || selectedHandBack === 'CONTINUE' ? selectedHandBack : null;
  if (!scene && !handBack) return null;
  const player = options.playerName || 'the player';
  const text = scene ? options.texts[scene].replaceAll('{{user}}', player).trim() : '';
  const instruction = text
    ? `[Director pacing — preserve on wording swipes]\nScene: ${scene}.\n${text}\nDo not skip time.`
    : '';
  const handBackInstruction = handBack === 'HAND_BACK'
    ? `[Director hand-back — preserve on wording swipes]\nEnd this reply at the first beat where ${player} must respond or act. Leave their response and choice to them. Do not skip time.`
    : '';
  return { scene, handBack, dynamicResponse: options.dynamicResponse, instruction, handBackInstruction };
}

/** A disabled hand-back switch suppresses its frozen instruction without rejudging. */
export function pacingBlock(pacing: FrozenPacing | null | undefined, handBackEnabled = true, dynamicResponseEnabled = false): string {
  if (!pacing) return '';
  // Older records froze the integration suffix; availability is live on every write.
  const handBack = handBackEnabled && pacing.handBack === 'HAND_BACK'
    ? pacing.handBackInstruction.replace(`\n${DYNAMIC_RESPONSE_INSTRUCTION}`, '') : '';
  const instruction = handBack && dynamicResponseEnabled ? `${handBack}\n${DYNAMIC_RESPONSE_INSTRUCTION}` : handBack;
  return [pacing.instruction, instruction].filter(Boolean).join('\n\n');
}
