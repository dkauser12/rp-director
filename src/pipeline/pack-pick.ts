/**
 * One-time genre pack pick for a chat set to "Auto": a single Choice over the
 * available packs, judged from the characters and the opening of the story.
 * The answer is stored on the chat and never re-asked; the user can override it.
 */
import type { GenrePack } from '../pack/pack.ts';
import type { ChoiceQuestion } from './questions.ts';

export function packQuestion(packs: GenrePack[]): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: 'Which genre pack fits this roleplay as a whole? Judge mainly from its premise: the characters\' descriptions and roles in state.characters (who they are, what their work or situation is, what they want). Use the recent story (state.recentAcceptedMessages and state.latestInput) only as supporting evidence; a single tender, tense or practical scene does not change the genre. Choose the single best fit.',
    criteria: Object.fromEntries(packs.map(p => [p.id, `${p.label}: ${p.description}`])),
  };
}
