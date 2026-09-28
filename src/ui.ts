/**
 * Streamlined play UI for RP Director.
 *
 * The play seam is intentionally deep: one Send button invokes automatic
 * speaker selection and automatic attempt adjudication. Recovery and
 * diagnostics exist, but they are hidden until requested.
 */
import type { Controller } from './controller.ts';
import { JEV_KEY_STORAGE, STRUCTURED_KEY_STORAGE } from './controller.ts';
import { BUILTIN_MOCK_SCENARIOS } from './providers.ts';
import type { InspectorEntry } from './types.ts';
import { el, button } from './dom.ts';
import { buildTableEditor } from './tableui.ts';
import { buildActionPanel } from './manual-ui.ts';
import { NPC_REACTION_GROUPS } from './npc-reaction.ts';
import { buildLorePanel, refreshLorePanel } from './loreui.ts';

export function mountUi(controller: Controller): void {
  const bar = buildBar(controller);
  const sendForm = document.getElementById('send_form');
  if (sendForm?.parentElement) sendForm.parentElement.insertBefore(bar, sendForm);
  else document.body.append(bar);

  const drawer = buildSettings(controller);
  const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (target) target.append(drawer);

  controller.onChange(() => { refreshBar(controller); refreshInspector(controller); refreshStory(controller); void refreshLorePanel(controller); });
  refreshBar(controller);
  refreshInspector(controller);
  refreshStory(controller);
  void refreshLorePanel(controller);
}

let overflowOpen = false;

function buildBar(controller: Controller): HTMLDivElement {
  const status = el('span', { id: 'rpd-status', class: 'rpd-status', 'data-state': 'Off', text: 'Off' });
  const overflow = buildOverflow(controller);
  const more = button('rpd-more', '⋯', 'Manual override and recovery controls', () => {
    overflowOpen = !overflowOpen;
    overflow.classList.toggle('rpd-hidden', !overflowOpen);
  });
  return el('div', { id: 'rpd-bar' }, [
    el('div', { class: 'rpd-main' }, [el('b', { text: 'Director' }), status, more]),
    overflow,
  ]);
}

function buildOverflow(controller: Controller): HTMLDivElement {
  const speaker = el('select', { id: 'rpd-speaker', class: 'text_pole', title: 'Optional one-turn reply-speaker override' });
  speaker.addEventListener('change', () => controller.setSpeakerOverride(speaker.value === 'auto' ? null : speaker.value));
  return el('div', { id: 'rpd-overflow', class: 'rpd-hidden' }, [
    el('label', { class: 'rpd-inline' }, [el('span', { class: 'rpd-muted', text: 'Speaker override' }), speaker]),
    button('rpd-commit', 'Commit reply', 'Explicitly commit the selected observed reply now; continuing normally commits it automatically', () => void controller.commitReply()),
    button('rpd-new-scene', 'New scene & continue', 'Commit the selected reply, start a new scene identity, and immediately continue through Director', () => void controller.startNewScene()),
    button('rpd-baseline', 'Repair selected branch', 'Repair the selected swipe at its predecessor, then retry observation; imported transcripts fall back to a head baseline', () => void controller.repairSelectedBranch()),
    button('rpd-clear-error', 'Clear pause', 'Clear the current paused/error display after fixing its cause', () => controller.clearError()),
  ]);
}

function refreshBar(controller: Controller): void {
  const bar = document.getElementById('rpd-bar');
  const status = document.getElementById('rpd-status');
  if (!bar || !status) return;
  bar.classList.toggle('rpd-hidden', !controller.settings.showBar);
  const provisional = controller.provisional();
  let label: string = controller.status;
  if (controller.status === 'Provisional') label = provisional?.outcome ? `Ready: ${provisional.outcome}` : 'Ready to continue';
  if (controller.status === 'Stale') label = 'Needs repair';
  status.textContent = label;
  status.dataset.state = controller.status;
  const tool = controller.host.writerToolCapability('normal');
  status.title = controller.lastError ?? controller.record?.projection.reason ?? `Native Send and generated swipes route through Director automatically. Scene ${controller.record?.projection.state.sceneId ?? '—'}. NPC action tool: ${tool.supported ? 'available' : tool.reason ?? 'unavailable'}.`;

  const speaker = document.getElementById('rpd-speaker') as HTMLSelectElement | null;
  if (speaker) {
    const previous = controller.speakerOverride ?? 'auto';
    speaker.replaceChildren(el('option', { value: 'auto', text: 'Automatic' }), el('option', { value: 'YIELD', text: 'Yield to {{user}}' }));
    for (const actor of controller.actorsForUi()) {
      const option = el('option', { value: actor.actorId, text: actor.name + (actor.disabled ? ' (muted)' : '') });
      option.disabled = actor.disabled;
      speaker.append(option);
    }
    speaker.value = Array.from(speaker.options).some(option => option.value === previous) ? previous : 'auto';
  }
  show('rpd-commit', controller.status === 'Provisional');
  show('rpd-baseline', controller.canRepairSelected());
  show('rpd-clear-error', controller.status === 'Error' || controller.status === 'Paused');
  document.getElementById('rpd-action-panel')?.dispatchEvent(new Event('rpd-refresh'));
}

function show(id: string, visible: boolean): void {
  const node = document.getElementById(id);
  if (node) node.style.display = visible ? '' : 'none';
}

function buildSettings(controller: Controller): HTMLDivElement {
  const settings = controller.settings;
  const content = el('div', { class: 'inline-drawer-content' });
  const enabled = el('input', { type: 'checkbox' }); enabled.checked = settings.enabled;
  enabled.addEventListener('change', () => controller.setEnabled(enabled.checked));
  const showBar = el('input', { type: 'checkbox' }); showBar.checked = settings.showBar;
  showBar.addEventListener('change', () => { controller.settings.showBar = showBar.checked; controller.host.saveSettings(); controller.refreshStatus(); });
  content.append(
    el('div', { class: 'rpd-row' }, [el('label', {}, [enabled, ' Enabled']), el('label', {}, [showBar, ' Show play strip'])]),
    el('div', { class: 'rpd-note', text: 'Normal use: type your message and use SillyTavern’s native Send or Enter. New generated swipes are also routed through Director; a choice appears before generation only when reuse, reroll, or explicit bypass are materially different.' }),
    collapsible('Connections', 'Decision model and optional observer profile.', buildConnection(controller)),
    collapsible('Modules', 'Pipeline and which Director suites run.', buildModuleSettings(controller)),
  );

  const tableEditor = buildTableEditor(controller);
  content.append(collapsible('Outcome table', 'All policy rows, outcomes, presets, and test controls.', tableEditor.element));
  content.append(collapsible('This chat', 'Genre pack, judged character state, secrets and lore picks for the open chat.', buildStoryPanel(controller)));
  content.append(collapsible('Lore selection', 'Which lorebooks the Director reads and how its picks reach the writer.', buildLorePanel(controller)));
  content.append(collapsible('NPC reactions', 'Relative weights for reactions when no action is ruled.', buildReactionSettings(controller)));
  content.append(collapsible('Manual attempt override', 'Optional: declare one specific attempt instead of automatic detection.', buildActionPanel(controller)));

  const inspector = el('div', { id: 'rpd-inspector' });
  const exportInspector = button('rpd-inspector-export', 'Copy inspector JSON', 'Copy recorded inputs and decisions; credentials are never stored', () => {
    void navigator.clipboard?.writeText(JSON.stringify(controller.record?.inspector ?? [], null, 2)).catch(() => undefined);
  });
  const exportState = button('rpd-state-export', 'Copy chat record JSON', 'Copy the complete automatic Director record', () => {
    void navigator.clipboard?.writeText(JSON.stringify(controller.record ?? null, null, 2)).catch(() => undefined);
  });
  const resetConfirm = button('rpd-reset-confirm', 'Reset binding confirmation', 'Ask again before the next binding decision', () => {
    controller.settings.bindingConfirmedAt = null;
    controller.host.saveSettings();
    controller.host.toast('info', 'Binding confirmation reset.');
  });
  const advanced = el('div', {}, [el('div', { class: 'rpd-row' }, [exportInspector, exportState, resetConfirm]), inspector]);
  content.append(collapsible('Inspector & recovery', 'Recorded questions, answers, rulings, and export controls.', advanced));

  return el('div', { id: 'rpd-settings', class: 'extension_settings' }, [
    el('div', { class: 'inline-drawer' }, [
      el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [el('b', { text: 'RP Director' }), el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })]),
      content,
    ]),
  ]);
}

function buildModuleSettings(controller: Controller): HTMLElement {
  const pipelineTip = 'Legacy: one judge batch per turn. Staged: select the exact passage of your message that is the move, route it (who acts, on whom, what kind), then rule on that passage with the evidence its kind allows.';
  const pipeline = el('select', { id: 'rpd-pipeline', class: 'text_pole', title: pipelineTip });
  for (const [value, label] of [['legacy', 'Legacy (one batch)'], ['staged', 'Staged (move, routing, ruling)']] as const) pipeline.append(el('option', { value, text: label }));
  pipeline.value = controller.settings.pipeline;
  pipeline.addEventListener('change', () => {
    controller.settings.pipeline = pipeline.value === 'staged' ? 'staged' : 'legacy';
    controller.host.saveSettings();
    controller.host.toast('success', `Pipeline: ${controller.settings.pipeline}.`);
  });
  const toggle = (id: string, label: string, key: 'speaker' | 'decisions' | 'meters' | 'secrets' | 'lore', tip: string) => {
    const input = el('input', { id, type: 'checkbox', title: tip });
    input.checked = controller.settings.modules[key];
    input.addEventListener('change', () => { controller.settings.modules[key] = input.checked; controller.host.saveSettings(); });
    return el('label', { title: tip }, [input, ` ${label}`]);
  };
  return el('div', { id: 'rpd-modules' }, [
    el('div', { class: 'rpd-row' }, [el('label', { text: 'Pipeline', title: pipelineTip }), pipeline]),
    el('div', { class: 'rpd-note', text: 'Staged rules on your own words and tells apart your attempt, an order to a character, and a hand-off ("go ahead, make me"). A hand-off gets that character\'s reaction, not a failed check. Legacy stays available.' }),
    el('div', { class: 'rpd-row' }, [
      toggle('rpd-module-speaker', 'Speaker', 'speaker', 'Choose who replies in group chats. Off: SillyTavern picks.'),
      toggle('rpd-module-decisions', 'Decisions', 'decisions', 'Rule on attempts, freeze outcomes, and offer the NPC-action tool.'),
      toggle('rpd-module-meters', 'Meters', 'meters', 'The judge places each character on the pack scales (regard, loyalty, suspicion) every turn, at most one step at a time. The writer plays them at those levels. Staged only.'),
      toggle('rpd-module-secrets', 'Secrets', 'secrets', 'Tell the writer who knows each secret of this chat, and let the judge record when one is revealed. Staged only.'),
      toggle('rpd-module-lore', 'Lore', 'lore', 'The judge picks the lorebook entries each turn depends on; rulings read them and, per book, the writer gets them too. Staged only.'),
    ]),
    el('div', { class: 'rpd-note', text: 'NPC reactions have their own switch below. With every module off, Director stands aside and makes no requests.' }),
  ]);
}

function buildStoryPanel(controller: Controller): HTMLElement {
  const packTip = 'The genre pack decides what counts as a move, the kinds of move, and the meters. Auto lets the judge pick once for this chat.';
  const pack = el('select', { id: 'rpd-pack', class: 'text_pole', title: packTip });
  pack.addEventListener('change', () => void controller.setChatPack(pack.value));
  const packNote = el('div', { id: 'rpd-pack-note', class: 'rpd-note' });
  const meters = el('div', { id: 'rpd-meters' });
  const secrets = el('div', { id: 'rpd-secrets-list' });
  const text = el('textarea', { id: 'rpd-secret-text', class: 'text_pole', rows: '2', placeholder: 'A secret, for example: The captain has been skimming the treasury.', title: 'What the secret is. The writer is told who knows it; characters who do not know it will not act on it.' });
  const holders = el('div', { id: 'rpd-secret-holders', class: 'rpd-row' });
  const add = button('rpd-secret-add', 'Add secret', 'Add this secret, known from the start by the characters ticked above', () => {
    const chosen = [...holders.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map(box => box.value);
    void controller.addSecret(text.value, chosen).then(() => { text.value = ''; });
  });
  return el('div', { id: 'rpd-story' }, [
    el('div', { class: 'rpd-row' }, [el('label', { text: 'Genre pack', title: packTip }), pack]),
    packNote,
    el('div', { class: 'rpd-subhead', text: 'Character state (judged from play)' }),
    meters,
    el('div', { class: 'rpd-subhead', text: 'Lore picked for the latest turn' }),
    el('div', { id: 'rpd-lore-last' }),
    el('div', { class: 'rpd-subhead', text: 'Secrets' }),
    secrets,
    text,
    el('div', { class: 'rpd-muted', text: 'Known from the start by:' }),
    holders,
    el('div', { class: 'rpd-row' }, [add]),
  ]);
}

let storySignature = '';

function refreshStory(controller: Controller): void {
  const pack = document.getElementById('rpd-pack') as HTMLSelectElement | null;
  if (!pack) return;
  const info = controller.chatPackInfo();
  const packs = controller.packsForUi();
  const state = controller.characterStateForUi();
  const secrets = controller.secretsForUi();
  const actors = controller.actionActorsForUi();
  const lastLore = controller.lastLoreForUi();
  const signature = JSON.stringify([info, packs.map(p => p.id), state, secrets, actors, lastLore]);
  if (signature === storySignature) return;
  storySignature = signature;

  pack.replaceChildren(el('option', { value: 'auto', text: 'Auto (the judge picks once)' }), ...packs.map(p => el('option', { value: p.id, text: p.label })));
  pack.disabled = !info;
  pack.value = info?.packId ?? 'auto';
  const note = document.getElementById('rpd-pack-note');
  if (note) {
    const chosen = packs.find(p => p.id === info?.packId);
    note.textContent = !info ? 'Open a chat to choose its pack.'
      : chosen ? `${chosen.description}${info.source === 'judge' ? ' Picked by the judge for this chat.' : ''}`
      : 'The judge picks a pack on this chat’s first staged turn. Until then the General pack applies.';
  }

  const meters = document.getElementById('rpd-meters');
  if (meters) {
    meters.replaceChildren(...(state.length ? state.map(c => el('div', { class: 'rpd-meter-line', text: `${c.name}: ${c.meters.map(m => `${m.label} ${m.level} (${m.rank})`).join(' · ')}` }))
      : [el('div', { class: 'rpd-muted', text: 'Not judged yet on this branch. With the staged pipeline and Meters on, the judge places each character on the pack’s scales every turn.' })]));
  }

  const loreLast = document.getElementById('rpd-lore-last');
  if (loreLast) {
    loreLast.replaceChildren(...(lastLore && lastLore.entries.length ? lastLore.entries.map(e => el('div', { class: 'rpd-meter-line', text: `${e.book} › ${e.title}` }))
      : [el('div', { class: 'rpd-muted', text: lastLore ? 'Nothing was needed from the lorebooks.' : 'No lore picked yet on this branch.' })]));
  }

  const nameOf = (id: string) => actors.find(a => a.actorId === id)?.name ?? id;
  const list = document.getElementById('rpd-secrets-list');
  if (list) {
    list.replaceChildren(...(secrets.length ? secrets.map(s => el('div', { class: 'rpd-secret' }, [
      el('div', { text: s.text }),
      el('div', { class: 'rpd-row' }, [
        el('span', { class: 'rpd-muted', text: `Known to: ${s.knownBy.map(nameOf).join(', ') || 'no one'}` }),
        button(`rpd-secret-remove-${s.id}`, 'Remove', 'Remove this secret from the chat', () => void controller.removeSecret(s.id)),
      ]),
    ])) : [el('div', { class: 'rpd-muted', text: 'No secrets in this chat.' })]));
  }

  const holders = document.getElementById('rpd-secret-holders');
  if (holders) {
    const ticked = new Set([...holders.querySelectorAll<HTMLInputElement>('input:checked')].map(box => box.value));
    holders.replaceChildren(...actors.map(a => {
      const box = el('input', { type: 'checkbox', value: a.actorId });
      box.checked = ticked.has(a.actorId);
      return el('label', {}, [box, ` ${a.name}`]);
    }));
  }
}

function buildReactionSettings(controller: Controller): HTMLElement {
  const enabled = el('input', { id: 'rpd-reactions-enabled', type: 'checkbox' });
  enabled.checked = controller.settings.reactions.enabled;
  enabled.addEventListener('change', () => {
    controller.settings.reactions.enabled = enabled.checked;
    controller.host.saveSettings();
  });
  const body = el('div', { id: 'rpd-reactions' }, [
    el('label', {}, [enabled, ' Enable NPC reactions']),
    el('div', { class: 'rpd-note', text: 'Jev identifies the relevant moment. On turns without an action ruling, these relative weights choose the reaction. They are not model confidence. A weight of 0 excludes an option; each group needs at least one positive weight.' }),
  ]);
  for (const group of NPC_REACTION_GROUPS) {
    const titleId = `rpd-reaction-${group.id}-label`;
    const errorId = `rpd-reaction-${group.id}-error`;
    const error = el('div', { id: errorId, class: 'rpd-note', role: 'status' });
    error.hidden = true;
    const controls = el('div', { class: 'rpd-row' });
    const fields = new Map<string, HTMLInputElement>();
    const save = () => {
      const weights = Object.fromEntries([...fields].map(([id, input]) => [id, input.value.trim() === '' ? NaN : Number(input.value)]));
      const validNumbers = Object.values(weights).every(weight => Number.isFinite(weight) && weight >= 0);
      const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
      const validTotal = Number.isFinite(total) && total > 0;
      for (const [id, input] of fields) {
        input.setAttribute('aria-invalid', String(!Number.isFinite(weights[id]) || weights[id]! < 0 || (validNumbers && !validTotal)));
      }
      error.textContent = !validNumbers ? 'Not saved: use a finite weight of 0 or greater for every option. The last valid weights are kept.'
        : !validTotal ? 'Not saved: the group total must be finite and greater than 0. The last valid weights are kept.' : '';
      error.hidden = !error.textContent;
      if (!validNumbers || !validTotal) return;
      controller.settings.reactions.weights[group.id] = weights;
      controller.host.saveSettings();
    };
    for (const option of group.options) {
      const input = el('input', {
        id: `rpd-reaction-${group.id}-${option.id}`, type: 'number', class: 'text_pole', min: '0', step: 'any',
        value: String(controller.settings.reactions.weights[group.id][option.id]), style: 'width: 5em;',
        'aria-describedby': errorId,
      });
      fields.set(option.id, input);
      input.addEventListener('change', save);
      controls.append(el('label', { style: 'min-width: 0; display: inline-flex; align-items: center; gap: 4px;' }, [option.label, input]));
    }
    body.append(el('div', { role: 'group', 'aria-labelledby': titleId }, [el('b', { id: titleId, text: group.label }), controls, error]));
  }
  return body;
}

function buildConnection(controller: Controller): HTMLElement {
  const current = controller.settings.connection;
  const host = el('div', { class: 'rpd-connection' });
  const kind = el('select', { class: 'text_pole' });
  for (const [value, label] of [
    ['mock', 'Mock (testing only)'],
    ['jev', 'Jev (TypeSafe)'],
    ['structured', 'Structured judge'],
    ['openrouter', 'OpenRouter (Jev or chat model)'],
  ] as const) kind.append(el('option', { value, text: label }));
  kind.value = current.kind === 'rules' ? 'mock' : current.kind;
  const scenario = el('select', { class: 'text_pole' });
  for (const name of Object.keys(BUILTIN_MOCK_SCENARIOS)) scenario.append(el('option', { value: name, text: name }));
  scenario.value = current.mockScenario;
  const baseUrl = el('input', { type: 'text', class: 'text_pole', value: current.baseUrl, placeholder: 'Endpoint / base URL' });
  const model = el('input', { type: 'text', class: 'text_pole', value: current.model, placeholder: 'Model id' });
  const stProfile = el('select', { class: 'text_pole' });
  stProfile.append(el('option', { value: '', text: 'Direct endpoint' }));
  for (const p of controller.host.connectionProfiles()) stProfile.append(el('option', { value: p.id, text: `${p.name}${p.model ? ' / ' + p.model : ''}` }));
  stProfile.value = current.stProfileId;
  const observerProfile = el('select', { class: 'text_pole' });
  observerProfile.append(el('option', { value: '', text: 'Use judge connection' }));
  for (const p of controller.host.connectionProfiles()) observerProfile.append(el('option', { value: p.id, text: `${p.name}${p.model ? ' / ' + p.model : ''}` }));
  observerProfile.value = controller.settings.observerConnection.stProfileId;
  const sessionKey = el('input', { type: 'password', class: 'text_pole', placeholder: 'Session-only key', autocomplete: 'off' });
  const keyStorage = () => kind.value === 'jev' ? JEV_KEY_STORAGE : STRUCTURED_KEY_STORAGE;
  sessionKey.value = sessionStorage.getItem(keyStorage()) ?? '';
  sessionKey.addEventListener('change', () => { if (sessionKey.value) sessionStorage.setItem(keyStorage(), sessionKey.value); else sessionStorage.removeItem(keyStorage()); });

  const rowScenario = row('Mock result', scenario);
  const rowProfile = row('ST profile', stProfile);
  const rowUrl = row('Endpoint', baseUrl);
  const rowModel = row('Model', model);
  const rowKey = row('Session key', sessionKey);
  const rowObserver = row('Reply observer', observerProfile);
  const update = () => {
    const value = kind.value;
    rowScenario.style.display = value === 'mock' ? '' : 'none';
    rowProfile.style.display = value === 'structured' ? '' : 'none';
    rowUrl.style.display = value === 'jev' || (value === 'structured' && !stProfile.value) ? '' : 'none';
    rowModel.style.display = value === 'jev' || value === 'structured' || value === 'openrouter' ? '' : 'none';
    rowKey.style.display = value === 'jev' || (value === 'structured' && !stProfile.value) ? '' : 'none';
    sessionKey.value = sessionStorage.getItem(keyStorage()) ?? '';
  };
  const save = () => {
    controller.settings.connection = { kind: kind.value as typeof current.kind, baseUrl: baseUrl.value.trim(), model: model.value.trim(), stProfileId: stProfile.value, mockScenario: scenario.value };
    controller.host.saveSettings();
    controller.reloadProfile();
    update();
  };
  for (const node of [kind, scenario, baseUrl, model, stProfile]) node.addEventListener('change', save);
  observerProfile.addEventListener('change', () => {
    controller.settings.observerConnection = { stProfileId: observerProfile.value };
    controller.host.saveSettings();
    controller.refreshStatus();
  });
  host.append(row('Judge connection', kind), rowScenario, rowProfile, rowUrl, rowModel, rowKey, rowObserver,
    el('div', { class: 'rpd-note', text: 'The observer checks the generated reply. Use the judge connection or choose a separate ST chat-completion profile. Jev only checks whether the reply follows frozen rulings; a structured observer can also track registered facts. Changes commit when you continue from the reply.' }));
  update();
  return host;
}

function row(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'rpd-row' }, [el('label', { text: label }), control]);
}

function collapsible(title: string, description: string, body: HTMLElement): HTMLDetailsElement {
  return el('details', { class: 'rpd-section' }, [el('summary', {}, [el('b', { text: title }), el('span', { class: 'rpd-muted', text: ` — ${description}` })]), body]);
}

function refreshInspector(controller: Controller): void {
  const host = document.getElementById('rpd-inspector');
  if (!host) return;
  const head = el('div', { class: 'rpd-muted', text: controller.record
    ? `projection ${controller.record.projection.status} · scene ${controller.record.projection.state.sceneId} · accepted ${controller.record.projection.state.acceptedResolutionIds.length}`
    : 'no chat' });
  const tool = controller.host.writerToolCapability('normal');
  const toolInfo = el('div', { class: 'rpd-note', text: tool.supported
    ? 'Writer tool: RPDirector_AdjudicateTurn. Appears in chat only when the writer calls it for a new consequential NPC action. The Jev pre-pass and observer run in the background; their calls are recorded below.'
    : `Writer tool unavailable: ${tool.reason}. Background decisions are recorded below.` });
  host.replaceChildren(head, toolInfo, ...(controller.record?.inspector ?? []).slice(-30).reverse().map(entry =>
    renderEntry(entry, entry.speaker ? controller.record?.actors[entry.speaker.selected]?.name : undefined)));
}

function renderEntry(entry: InspectorEntry, speakerName?: string): HTMLElement {
  // The saved message states what happened. Entry kinds alone do not distinguish
  // successful observation from failure, or a reused ruling from a new one.
  const item = el('div', { class: 'rpd-entry' }, [el('div', {}, [
    el('span', { class: 'rpd-muted', text: new Date(entry.at).toLocaleTimeString() }),
    ' · ', entry.message,
  ])]);
  const summary: string[] = [];
  if (entry.speaker) summary.push(`Speaker: ${speakerName || (entry.speaker.selected === 'YIELD' ? 'Yield to {{user}}' : entry.speaker.selected)}`);
  if (entry.outcome) summary.push(`Outcome: ${entry.outcome}`);
  if (entry.policyBandId) summary.push(`Band: ${entry.policyBandId}`);
  if (summary.length) item.append(el('div', { text: summary.join(' · ') }));
  const network = [entry.networkCalls === 0 ? 'No network calls' : `${entry.networkCalls} network ${entry.networkCalls === 1 ? 'call' : 'calls'}`];
  if (entry.providerKind) network.push(entry.providerKind);
  if (entry.returnedModel) network.push(entry.returnedModel);
  else if (entry.requestedModel) network.push(`requested ${entry.requestedModel}`);
  if (entry.durationMs !== null) network.push(`${Math.round(entry.durationMs)} ms`);
  item.append(el('div', { class: 'rpd-muted', text: network.join(' · ') }));
  const details = el('details', {}, [el('summary', { text: 'Details' })]);
  const lines: string[] = [];
  lines.push(`network calls: ${entry.networkCalls}`);
  if (entry.providerKind) lines.push(`provider: ${entry.providerKind}; model: ${entry.returnedModel ?? entry.requestedModel ?? 'not reported'}`);
  if (entry.durationMs !== null) lines.push(`decision time: ${Math.round(entry.durationMs)} ms`);
  if (entry.speaker) lines.push(`speaker: ${entry.speaker.selected} (${entry.speaker.source})`);
  if (entry.outcome) lines.push(`outcome: ${entry.outcome}${entry.policyBandId ? ` / ${entry.policyBandId}` : ''}`);
  if (entry.answers) lines.push(`answers: ${JSON.stringify(entry.answers)}`);
  if (entry.questions) lines.push(`questions: ${JSON.stringify(entry.questions)}`);
  if (entry.stateSent) lines.push(`state: ${JSON.stringify(entry.stateSent)}`);
  if (entry.injectedText) lines.push(`injected:\n${entry.injectedText}`);
  details.append(el('pre', { text: lines.join('\n') }));
  item.append(details);
  return item;
}
