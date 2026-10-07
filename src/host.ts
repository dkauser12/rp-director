/**
 * Host adapter: the only module that touches SillyTavern.
 *
 * Every call site here was verified against the installed checkout and is
 * recorded in COMPATIBILITY.md. The adapter reaches the host through the
 * global `SillyTavern.getContext()` (script.js) and never patches host core.
 * Live generation flags that are not exposed on the context are read through
 * a dynamic import of the host module, with a DOM fallback.
 */
import type { DirectorChatRecord, DirectorSettings, Json, TurnPermit } from './types.ts';
import type { FingerprintMessage } from './identity.ts';
import { uiActorName } from './identity.ts';
import type { StructuredTransport } from './providers.ts';
import type { OpenRouterDecisionsTransport } from './providers.ts';
import { createOpenRouterTransport, ProviderError } from './providers.ts';
import { DEFAULT_PROFILE_ID } from './profiles.ts';
import { migrateAutoHistory, normalizeBaseSettings } from './migration.ts';
import { needsLegacyRecordBackup, RECORD_BACKUP_KEY } from './state.ts';
import { encodeRecordForStorage } from './state-storage.ts';
import { stripResultFooter, stripChatResultFooters } from './result-footer.ts';
import { defaultReactionSettings } from './npc-reaction.ts';
import { defaultLoreSettings } from './lore/settings.ts';
import type { LorePlan } from './lore/settings.ts';
import { applyLorePlan, placeLorePick, summarizeActivation } from './lore/apply.ts';
import type { LoreActivation } from './lore/apply.ts';
import type { LoreEntry, TunnelVisionNode } from './lore/tree.ts';
import type { WorkflowBadge } from './workflow-badge.ts';
import { isWorkflowBadge, WORKFLOW_BADGE_KEY } from './workflow-badge.ts';
import { playerUiText } from './activity.ts';
import { normalizeUiPreferences } from './ui-preferences.ts';
import { registerDirectorMacros } from './macros.ts';
import type { DirectorMacroState, DirectorMacroRegistry } from './macros.ts';
import { registerDirectorCommands } from './commands.ts';
import type { DirectorCommandActions } from './commands.ts';

export const INJECTION_KEY = 'rp_director_binding';
export const SETTINGS_KEY = 'rpDirector';
export const METADATA_KEY = 'rpDirector';
export const VARIANT_MARKER_KEY = 'rpd';

/** Public ST command records; unknown properties preserve native argument/help metadata. */
export interface HostSlashCommand {
  name: string;
  aliases?: string[];
  callback: (named: Record<string, unknown>, unnamed: unknown) => unknown;
  [key: string]: unknown;
}

/** Subset of the host context this extension relies on. Everything else is deliberately untyped. */
export interface StContext {
  macros?: { registry: DirectorMacroRegistry };
  chat: HostChatMessage[];
  characters: HostCharacter[];
  groups: HostGroup[];
  name1: string;
  characterId: number | string | undefined;
  groupId: string | null;
  chatId: string | undefined;
  chatMetadata: Record<string, unknown>;
  extensionSettings: Record<string, unknown>;
  eventSource: { on: (event: string, handler: (...args: unknown[]) => unknown) => void; removeListener: (event: string, handler: (...args: unknown[]) => unknown) => void; emit?: (event: string, ...args: unknown[]) => Promise<unknown> };
  eventTypes: Record<string, string>;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  shouldSendOnEnter?: () => boolean;
  generate: (type: string, options?: Record<string, unknown>, dryRun?: boolean) => Promise<unknown>;
  stopGeneration: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
  updateMessageBlock?: (messageId: number, message: HostChatMessage) => void;
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
  SlashCommandParser?: { addCommandObject: (command: unknown) => unknown; commands?: Record<string, HostSlashCommand> };
  SlashCommand?: { fromProps: (props: HostSlashCommand) => unknown };
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
  personality?: string;
  chat?: string;
  data?: { extensions?: { world?: string } };
}

/** Lorebooks the scan could load for a turn's cast, and their entries. */
export interface LoreCatalog {
  books: { world: string; source: 'global' | 'character' | 'chat' | 'persona'; owner: string | null }[];
  entries: LoreEntry[];
}

/** The parts of public/scripts/world-info.js this extension reads. */
interface WorldInfoModule {
  selected_world_info?: string[];
  world_info?: { charLore?: { name?: string; extraBooks?: string[] }[] };
  loadWorldInfo: (name: string) => Promise<{ entries?: Record<string, Record<string, unknown>> } | null>;
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
  setCharacterId?: (index: number) => void;
  setCharacterName?: (name: string) => void;
}

const EXTENSION_PROMPT_TYPE_IN_CHAT = 1;
const ROLE_NUMBER: Record<'system' | 'user' | 'assistant', number> = { system: 0, user: 1, assistant: 2 };

export function defaultSettings(): DirectorSettings {
  return {
    enabled: true,
    profileId: DEFAULT_PROFILE_ID,
    connection: { kind: 'openrouter', baseUrl: '', model: '', stProfileId: '', mockScenario: 'gate-deferred' },
    reactions: defaultReactionSettings(),
    showBadges: true,
    ...normalizeUiPreferences(),
    profileOverrides: {},
    pipeline: 'staged',
    settingsRevision: 3,
    waitForJudgeSeconds: 10,
    askWhenSwiping: true,
    reviewNpcRolls: true,
    modules: { speaker: true, decisions: true, meters: true, secrets: true, lore: true, pacing: true, replyCheck: true },
    lore: defaultLoreSettings(),
  };
}

export class Host {
  registerDirectorMacros(getState: () => DirectorMacroState): boolean {
    return registerDirectorMacros(this.ctx().macros?.registry, getState);
  }

  registerDirectorCommands(actions: DirectorCommandActions): boolean {
    return registerDirectorCommands(this.ctx(), actions);
  }
  private flags: HostFlags | null = null;
  private extensionLookup: ((name: string) => { enabled: boolean } | null) | null = null;

  protected findHostExtension(name: string): { enabled: boolean } | null {
    return this.extensionLookup?.(name) ?? null;
  }
  private ownedTool: HostFunctionTool | null = null;
  private composerLock: { element: HTMLTextAreaElement; readOnly: boolean } | null = null;

  ctx(): StContext {
    const st = (globalThis as unknown as { SillyTavern?: { getContext?: () => StContext } }).SillyTavern;
    if (!st || typeof st.getContext !== 'function') throw new Error('SillyTavern.getContext is not available');
    return st.getContext();
  }

  /** Loads live flag getters from host modules; safe to call more than once. */
  async loadFlags(): Promise<void> {
    if (this.flags) return;
    try {
      const extensionsUrl = new URL('../../../extensions.js', import.meta.url).href;
      const extensions = await import(/* @vite-ignore */ extensionsUrl);
      this.extensionLookup = typeof extensions.findExtension === 'function' ? extensions.findExtension : null;
    } catch (error) {
      // Optional integrations stay unavailable without the host registry.
      console.warn('[RP Director] extensions.js import failed; Dynamic Response is treated as absent', error);
    }
    try {
      const groupUrl = new URL('../../../group-chats.js', import.meta.url).href;
      const scriptUrl = new URL('../../../../script.js', import.meta.url).href;
      const [groupModule, scriptModule] = await Promise.all([import(/* @vite-ignore */ groupUrl), import(/* @vite-ignore */ scriptUrl)]);
      this.flags = {
        isGroupGenerating: () => Boolean(groupModule.is_group_generating),
        isAutoMode: () => Boolean(groupModule.is_group_automode_enabled),
        isSendPress: () => Boolean(scriptModule.is_send_press),
        sendMessageAsUser: typeof scriptModule.sendMessageAsUser === 'function' ? scriptModule.sendMessageAsUser : null,
        setCharacterId: scriptModule.setCharacterId,
        setCharacterName: scriptModule.setCharacterName,
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

  /** Called at GROUP_MEMBER_DRAFTED, before the host constructs the speaker's prompt. */
  enforceGroupSpeaker(avatar: string): boolean {
    if (!this.isGroup()) return true;
    const index = this.resolveIndex(avatar);
    if (index < 0 || !this.actors().some(actor => actor.avatar === avatar)) return false;
    if (Number(this.ctx().characterId) === index) return true;
    if (!this.flags?.setCharacterId || !this.flags.setCharacterName) return false;
    this.flags.setCharacterId(index);
    this.flags.setCharacterName(this.ctx().characters[index]!.name);
    return true;
  }

  hasSelectedReply(): boolean {
    const message = this.chat().at(-1);
    return Boolean(message && !message.is_user && !message.is_system);
  }

  /** Full authorial card text (description and personality) for rulings whose family admits it. */
  cardText(avatar: string): string {
    const c = this.ctx().characters.find(x => x.avatar === avatar);
    return [c?.description, c?.personality].map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n');
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
      else out.push({ role: 'assistant', actorKey: m.original_avatar ?? `name:${m.name}`, text: stripResultFooter(m.mes ?? '') });
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
    return typeof document === 'undefined' ? null : document.getElementById('send_textarea') as HTMLTextAreaElement | null;
  }

  composerText(): string {
    return String(this.composer()?.value ?? '');
  }

  onComposerInput(cancel: () => void): () => void {
    const element = this.composer();
    element?.addEventListener('input', cancel);
    return () => element?.removeEventListener('input', cancel);
  }

  dynamicResponseEnabled(): boolean {
    const settings = this.ctx().extensionSettings.dynamic_response as { enabled?: unknown } | undefined;
    return this.findHostExtension('DynamicResponse')?.enabled === true && settings?.enabled === true;
  }

  /** Preserve the submitted text while the judge works, without owning ST's generation lock. */
  setComposerLocked(locked: boolean): void {
    if (locked) {
      const element = this.composer();
      if (element && !this.composerLock) {
        this.composerLock = { element, readOnly: element.readOnly };
        element.readOnly = true;
      }
    } else if (this.composerLock) {
      this.composerLock.element.readOnly = this.composerLock.readOnly;
      this.composerLock = null;
    }
  }

  /** Any visible assistant prose saved after an attempt bound to the transcript. */
  assistantProseSince(messageIndex: number): string[] {
    return this.chat().slice(Math.max(0, messageIndex)).filter(message => !message.is_user && !message.is_system)
      .map(message => stripResultFooter(String(message.mes ?? '')).trim()).filter(text => !['', '...'].includes(text));
  }

  /** Mutate all old storage copies together; the caller saves once with the Activity record. */
  stripLegacyResultFooters(): { messages: number; copies: number } {
    const ctx = this.ctx();
    const result = stripChatResultFooters(ctx.chat);
    for (const id of result.changedMessageIds) ctx.updateMessageBlock?.(id, ctx.chat[id]!);
    return { messages: result.messages, copies: result.copies };
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
    m.extra = m.extra && typeof m.extra === 'object' ? { ...m.extra } : {};
    m.extra[VARIANT_MARKER_KEY] = { ...marker };
    if (Array.isArray(m.swipes) && !Array.isArray(m.swipe_info)) m.swipe_info = [];
    if (typeof m.swipe_id === 'number' && Array.isArray(m.swipe_info)) {
      const info = m.swipe_info[m.swipe_id] ?? (m.swipe_info[m.swipe_id] = {});
      info.extra = info.extra && typeof info.extra === 'object' ? { ...info.extra } : {};
      info.extra[VARIANT_MARKER_KEY] = { ...marker };
    }
  }

  /** Workflow details belong to this swipe, never to the reply's prose. */
  writeWorkflowBadge(mesId: number, badge: WorkflowBadge | null): boolean {
    const message = this.chat()[mesId];
    if (!message || message.is_user || message.is_system) return false;
    const swipeId = message.swipe_id ?? 0;
    if (!badge) {
      let changed = false;
      const clear = (extra: Record<string, unknown> | undefined) => {
        if (extra && typeof extra === 'object' && WORKFLOW_BADGE_KEY in extra) {
          const next = { ...extra };
          delete next[WORKFLOW_BADGE_KEY]; changed = true;
          return next;
        }
        return extra;
      };
      message.extra = clear(message.extra);
      const info = message.swipe_info?.[swipeId];
      if (info) {
        info.extra = clear(info.extra);
      }
      return changed;
    }
    message.extra = message.extra && typeof message.extra === 'object' ? { ...message.extra } : {};
    let changed = JSON.stringify(message.extra[WORKFLOW_BADGE_KEY]) !== JSON.stringify(badge);
    message.extra[WORKFLOW_BADGE_KEY] = structuredClone(badge);
    if (Array.isArray(message.swipes) && !Array.isArray(message.swipe_info)) message.swipe_info = [];
    if (Array.isArray(message.swipe_info)) {
      const info = message.swipe_info[swipeId] ?? (message.swipe_info[swipeId] = {});
      info.extra = info.extra && typeof info.extra === 'object' ? { ...info.extra } : {};
      changed ||= JSON.stringify(info.extra[WORKFLOW_BADGE_KEY]) !== JSON.stringify(badge);
      info.extra[WORKFLOW_BADGE_KEY] = structuredClone(badge);
    }
    return changed;
  }

  readWorkflowBadge(mesId: number): WorkflowBadge | null {
    const message = this.chat()[mesId];
    if (!message || message.is_user || message.is_system) return null;
    const swipeId = message.swipe_id ?? 0;
    if (message.swipes && swipeId >= message.swipes.length) return null;
    const info = message.swipe_info?.[swipeId];
    // A present swipe slot is authoritative, including an intentionally empty
    // one; never borrow another swipe's badge while ST restores its extras.
    const data = info ? info.extra?.[WORKFLOW_BADGE_KEY] : message.extra?.[WORKFLOW_BADGE_KEY];
    return isWorkflowBadge(data) ? data : null;
  }

  registerWorkspaceCommand(open: (tab?: string) => Promise<unknown>): boolean {
    const { SlashCommandParser, SlashCommand } = this.ctx();
    if (!SlashCommandParser || !SlashCommand) return false;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
      name: 'director',
      callback: async (_named, tab) => { await open(typeof tab === 'string' ? tab : undefined); return ''; },
      returns: 'Nothing',
      helpString: 'Open Director: /director [chat|activity|outcomes|lore|settings].',
    }));
    return true;
  }

  /** Route managed /regenerate and its native aliases through the same wording-swipe path. */
  interceptRegenerateCommand(shouldIntercept: () => boolean, regenerate: () => Promise<unknown>): () => void {
    const { SlashCommandParser: parser, SlashCommand } = this.ctx();
    const registry = parser?.commands;
    const original = registry?.regenerate;
    if (!parser || !SlashCommand || !registry || original?.name !== 'regenerate' || typeof original.callback !== 'function') return () => {};
    // Do not overwrite an alias another extension has independently replaced.
    const aliases = (original.aliases ?? []).filter(alias => registry[alias] === original);
    const names = ['regenerate', ...aliases];
    const previous = new Map(names.map(name => [name, registry[name]!]));
    let active = true;
    const callback = (named: Record<string, unknown>, unnamed: unknown): unknown => {
      // The native command owns waiting for an active generation and regenerating
      // the whole last group round. Its Generate calls still reach our interceptor.
      if (!active || !shouldIntercept() || !this.hasSelectedReply() || this.isGenerating() || this.isGroup() || !this.swipesEnabled()) return original.callback.call(original, named, unnamed);
      const chatKey = this.chatKey();
      const message = this.chat().at(-1);
      const swipeId = message?.swipe_id ?? 0;
      // Match ST's delayed command generation, allowing composer command processing to finish.
      const pending = new Promise<string>(resolve => setTimeout(() => {
        if (!active || chatKey !== this.chatKey() || this.chat().at(-1) !== message || (message?.swipe_id ?? 0) !== swipeId
          || !shouldIntercept() || (named._abortController as { signal?: { aborted?: boolean } } | undefined)?.signal?.aborted) { resolve(''); return; }
        void Promise.resolve().then(() => this.isGenerating() || this.isGroup() || !this.swipesEnabled()
          ? original.callback.call(original, named, unnamed) : regenerate()).then(() => resolve('')).catch(error => {
          console.error('[RP Director] /regenerate failed', error);
          resolve('');
        });
      }, 1));
      const wait = typeof named.await === 'string' && ['on', 'true', '1'].includes(named.await.trim().toLowerCase());
      return wait ? pending : '';
    };
    const wrapped = SlashCommand.fromProps({ ...original, aliases, callback }) as HostSlashCommand;
    parser.addCommandObject(wrapped);
    // Registration infers provenance from its call stack. This is still ST's
    // command, so keep its original help categorization and source.
    for (const key of ['isExtension', 'isThirdParty', 'source']) {
      if (Object.prototype.hasOwnProperty.call(original, key)) wrapped[key] = original[key];
      else delete wrapped[key];
    }
    return () => {
      active = false;
      for (const name of names) if (registry[name] === wrapped) registry[name] = previous.get(name)!;
    };
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
  async writeRecord(record: DirectorChatRecord, expectedChatKey: string): Promise<boolean> {
    const ctx = this.ctx();
    if (this.chatKey() !== expectedChatKey) {
      console.warn('[RP Director] refusing to save metadata: chat changed');
      return false;
    }
    const previous = ctx.chatMetadata[METADATA_KEY];
    if (!Object.prototype.hasOwnProperty.call(ctx.chatMetadata, RECORD_BACKUP_KEY) && needsLegacyRecordBackup(previous)) {
      const backup = structuredClone(previous) as Record<string, unknown>;
      // The 0.7 reader defaults an absent inspector to []; it is diagnostic
      // history, not state needed to restore meters, rulings or secrets.
      delete backup.inspector;
      ctx.chatMetadata[RECORD_BACKUP_KEY] = backup;
    }
    ctx.chatMetadata[METADATA_KEY] = encodeRecordForStorage(record);
    await ctx.saveMetadata();
    return true;
  }

  hasLegacyRecordBackup(): boolean {
    return Object.prototype.hasOwnProperty.call(this.ctx().chatMetadata, RECORD_BACKUP_KEY);
  }

  async removeLegacyRecordBackup(expectedChatKey: string): Promise<boolean> {
    if (this.chatKey() !== expectedChatKey || !this.hasLegacyRecordBackup()) return false;
    const ctx = this.ctx();
    delete ctx.chatMetadata[RECORD_BACKUP_KEY];
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

  private liveInjection = '';
  private injectionWrites = 0;

  setInjection(text: string, depth: number, role: 'system' | 'user' | 'assistant'): void {
    this.ctx().setExtensionPrompt(INJECTION_KEY, text, EXTENSION_PROMPT_TYPE_IN_CHAT, depth, false, ROLE_NUMBER[role]);
    this.liveInjection = text;
    this.injectionWrites += 1;
  }

  clearInjection(): void {
    this.ctx().setExtensionPrompt(INJECTION_KEY, '', EXTENSION_PROMPT_TYPE_IN_CHAT, 0, false, ROLE_NUMBER.system);
    this.liveInjection = '';
    this.injectionWrites += 1;
  }

  /** The Director block as last written, including any tool-result lines added after binding. */
  currentInjection(): string {
    return this.liveInjection;
  }

  /** Changes on every write (set or clear), so a caller can tell whether anyone wrote since. */
  injectionVersion(): number {
    return this.injectionWrites;
  }

  // ---- generation -------------------------------------------------------------

  /** Director Send / Next: forced-character generation through the verified host path. */
  async generate(forceIndex: number | null): Promise<unknown> {
    const options: Record<string, unknown> = {};
    if (typeof forceIndex === 'number' && forceIndex >= 0 && this.isGroup()) options.force_chid = forceIndex;
    return this.ctx().generate('normal', options);
  }

  /** SillyTavern's swipe state; anything but 'none' means a swipe is still animating, generating or saving. */
  swipeState(): string {
    return String(this.ctx().swipe?.state?.() ?? 'none');
  }

  async swipeRight(forceIndex: number | null = null): Promise<void> {
    // The slash-command source below bypasses SillyTavern's one-swipe-at-a-time
    // guard; a second swipe would write into the running swipe's slot.
    if (this.swipeState() !== 'none') throw new Error('another swipe is still running');
    if (!this.hasSelectedReply()) { await this.generate(forceIndex); return; }
    if (!this.swipesEnabled()) {
      const options = this.isGroup() && forceIndex !== null && forceIndex >= 0 ? { force_chid: forceIndex } : undefined;
      await this.ctx().generate('regenerate', options); return;
    }
    const message = this.chat().at(-1);
    const options = { source: 'slash_command', forceMesId: this.chat().length - 1, forceSwipeId: message?.swipes?.length ?? 1 };
    const swipe = this.ctx().swipe;
    if (swipe.to) await swipe.to(null, 'right', options);
    else await swipe.right(undefined, options);
  }

  /**
   * After an unfinished automatic rewrite, show the wording the user was
   * answering again. A fragment slot (our newly appended last swipe) is removed
   * only when `removeFragment`; with no new slot, SillyTavern's endSwipe()
   * clamped the selection to the last swipe, so the original is reselected.
   * Returns true when the message changed.
   */
  async discardAutomaticSwipe(message: HostChatMessage, cancelledSwipe: number, originalSwipe: number, removeFragment = true): Promise<boolean> {
    const index = this.chat().indexOf(message);
    if (index < 0 || !message.swipes || originalSwipe < 0 || originalSwipe >= cancelledSwipe) return false;
    const fragment = cancelledSwipe === message.swipes.length - 1 && message.swipe_id === cancelledSwipe;
    if (fragment && removeFragment) {
      message.swipes.splice(cancelledSwipe, 1);
      message.swipe_info?.splice(cancelledSwipe, 1);
      message.swipe_id = originalSwipe;
      message.mes = message.swipes[originalSwipe]!;
      message.extra = structuredClone(message.swipe_info?.[originalSwipe]?.extra ?? {});
      this.ctx().chatMetadata.tainted = true;
      await this.ctx().eventSource.emit?.(this.ctx().eventTypes.MESSAGE_SWIPE_DELETED ?? 'MESSAGE_SWIPE_DELETED',
        { messageId: index, swipeId: cancelledSwipe, newSwipeId: originalSwipe });
    } else if (message.swipes.length > cancelledSwipe || originalSwipe >= message.swipes.length || message.swipe_id === originalSwipe) return false;
    // Like SillyTavern's own deleteSwipe(): moving to a lower index animates left.
    if (this.ctx().swipe.to) await this.ctx().swipe.to!(null, 'left', { source: 'delete', forceMesId: index, forceSwipeId: originalSwipe });
    else {
      message.swipe_id = originalSwipe;
      message.mes = message.swipes[originalSwipe]!;
      message.extra = structuredClone(message.swipe_info?.[originalSwipe]?.extra ?? {});
      this.ctx().updateMessageBlock?.(index, message);
    }
    await this.ctx().saveChat();
    return true;
  }

  /** ST's user preference is reflected by this native settings checkbox. */
  swipesEnabled(): boolean {
    const checkbox = typeof document === 'undefined' ? null : document.getElementById('swipes-checkbox') as HTMLInputElement | null;
    return checkbox ? checkbox.checked : true;
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

  // ---- lore -------------------------------------------------------------------

  private lorePlanArmed: (LorePlan & { forced: Record<string, unknown>[] }) | null = null;
  private loreArmSeq = 0;
  private loreHookOff: (() => void) | null = null;
  private lastActivation: LoreActivation | null = null;
  /** Called after every real World Info scan (set by the controller to refresh the panel). */
  onLoreActivation: (() => void) | null = null;

  /** What the last real World Info scan activated, per book. */
  lastLoreActivation(): LoreActivation | null {
    return this.lastActivation;
  }

  /**
   * Books SillyTavern could load for these cast members, with their entries.
   * Mirrors world-info.js getGlobalLore/getCharacterLore/getChatLore/
   * getPersonaLore, except that a group lists every given member's books:
   * SillyTavern itself loads only the current speaker's (this_chid) books per
   * scan, which is also all a forced activation can reach.
   */
  async loreCatalog(avatars: string[]): Promise<LoreCatalog> {
    const ctx = this.ctx();
    const wi = await import(/* @vite-ignore */ new URL('../../../world-info.js', import.meta.url).href) as WorldInfoModule;
    const books: LoreCatalog['books'] = [];
    const add = (world: unknown, source: LoreCatalog['books'][number]['source'], owner: string | null) => {
      const name = typeof world === 'string' ? world.trim() : '';
      if (name && !books.some(b => b.world === name)) books.push({ world: name, source, owner });
    };
    for (const world of wi.selected_world_info ?? []) add(world, 'global', null);
    for (const avatar of avatars) {
      const character = ctx.characters.find(c => c.avatar === avatar);
      add(character?.data?.extensions?.world, 'character', avatar);
      // charLore is keyed by the avatar file name without its extension.
      const filename = avatar.replace(/\.[^/.]+$/, '');
      const extra = (wi.world_info?.charLore ?? []).find(item => item?.name === filename)?.extraBooks ?? [];
      for (const world of extra) add(world, 'character', avatar);
    }
    add((ctx.chatMetadata as Record<string, unknown> | undefined)?.world_info, 'chat', null);
    try {
      const pu = await import(/* @vite-ignore */ new URL('../../../power-user.js', import.meta.url).href) as { power_user?: { persona_description_lorebook?: unknown } };
      add(pu.power_user?.persona_description_lorebook, 'persona', null);
    } catch { /* persona lore is optional */ }
    const entries: LoreEntry[] = [];
    for (const book of books) {
      let data: { entries?: Record<string, Record<string, unknown>> } | null = null;
      try { data = await wi.loadWorldInfo(book.world); } catch { data = null; }
      for (const raw of Object.values(data?.entries ?? {})) {
        const uid = Number(raw.uid);
        if (!Number.isInteger(uid)) continue;
        const content = String(raw.content ?? '');
        const keys = Array.isArray(raw.key) ? raw.key.map(String).filter(k => k.trim()) : [];
        entries.push({
          world: book.world, uid, keys, content,
          title: String(raw.comment ?? '').trim() || keys.slice(0, 3).join(', ') || `Entry ${uid}`,
          constant: raw.constant === true,
          // An @@dont_activate decorator blocks forced activation too.
          disabled: raw.disable === true || /^\s*@@dont_activate\b/.test(content),
        });
      }
    }
    return { books, entries };
  }

  /** TunnelVision's stored index roots by book, if the extension has built any. */
  tunnelVisionRoots(): Record<string, TunnelVisionNode> {
    const tv = this.ctx().extensionSettings.tunnelvision as { trees?: Record<string, { root?: TunnelVisionNode }> } | undefined;
    const out: Record<string, TunnelVisionNode> = {};
    for (const [world, tree] of Object.entries(tv?.trees ?? {})) if (tree?.root && typeof tree.root === 'object') out[world] = tree.root;
    return out;
  }

  /** True when TunnelVision is on and suppresses this book's keyword scan itself. */
  tunnelVisionManages(world: string): boolean {
    const tv = this.ctx().extensionSettings.tunnelvision as { globalEnabled?: unknown; enabledLorebooks?: Record<string, unknown> } | undefined;
    return tv?.globalEnabled === true && tv.enabledLorebooks?.[world] === true;
  }

  /**
   * SillyTavern's processed World Info entries for the current speaker (group
   * scans load this_chid's books only), exactly as its scan will see them:
   * decorators parsed out of content, hash set. Forcing anything else would put
   * decorator lines in the prompt and break sticky/cooldown, which key on hash.
   */
  async sortedEntries(): Promise<Record<string, unknown>[]> {
    const wi = await import(/* @vite-ignore */ new URL('../../../world-info.js', import.meta.url).href) as { getSortedEntries: () => Promise<Record<string, unknown>[]> };
    return wi.getSortedEntries();
  }

  /**
   * Arms the plan for every World Info scan until disarmed. null disarms at
   * once; a plan resolves its forced entries first. A later call supersedes an
   * earlier one that is still resolving.
   */
  async armLore(plan: LorePlan | null): Promise<void> {
    const seq = ++this.loreArmSeq;
    this.lorePlanArmed = null;
    if (!plan || (plan.force.size === 0 && plan.managed.size === 0)) return;
    let forced: Record<string, unknown>[] = [];
    if (plan.force.size) {
      try { forced = (await this.sortedEntries()).filter(e => plan.force.has(`${String(e.world)}.${String(e.uid)}`)).map(entry => placeLorePick(entry, plan.nearEnd !== false)); }
      catch (error) { console.warn('[RP Director] could not resolve lore picks; keyword lore only', error); forced = []; }
    }
    if (seq === this.loreArmSeq) this.lorePlanArmed = { ...plan, forced };
  }

  armedLore(): (LorePlan & { forced: Record<string, unknown>[] }) | null {
    return this.lorePlanArmed;
  }

  /** Registers the WORLDINFO_ENTRIES_LOADED hook once; false when the host lacks the event. */
  installLoreHook(): boolean {
    if (this.loreHookOff) return true;
    const ctx = this.ctx();
    const name = ctx.eventTypes.WORLDINFO_ENTRIES_LOADED;
    const forceName = ctx.eventTypes.WORLDINFO_FORCE_ACTIVATE;
    if (!name || !forceName || typeof ctx.eventSource.emit !== 'function') return false;
    const handler = async (payload: unknown) => {
      const plan = this.lorePlanArmed;
      if (!plan || !payload || typeof payload !== 'object') return;
      const lists = payload as Record<string, unknown>;
      applyLorePlan([lists.globalLore, lists.characterLore, lists.chatLore, lists.personaLore], plan);
      // Every scan resets external activations, so each load re-emits them.
      if (plan.forced.length) await ctx.eventSource.emit!(forceName, plan.forced);
    };
    ctx.eventSource.on(name, handler);
    const activatedName = ctx.eventTypes.WORLD_INFO_ACTIVATED;
    const onActivated = (entries: unknown) => {
      if (!Array.isArray(entries)) return;
      this.lastActivation = summarizeActivation(entries, this.lorePlanArmed?.force ?? null);
      this.onLoreActivation?.();
    };
    if (activatedName) ctx.eventSource.on(activatedName, onActivated);
    this.loreHookOff = () => {
      ctx.eventSource.removeListener(name, handler);
      if (activatedName) ctx.eventSource.removeListener(activatedName, onActivated);
    };
    return true;
  }

  removeLoreHook(): void {
    this.loreHookOff?.();
    this.loreHookOff = null;
    this.loreArmSeq += 1;
    this.lorePlanArmed = null;
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

  /** Capture native Send/Enter before SillyTavern's handlers and route it through Director. */
  interceptNativeSend(shouldIntercept: () => boolean, send: () => Promise<void>): () => void {
    const button = document.getElementById('send_but');
    const onClick = (event: Event): void => {
      if (!shouldIntercept() || !this.composerText().trim() || this.composerText().trimStart().startsWith('/') || this.ctx().Popup?.util.isPopupOpen() || (this.ctx().swipe.state?.() ?? 'none') !== 'none') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void send().catch(error => console.error('[RP Director] native Send interception failed', error));
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.id !== 'send_textarea' || event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.metaKey) return;
      const shouldSendOnEnter = this.ctx().shouldSendOnEnter;
      if (shouldSendOnEnter && !shouldSendOnEnter()) return;
      if (!shouldIntercept() || !this.composerText().trim() || this.composerText().trimStart().startsWith('/') || this.ctx().Popup?.util.isPopupOpen() || (this.ctx().swipe.state?.() ?? 'none') !== 'none') return;
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
    return this.isGenerating();
  }

  async chooseSwipeAction(kind: 'ruled' | 'native' = 'ruled', canReroll = true, signal?: AbortSignal, settings = this.settings(), canCancel = true): Promise<'reuse' | 'reroll' | 'cancel'> {
    if (kind !== 'ruled' || !settings.askWhenSwiping) return 'reuse';
    const ctx = this.ctx();
    // A host lacking the popup API must still be able to keep a frozen result.
    if (!ctx.callGenericPopup || !ctx.POPUP_TYPE || !ctx.POPUP_RESULT) return 'reuse';
    if (signal?.aborted) return 'cancel';
    const content = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = 'New wording, same result?';
    const hint = document.createElement('p'); hint.textContent = canReroll
      ? 'Keep the result, or roll again before the new reply.'
      : 'Keep the result while the writer gives it new wording.';
    const label = document.createElement('label');
    const remember = document.createElement('input'); remember.type = 'checkbox';
    label.append(remember, document.createTextNode(" Don't ask again"));
    content.append(title, hint, label);
    const REROLL = 1001;
    let close: (() => void) | null = null;
    const abort = () => close?.();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Keep the result', cancelButton: canCancel ? 'Cancel' : false,
        customButtons: canReroll ? [{ text: 'Roll again', result: REROLL, icon: 'fa-dice' }] : [],
        onOpen: (popup: { complete: (result: unknown) => Promise<unknown> }) => {
          close = () => { void popup.complete(ctx.POPUP_RESULT!.CANCELLED); };
          if (signal?.aborted) close();
        },
      });
      if (signal?.aborted) return 'cancel';
      // A native regenerate has already deleted the old reply. Dismissal
      // therefore keeps its frozen result and lets replacement writing finish.
      const choice = result === REROLL && canReroll ? 'reroll' : result === ctx.POPUP_RESULT.AFFIRMATIVE || !canCancel ? 'reuse' : 'cancel';
      if (remember.checked && choice !== 'cancel') { settings.askWhenSwiping = false; this.saveSettings(); }
      return choice;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  async reviewRolls(permit: TurnPermit, names: Record<string, string>, _method: 'sample' | 'threshold', signal: AbortSignal): Promise<'keep' | 'reroll' | 'cancel'> {
    const ctx = this.ctx();
    if (signal.aborted) return 'cancel';
    if (!ctx.callGenericPopup || !ctx.POPUP_TYPE || !ctx.POPUP_RESULT) return 'keep';
    const content = document.createElement('div');
    content.className = 'rpd-workflow-popup';
    const title = document.createElement('h3'); title.textContent = 'NPC results'; content.append(title);
    const display = (text: string) => playerUiText(text, names.player ?? ctx.name1);
    for (const action of permit.actions) {
      const section = document.createElement('section');
      const heading = document.createElement('strong'); heading.textContent = `${uiActorName(action.actingActorId, names[action.actingActorId])}: ${display(action.method)}`;
      const line = [action.outcome.replaceAll('_', ' ')];
      const odds = action.methodUsed === 'sample' ? action.policyBand?.sampleWeights[action.outcome] : undefined;
      if (typeof odds === 'number') line.push(`${Math.round(odds * 100)}%`);
      if (typeof action.draw === 'number') line.push(`rolled ${Math.round(action.draw * 100)}`);
      const result = document.createElement('p'); result.textContent = line.join(' · ');
      const instruction = document.createElement('p'); instruction.textContent = display(action.instruction);
      section.append(heading, result, instruction); content.append(section);
    }
    const REROLL = 1001;
    let close: (() => void) | null = null;
    const abort = () => close?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await ctx.callGenericPopup(content, ctx.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Keep & continue', cancelButton: 'Cancel', customButtons: [{ text: 'Roll again', result: REROLL, icon: 'fa-dice' }],
        onOpen: (popup: { complete: (result: unknown) => Promise<unknown> }) => {
          close = () => { void popup.complete(ctx.POPUP_RESULT!.CANCELLED); };
          if (signal.aborted) close();
        },
      });
      if (signal.aborted) return 'cancel';
      return result === REROLL ? 'reroll' : result === ctx.POPUP_RESULT.AFFIRMATIVE ? 'keep' : 'cancel';
    } finally { signal.removeEventListener('abort', abort); }
  }

  /** Managed Regenerate keeps the selected reply as a swipe, including its speaker. */
  interceptNativeRegenerate(shouldIntercept: () => boolean, regenerate: () => Promise<unknown>): () => void {
    if (typeof document === 'undefined') return () => {};
    const control = document.getElementById('option_regenerate');
    const onClick = (event: Event): void => {
      if (!shouldIntercept() || !this.hasSelectedReply() || this.isGroup() || !this.swipesEnabled() || this.isGenerating() || (this.ctx().swipe.state?.() ?? 'none') !== 'none' || this.ctx().Popup?.util.isPopupOpen()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const menu = document.getElementById('options');
      if (menu && menu.style.display !== 'none') document.getElementById('options_button')?.click();
      void regenerate().catch(error => console.error('[RP Director] Regenerate failed', error));
    };
    control?.addEventListener('click', onClick, true);
    return () => control?.removeEventListener('click', onClick, true);
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
