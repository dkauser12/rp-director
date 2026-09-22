import type { Controller, ActionDraft } from './controller.ts';
import { ACTION_TEMPLATES } from './templates.ts';
import { el, button } from './dom.ts';

export function buildActionPanel(controller: Controller): HTMLDivElement {
  const template = el('select', { id: 'rpd-action-template', class: 'text_pole' });
  for (const t of ACTION_TEMPLATES) template.append(el('option', { value: t.id, text: t.label }));
  const actor = el('select', { id: 'rpd-action-actor', class: 'text_pole', title: 'Character making the attempt; this is independent of who writes the reply' });
  const target = el('select', { id: 'rpd-action-target', class: 'text_pole', multiple: 'multiple', size: '3', title: 'Optional target actors. Ctrl/Cmd-click to select several.' });
  const attempted = el('input', { id: 'rpd-action-attempt', type: 'text', class: 'text_pole', placeholder: 'Concrete method: what the acting character tries' });
  const gain = el('input', { id: 'rpd-action-gain', type: 'text', class: 'text_pole', placeholder: 'Bounded intended result — no bonus success' });
  const applicability = el('select', { id: 'rpd-action-applicability', class: 'text_pole', title: 'Used by the Player-favorable-only actor policy' });
  for (const [v, label] of [['favorable', 'Good for my character: judge it'], ['not_favorable', 'Not a gain: skip the judge'], ['unresolved', 'Not sure: pause and ask me']] as const) applicability.append(el('option', { value: v, text: label }));
  const uncertain = el('input', { id: 'rpd-action-uncertain', type: 'checkbox' }); uncertain.checked = true;
  const opposed = el('input', { id: 'rpd-action-opposed', type: 'checkbox' });
  const scope = el('select', { id: 'rpd-action-scope', class: 'text_pole', title: 'How long an accepted final ruling may settle the same fact' });
  for (const [v, label] of [['attempt', 'This attempt only'], ['scene', 'This scene'], ['persistent', 'Persistent fact']] as const) scope.append(el('option', { value: v, text: label }));
  const factKey = el('input', { id: 'rpd-action-fact-key', type: 'text', class: 'text_pole', placeholder: 'Optional persistent fact name' });
  const stake = el('select', { id: 'rpd-action-stake', class: 'text_pole', title: 'Boundary on what failure may cost in prose' });
  for (const [v, label] of [['delay', 'Delay'], ['exposure', 'Exposure'], ['injury', 'Injury'], ['lost_position', 'Lost position'], ['resource_cost', 'Resource cost'], ['relationship_friction', 'Relationship friction'], ['closed_opportunity', 'Closed opportunity'], ['other', 'Other']] as const) stake.append(el('option', { value: v, text: label }));
  const stakeDetail = el('input', { id: 'rpd-action-stake-detail', type: 'text', class: 'text_pole', placeholder: 'Failure boundary, e.g. “guard notices the forged seal”' });
  const evidence = el('input', { id: 'rpd-action-evidence', type: 'text', class: 'text_pole', placeholder: 'Relevant evidence; for detection, observer-visible cues only' });
  const armed = el('input', { id: 'rpd-action-armed', type: 'checkbox' });
  const armedLabel = el('label', { class: 'rpd-arm' }, [armed, ' Use once on the next Director turn']);

  const refreshTemplateHints = () => {
    const t = ACTION_TEMPLATES.find(x => x.id === template.value);
    if (t) { attempted.placeholder = t.attemptPrompt; gain.placeholder = t.gainPrompt; }
    evidence.placeholder = template.value === 'detect_discover'
      ? 'Required: only cues this observer can actually perceive'
      : 'Optional concise established evidence or conditions';
    factKey.style.display = scope.value === 'persistent' ? '' : 'none';
  };

  const sync = () => {
    if (!armed.checked || !gain.value.trim() || !attempted.value.trim()) { controller.setActionDraft(null); return; }
    const draft: ActionDraft = {
      templateId: template.value,
      actingActorId: actor.value || 'player',
      targetActorIds: Array.from(target.selectedOptions).map(o => o.value).filter(Boolean),
      attemptedAction: attempted.value,
      requestedGain: gain.value,
      applicability: applicability.value as ActionDraft['applicability'],
      uncertainConsequential: uncertain.checked,
      opposed: opposed.checked,
      resolutionScope: scope.value as ActionDraft['resolutionScope'],
      persistentFactKey: factKey.value,
      failureStakeKind: stake.value as ActionDraft['failureStakeKind'],
      failureStakeDetail: stakeDetail.value,
      availableEvidence: evidence.value,
    };
    controller.setActionDraft(draft);
  };
  for (const node of [template, actor, target, attempted, gain, applicability, uncertain, opposed, scope, factKey, stake, stakeDetail, evidence, armed]) node.addEventListener('change', () => { refreshTemplateHints(); sync(); });
  for (const node of [attempted, gain, factKey, stakeDetail, evidence]) node.addEventListener('input', sync);

  const panel = el('div', { id: 'rpd-action-panel', class: 'rpd-manual-attempt' }, [
    field('Family', template), field('Acting character', actor), field('Targets', target),
    field('Method', attempted), field('Bounded result', gain), field('Player favor', applicability),
    el('label', { class: 'rpd-check' }, [uncertain, ' Uncertain + consequential']),
    el('label', { class: 'rpd-check' }, [opposed, ' Actively opposed']),
    field('Resolution scope', scope), factKey, field('Failure stake', stake), stakeDetail, field('Evidence / visible cues', evidence), armedLabel,
    button('rpd-action-clear', 'Clear', 'Clear the declared action', () => { attempted.value = ''; gain.value = ''; armed.checked = false; sync(); }),
  ]);
  panel.addEventListener('rpd-refresh', () => {
    const actors = controller.actionActorsForUi();
    const previousActor = actor.value || 'player';
    const previousTargets = new Set(Array.from(target.selectedOptions).map(o => o.value));
    actor.replaceChildren();
    target.replaceChildren();
    for (const a of actors) {
      const actorOption = el('option', { value: a.actorId, text: a.name + (a.disabled ? ' (muted)' : '') });
      actorOption.disabled = a.disabled;
      actor.append(actorOption);
      const option = el('option', { value: a.actorId, text: a.name + (a.disabled ? ' (muted)' : '') });
      option.disabled = a.disabled;
      option.selected = previousTargets.has(a.actorId);
      target.append(option);
    }
    actor.value = actors.some(a => a.actorId === previousActor && !a.disabled) ? previousActor : 'player';
    if (!controller.actionDraft) armed.checked = false;
    refreshTemplateHints();
  });
  refreshTemplateHints();
  return panel;
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el('label', { class: 'rpd-field' }, [el('span', { class: 'rpd-muted', text: label }), control]);
}
