import type { Answer, DirectorSettings, Json, Question, TurnPermit } from './types.ts';
import { bindingBlock } from './prompts.ts';
import type { BindingBlockInput } from './prompts.ts';
import { permitFollowupBlock } from './director-tool.ts';
import { visibleText } from './pipeline/spans.ts';

export type ReplyCheckReason = 'writes for {{user}}' | 'broken ruling';
export interface ReplyCheckResult {
  speaksForUser: number | null;
  responds: number | null;
  repeats: number | null;
  followsRuling: number | null;
  reason: ReplyCheckReason | null;
  nudge: string;
}

/** Check the same filled ruling and bounded action that constrained the writer. */
export function replyCheckRuling(binding: BindingBlockInput | null, permit: TurnPermit | null): string {
  return [binding ? bindingBlock(binding) : '', permit ? permitFollowupBlock(permit) : ''].filter(Boolean).join('\n\n');
}

interface ReplyCheckStateInput {
  player: string;
  latestInput: string;
  previousReplies: { name: string; text: string }[];
  reply: { name: string; text: string };
  maxChars: number;
}

/** Preserve the exchange being checked and drop the oldest comparison replies first. */
export function replyCheckState(input: ReplyCheckStateInput): Json {
  const state = {
    player: visibleText(input.player),
    latest_input: visibleText(input.latestInput),
    previous_replies: input.previousReplies.slice(-5).map(reply => ({ name: visibleText(reply.name), text: visibleText(reply.text) })),
    reply: { name: visibleText(input.reply.name), text: visibleText(input.reply.text) },
  };
  while (state.previous_replies.length && JSON.stringify(state).length > input.maxChars) state.previous_replies.shift();
  // If the latest exchange alone is too large, the caller fails open rather
  // than asking for a verdict on a silently truncated reply or user message.
  return state;
}

/** One public-transcript request; hidden trackers never count as prose. */
export function replyCheckQuestions(player: string, ruling: string): Record<string, Question> {
  const questions: Record<string, Question> = {
    speaks_for_user: { type: 'score', instructions: `Does the latest reply invent voluntary speech, thoughts, feelings, consent, decisions or actions for ${player}? Effects imposed by another character are not voluntary actions.`, criteria: ['None', 'Minor implication', 'Ambiguous', 'Clear invented choice', 'Extensive control'] },
    responds: { type: 'score', instructions: `Does the latest reply respond to ${player}'s latest message?`, criteria: ['Ignores it', 'Partly responds', 'Directly responds'] },
    repeats: { type: 'score', instructions: 'Does the latest reply repeat the same prose, actions or conversational beat from the previous five replies without meaningful development?', criteria: ['No repetition', 'Small overlap', 'Some repeated beats', 'Mostly repeated', 'Almost entirely repeated'] },
  };
  if (ruling) questions.follows_ruling = { type: 'noul', instructions: `The reply delivers this frozen outcome, including its boundaries:\n${ruling}` };
  return questions;
}

export function assessReply(answers: Record<string, Answer>, thresholds: DirectorSettings['replyCheckThresholds'], previous: readonly ReplyCheckResult[]): ReplyCheckResult {
  const score = (id: string, max: number) => {
    const answer = answers[id];
    return answer?.type === 'score' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= max ? answer.score : null;
  };
  const follows = answers.follows_ruling;
  const result: ReplyCheckResult = { speaksForUser: score('speaks_for_user', 4), responds: score('responds', 2), repeats: score('repeats', 4),
    followsRuling: follows?.type === 'noul' && Number.isFinite(follows.noul) && follows.noul >= 0 && follows.noul <= 1 ? follows.noul : null, reason: null, nudge: '' };
  if (result.speaksForUser !== null && result.speaksForUser > thresholds.speaksForUser) result.reason = 'writes for {{user}}';
  else if (result.followsRuling !== null && result.followsRuling < thresholds.followsRuling) result.reason = 'broken ruling';
  const nudges: string[] = [];
  if (result.responds !== null && result.responds < thresholds.responds) nudges.push('Respond directly to the latest user message and its actions or questions.');
  if ([...previous.slice(-5), result].filter(item => item.repeats !== null && item.repeats > thresholds.repeats).length >= 4) nudges.push('Develop the current beat with fresh actions and wording; do not repeat earlier replies or skip time.');
  result.nudge = nudges.join(' ');
  return result;
}

export function replyCorrection(reason: ReplyCheckReason, player: string): string {
  return reason === 'writes for {{user}}'
    ? `Rewrite the reply without inventing voluntary speech, thoughts, feelings, consent, decisions or actions for ${player}. Leave their response open. Preserve every frozen Director ruling and do not skip time.`
    : 'Rewrite the reply to deliver the frozen Director ruling and its exact boundaries. Do not roll again, change the outcome or skip time.';
}
