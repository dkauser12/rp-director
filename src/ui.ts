/** Drawer, workspace and per-reply details; all generation stays in the controller. */
import type { Controller } from './controller.ts';
import { el, button } from './dom.ts';
import { buildTableEditor } from './tableui.ts';
import { buildActionPanel } from './manual-ui.ts';
import { buildLorePanel, refreshLorePanel } from './loreui.ts';
import { buildModuleSettings, buildStoryPanel, refreshStory, buildReactionSettings, buildConnection, buildPacingSettings, buildReplyCheckSettings, collapsible } from './ui-panels.ts';
import { workflowBadgeLabel } from './workflow-badge.ts';
import type { WorkflowBadge } from './workflow-badge.ts';
import { uiActorName } from './identity.ts';
import { activityTurns, activityMetrics, activityUsage, playerUiText } from './activity.ts';
import { costLabel, mergeRequestUsage, summarizeUsage, usageLabel } from './usage.ts';
import type { RequestUsage } from './types.ts';
import type { ActivityTurn } from './activity.ts';
import { buildStatusChip } from './status-chip.ts';
import { WORKSPACE_TABS, createWorkspaceState, normalizeWorkspaceTab, openWorkspace, selectWorkspaceTab, setWorkspaceDraftDirty, closeWorkspace } from './workspace-state.ts';
import type { WorkspaceState, WorkspaceTab } from './workspace-state.ts';

interface WorkspaceView {
  state: WorkspaceState;
  element: HTMLElement;
  select: (tab: WorkspaceTab, messageId?: number) => void;
  refresh: () => void;
}
const workspaces = new WeakMap<Controller, WorkspaceView>();
const connections = new WeakMap<Controller, { signature: string; chatKey: string | null; seen: Set<string>; working: boolean; requests: number; usage: RequestUsage[] }>();
const activitySignatures = new WeakMap<HTMLElement, string>();

function connectionState(controller: Controller) {
  const signature = JSON.stringify(controller.settings.connection);
  let state = connections.get(controller);
  if (!state) {
    state = { signature, chatKey: controller.record ? controller.host.chatKey() : null, seen: new Set((controller.record?.inspector ?? []).map(entry => entry.id)), working: false, requests: 0, usage: [] };
    connections.set(controller, state);
  }
  if (signature !== state.signature) {
    state.signature = signature; state.working = false;
    for (const entry of controller.record?.inspector ?? []) state.seen.add(entry.id);
  }
  if (controller.record && state.chatKey !== controller.host.chatKey()) {
    state.chatKey = controller.host.chatKey();
    for (const entry of controller.record.inspector) state.seen.add(entry.id);
  }
  for (const entry of controller.record?.inspector ?? []) {
    if (state.seen.has(entry.id)) continue;
    state.seen.add(entry.id);
    state.requests += entry.networkCalls;
    state.usage = mergeRequestUsage(state.usage, entry.requestUsage);
  }
  state.working = controller.lastWorkingConnection === signature && !controller.lastError;
  return state;
}

function connectionConfigured(controller: Controller): boolean {
  const c = controller.settings.connection;
  // These routes have default endpoints/models; configuration is not a connection test.
  if (c.kind === 'openrouter' || c.kind === 'jev') return true;
  if (c.kind === 'structured' && c.stProfileId) return true;
  if (c.kind === 'structured') return Boolean(c.baseUrl.trim());
  return c.kind === 'mock' || c.kind === 'rules';
}

export function mountUi(controller: Controller): void {
  connectionState(controller);
  const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
  target?.append(buildDrawer(controller));
  const menu = document.getElementById('extensionsMenu');
  if (menu && !document.getElementById('rpd-open-menu')) {
    const item = button('rpd-open-menu', 'Director', 'Open Director', () => { void openDirector(controller); }, 'list-group-item flex-container');
    menu.append(item);
  }
  controller.host.registerWorkspaceCommand(tab => openDirector(controller, tab));
  const refresh = () => { refreshDrawer(controller); refreshWorkflowBadges(controller); workspaces.get(controller)?.refresh(); };
  controller.onChange(refresh);
  for (const event of ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'CHAT_CHANGED']) controller.host.on(event, refresh);
  refresh();
}

function buildDrawer(controller: Controller): HTMLElement {
  const enabled = el('input', { id: 'rpd-enabled', type: 'checkbox' });
  enabled.addEventListener('change', () => controller.setEnabled(enabled.checked));
  const paused = el('input', { id: 'rpd-paused', type: 'checkbox' });
  paused.addEventListener('change', () => void controller.setPaused(paused.checked));
  return el('div', { id: 'rpd-settings', class: 'extension_settings' }, [el('div', { class: 'inline-drawer' }, [
    el('div', { class: 'inline-drawer-toggle inline-drawer-header' }, [el('b', { text: 'RP Director' }), el('span', { id: 'rpd-status', class: 'rpd-status', role: 'status' }), el('div', { class: 'inline-drawer-icon fa-solid fa-circle-chevron-down down' })]),
    el('div', { class: 'inline-drawer-content' }, [el('p', { id: 'rpd-next-step', class: 'rpd-muted', 'aria-live': 'polite' }),
      el('div', { class: 'rpd-row' }, [el('label', {}, [enabled, ' Enabled']), el('label', {}, [paused, ' Pause for this chat'])]),
      button('rpd-open', 'Open Director', 'Open Director', () => { void openDirector(controller); })]),
  ])]);
}

function refreshDrawer(controller: Controller): void {
  const connection = connectionState(controller);
  const state = buildStatusChip({ enabled: controller.settings.enabled, paused: Boolean(controller.record?.paused), hasChat: Boolean(controller.record),
    status: controller.status, lastError: controller.lastError, connectionConfigured: connectionConfigured(controller), connectionWorking: connection.working });
  const chip = document.getElementById('rpd-status');
  if (chip) { chip.textContent = state.label; chip.dataset.state = state.state; chip.dataset.tone = state.tone; }
  const hint = document.getElementById('rpd-next-step');
  if (hint) hint.textContent = state.nextStep;
  const enabled = document.getElementById('rpd-enabled') as HTMLInputElement | null;
  if (enabled) enabled.checked = controller.settings.enabled;
  const paused = document.getElementById('rpd-paused') as HTMLInputElement | null;
  if (paused) { paused.checked = Boolean(controller.record?.paused); paused.disabled = !controller.record; }
}

/** A single popup per controller; switching tabs keeps unapplied forms mounted. */
export async function openDirector(controller: Controller, requestedTab?: string, messageId?: number): Promise<void> {
  const tab = normalizeWorkspaceTab(requestedTab) ?? undefined;
  if (requestedTab?.trim() && !tab) {
    controller.host.toast('info', 'Tabs: This chat, Activity, Outcomes, Lore, Settings.');
    return;
  }
  const current = workspaces.get(controller);
  if (current) { if (tab || messageId !== undefined) current.select(tab ?? 'activity', messageId); return; }
  const context = controller.host.ctx();
  if (!context.callGenericPopup || !context.POPUP_TYPE) return;
  const state = createWorkspaceState();
  openWorkspace(state, tab, messageId);
  const root = el('div', { id: 'rpd-workspace', class: 'rpd-workspace' });
  // ST uses Enter as the popup's Close shortcut; native form controls own it here.
  root.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.target as HTMLElement | null)?.closest('button, input, select, textarea')) event.stopPropagation();
  });
  const tabs = el('div', { class: 'rpd-tabs', role: 'tablist', 'aria-label': 'Director' });
  const body = el('div', { class: 'rpd-workspace-body' });
  const panes = new Map<WorkspaceTab, HTMLElement>();
  const tabButtons = new Map<WorkspaceTab, HTMLButtonElement>();
  let table: ReturnType<typeof buildTableEditor> | null = null;
  let chatKey = controller.host.chatKey();
  const ensurePane = (id: WorkspaceTab): HTMLElement => {
    const existing = panes.get(id);
    if (existing) return existing;
    const pane = el('section', { id: `rpd-pane-${id}`, role: 'tabpanel', 'aria-labelledby': `rpd-tab-${id}`, tabindex: '0' });
    if (id === 'chat') pane.append(buildStoryPanel(controller));
    if (id === 'activity') pane.append(el('div', { id: 'rpd-activity' }));
    if (id === 'outcomes') { table = buildTableEditor(controller); pane.append(table.element); }
    if (id === 'lore') pane.append(buildLorePanel(controller));
    if (id === 'settings') pane.append(buildWorkspaceSettings(controller));
    panes.set(id, pane); body.append(pane);
    return pane;
  };
  const refresh = () => {
    if (controller.host.chatKey() !== chatKey) {
      chatKey = controller.host.chatKey();
      // Per-chat forms never carry a secret or holder selection into another chat.
      const chatPane = panes.get('chat');
      if (chatPane) chatPane.replaceChildren(buildStoryPanel(controller));
      state.activityMessageId = null;
      const activity = document.getElementById('rpd-activity');
      if (activity) activity.dataset.detailOpen = 'false';
    }
    if (state.tab === 'chat') refreshStory(controller);
    if (state.tab === 'activity') refreshActivity(controller, state);
    if (state.tab === 'lore') void refreshLorePanel(controller);
    document.getElementById('rpd-action-panel')?.dispatchEvent(new Event('rpd-refresh'));
    const ask = document.getElementById('rpd-ask-swiping') as HTMLInputElement | null;
    if (ask) ask.checked = controller.settings.askWhenSwiping;
    const rollback = document.getElementById('rpd-remove-rollback') as HTMLButtonElement | null;
    if (rollback) rollback.disabled = !controller.host.hasLegacyRecordBackup();
    const session = document.getElementById('rpd-session');
    if (session) {
      const state = connectionState(controller), totals = summarizeUsage(controller.sessionUsage ?? state.usage);
      const requests = controller.sessionUsage ? totals.requests : state.requests;
      session.textContent = `Session: ${requests} requests · ${costLabel(requests === 0 ? 0 : totals.costUsd, totals.unreportedCostRequests + Math.max(0, requests - totals.requests))}`;
    }
    const connection = document.getElementById('rpd-connection-section') as HTMLDetailsElement | null;
    if (connection) {
      const working = connectionState(controller).working;
      const title = connection.querySelector('summary b');
      if (title) title.textContent = working ? 'Connected' : 'Connection';
      if (connection.dataset.working !== String(working)) connection.open = !working;
      connection.dataset.working = String(working);
    }
  };
  const select = (id: WorkspaceTab, selectedMessage?: number) => {
    selectWorkspaceTab(state, id);
    if (selectedMessage !== undefined) state.activityMessageId = selectedMessage;
    ensurePane(id);
    if (selectedMessage !== undefined) {
      const activity = panes.get('activity')?.querySelector<HTMLElement>('#rpd-activity');
      if (activity) { activity.dataset.detailOpen = 'true'; activitySignatures.delete(activity); }
    }
    for (const [key, pane] of panes) pane.hidden = key !== id;
    for (const [key, control] of tabButtons) { control.setAttribute('aria-selected', String(key === id)); control.tabIndex = key === id ? 0 : -1; }
    refresh();
  };
  for (const [index, item] of WORKSPACE_TABS.entries()) {
    const control = button(`rpd-tab-${item.id}`, item.label, item.label, () => select(item.id));
    control.setAttribute('role', 'tab'); control.setAttribute('aria-controls', `rpd-pane-${item.id}`);
    control.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % WORKSPACE_TABS.length;
      else if (event.key === 'ArrowLeft') next = (index + WORKSPACE_TABS.length - 1) % WORKSPACE_TABS.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = WORKSPACE_TABS.length - 1;
      else return;
      event.preventDefault(); const id = WORKSPACE_TABS[next]!.id; select(id); tabButtons.get(id)?.focus();
    });
    tabs.append(control); tabButtons.set(item.id, control);
  }
  root.append(el('h2', { text: 'Director' }), tabs, body);
  const view: WorkspaceView = { state, element: root, select, refresh };
  workspaces.set(controller, view);
  select(state.tab, state.activityMessageId ?? undefined);
  try {
    await context.callGenericPopup(root, context.POPUP_TYPE.TEXT, '', {
      wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close',
      onOpen: (popup: { dlg?: HTMLElement }) => {
        popup.dlg?.classList.add('rpd-workspace-dialog');
        refresh();
      },
      onClosing: async () => {
        const secret = root.querySelector<HTMLTextAreaElement>('#rpd-secret-text');
        setWorkspaceDraftDirty(state, Boolean(table?.isDirty() || secret?.value.trim()));
        if (closeWorkspace(state)) return true;
        const result = await context.callGenericPopup!('Discard the unsaved table or secret?', context.POPUP_TYPE!.CONFIRM, '', { okButton: 'Discard', cancelButton: 'Keep editing' });
        return result === (context.POPUP_RESULT?.AFFIRMATIVE ?? 1) ? closeWorkspace(state, true) : false;
      },
    });
  } finally { if (workspaces.get(controller) === view) workspaces.delete(controller); }
}

function buildWorkspaceSettings(controller: Controller): HTMLElement {
  const connection = collapsible(connectionState(controller).working ? 'Connected' : 'Connection', 'Choose the judge for your replies.', buildConnection(controller));
  connection.id = 'rpd-connection-section';
  connection.open = !connectionState(controller).working;
  connection.dataset.working = String(connectionState(controller).working);
  const badges = el('input', { id: 'rpd-badges', type: 'checkbox' }); badges.checked = controller.settings.showBadges;
  badges.addEventListener('change', () => { controller.settings.showBadges = badges.checked; controller.host.saveSettings(); refreshWorkflowBadges(controller); });
  const copy = (value: unknown) => {
    if (!navigator.clipboard) { controller.host.toast('warning', 'Clipboard unavailable.'); return; }
    void navigator.clipboard.writeText(JSON.stringify(value, null, 2)).then(() => controller.host.toast('success', 'Copied JSON.')).catch(() => controller.host.toast('warning', 'Could not copy JSON.'));
  };
  const removeBackup = button('rpd-remove-rollback', 'Remove the 0.7 rollback copy', 'Keep the current Director record and remove its old rollback copy', () => {
    const chatKey = controller.host.chatKey();
    if (!chatKey) return;
    removeBackup.disabled = true;
    void controller.host.removeLegacyRecordBackup(chatKey).then(removed => {
      if (removed) controller.host.toast('success', 'Removed the 0.7 rollback copy.');
      removeBackup.disabled = !controller.host.hasLegacyRecordBackup();
    }).catch(() => {
      removeBackup.disabled = !controller.host.hasLegacyRecordBackup();
      controller.host.toast('warning', 'Could not save the removal of the rollback copy.');
    });
  });
  removeBackup.disabled = !controller.host.hasLegacyRecordBackup();
  const advanced = el('div', {}, [collapsible('Manual move', 'Choose a move for the next reply.', buildActionPanel(controller)),
    el('div', { class: 'rpd-row' }, [button('rpd-state-export', 'Copy chat JSON', 'Copy the Director chat record', () => copy(controller.record)),
      button('rpd-activity-export', 'Copy activity JSON', 'Copy the saved activity', () => copy({ turns: activityTurns(controller.host.chat(), id => controller.host.readWorkflowBadge(id), controller.record?.inspector ?? []), events: controller.record?.inspector ?? [] }))]),
    el('div', { class: 'rpd-row' }, [removeBackup])]);
  return el('div', {}, [connection, el('p', { id: 'rpd-session', class: 'rpd-muted' }), el('h3', { text: 'Modules' }), buildModuleSettings(controller),
    collapsible('NPC reactions', 'Choose how likely each reaction is.', buildReactionSettings(controller)),
    collapsible('Pacing texts', 'Set the guidance for each scene.', buildPacingSettings(controller)),
    collapsible('Reply-check thresholds', 'Choose which scores need attention.', buildReplyCheckSettings(controller)),
    el('p', {}, [el('label', {}, [badges, ' Reply badges'])]), collapsible('Advanced', 'Manual moves, JSON exports and rollback storage.', advanced)]);
}

export function refreshWorkflowBadges(controller: Controller): void {
  if (typeof document === 'undefined') return;
  for (const messageElement of document.querySelectorAll<HTMLElement>('#chat .mes[mesid]')) {
    const id = Number(messageElement.getAttribute('mesid'));
    if (!Number.isInteger(id)) continue;
    const badge = controller.settings.showBadges ? controller.host.readWorkflowBadge(id) : null;
    let pill = messageElement.querySelector<HTMLButtonElement>('.rpd-workflow-badge');
    if (!badge) { pill?.remove(); continue; }
    const block = messageElement.querySelector('.mes_block');
    if (!block) continue;
    if (!pill) {
      pill = el('button', { type: 'button', class: 'menu_button rpd-workflow-badge', title: 'View Director decisions' });
      pill.addEventListener('click', () => void openWorkflowBadge(controller, id));
      block.append(pill);
    }
    pill.textContent = displayText(controller, workflowBadgeLabel(badge));
  }
}

function displayText(controller: Controller, text: string): string {
  return playerUiText(text, controller.record?.actors.player?.name ?? controller.host.ctx().name1);
}

function badgeDetails(controller: Controller, badge: WorkflowBadge): HTMLElement {
  const content = el('div', { class: 'rpd-turn-details' });
  const name = (id: string) => uiActorName(id, badge.actorNames?.[id] ?? controller.record?.actors[id]?.name);
  const paragraph = (text: string) => el('p', { text: displayText(controller, text) });
  const section = (title: string, children: HTMLElement[]) => el('section', {}, [el('h3', { text: title }), ...children]);
  if (badge.rerolledByCheck) content.append(paragraph(`Rerolled (${badge.rerolledByCheck}). ${badge.replyOriginalSwipe === undefined ? 'The original reply is saved in this message’s swipes.'
    : badge.replyOriginalSwipe < 0 ? 'The original reply was deleted.' : `The original reply is swipe ${badge.replyOriginalSwipe + 1}.`}`));
  content.append(section('Move', [paragraph(badge.move ?? badge.results[0]?.action ?? 'No move.'),
    ...(badge.route ? [paragraph(`${name(badge.route.actorId)} → ${badge.route.targetActorIds.map(name).join(', ') || 'the scene'} · ${badge.route.kind.replaceAll('_', ' ')}`)] : [])]));
  const rulings = badge.results.map(result => el('div', {}, [paragraph(`${name(result.actorId)}: ${result.outcome.replaceAll('_', ' ')}`),
    paragraph([result.odds === null ? 'Odds: not used' : `Odds: ${Math.round(result.odds * 100)}%`, result.draw === null ? 'Roll: not used' : `Roll: ${Math.round(result.draw * 100)}/100`].join(' · ')),
    ...(result.source === 'npc' ? [paragraph(result.action)] : []), paragraph(result.instruction || 'No instruction recorded.')]));
  if (badge.unavailable) rulings.unshift(paragraph("The judge was unavailable for part of this turn. Your chat isn't affected."));
  if (badge.toolError) rulings.push(paragraph("The writer's move could not be ruled. Your chat isn't affected."));
  if (!rulings.length) rulings.push(paragraph('No ruling for this reply.'));
  if (badge.reaction) rulings.push(paragraph(`Reaction: ${name(badge.reaction.actorId)} · ${badge.reaction.outcome.replaceAll('_', ' ')}`));
  if (badge.speaker) rulings.push(paragraph(`Speaker: ${name(badge.speaker.actorId)}`));
  content.append(section('Ruling', rulings));
  if (badge.writerInstruction) content.append(el('details', {}, [el('summary', { text: 'Writer instruction' }),
    el('pre', { text: displayText(controller, badge.writerInstruction) })]));
  const changes = (badge.meterChanges ?? []).map(change => paragraph(`${name(change.actorId)} · ${change.label}: ${change.fromLabel} → ${change.toLabel}`));
  changes.push(...(badge.reveals ?? []).map(reveal => paragraph(`${reveal.actorIds.map(name).join(', ')} learned: ${reveal.text}`)));
  content.append(section('State changes', changes.length ? changes : [paragraph('No changes recorded.')]),
    section('Lore', badge.lore?.length ? badge.lore.map(pick => paragraph(`${pick.world} › ${pick.title}`)) : [paragraph('No lore picked.')]));
  content.append(section('Pacing', [paragraph(badge.pacing?.scene ? `Scene: ${badge.pacing.scene}` : 'No scene decision recorded.'),
    paragraph(badge.pacing?.handBack === 'HAND_BACK' ? 'Hand back at the first beat where {{user}} must respond.' : badge.pacing?.handBack === 'CONTINUE' ? 'Continue the current short beat.' : 'No hand-back decision recorded.')]));
  const check = badge.replyCheck;
  content.append(section('Reply check', badge.replyCheckError ? [paragraph(`Reply check: unavailable. ${badge.replyCheckError}`)] : check ? [paragraph(check.reason ? `Needs correction: ${check.reason}` : 'No automatic rewrite needed.'),
    paragraph(`Writes for {{user}}: ${check.speaksForUser ?? 'not reported'} · Responds: ${check.responds ?? 'not reported'} · Repetition: ${check.repeats ?? 'not reported'} · Follows ruling: ${check.followsRuling ?? 'not checked'}`),
    ...(check.nudge ? [paragraph(`Next turn: ${check.nudge}`)] : [])] : [paragraph('No reply check recorded.')]));
  return content;
}

function renderActivityTurn(controller: Controller, turn: ActivityTurn): HTMLElement {
  const content = el('div', {}, [el('h3', { text: `Reply ${turn.messageId + 1} · Swipe ${turn.swipeId + 1}` })]);
  if (turn.badge) content.append(badgeDetails(controller, turn.badge));
  else content.append(el('p', { text: 'No Director record for this reply.' }));
  const metrics = activityMetrics(turn.entries);
  const usage = activityUsage(turn);
  const duration = summarizeUsage(usage).durationMs ?? metrics.durationMs;
  content.append(el('p', { class: 'rpd-muted', text: `${usageLabel(usage, metrics.requests)} · Recorded request time (ms): ${duration === null ? 'not recorded' : Math.round(duration)}` }));
  for (const receipt of usage) content.append(el('p', { class: 'rpd-request-usage', text: `${receipt.stage.replaceAll('_', ' ')} · ${costLabel(receipt.costUsd)} · Tokens in/out: ${receipt.inputTokens ?? 'not reported'}/${receipt.outputTokens ?? 'not reported'} · Time (ms): ${receipt.durationMs === null ? 'not reported' : Math.round(receipt.durationMs)}` }));
  const raw = el('details', {}, [el('summary', { text: 'Raw' }), el('pre', { text: displayText(controller, JSON.stringify({ errors: turn.badge?.errors ?? [], usage, requests: turn.entries.map(entry => ({ questions: entry.questions, answers: entry.answers, requests: entry.networkCalls, durationMs: entry.durationMs })) }, null, 2)) })]);
  if (!turn.entries.length) raw.append(el('p', { text: 'Request details are no longer recorded for this reply.' }));
  content.append(raw);
  return content;
}

function refreshActivity(controller: Controller, state: WorkspaceState): void {
  const host = document.getElementById('rpd-activity');
  if (!host) return;
  const turns = activityTurns(controller.host.chat(), id => controller.host.readWorkflowBadge(id), controller.record?.inspector ?? []);
  const requested = state.activityMessageId;
  let selected = turns.find(turn => turn.messageId === requested);
  // The list stays at 20 replies, but a historical badge can still open its own details.
  if (!selected && requested !== null) {
    const message = controller.host.chat()[requested];
    const badge = controller.host.readWorkflowBadge(requested);
    if (message && !message.is_user && !message.is_system) selected = { messageId: requested, swipeId: message.swipe_id ?? 0, badge,
      entries: badge ? (controller.record?.inspector ?? []).filter(entry => entry.attemptId === badge.attemptId) : [] };
  }
  selected ??= turns.at(-1);
  state.activityMessageId = selected?.messageId ?? null;
  const notes = (controller.record?.inspector ?? []).filter(entry => entry.kind === 'info' && /removed .*footer/i.test(entry.message));
  const signature = () => JSON.stringify([turns, notes, state.activityMessageId, selected]);
  if (activitySignatures.get(host) === signature()) return;
  const list = el('div', { class: 'rpd-activity-list', 'aria-label': 'Last 20 replies' });
  const detail = el('div', { class: 'rpd-activity-detail' });
  const layout = el('div', { class: 'rpd-activity-layout' }, [list, detail]);
  layout.classList.toggle('rpd-detail-open', host.dataset.detailOpen === 'true');
  const show = (turn: ActivityTurn, focus = false) => {
    state.activityMessageId = turn.messageId;
    for (const control of list.querySelectorAll<HTMLButtonElement>('button')) control.setAttribute('aria-pressed', String(Number(control.dataset.messageId) === turn.messageId));
    const back = button('rpd-activity-back', 'Back', 'Back to replies', () => { host.dataset.detailOpen = 'false'; layout.classList.remove('rpd-detail-open'); list.querySelector<HTMLButtonElement>(`[data-message-id="${turn.messageId}"]`)?.focus(); });
    detail.replaceChildren(back, renderActivityTurn(controller, turn));
    if (focus) { host.dataset.detailOpen = 'true'; layout.classList.add('rpd-detail-open'); back.focus(); }
  };
  for (const turn of [...turns].reverse()) {
    const label = turn.badge ? workflowBadgeLabel(turn.badge).replace(/^Director · /, '') : 'No Director record';
    const control = button(`rpd-turn-${turn.messageId}`, `Reply ${turn.messageId + 1} · ${displayText(controller, label)}`, 'View this reply', () => show(turn, true));
    control.dataset.messageId = String(turn.messageId); list.append(control);
  }
  if (selected) show(selected);
  else list.append(el('p', { text: 'No replies yet.' }));
  host.replaceChildren(el('p', { class: 'rpd-muted', text: 'Last 20 replies' }), ...notes.map(entry => el('p', { text: entry.message })), layout);
  activitySignatures.set(host, signature());
}

export async function openWorkflowBadge(controller: Controller, messageId: number): Promise<void> {
  const badge = controller.host.readWorkflowBadge(messageId);
  const context = controller.host.ctx();
  if (!badge || !context.callGenericPopup || !context.POPUP_TYPE) return;
  const message = controller.host.chat()[messageId];
  const swipeId = message?.swipe_id ?? 0;
  const chatKey = controller.host.chatKey();
  const transcript = JSON.stringify(controller.host.fingerprintMessages(controller.host.chat().slice(0, messageId + 1)));
  const selected = messageId === controller.host.chat().length - 1;
  const idle = controller.settings.enabled && controller.settings.modules.decisions && !controller.record?.paused && !controller.host.isGenerating();
  const content = el('div', { class: 'rpd-workflow-popup' }, [el('h2', { text: 'Director' }), badgeDetails(controller, badge)]);
  const REROLL = 1001, REASSESS = 1002, RETRY = 1003, ACTIVITY = 1004;
  const buttons = [];
  if (selected && idle && controller.canRerollSelected() && badge.results.some(item => item.draw !== null)) buttons.push({ text: 'Roll again', result: REROLL, icon: 'fa-dice' });
  if (selected && idle && controller.record?.attempts[badge.attemptId]) buttons.push({ text: 'Reassess', result: REASSESS, icon: 'fa-rotate' });
  if (selected && idle && (badge.retryEligible ?? (badge.unavailable && !badge.results.length))) buttons.push({ text: 'Try the judge again', result: RETRY, icon: 'fa-rotate' });
  buttons.push({ text: 'Open Activity', result: ACTIVITY, icon: 'fa-clock' });
  const entries = controller.record?.inspector.filter(entry => entry.attemptId === badge.attemptId) ?? [];
  const metrics = activityMetrics(entries);
  const usage = activityUsage({ badge, entries });
  content.append(el('p', { class: 'rpd-muted', text: `${usageLabel(usage, metrics.requests)} · Recorded request time (ms): ${summarizeUsage(usage).durationMs ?? metrics.durationMs ?? 'not recorded'}` }));
  const result = await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', { okButton: 'Close', customButtons: buttons, allowVerticalScrolling: true });
  if (chatKey !== controller.host.chatKey() || controller.host.chat()[messageId] !== message || (message?.swipe_id ?? 0) !== swipeId
    || controller.host.readWorkflowBadge(messageId)?.attemptId !== badge.attemptId
    || JSON.stringify(controller.host.fingerprintMessages(controller.host.chat().slice(0, messageId + 1))) !== transcript) return;
  if (result === ACTIVITY) { await openDirector(controller, 'activity', messageId); return; }
  if (messageId !== controller.host.chat().length - 1) return;
  if (result === REROLL && buttons.some(button => button.result === REROLL)) await controller.reroll(true);
  if (result === REASSESS && buttons.some(button => button.result === REASSESS)) await controller.reassess(true);
  if (result === RETRY && buttons.some(button => button.result === RETRY)) await controller.retryJudge();
}
