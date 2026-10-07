/** Pure readers for the generation being built; no host globals or state writes. */
export type DirectorModuleName = 'speaker' | 'decisions' | 'meters' | 'secrets' | 'lore' | 'reactions' | 'pacing' | 'replyCheck';

export interface DirectorMacroState {
  /** The caller must suppress stale, paused, disabled and standing-aside generations. */
  active: boolean;
  modules: Partial<Record<DirectorModuleName, boolean>>;
  outcome?: string | null;
  /** Outcome probability, in [0, 1], matching the badge. */
  odds?: number | null;
  /** Frozen uniform draw, in [0, 1). */
  roll?: number | null;
  scene?: string | null;
  pack?: string | null;
  /** Actor display name or stable id -> meter key -> judged level word. */
  meters?: Record<string, Record<string, string>>;
}

export interface DirectorMacroDefinition {
  category: string;
  unnamedArgs: { name: string; optional?: boolean }[];
  strictArgs: boolean;
  description: string;
  returns: string;
  exampleUsage: string[];
  handler: (context: { args?: unknown; unnamedArgs?: unknown }) => string;
}

/** The supported subset of getContext().macros.registry (MacroRegistry). */
export interface DirectorMacroRegistry {
  registerMacro: (name: string, definition: DirectorMacroDefinition) => unknown;
}

const moduleNames: Record<string, DirectorModuleName> = {
  speaker: 'speaker', decisions: 'decisions', meters: 'meters', secrets: 'secrets', lore: 'lore',
  reactions: 'reactions', 'npc reactions': 'reactions', pacing: 'pacing', replycheck: 'replyCheck',
  'reply-check': 'replyCheck', reply_check: 'replyCheck', 'reply check': 'replyCheck',
};
const scenes = new Set(['combat', 'conversation', 'travel', 'intimate', 'downtime']);

function keyParts(key: string): string[] {
  let bare = key.trim();
  if (bare.startsWith('{{') && bare.endsWith('}}')) bare = bare.slice(2, -2).trim();
  const parts = bare.split('::').map(part => part.trim());
  if (parts[0]?.toLowerCase() === 'director') parts.shift();
  return parts;
}

function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  if (!record) return undefined;
  if (Object.hasOwn(record, key)) return record[key];
  // Exact identities win. Ambiguous case-insensitive names have no safe value.
  const matches = Object.keys(record).filter(name => name.toLowerCase() === key.toLowerCase());
  return matches.length === 1 ? record[matches[0]!] : undefined;
}

/** Also backs /director-get. Empty is intentional: it is false in ST's {{if}}. */
export function resolveDirectorMacro(state: DirectorMacroState | null | undefined, key: string): string {
  try {
    if (!state?.active || typeof key !== 'string') return '';
    const [name, member, detail, ...extra] = keyParts(key);
    if (extra.length) return '';
    if (name?.toLowerCase() === 'module') {
      if (!member || detail) return '';
      const module = moduleNames[member.toLowerCase()];
      return module && state.modules[module] ? 'true' : '';
    }
    if (name?.toLowerCase() === 'meter') {
      if (!state.modules.meters || !member || !detail) return '';
      return own(own(state.meters, member), detail) ?? '';
    }
    if (member !== undefined || detail !== undefined) return '';
    switch (name?.toLowerCase()) {
      case 'active': return 'true';
      case 'outcome': return state.modules.decisions ? (state.outcome ?? '').replaceAll('_', ' ') : '';
      case 'odds': return state.modules.decisions && typeof state.odds === 'number' && Number.isFinite(state.odds)
        && state.odds >= 0 && state.odds <= 1 ? `${Math.round(state.odds * 100)}%` : '';
      case 'roll': return state.modules.decisions && typeof state.roll === 'number' && Number.isFinite(state.roll)
        && state.roll >= 0 && state.roll < 1 ? `${Math.round(state.roll * 100)}/100` : '';
      case 'scene': return state.modules.pacing && state.scene && scenes.has(state.scene) ? state.scene : '';
      case 'pack': return state.pack && state.pack !== 'auto' ? state.pack : '';
      default: return '';
    }
  } catch {
    // Host dry runs may have no current chat or only partially prepared state.
    return '';
  }
}

/** Register one namespaced reader with ST's new engine, including nested macro evaluation. */
export function registerDirectorMacros(registry: DirectorMacroRegistry | null | undefined, getState: () => DirectorMacroState | null | undefined): boolean {
  if (!registry?.registerMacro) return false;
  const registered = registry.registerMacro('director', {
    category: 'state',
    unnamedArgs: [{ name: 'key', optional: true }, { name: 'member', optional: true }, { name: 'detail', optional: true }],
    // Unknown/incomplete reader keys should resolve empty, including during dry runs.
    strictArgs: false,
    description: 'Read the Director decision for the generation being built; use in depth 0–1 prompts.',
    returns: 'A frozen value, true for enabled guards, or an empty string when unavailable.',
    exampleUsage: ['{{director::outcome}}', '{{director::roll}}', '{{director::meter::Guide::regard}}', '{{director::module::meters}}'],
    handler: context => {
      try {
        const args = context?.args ?? context?.unnamedArgs;
        if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return '';
        return resolveDirectorMacro(getState(), args.join('::'));
      } catch {
        return '';
      }
    },
  });
  return registered !== null && registered !== false;
}
