/** Popup state has no host or DOM dependency, so closing cannot silently lose a draft. */
export const WORKSPACE_TABS = [
  { id: 'chat', label: 'This chat' },
  { id: 'activity', label: 'Activity' },
  { id: 'outcomes', label: 'Outcomes' },
  { id: 'lore', label: 'Lore' },
  { id: 'settings', label: 'Settings' },
] as const;

export type WorkspaceTab = typeof WORKSPACE_TABS[number]['id'];

export interface WorkspaceState {
  open: boolean;
  tab: WorkspaceTab;
  draftDirty: boolean;
  activityMessageId: number | null;
}

/** Accept the visible tab names as well as the short slash-command names. */
export function normalizeWorkspaceTab(value: unknown): WorkspaceTab | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (normalized === 'this chat') return 'chat';
  return WORKSPACE_TABS.find(tab => tab.id === normalized)?.id ?? null;
}

export function createWorkspaceState(): WorkspaceState {
  return { open: false, tab: 'chat', draftDirty: false, activityMessageId: null };
}

/** Reopening an already visible workspace keeps its tab and mounted drafts. */
export function openWorkspace(state: WorkspaceState, tab?: WorkspaceTab, activityMessageId?: number): void {
  if (!state.open) {
    state.tab = tab ?? 'chat';
    state.activityMessageId = null;
    state.draftDirty = false;
  } else if (tab) {
    state.tab = tab;
  }
  if (activityMessageId !== undefined && Number.isInteger(activityMessageId) && activityMessageId >= 0) {
    state.activityMessageId = activityMessageId;
    state.tab = 'activity';
  }
  state.open = true;
}

/** Panes stay mounted while switching tabs; their draft guard stays active. */
export function selectWorkspaceTab(state: WorkspaceState, tab: WorkspaceTab): void {
  state.tab = tab;
}

export function setWorkspaceDraftDirty(state: WorkspaceState, dirty: boolean): void {
  state.draftDirty = dirty;
}

/** The caller confirms any discard before passing true. */
export function closeWorkspace(state: WorkspaceState, discard = false): boolean {
  if (state.draftDirty && !discard) return false;
  state.open = false;
  state.draftDirty = false;
  state.activityMessageId = null;
  return true;
}
