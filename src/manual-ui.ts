import type { Controller, ActionDraft } from './controller.ts';
import { el, button } from './dom.ts';
import { PLAYER_LABEL, uiActorName } from './identity.ts';

export function buildActionPanel(controller: Controller): HTMLDivElement {
  const template = el('select', { id: 'rpd-action-template', class: 'text_pole' });
  const refreshFamilies = () => {
    const previous = template.value;
    const families = controller.chatPack().families;
    template.replaceChildren(...families.map(family => el('option', { value: family.key, text: family.label })));
    template.value = families.some(family => family.key === previous) ? previous : families[0]?.key ?? '';
  };
  refreshFamilies();
  const actor = el('select', { id: 'rpd-action-actor', class: 'text_pole', title: 'Choose the character making this move.' });
  const target = el('select', { id: 'rpd-action-target', class: 'text_pole', multiple: 'multiple', size: '3', title: 'Hold Ctrl or Cmd to select several targets.' });
  const attempted = el('input', { id: 'rpd-action-attempt', type: 'text', class: 'text_pole', placeholder: 'What the character tries' });
  const gain = el('input', { id: 'rpd-action-gain', type: 'text', class: 'text_pole', placeholder: 'The exact result they want' });
  const applicability = el('select', { id: 'rpd-action-applicability', class: 'text_pole', title: `Choose whether this move benefits ${PLAYER_LABEL}.` });
  for (const [v, label] of [['favorable', `Benefits ${PLAYER_LABEL}`], ['not_favorable', `No benefit for ${PLAYER_LABEL}`], ['unresolved', 'Not sure']] as const) applicability.append(el('option', { value: v, text: label }));
  const uncertain = el('input', { id: 'rpd-action-uncertain', type: 'checkbox' }); uncertain.checked = true;
  const opposed = el('input', { id: 'rpd-action-opposed', type: 'checkbox' });
  const stake = el('select', { id: 'rpd-action-stake', class: 'text_pole', title: 'Choose what failure may cost.' });
  for (const [v, label] of [['delay', 'Delay'], ['exposure', 'Exposure'], ['injury', 'Injury'], ['lost_position', 'Lost position'], ['resource_cost', 'Resource cost'], ['relationship_friction', 'Relationship friction'], ['closed_opportunity', 'Closed opportunity'], ['other', 'Other']] as const) stake.append(el('option', { value: v, text: label }));
  const stakeDetail = el('input', { id: 'rpd-action-stake-detail', type: 'text', class: 'text_pole', placeholder: 'For example, the guard notices the forged seal' });
  const evidence = el('input', { id: 'rpd-action-evidence', type: 'text', class: 'text_pole', placeholder: 'Relevant facts or visible clues' });
  const armed = el('input', { id: 'rpd-action-armed', type: 'checkbox' });
  const armedLabel = el('label', { class: 'rpd-arm' }, [armed, ' Use on the next Director send']);

  const refreshTemplateHints = () => {
    const family = controller.chatPack().families.find(item => item.key === template.value);
    attempted.placeholder = family?.kind === 'discovery' ? 'What the character tries to learn' : 'What the character tries';
    gain.placeholder = 'The exact result they want';
    evidence.placeholder = family?.kind === 'discovery'
      ? 'Required: only clues this character can perceive'
      : 'Optional facts or conditions already shown';
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
      failureStakeKind: stake.value as ActionDraft['failureStakeKind'],
      failureStakeDetail: stakeDetail.value,
      availableEvidence: evidence.value,
    };
    controller.setActionDraft(draft);
  };
  for (const node of [template, actor, target, attempted, gain, applicability, uncertain, opposed, stake, stakeDetail, evidence, armed]) node.addEventListener('change', () => { refreshTemplateHints(); sync(); });
  for (const node of [attempted, gain, stakeDetail, evidence]) node.addEventListener('input', sync);

  const panel = el('div', { id: 'rpd-action-panel', class: 'rpd-manual-attempt' }, [
    field('Kind', template), field('Character', actor), field('Targets', target),
    field('Move', attempted), field('Intended result', gain), field(`Benefit for ${PLAYER_LABEL}`, applicability),
    el('label', { class: 'rpd-check' }, [uncertain, ' Uncertain result with consequences']),
    el('label', { class: 'rpd-check' }, [opposed, ' Opposed']),
    field('Risk', stake), stakeDetail, field('Evidence', evidence), armedLabel,
    button('rpd-action-clear', 'Clear', 'Clear this move.', () => { attempted.value = ''; gain.value = ''; armed.checked = false; sync(); }),
  ]);
  panel.addEventListener('rpd-refresh', () => {
    const previousFamily = template.value;
    refreshFamilies();
    if (template.value !== previousFamily) { armed.checked = false; controller.setActionDraft(null); }
    const actors = controller.actionActorsForUi();
    const previousActor = actor.value || 'player';
    const previousTargets = new Set(Array.from(target.selectedOptions).map(o => o.value));
    actor.replaceChildren();
    target.replaceChildren();
    for (const a of actors) {
      const name = uiActorName(a.actorId, a.name) + (a.disabled ? ' (muted)' : '');
      const actorOption = el('option', { value: a.actorId, text: name });
      actorOption.disabled = a.disabled;
      actor.append(actorOption);
      const option = el('option', { value: a.actorId, text: name });
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
