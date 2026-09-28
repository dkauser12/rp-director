/**
 * Bounded action templates (plan §5.1). A template only shapes how a gain is
 * declared: its label, the prompts, and the family it belongs to (which feeds
 * the gain's variable id). What each ruling means is defined by the profile's
 * outcome columns, not here.
 */
import type {
  ActionSpec, ActionTemplate, Applicability, AttemptFamily, FailureStake, ResolutionScope,
} from './types.ts';

export const ACTION_TEMPLATES: ActionTemplate[] = [
  {
    id: 'overcome_operate',
    label: 'Overcome / operate',
    gainPrompt: 'What bounded physical or technical result should this produce?',
    attemptPrompt: 'What does the acting character do to overcome, repair, operate, treat, or create it?',
  },
  {
    id: 'contest_impose',
    label: 'Contest / impose',
    gainPrompt: 'What bounded result would overcoming the opposition produce?',
    attemptPrompt: 'What does the acting character attempt against the opposition?',
  },
  {
    id: 'evade_resist',
    label: 'Evade / resist',
    gainPrompt: 'What consequence, restraint, pursuit, or effect should be avoided?',
    attemptPrompt: 'How does the acting character evade or resist it?',
  },
  {
    id: 'conceal_deceive',
    label: 'Conceal / deceive',
    gainPrompt: 'What bounded fact, action, identity, or object should remain undiscovered?',
    attemptPrompt: 'What lie, disguise, hiding, stealth, or misdirection is attempted?',
  },
  {
    id: 'detect_discover',
    label: 'Detect / discover',
    gainPrompt: 'What exact bounded fact should the observer discover?',
    attemptPrompt: 'What does the observer do to notice, search, investigate, or infer it?',
  },
  {
    id: 'influence_negotiate',
    label: 'Influence / negotiate',
    gainPrompt: 'What specific conduct should the target choose now?',
    attemptPrompt: 'What offer, argument, request, threat, or pressure is used?',
  },
  {
    id: 'acquire_secure',
    label: 'Acquire / secure',
    gainPrompt: 'What bounded access, information, possession, or commitment should be secured?',
    attemptPrompt: 'What method does the acting character use to secure it?',
  },
];

/** Old ids remain readable for saved action drafts and imported metadata. */
const LEGACY_FAMILY_IDS: Record<string, AttemptFamily> = {
  obtain_access: 'acquire_secure',
  secure_cooperation: 'influence_negotiate',
  obtain_information: 'acquire_secure',
};

export function actionFamily(id: string): AttemptFamily {
  return (ACTION_TEMPLATES.some(t => t.id === id) ? id : LEGACY_FAMILY_IDS[id] ?? 'acquire_secure') as AttemptFamily;
}

export function templateById(id: string): ActionTemplate | null {
  const canonical = actionFamily(id);
  return ACTION_TEMPLATES.find(t => t.id === canonical) ?? null;
}

/** Gain of an automatic attempt: the Director has not named it, only located it in the player's message. */
export const AUTOMATIC_GAIN = 'the first primary uncertain, consequential state change explicitly attempted in the latest user message';

/** How an attempt is labelled for review: automatic gains show the player's own words instead of the generic gain. */
export function attemptLabel(boundedResult: string, method: string): string {
  if (boundedResult !== AUTOMATIC_GAIN) return boundedResult;
  const words = String(method ?? '').replace(/\s+/g, ' ').trim();
  const excerpt = words.length > 160 ? `${words.slice(0, 159).trimEnd()}…` : words;
  return `attempt: ${excerpt}`;
}

export interface DeclareActionInput {
  actionId: string;
  templateId: string;
  actingActorId?: string;
  playerActorId: string;
  targetActorIds: string[];
  attemptedAction: string;
  requestedGain: string;
  applicability: Applicability;
  uncertainConsequential?: boolean;
  opposed?: boolean;
  resolutionScope?: ResolutionScope;
  sceneId?: number;
  persistentFactKey?: string;
  failureStake?: FailureStake;
  availableEvidence?: string;
}

/** Instantiates a template into an ActionSpec. */
export function declareAction(input: DeclareActionInput): ActionSpec | null {
  const template = templateById(input.templateId);
  if (!template) return null;
  return {
    actionId: input.actionId,
    identityVersion: 2,
    templateId: actionFamily(template.id),
    actingActorId: input.actingActorId ?? input.playerActorId,
    playerActorId: input.playerActorId,
    targetActorIds: [...new Set(input.targetActorIds)].sort(),
    attemptedAction: input.attemptedAction.trim(),
    requestedGain: input.requestedGain.trim(),
    applicability: input.applicability,
    uncertainConsequential: input.uncertainConsequential ?? true,
    opposed: input.opposed ?? false,
    resolutionScope: input.resolutionScope ?? 'attempt',
    sceneId: input.sceneId ?? 1,
    persistentFactKey: (input.persistentFactKey ?? '').trim(),
    failureStake: { kind: input.failureStake?.kind ?? 'delay', detail: (input.failureStake?.detail ?? '').trim() },
    availableEvidence: (input.availableEvidence ?? '').trim(),
    preconditions: [],
  };
}
