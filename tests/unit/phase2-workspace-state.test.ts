import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_TABS, createWorkspaceState, normalizeWorkspaceTab,
  openWorkspace, selectWorkspaceTab, setWorkspaceDraftDirty, closeWorkspace,
} from '../../src/workspace-state.ts';

test('workspace offers all five tabs and accepts their names in slash commands', () => {
  assert.deepEqual(WORKSPACE_TABS.map(tab => tab.label), ['This chat', 'Activity', 'Outcomes', 'Lore', 'Settings']);
  for (const tab of WORKSPACE_TABS) {
    assert.equal(normalizeWorkspaceTab(`  ${tab.id.toUpperCase()}  `), tab.id);
    assert.equal(normalizeWorkspaceTab(tab.label), tab.id);
  }
  assert.equal(normalizeWorkspaceTab(' \tThis   Chat\n '), 'chat');
  for (const invalid of [undefined, null, '', 'unknown', 'chat later', 3, ['chat']]) {
    assert.equal(normalizeWorkspaceTab(invalid), null);
  }
});

test('an open workspace keeps its tab and draft when opened through another entry point', () => {
  const state = createWorkspaceState();
  openWorkspace(state);
  assert.equal(state.tab, 'chat');
  selectWorkspaceTab(state, 'outcomes');
  setWorkspaceDraftDirty(state, true);
  openWorkspace(state);
  assert.deepEqual(state, { open: true, tab: 'outcomes', draftDirty: true, activityMessageId: null });
  selectWorkspaceTab(state, 'settings');
  assert.equal(state.draftDirty, true, 'switching mounted panes must not drop an unsaved table');
});

test('closing a dirty workspace leaves it intact until saved or explicitly discarded', () => {
  const state = createWorkspaceState();
  openWorkspace(state, 'outcomes');
  setWorkspaceDraftDirty(state, true);
  const before = { ...state };
  assert.equal(closeWorkspace(state), false);
  assert.deepEqual(state, before);
  setWorkspaceDraftDirty(state, false);
  assert.equal(closeWorkspace(state), true);
  openWorkspace(state, 'settings');
  setWorkspaceDraftDirty(state, true);
  assert.equal(closeWorkspace(state, true), true);
  assert.equal(state.open, false);
  assert.equal(state.draftDirty, false);
});

test('a badge opens the matching Activity message and tab changes retain that selection', () => {
  const state = createWorkspaceState();
  openWorkspace(state, 'chat', 0);
  assert.equal(state.tab, 'activity');
  assert.equal(state.activityMessageId, 0);
  selectWorkspaceTab(state, 'lore');
  openWorkspace(state, 'activity');
  assert.equal(state.activityMessageId, 0);
  openWorkspace(state, 'activity', 18);
  assert.equal(state.activityMessageId, 18);
  for (const invalid of [-1, 1.5, NaN, Infinity]) openWorkspace(state, 'activity', invalid);
  assert.equal(state.activityMessageId, 18);
});

test('a new popup starts in This chat unless a tab or message was explicitly requested', () => {
  const state = createWorkspaceState();
  openWorkspace(state, 'activity', 12);
  assert.equal(closeWorkspace(state), true);
  openWorkspace(state);
  assert.deepEqual(state, { open: true, tab: 'chat', draftDirty: false, activityMessageId: null });
  closeWorkspace(state);
  openWorkspace(state, 'settings');
  assert.equal(state.tab, 'settings');
});
