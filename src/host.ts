/**
 * Host adapter: the only module that touches SillyTavern.
 *
 * Every call site here was verified against the installed checkout and is
 * recorded in COMPATIBILITY.md. The adapter reaches the host through the
 * global `SillyTavern.getContext()` (script.js) and never patches host core.
 * Live generation flags that are not exposed on the context are read through
 * a dynamic import of the host module, with a DOM fallback.
 */
import type { DirectorSettings, Json, TurnPermit } from './types.ts';
import type { RollReviewChoice } from './roll-review.ts';
import type { FingerprintMessage } from './identity.ts';
import type { StructuredTransport } from './providers.ts';
import type { OpenRouterDecisionsTransport } from './providers.ts';
import { createOpenRouterTransport, ProviderError } from './providers.ts';
import { DEFAULT_PROFILE_ID } from './profiles.ts';
import { migrateAutoHistory, normalizeBaseSettings } from './migration.ts';

export const INJECTION_KEY = 'rp_director_binding';
export const SETTINGS_KEY = 'rpDirector';
export const METADATA_KEY = 'rpDirector';
export const VARIANT_MARKER_KEY = 'rpd';

/** Subset of the host context this extension relies on. Everything else is deliberately untyped. */
export interface StContext {
  chat: HostChatMessage[];
  characters: HostCharacter[];
  groups: HostGroup[];
  name1: string;
  characterId: number | string | undefined;
  groupId: string | null;
  chatId: string | undefined;
  chatMetadata: Record<string, unknown>;
  extensionSettings: Record<string, unknown>;
  eventSource: { on: (event: string, handler: (...args: unknown[]) => unknown) => void; removeListener: (event: string, handler: (...args: unknown[]) => unknown) => void };
  eventTypes: Record<string, string>;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  shouldSendOnEnter?: () => boolean;
  generate: (type: string, options?: Record<string, unknown>, dryRun?: boolean) => Promise<unknown>;
  stopGeneration: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
  saveSettingsDebounced: () => void;
  setExtensionPrompt: (key: string, value: string, position: number, depth: number, scan?: boolean, role?: number, filter?: unknown) => void;
  swipe: { right: (event?: unknown, options?: Record<string, unknown>) => Promise<void>; to?: (event: unknown, direction: string, options: Record<string, unknown>) => Promise<void>; state?: () => string };
  Popup?: { util: { isPopupOpen: () => boolean } };
  ConnectionManagerRequestService: { sendRequest: (profileId: string, prompt: unknown, maxTokens: number, custom?: Record<string, unknown>, overridePayload?: Record<string, unknown>) => Promise<unknown> };
  ChatCompletionService: { processRequest: (requestData: Record<string, unknown>, options: Record<string, unknown>, extractData?: boolean, signal?: AbortSignal | null) => Promise<unknown> };
  uuidv4: () => string;
  callGenericPopup?: (content: string | HTMLElement, type: unknown, inputValue?: string, options?: Record<string, unknown>) => Promise<unknown>;
  POPUP_TYPE?: Record<string, unknown>;
  POPUP_RESULT?: Record<string, unknown>;
  registerFunctionTool?: (tool: HostFunctionTool) => void;
  unregisterFunctionTool?: (name: string) => void;
  isToolCallingSupported?: () => boolean;
  canPerformToolCalls?: (type: string) => boolean;
}

export interface HostFunctionTool {
  name: string;
  displayName?: string;
  description: string;
  parameters: Json;
  action: (args: unknown) => Promise<string> | string;
  formatMessage?: (args: unknown) => string;
  shouldRegister?: () => boolean;
  stealth?: boolean;
}

export interface HostChatMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  original_avatar?: string;
  swipe_id?: number;
  swipes?: string[];
  swipe_info?: { extra?: Record<string, unknown> }[];
  extra?: Record<string, unknown>;
}

export interface HostCharacter {
  name: string;
  avatar: string;
  description?: string;
  chat?: string;
}

export interface HostGroup {
  id: string;
  name: string;
  chat_id: string;
  members: string[];
  disabled_members: string[];
  activation_strategy?: number;
  generation_mode?: number;
}

export interface HostActor {
  avatar: string;
  name: string;
  /** Current array index; re-resolved before every generation, never persisted. */
  index: number;
  disabled: boolean;
}

export interface VariantMarker {
  v: string;
  a: string;
  r: string | null;
}

export interface HostFlags {
  isGroupGenerating: () => boolean;
  isAutoMode: () => boolean;
  isSendPress: () => boolean;
  /** Host's own user-message path (script.js `sendMessageAsUser`), used when the Director yields with composer text. */
  sendMessageAsUser: ((text: string, bias: string) => Promise<unknown>) | null;
}

const EXTENSION_PROMPT_TYPE_IN_CHAT = 1;
const ROLE_NUMBER: Record<'system' | 'user' | 'assistant', number> = { system: 0, user: 1, assistant: 2 };

export function defaultSettings(): DirectorSettings {
  return {
    enabled: true,
    profileId: DEFAULT_PROFILE_ID,
    bindingConfirmedAt: null,
    connection: { kind: 'mock', baseUrl: '', model: '', stProfileId: '', mockScenario: 'gate-deferred' },
    observerConnection: { stProfileId: '' },
    showBar: true,
    inspectorOpen: false,
    profileOverrides: {},
  };
}

export class Host {
  private flags: HostFlags | null = null;
  private ownedTool: HostFunctionTool | null = null;

  ctx(): StContext {
    const st = (globalThis as unknown as { SillyTavern?: { getContext?: () => StContext } }).SillyTavern;
    if (!st || typeof st.getContext !== 'function') throw new Error('SillyTavern.getContext is not available');
    return st.getContext();
  }

  /** Loads live flag getters from host modules; safe to call more than once. */
  async loadFlags(): Promise<void> {
    if (this.flags) return;
    try {
      const groupUrl = new URL('../../../group-chats.js', import.meta.url).href;
      const scriptUrl = new URL('../../../../script.js', import.meta.url).href;
      const [groupModule, scriptModule] = await Promise.all([import(/* @vite-ignore */ groupUrl), import(/* @vite-ignore */ scriptUrl)]);
      this.flags = {
        isGroupGenerating: () => Boolean(groupModule.is_group_generating),
        isAutoMode: () => Boolean(groupModule.is_group_automode_enabled),
        isSendPress: () => Boolean(scriptModule.is_send_press),
        sendMessageAsUser: typeof scriptModule.sendMessageAsUser === 'function' ? scriptModule.sendMessageAsUser : null,
      };
    } catch (error) {
      console.warn('[RP Director] host flag import failed; using DOM fallback', error);
      this.flags = {
        isGroupGenerating: () => document.body.dataset.generating === 'true',
        isAutoMode: () => false,
        isSendPress: () => document.body.dataset.generating === 'true',
        sendMessageAsUser: null,
      };
    }
  }

  /** Posts the composer text as a user message without any reply, through the host's own path. Returns false if unavailable. */
  async postUserMessage(text: string): Promise<boolean> {
    const fn = this.flags?.sendMessageAsUser;
    if (!fn) return false;
    await fn(text, '');
    const composer = this.composer();
    if (composer) {
      composer.value = '';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await this.ctx().saveChat();
    return true;
  }

  isGenerating(): boolean {
    const f = this.flags;
    if (f) return f.isGroupGenerating() || f.isSendPress();
    return document.body.dataset.generating === 'true';
  }

  isAutoMode(): boolean {
    return this.flags ? this.flags.isAutoMode() : false;
  }

  isAutoDirectorEnabled(): boolean {
    // The consolidated base owns generation when enabled, irrespective of
    // whether the legacy Auto settings are still present.
    const all = this.ctx().extensionSettings;
    const base = all[SETTINGS_KEY] as { enabled?: unknown } | undefined;
    return !base?.enabled && Boolean((all.rpDirectorAuto as { enabled?: unknown } | undefined)?.enabled);
  }

  takeOverAuto(): void {
    const all = this.ctx().extensionSettings;
    if (!(all[SETTINGS_KEY] as DirectorSettings | undefined)?.enabled) return;
    const sibling = all.rpDirectorAuto as { enabled?: boolean } | undefined;
    if (sibling) sibling.enabled = false;
    const auto = (globalThis as unknown as { rpDirectorAuto?: { controller?: { setEnabled: (value: boolean) => void; destroy: () => void } } }).rpDirectorAuto;
    if (auto?.controller) { auto.controller.setEnabled(false); auto.controller.destroy(); }
    if (typeof document !== 'undefined') {
      document.getElementById('rpda-bar')?.remove();
      document.getElementById('rpda-settings')?.remove();
    }
    this.saveSettings();
  }

  // ---- chat identity -------------------------------------------------------

  isGroup(): boolean {
    return Boolean(this.ctx().groupId);
  }

  /** Stable key for the open chat: group id or character avatar plus chat file name. */
  chatKey(): string | null {
    const ctx = this.ctx();
    const chatId = ctx.getCurrentChatId();
    if (!chatId) return null;
    if (ctx.groupId) return `group:${ctx.groupId}:${chatId}`;
    const idx = Number(ctx.characterId);
    const avatar = Number.isInteger(idx) ? ctx.characters[idx]?.avatar : undefined;
    if (!avatar) return null;
    return `char:${avatar}:${chatId}`;
  }

  seedId(): string {
    const ctx = this.ctx();
    const integrity = ctx.chatMetadata?.integrity;
    return `${this.chatKey() ?? 'none'}|${typeof integrity === 'string' ? integrity : ''}`;
  }

  playerName(): string {
    return String(this.ctx().name1 ?? 'User');
  }

  // ---- actors ----------------------------------------------------------------

  /** Group members in stable group order (or the single character), with current indexes. */
  actors(): HostActor[] {
    const ctx = this.ctx();
    if (ctx.groupId) {
      const group = ctx.groups.find(g => g.id === ctx.groupId);
      if (!group) return [];
      const disabled = new Set(group.disabled_members ?? []);
      return group.members.map(avatar => {
        const index = ctx.characters.findIndex(c => c.avatar === avatar);
        const character = index >= 0 ? ctx.characters[index] : undefined;
        return { avatar, name: character?.name ?? avatar, index, disabled: disabled.has(avatar) };
      }).filter(a => a.index >= 0);
    }
    const idx = Number(ctx.characterId);
    const character = Number.isInteger(idx) ? ctx.characters[idx] : undefined;
    if (!character) return [];
    return [{ avatar: character.avatar, name: character.name, index: idx, disabled: false }];
  }

  /** Re-resolves a durable avatar to its current array index, or -1. */
  resolveIndex(avatar: string): number {
    return this.ctx().characters.findIndex(c => c.avatar === avatar);
  }

  /** Bounded public card summary for the decision snapshot. */
  publicCard(avatar: string, maxChars = 400): string {
    const c = this.ctx().characters.find(x => x.avatar === avatar);
    const description = String(c?.description ?? '').replace(/\s+/g, ' ').trim();
    return description.length > maxChars ? description.slice(0, maxChars) + '…' : description;
  }

  // ---- chat -------------------------------------------------------------------

  chat(): HostChatMessage[] {
    return this.ctx().chat;
  }

  /**
   * Maps host messages to fingerprint inputs. Every message in the array is
   * part of the transcript identity; `is_system` is deliberately ignored
   * because the host flips it on existing messages (observed on group
   * greetings), which would silently move every later cursor.
   */
  fingerprintMessages(messages: HostChatMessage[]): FingerprintMessage[] {
    const out: FingerprintMessage[] = [];
    for (const m of messages) {
      if (!m) continue;
      if (m.is_user) out.push({ role: 'user', actorKey: 'persona', text: m.mes ?? '' });
      else out.push({ role: 'assistant', actorKey: m.original_avatar ?? `name:${m.name}`, text: m.mes ?? '' });
    }
    return out;
  }

  lastAssistantAvatar(): string | null {
    const chat = this.chat();
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i]!;
      if (!m.is_user && !m.is_system) return m.original_avatar ?? null;
    }
    return null;
  }

  composer(): HTMLTextAreaElement | null {
    return document.getElementById('send_textarea') as HTMLTextAreaElement | null;
  }

  composerText(): string {
    return String(this.composer()?.value ?? '');
  }

  /** Any visible assistant prose saved after an attempt bound to the transcript. */
  assistantProseSince(messageIndex: number): string[] {
    return this.chat().slice(Math.max(0, messageIndex)).filter(message => !message.is_user && !message.is_system && !['', '...'].includes(String(message.mes ?? '').trim())).map(message => String(message.mes).trim());
  }

  // ---- variant markers --------------------------------------------------------

  readMarker(mesId: number): VariantMarker | null {
    const m = this.chat()[mesId];
    const marker = m?.extra?.[VARIANT_MARKER_KEY] as VariantMarker | undefined;
    if (marker && typeof marker.v === 'string' && typeof marker.a === 'string') return marker;
    return null;
  }

  /** Writes the marker to the message and to its current swipe_info entry so swipe selection restores it. */
  writeMarker(mesId: number, marker: VariantMarker): void {
    const m = this.chat()[mesId];
    if (!m) return;
    m.extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
    m.extra[VARIANT_MARKER_KEY] = { ...marker };
    if (typeof m.swipe_id === 'number' && Array.isArray(m.swipe_info)) {
      const info = m.swipe_info[m.swipe_id] ?? (m.swipe_info[m.swipe_id] = {});
      info.extra = info.extra && typeof info.extra === 'object' ? info.extra : {};
      info.extra[VARIANT_MARKER_KEY] = { ...marker };
    }
  }

  // ---- metadata ---------------------------------------------------------------

  readRecord(): unknown {
    const ctx = this.ctx();
    if (!(ctx.extensionSettings[SETTINGS_KEY] as DirectorSettings | undefined)?.enabled) return ctx.chatMetadata?.[METADATA_KEY];
    const migrated = migrateAutoHistory(ctx.chatMetadata, ctx.chat);
    if (migrated.migrated) {
      ctx.chatMetadata[METADATA_KEY] = migrated.metadata[METADATA_KEY];
      for (let i = 0; i < ctx.chat.length; i++) {
        ctx.chat[i]!.extra = migrated.messages[i]!.extra;
        ctx.chat[i]!.swipe_info = migrated.messages[i]!.swipe_info;
      }
    }
    return ctx.chatMetadata?.[METADATA_KEY];
  }

  /**
   * Re-acquires the live metadata reference and verifies the chat before
   * writing; a stale reference from another chat cannot commit (M1-11).
   */
  async writeRecord(record: unknown, expectedChatKey: string): Promise<boolean> {
    const ctx = this.ctx();
    if (this.chatKey() !== expectedChatKey) {
      console.warn('[RP Director] refusing to save metadata: chat changed');
      return false;
    }
    ctx.chatMetadata[METADATA_KEY] = record;
    await ctx.saveMetadata();
    return true;
  }

  // ---- settings ---------------------------------------------------------------

  settings(): DirectorSettings {
    const all = this.ctx().extensionSettings;
    const merged = normalizeBaseSettings(defaultSettings(), all[SETTINGS_KEY]);
    all[SETTINGS_KEY] = merged;
    return merged;
  }

  saveSettings(): void {
    this.ctx().saveSettingsDebounced();
  }

  connectionProfiles(): { id: string; name: string; api: string; model: string }[] {
    const cm = this.ctx().extensionSettings.connectionManager as { profiles?: { id: string; name: string; api?: string; model?: string; mode?: string }[] } | undefined;
    return (cm?.profiles ?? []).filter(p => p && p.mode === 'cc').map(p => ({ id: p.id, name: p.name, api: String(p.api ?? ''), model: String(p.model ?? '') }));
  }

  // ---- injection --------------------------------------------------------------

  setInjection(text: string, depth: number, role: 'system' | 'user' | 'assistant'): void {
    this.ctx().setExtensionPrompt(INJECTION_KEY, text, EXTENSION_PROMPT_TYPE_IN_CHAT, depth, false, ROLE_NUMBER[role]);
  }

  clearInjection(): void {
    this.ctx().setExtensionPrompt(INJECTION_KEY, '', EXTENSION_PROMPT_TYPE_IN_CHAT, 0, false, ROLE_NUMBER.system);
  }

  // ---- generation -------------------------------------------------------------

  /** Director Send / Next: forced-character generation through the verified host path. */
  async generate(forceIndex: number | null): Promise<unknown> {
    const options: Record<string, unknown> = {};
    if (typeof forceIndex === 'number' && forceIndex >= 0 && this.isGroup()) options.force_chid = forceIndex;
    return this.ctx().generate('normal', options);
  }

  async swipeRight(): Promise<void> {
    const message = this.chat().at(-1);
    const options = { forceMesId: this.chat().length - 1, forceSwipeId: message?.swipes?.length ?? 1 };
    const swipe = this.ctx().swipe;
    if (swipe.to) await swipe.to(null, 'right', options);
    else await swipe.right(undefined, options);
  }

  stopGeneration(): void {
    this.ctx().stopGeneration();
  }

  // ---- writer function tool --------------------------------------------------

  registerFunctionTool(tool: HostFunctionTool): boolean {
    const ctx = this.ctx();
    if (!(ctx.extensionSettings[SETTINGS_KEY] as DirectorSettings | undefined)?.enabled) return false;
    if (typeof ctx.registerFunctionTool !== 'function' || typeof ctx.unregisterFunctionTool !== 'function') return false;
    ctx.unregisterFunctionTool(tool.name);
    ctx.registerFunctionTool(tool);
    this.ownedTool = tool;
    (globalThis as unknown as Record<string, unknown>).__rpDirectorToolOwner = tool;
    return true;
  }

  unregisterFunctionTool(name: string): void {
    if (!this.ownedTool || (globalThis as unknown as Record<string, unknown>).__rpDirectorToolOwner !== this.ownedTool) return;
    this.ctx().unregisterFunctionTool?.(name);
    this.ownedTool = null;
    delete (globalThis as unknown as Record<string, unknown>).__rpDirectorToolOwner;
  }

  writerToolCapability(type = 'normal'): { supported: boolean; reason: string | null } {
    try {
      const ctx = this.ctx();
      if (typeof ctx.isToolCallingSupported !== 'function' || typeof ctx.canPerformToolCalls !== 'function') return { supported: false, reason: 'installed SillyTavern does not expose function-tool capability checks' };
      if (!ctx.isToolCallingSupported()) return { supported: false, reason: 'the selected writer API/model does not support enabled function calling' };
      if (!ctx.canPerformToolCalls(type)) return { supported: false, reason: `SillyTavern does not permit tools for ${type} generation` };
      return { supported: true, reason: null };
    } catch (error) {
      return { supported: false, reason: `tool capability check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ---- events -----------------------------------------------------------------

  on(event: string, handler: (...args: unknown[]) => unknown): () => void {
    const ctx = this.ctx();
    const name = ctx.eventTypes[event];
    if (!name) throw new Error(`unknown host event ${event}`);
    ctx.eventSource.on(name, handler);
    return () => ctx.eventSource.removeListener(name, handler);
  }

  // ---- transport through SillyTavern's connection manager --------------------

  /** Structured-output transport that uses a stored connection profile; the extension never sees the key. */
  stProfileTransport(profileId: string): StructuredTransport {
    return async (payload, signal) => {
      const ctx = this.ctx();
      // SillyTavern's server expects { name, description, value, strict } and builds the
      // provider-specific response_format itself (src/endpoints/backends/chat-completions.js).
      const override: Record<string, unknown> = {
        json_schema: {
          name: payload.json_schema.name,
          description: 'RP Director decision batch',
          value: payload.json_schema.schema,
          strict: payload.json_schema.strict,
        },
      };
      if (payload.model) override.model = payload.model;
      const result = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        payload.messages,
        1024,
        { stream: false, signal, extractData: true, includePreset: false, includeInstruct: false },
        override,
      ) as { content?: unknown } | undefined;
      return { content: result?.content, model: null, usage: null };
    };
  }

  /**
   * Structured-output transport that routes through SillyTavern's own server
   * (`ChatCompletionService.processRequest`, `chat_completion_source: 'openrouter'`),
   * using the OpenRouter key already saved in SillyTavern's secrets; the
   * extension never sees or stores it.
   */
  openRouterTransport(): StructuredTransport {
    return createOpenRouterTransport((payload, signal) => this.ctx().ChatCompletionService.processRequest(payload, {}, false, signal));
  }

  /** Jev decision batches through the authenticated companion server plugin. */
  openRouterDecisionsTransport(): OpenRouterDecisionsTransport {
    return async (payload, signal) => {
      let response: Response;
      try {
        response = await fetch('/api/plugins/rp-director-openrouter/decide', {
          method: 'POST',
          headers: this.ctx().getRequestHeaders(),
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new ProviderError('aborted', 'OpenRouter Decisions request was cancelled');
        throw new ProviderError('network', `RP Director Decisions plugin request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const text = await response.text();
      let parsed: unknown;
      try { parsed = text ? JSON.parse(text) : {}; } catch { throw new ProviderError('malformed', 'RP Director Decisions plugin returned invalid JSON'); }
      if (!response.ok) {
        const body = parsed && typeof parsed === 'object' ? parsed as { error?: { message?: unknown } } : null;
        const message = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
        const hint = response.status === 404 ? ' Restart SillyTavern after installing the rp-director-openrouter server plugin.' : '';
        throw new ProviderError('http', `OpenRouter Decisions plugin: ${message}.${hint}`, response.status);
      }
      return parsed;
    };
  }

  // ---- ui helpers -------------------------------------------------------------

  toast(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
    const t = (globalThis as unknown as { toastr?: Record<string, (m: string, t?: string) => void> }).toastr;
    if (t && typeof t[kind] === 'function') t[kind]!(message, 'RP Director');
    else console.log(`[RP Director] ${kind}: ${message}`);
  }

  async confirm(title: string, html: string): Promise<boolean> {
    const ctx = this.ctx();
    if (ctx.callGenericPopup && ctx.POPUP_TYPE && ctx.POPUP_RESULT) {
      const result = await ctx.callGenericPopup(`<h3>${title}</h3>${html}`, ctx.POPUP_TYPE.CONFIRM, '', { okButton: 'Confirm', cancelButton: 'Cancel' });
      return result === ctx.POPUP_RESULT.AFFIRMATIVE;
    }
    return window.confirm(`${title}\n\n${html.replace(/<[^>]+>/g, '')}`);
  }

  async chooseSwipeAction(kind: 'ruled' | 'native', canReroll = true): Promise<'reuse' | 'reroll' | 'manage' | 'bypass' | 'cancel'> {
    const ctx = this.ctx();
    if (ctx.callGenericPopup && ctx.POPUP_TYPE && ctx.POPUP_RESULT) {
      if (kind === 'ruled') {
        const reroll = 1001;
        const result = await ctx.callGenericPopup(
          '<h3>Generate a new swipe</h3><p>This reply has a frozen Director ruling. Choose whether the new wording must keep it or receive a new ruling.</p>',
          ctx.POPUP_TYPE.CONFIRM,
          '',
          { okButton: 'Keep values & swipe', cancelButton: 'Cancel', customButtons: canReroll ? [{ text: 'Review new values & swipe', result: reroll, icon: 'fa-dice' }] : [] },
        );
        return result === reroll ? 'reroll' : result === ctx.POPUP_RESULT.AFFIRMATIVE ? 'reuse' : 'cancel';
      }
      const bypass = 1002;
      const result = await ctx.callGenericPopup(
        '<h3>Generate a new swipe</h3><p>The selected reply predates Director adjudication. Director can adopt this branch and manage the new swipe, or you can explicitly bypass it once.</p>',
        ctx.POPUP_TYPE.CONFIRM,
        '',
        { okButton: 'Director-managed', cancelButton: 'Cancel', customButtons: [{ text: 'Native bypass', result: bypass, icon: 'fa-forward' }] },
      );
      return result === bypass ? 'bypass' : result === ctx.POPUP_RESULT.AFFIRMATIVE ? 'manage' : 'cancel';
    }
    return 'cancel';
  }

  async reviewRolls(permit: TurnPermit, names: Record<string, string>, method: 'sample' | 'threshold', signal: AbortSignal): Promise<RollReviewChoice> {
    const ctx = this.ctx();
    if (signal.aborted || !ctx.callGenericPopup || !ctx.POPUP_TYPE || !ctx.POPUP_RESULT) return 'cancel';
    const content = document.createElement('div');
    content.className = 'rpd-roll-review';
    const title = document.createElement('h3'); title.textContent = 'Director results'; content.append(title);
    const hint = document.createElement('p');
    hint.textContent = 'The writer is waiting. Keep these values to continue, or review new results before the reply is written.';
    content.append(hint);
    for (const action of permit.actions) {
      const section = document.createElement('section');
      const heading = document.createElement('strong');
      heading.textContent = `${names[action.actingActorId] ?? action.actingActorId}: ${action.boundedResult}`;
      const result = document.createElement('p');
      result.textContent = `${action.outcome}${typeof action.draw === 'number' ? ` · draw ${action.draw.toFixed(4)}` : ' · threshold assessment (no dice)'}${action.assessment?.type === 'noul' ? ` · support ${action.assessment.noul.toFixed(3)}` : ''}`;
      const instruction = document.createElement('p'); instruction.textContent = action.instruction;
      section.append(heading, result, instruction); content.append(section);
    }
    const REROLL = 1001;
    let closePopup: (() => void) | null = null;
    const abort = () => closePopup?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Keep & continue', cancelButton: 'Cancel generation',
        customButtons: [{ text: method === 'sample' ? 'Reroll' : 'Reassess', result: REROLL, icon: 'fa-dice' }],
        onOpen: (popup: { complete: (result: unknown) => Promise<unknown> }) => {
          closePopup = () => { void popup.complete(ctx.POPUP_RESULT!.CANCELLED); };
          if (signal.aborted) closePopup();
        },
      });
      if (signal.aborted) return 'cancel';
      return result === REROLL ? 'reroll' : result === ctx.POPUP_RESULT.AFFIRMATIVE ? 'keep' : 'cancel';
    } finally { signal.removeEventListener('abort', abort); }
  }

  /** Capture native Send/Enter before SillyTavern's handlers and route it through Director. */
  interceptNativeSend(shouldIntercept: () => boolean, send: () => Promise<void>): () => void {
    const button = document.getElementById('send_but');
    const onClick = (event: Event): void => {
      if (!shouldIntercept() || !this.composerText().trim() || this.composerText().trimStart().startsWith('/') || this.ctx().Popup?.util.isPopupOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void send().catch(error => console.error('[RP Director] native Send interception failed', error));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.id !== 'send_textarea' || event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.metaKey) return;
      const shouldSendOnEnter = this.ctx().shouldSendOnEnter;
      if (shouldSendOnEnter && !shouldSendOnEnter()) return;
      if (!shouldIntercept() || !this.composerText().trim() || this.composerText().trimStart().startsWith('/') || this.ctx().Popup?.util.isPopupOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void send().catch(error => console.error('[RP Director] native Enter interception failed', error));
    };
    button?.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      button?.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }

  nativeSendBlocked(): boolean {
    return this.isGenerating() || (this.ctx().swipe.state?.() ?? 'none') !== 'none';
  }

  newId(): string {
    try { return this.ctx().uuidv4(); } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
  }

  installedVersion(): string {
    const v = (globalThis as unknown as { SillyTavern?: { getContext?: () => { ['version']?: unknown } } });
    void v;
    return 'see COMPATIBILITY.md';
  }
}

export function jsonSafe(value: unknown): Json {
  try { return JSON.parse(JSON.stringify(value ?? null)) as Json; } catch { return null; }
}
