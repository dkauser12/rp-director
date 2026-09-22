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

export function mountUi(controller: Controller): void {
  const bar = buildBar(controller);
  const sendForm = document.getElementById('send_form');
  if (sendForm?.parentElement) sendForm.parentElement.insertBefore(bar, sendForm);
  else document.body.append(bar);

  const drawer = buildSettings(controller);
  const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  if (target) target.append(drawer);

  controller.onChange(() => { refreshBar(controller); refreshInspector(controller); });
  refreshBar(controller);
  refreshInspector(controller);
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
    speaker.replaceChildren(el('option', { value: 'auto', text: 'Automatic' }), el('option', { value: 'YIELD', text: 'Yield to player' }));
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
  );

  const tableEditor = buildTableEditor(controller);
  content.append(collapsible('Outcome table', 'All policy rows, outcomes, presets, and test controls.', tableEditor.element));
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
  observerProfile.append(el('option', { value: '', text: 'Jev bounded observer (fallback)' }));
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
  const rowObserver = row('Observer sidecar', observerProfile);
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
    el('div', { class: 'rpd-note', text: 'The judge uses Jev. The observer can use a separate ST chat-completion profile; leaving it on fallback asks Jev only bounded ruling-entailment questions.' }));
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
  host.replaceChildren(head, toolInfo, ...(controller.record?.inspector ?? []).slice(-30).reverse().map(renderEntry));
}

function renderEntry(entry: InspectorEntry): HTMLElement {
  const details = el('details', { class: 'rpd-entry' }, [el('summary', { text: `${new Date(entry.at).toLocaleTimeString()} · ${entry.message}` })]);
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
  return details;
}
