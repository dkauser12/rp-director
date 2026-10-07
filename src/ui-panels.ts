import type { Controller } from './controller.ts';
import { JEV_KEY_STORAGE, STRUCTURED_KEY_STORAGE } from './controller.ts';
import { el, button } from './dom.ts';
import { NPC_REACTION_GROUPS } from './npc-reaction.ts';
import { uiActorName } from './identity.ts';
import { DEFAULT_PACING_TEXTS, REPLY_CHECK_FIELDS } from './ui-preferences.ts';

export function buildPacingSettings(controller: Controller): HTMLElement {
  const handBack = el('input', { id: 'rpd-hand-back-beats', type: 'checkbox' });
  handBack.checked = controller.settings.handBackBeats !== false;
  handBack.disabled = !controller.settings.modules.pacing;
  handBack.addEventListener('change', () => { controller.settings.handBackBeats = handBack.checked; controller.host.saveSettings(); });
  const body = el('div', {}, [el('label', {}, [handBack, ' Hand the turn back at beats']),
    el('p', { class: 'rpd-muted', text: 'Stop when {{user}} must respond; show a cue when Dynamic Response is enabled.' })]);
  for (const key of Object.keys(DEFAULT_PACING_TEXTS) as (keyof typeof DEFAULT_PACING_TEXTS)[]) {
    const text = el('textarea', { id: `rpd-pacing-${key}`, class: 'text_pole', rows: '3', 'aria-label': key });
    text.value = controller.settings.pacingTexts[key];
    text.addEventListener('change', () => { controller.settings.pacingTexts[key] = text.value; controller.host.saveSettings(); });
    body.append(el('label', { class: 'rpd-field' }, [key[0]!.toUpperCase() + key.slice(1), text]));
  }
  return body;
}

export function buildReplyCheckSettings(controller: Controller): HTMLElement {
  const body = el('div', {}, [el('p', { class: 'rpd-muted', text: 'Check each reply and automatically rewrite at most once per user turn.' })]);
  for (const field of REPLY_CHECK_FIELDS) {
    const input = el('input', { id: `rpd-check-${field.key}`, type: 'number', class: 'text_pole', min: '0', max: String(field.max), step: '0.05', value: String(controller.settings.replyCheckThresholds[field.key]) });
    input.addEventListener('change', () => {
      const value = input.value.trim() ? Number(input.value) : NaN;
      if (!Number.isFinite(value) || value < 0 || value > field.max) { input.value = String(controller.settings.replyCheckThresholds[field.key]); return; }
      controller.settings.replyCheckThresholds[field.key] = value; controller.host.saveSettings();
    });
    body.append(row(field.label, input));
  }
  body.append(el('p', { class: 'rpd-muted', text: 'These thresholds trigger an automatic rewrite or a nudge on the next turn.' }));
  return body;
}

export function buildModuleSettings(controller: Controller): HTMLElement {
  const askWhenSwiping = el('input', { id: 'rpd-ask-swiping', type: 'checkbox' }); askWhenSwiping.checked = controller.settings.askWhenSwiping;
  askWhenSwiping.addEventListener('change', () => { controller.settings.askWhenSwiping = askWhenSwiping.checked; controller.host.saveSettings(); });
  const reviewNpc = el('input', { id: 'rpd-review-npc', type: 'checkbox' }); reviewNpc.checked = controller.settings.reviewNpcRolls;
  reviewNpc.addEventListener('change', () => { controller.settings.reviewNpcRolls = reviewNpc.checked; controller.host.saveSettings(); });
  const wait = el('input', { id: 'rpd-wait-seconds', type: 'number', min: '2', max: '120', step: '1', class: 'text_pole', value: String(controller.settings.waitForJudgeSeconds) });
  wait.addEventListener('change', () => {
    const value = Number(wait.value);
    if (!Number.isFinite(value)) { wait.value = String(controller.settings.waitForJudgeSeconds); return; }
    controller.settings.waitForJudgeSeconds = Math.max(2, Math.min(value, 120));
    wait.value = String(controller.settings.waitForJudgeSeconds);
    controller.host.saveSettings();
  });
  const toggle = (id: string, label: string, key: 'speaker' | 'decisions' | 'meters' | 'secrets' | 'lore' | 'pacing' | 'replyCheck', tip: string, requests: string) => {
    const input = el('input', { id, type: 'checkbox', title: tip });
    input.checked = Boolean(controller.settings.modules[key]);
    input.addEventListener('change', () => {
      controller.settings.modules[key] = input.checked; controller.host.saveSettings();
      if (key === 'pacing') {
        const handBack = document.getElementById('rpd-hand-back-beats') as HTMLInputElement | null;
        if (handBack) handBack.disabled = !input.checked;
      }
    });
    return el('div', { class: 'rpd-module' }, [el('label', {}, [input, ` ${label}`]), el('span', { class: 'rpd-muted', text: requests }), el('p', { text: tip })]);
  };
  return el('div', { id: 'rpd-modules' }, [
    el('div', {}, [el('label', {}, [askWhenSwiping, ' Ask when swiping a ruled reply'])]),
    el('div', {}, [el('label', {}, [reviewNpc, ' Review NPC rolls before the writer continues'])]),
    row('Wait for the judge (s)', wait),
    el('div', { class: 'rpd-note', text: 'When this time runs out, your reply continues with any decisions already completed.' }),
    el('div', {}, [
      toggle('rpd-module-speaker', 'Speaker', 'speaker', 'Choose who replies in group chats.', 'about 1 request per turn, shared'),
      toggle('rpd-module-decisions', 'Decisions', 'decisions', 'Decide what happens when a character tries a consequential move.', 'about 3 requests per turn, plus 1 per NPC request'),
      toggle('rpd-module-meters', 'Meters', 'meters', 'Set character feelings at most one step per turn.', 'about 1 request per turn, shared'),
      toggle('rpd-module-secrets', 'Secrets', 'secrets', 'Track which characters learn a secret.', 'about 1 request per turn, shared'),
      toggle('rpd-module-lore', 'Lore', 'lore', 'Pick relevant entries from this chat’s lorebooks.', 'about 1 request per book level per turn'),
      toggle('rpd-module-pacing', 'Pacing', 'pacing', 'Keep each reply in the current scene without skipping time.', 'about 1 request per turn, shared'),
      toggle('rpd-module-reply-check', 'Reply check', 'replyCheck', 'Check for writing for {{user}}, ignored input, repetition and broken rulings.', '1 request per reply'),
    ]),
    el('div', { class: 'rpd-note', text: 'Shared requests cover several modules; large casts or books can need more requests.' }),
  ]);
}

export function buildStoryPanel(controller: Controller): HTMLElement {
  const packTip = 'The pack sets the kinds of moves and meters for this chat.';
  const pack = el('select', { id: 'rpd-pack', class: 'text_pole', title: packTip });
  pack.addEventListener('change', () => void controller.setChatPack(pack.value));
  const packNote = el('div', { id: 'rpd-pack-note', class: 'rpd-note' });
  const meters = el('div', { id: 'rpd-meters' });
  const secrets = el('div', { id: 'rpd-secrets-list' });
  const text = el('textarea', { id: 'rpd-secret-text', class: 'text_pole', rows: '2', placeholder: 'A secret, for example: The guide has a spare key.', title: 'Only the selected characters know this secret.' });
  const holders = el('div', { id: 'rpd-secret-holders', class: 'rpd-row' });
  const add = button('rpd-secret-add', 'Add secret', 'Add this secret, known from the start by the characters ticked above', () => {
    if (!controller.record || !text.value.trim() || add.disabled) return;
    const draft = text.value;
    const key = controller.host.chatKey();
    add.disabled = true;
    const chosen = [...holders.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked')].map(box => box.value);
    void controller.addSecret(draft, chosen).then(() => { if (controller.host.chatKey() === key && text.value === draft) text.value = ''; }).finally(() => { add.disabled = false; });
  });
  const speaker = el('select', { id: 'rpd-speaker', class: 'text_pole' });
  speaker.addEventListener('change', () => controller.setSpeakerOverride(speaker.value === 'auto' ? null : speaker.value));
  return el('div', { id: 'rpd-story' }, [
    row('Next speaker', speaker),
    el('div', { class: 'rpd-row' }, [el('label', { text: 'Genre pack', title: packTip }), pack]),
    packNote,
    el('div', { class: 'rpd-subhead', text: 'Meters' }),
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

const storySignatures = new WeakMap<HTMLElement, string>();

export function refreshStory(controller: Controller): void {
  const pack = document.getElementById('rpd-pack') as HTMLSelectElement | null;
  if (!pack) return;
  const speaker = document.getElementById('rpd-speaker') as HTMLSelectElement | null;
  if (speaker) {
    speaker.replaceChildren(el('option', { value: 'auto', text: 'Automatic' }), el('option', { value: 'YIELD', text: 'Yield to {{user}}' }),
      ...controller.actorsForUi().map(actor => { const option = el('option', { value: actor.actorId, text: uiActorName(actor.actorId, actor.name) + (actor.disabled ? ' (muted)' : '') }); option.disabled = actor.disabled; return option; }));
    speaker.value = controller.speakerOverride ?? 'auto';
    speaker.disabled = !controller.record;
  }
  const text = document.getElementById('rpd-secret-text') as HTMLTextAreaElement | null;
  if (text) text.disabled = !controller.record;
  const info = controller.chatPackInfo();
  const packs = controller.packsForUi();
  const state = controller.characterStateForUi();
  const secrets = controller.secretsForUi();
  const actors = controller.actionActorsForUi();
  const lastLore = controller.lastLoreForUi();
  const signature = JSON.stringify([controller.host.chatKey(), info, packs.map(p => p.id), state, secrets, actors, lastLore]);
  if (signature === storySignatures.get(pack)) return;
  storySignatures.set(pack, signature);

  pack.replaceChildren(el('option', { value: 'auto', text: 'Automatic' }), ...packs.map(p => el('option', { value: p.id, text: p.label })));
  pack.disabled = !info;
  pack.value = info?.packId ?? 'auto';
  const note = document.getElementById('rpd-pack-note');
  if (note) {
    const chosen = packs.find(p => p.id === info?.packId);
    note.textContent = !info ? 'Open a chat to choose its pack.'
      : chosen ? `Uses ${chosen.label} moves and meters.`
      : 'The judge picks a pack on the first turn.';
  }

  const meters = document.getElementById('rpd-meters');
  if (meters) {
    meters.replaceChildren(...(state.length ? state.map(c => el('div', { class: 'rpd-meter-line', text: `${c.name}: ${c.meters.map(m => `${m.label}: ${m.level}`).join(' · ')}` }))
      : [el('div', { class: 'rpd-muted', text: 'The judge has not set any meters yet.' })]));
  }

  const loreLast = document.getElementById('rpd-lore-last');
  if (loreLast) {
    loreLast.replaceChildren(...(lastLore && lastLore.entries.length ? lastLore.entries.map(e => el('div', { class: 'rpd-meter-line', text: `${e.book} › ${e.title}` }))
      : [el('div', { class: 'rpd-muted', text: lastLore ? 'Nothing was needed from the lorebooks.' : 'No lore picked yet.' })]));
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

export function buildReactionSettings(controller: Controller): HTMLElement {
  const enabled = el('input', { id: 'rpd-reactions-enabled', type: 'checkbox' });
  enabled.checked = controller.settings.reactions.enabled;
  enabled.addEventListener('change', () => {
    controller.settings.reactions.enabled = enabled.checked;
    controller.host.saveSettings();
  });
  const body = el('div', { id: 'rpd-reactions' }, [
    el('label', {}, [enabled, ' NPC reactions']),
    el('div', { class: 'rpd-muted', text: 'about 0 extra requests per turn, shared with Decisions' }),
    el('div', { class: 'rpd-note', text: 'Higher weights make a reaction more likely; zero excludes it.' }),
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
      error.textContent = !validNumbers ? 'Use a weight of zero or greater for every option.'
        : !validTotal ? 'Give at least one option a positive weight.' : '';
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

export function buildConnection(controller: Controller): HTMLElement {
  const current = controller.settings.connection;
  const host = el('div', { class: 'rpd-connection' });
  const status = el('div', { class: 'rpd-note' });
  const openRouterModel = el('input', { type: 'text', class: 'text_pole', value: current.kind === 'openrouter' ? current.model : '', placeholder: 'OpenRouter model id' });
  const kind = el('select', { class: 'text_pole' });
  for (const [value, label] of [['', 'Choose an advanced connection'], ['jev', 'Jev (TypeSafe)'], ['structured', 'Structured judge']] as const) kind.append(el('option', { value, text: label }));
  kind.value = current.kind === 'jev' || current.kind === 'structured' ? current.kind : '';
  const baseUrl = el('input', { type: 'text', class: 'text_pole', value: current.baseUrl, placeholder: 'Endpoint / base URL' });
  const model = el('input', { type: 'text', class: 'text_pole', value: current.kind === 'openrouter' ? '' : current.model, placeholder: 'Model id' });
  const stProfile = el('select', { class: 'text_pole' });
  stProfile.append(el('option', { value: '', text: 'Direct endpoint' }));
  for (const p of controller.host.connectionProfiles()) stProfile.append(el('option', { value: p.id, text: `${p.name}${p.model ? ' / ' + p.model : ''}` }));
  stProfile.value = current.stProfileId;
  const sessionKey = el('input', { type: 'password', class: 'text_pole', placeholder: 'Session-only key', autocomplete: 'off' });
  const keyStorage = () => kind.value === 'jev' ? JEV_KEY_STORAGE : STRUCTURED_KEY_STORAGE;
  sessionKey.addEventListener('change', () => { if (sessionKey.value) sessionStorage.setItem(keyStorage(), sessionKey.value); else sessionStorage.removeItem(keyStorage()); controller.lastWorkingConnection = null; controller.refreshStatus(); });
  const rowProfile = row('Connection profile', stProfile);
  const rowUrl = row('Endpoint', baseUrl);
  const rowModel = row('Model', model);
  const rowKey = row('Session key', sessionKey);
  const advanced = collapsible('Advanced', 'Native Jev and structured judge connections.', el('div', {}, [row('Connection', kind), rowProfile, rowUrl, rowModel, rowKey]));
  advanced.open = Boolean(kind.value);
  const update = () => {
    const selected = controller.settings.connection.kind;
    status.textContent = selected === 'openrouter' ? 'OpenRouter through the server plugin (recommended).'
      : selected === 'jev' ? 'Using native Jev (TypeSafe).' : selected === 'structured' ? 'Using the structured judge.' : 'Choose a connection.';
    const value = kind.value;
    rowProfile.hidden = value !== 'structured';
    rowUrl.hidden = value !== 'jev' && !(value === 'structured' && !stProfile.value);
    rowModel.hidden = !value;
    rowKey.hidden = rowUrl.hidden;
    sessionKey.value = sessionStorage.getItem(keyStorage()) ?? '';
  };
  const saveOpenRouter = () => {
    controller.settings.connection = { ...controller.settings.connection, kind: 'openrouter', model: openRouterModel.value.trim() };
    kind.value = '';
    controller.host.saveSettings();
    controller.reloadProfile();
    update();
  };
  const saveAdvanced = () => {
    if (kind.value !== 'jev' && kind.value !== 'structured') { update(); return; }
    controller.settings.connection = { kind: kind.value, baseUrl: baseUrl.value.trim(), model: model.value.trim(), stProfileId: stProfile.value, mockScenario: current.mockScenario };
    controller.host.saveSettings();
    controller.reloadProfile();
    update();
  };
  for (const node of [kind, baseUrl, model, stProfile]) node.addEventListener('change', saveAdvanced);
  openRouterModel.addEventListener('change', saveOpenRouter);
  host.append(status, row('OpenRouter model', openRouterModel),
    button('rpd-use-openrouter', 'Use OpenRouter', 'Use the recommended OpenRouter server plugin connection', saveOpenRouter), advanced);
  update();
  return host;
}
export function row(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'rpd-row' }, [el('label', { text: label }), control]);
}

export function collapsible(title: string, description: string, body: HTMLElement): HTMLDetailsElement {
  return el('details', { class: 'rpd-section' }, [el('summary', {}, [el('b', { text: title }), el('span', { class: 'rpd-muted', text: ` — ${description}` })]), body]);
}
