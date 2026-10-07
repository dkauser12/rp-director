/**
 * Editor for the outcome policy table: fully configurable rows (bands) and
 * columns (outcomes), a tooltip on every field, and a "Test table" button
 * that sends the edited table through one judge call.
 *
 * Table edits happen on a draft; nothing in the table changes play until
 * "Apply table". The resolution method is a mode and applies immediately.
 */
import type { Controller } from './controller.ts';
import { el, button } from './dom.ts';
import { loadLocalPresets, TABLE_PRESETS, presetById, presetDraft } from './presets.ts';
import { setResolutionMethod } from './profiles.ts';
import type { ActorPolicy } from './types.ts';
import type { PolicyTable } from './table.ts';
import {
  INSTRUCTION_MAX_LENGTH, MAX_BANDS, MAX_OUTCOMES, MIN_OUTCOMES, NAME_MAX_LENGTH,
  addBand, addOutcome, canAddBand, canAddOutcome, canRemoveBand, canRemoveOutcome, cloneTable,
  removeBand, removeOutcome, renameOutcome, sanitizeName, setBandUpper, validateTable, weightSum,
} from './table.ts';
import type { TableTestReport } from './tabletest.ts';

export const TABLE_HELP = [
  'The judge gives a score from 0 to 1, and the matching row sets the result or its odds.',
  'Threshold uses the named result, while Dice rolls using the odds in that row.',
  'Edit each result and its writer instruction, then choose Apply table to use your changes.',
];

export const TIP = {
  method: 'Changes apply to new rulings immediately, while existing rulings keep their result.',
  id: 'Rows are numbered automatically.',
  from: 'This score is included and follows the end of the previous row.',
  to: 'This score starts the next row.',
  toLast: 'The last row includes the maximum score of 1.',
  threshold: 'Enter the name of the result used when the score falls in this row.',
  prefix: 'Each number is the chance of this result with Dice.',
  name: `Use up to ${NAME_MAX_LENGTH} letters, digits or underscores, starting with a letter.`,
  instruction: `Describe what happens and what it costs in up to ${INSTRUCTION_MAX_LENGTH} characters.`,
  preset: 'Load a starting table, then choose Apply table to use it.',
  weight: 'Enter a chance from 0 to 1, with all chances in the row adding to 1.',
  sum: 'The chances in this row must add to 1.',
  removeRow: 'Remove this row and give its score range to the next available row.',
  removeCol: `Keep at least ${MIN_OUTCOMES} result columns.`,
  addRow: `Split the widest row in half, up to ${MAX_BANDS} rows.`,
  addCol: `Add a result column, up to ${MAX_OUTCOMES} columns.`,
  apply: 'Use this table for new rulings.',
  reset: 'Restore the original table while keeping the selected method.',
  test: 'Check this edited table with one judge request.',
};

/** The workspace uses isDirty before navigation; reload discards the draft. */
export function buildTableEditor(controller: Controller): { element: HTMLElement; reload: () => void; isDirty: () => boolean } {
  const host = el('div', { id: 'rpd-bands' });
  let draft: PolicyTable = { outcomes: [], bands: [] };
  let method: 'threshold' | 'sample' = 'threshold';
  let report: TableTestReport | { status: 'info' | 'fail'; headline: string; lines: string[] } | null = null;
  let testing = false;
  let presetChoice = TABLE_PRESETS[0]?.id ?? 'standard';
  let pendingPresetActorPolicy: ActorPolicy | null = null;
  let localPresetWarnings: string[] = [];
  let refreshPresetChoices = () => {};

  void loadLocalPresets().then(result => {
    localPresetWarnings = result.warnings;
    if (result.warnings.length) console.warn('[RP Director] local presets:', ...result.warnings);
    // Update only the list: loading must not replace a focused or edited field.
    refreshPresetChoices();
  });

  const names = () => draft.outcomes.map(o => o.name);
  const isDirty = () => JSON.stringify({ o: draft.outcomes, b: draft.bands, m: method }) !== JSON.stringify({ o: controller.profile.outcomes, b: controller.profile.bands, m: controller.profile.resolutionMethod })
    || pendingPresetActorPolicy !== null && pendingPresetActorPolicy !== controller.profile.actorPolicy;

  const reload = () => {
    draft = cloneTable({ outcomes: controller.profile.outcomes, bands: controller.profile.bands });
    method = controller.profile.resolutionMethod;
    pendingPresetActorPolicy = null;
    render();
  };

  const showReport = (box: HTMLElement) => {
    box.replaceChildren();
    box.dataset.status = report ? report.status : 'none';
    if (testing) { box.dataset.status = 'info'; box.append(el('div', { class: 'rpd-result-head', text: 'Testing… 1 judge request.' })); return; }
    if (!report) return;
    box.append(el('div', { class: 'rpd-result-head', text: tableReportText(report.headline) }));
    for (const line of report.lines) box.append(el('div', { class: 'rpd-result-line', text: tableReportText(line) }));
  };

  function render(): void {
    host.replaceChildren();
    const outcomeNames = names();

    // Method
    const methodSelect = el('select', { class: 'text_pole', title: TIP.method });
    for (const m of ['threshold', 'sample'] as const) methodSelect.append(el('option', { value: m, text: m === 'threshold' ? 'Threshold' : 'Dice' }));
    methodSelect.value = method;
    methodSelect.addEventListener('change', () => {
      // The method is a mode, not table data: it applies now, without Apply table.
      method = methodSelect.value as 'threshold' | 'sample';
      setResolutionMethod(controller.settings, controller.profile.id, method);
      controller.host.saveSettings();
      controller.reloadProfile();
      controller.host.toast('success', method === 'sample' ? 'Method: Dice.' : 'Method: Threshold.');
      render();
    });
    const uses = el('span', { class: 'rpd-muted', text: method === 'threshold' ? 'The score picks the named result.' : 'The score picks the odds, then one roll picks the result.' });
    host.append(el('div', { class: 'rpd-row' }, [el('label', { text: 'Method', title: TIP.method }), methodSelect, uses]));

    const help = el('details', { class: 'rpd-help' }, [el('summary', { text: 'Table help' })]);
    for (const line of TABLE_HELP) help.append(el('div', { text: line }));
    host.append(help);

    // Presets
    const presetSelect = el('select', { id: 'rpd-preset', class: 'text_pole', title: TIP.preset });
    for (const p of TABLE_PRESETS) presetSelect.append(el('option', { value: p.id, text: p.label, title: presetHint(p.description) }));
    presetSelect.value = presetChoice;
    const presetHelp = el('span', { class: 'rpd-muted', text: presetHint(TABLE_PRESETS.find(p => p.id === presetChoice)?.description ?? '') });
    const presetWarnings = el('div', { class: 'rpd-muted' });
    refreshPresetChoices = () => {
      presetSelect.replaceChildren(...TABLE_PRESETS.map(p => el('option', { value: p.id, text: p.label })));
      presetSelect.value = presetChoice;
      presetWarnings.textContent = localPresetWarnings.length ? 'Some local presets could not be loaded.' : '';
    };
    presetSelect.addEventListener('change', () => { presetChoice = presetSelect.value; presetHelp.textContent = presetHint(TABLE_PRESETS.find(p => p.id === presetChoice)?.description ?? ''); });
    const loadPreset = button('rpd-preset-load', 'Load preset', TIP.preset, () => {
      const preset = presetById(presetSelect.value);
      if (!preset) return;
      const loaded = presetDraft(preset, method);
      draft = cloneTable(loaded.table);
      pendingPresetActorPolicy = preset.actorPolicy ?? null;
      report = { status: 'info', headline: `Choose Apply table to use "${preset.label}".`, lines: loaded.note ? [loaded.note] : [] };
      render();
    });
    refreshPresetChoices();
    host.append(el('div', { class: 'rpd-row' }, [el('label', { text: 'Preset', title: TIP.preset }), presetSelect, loadPreset]), el('div', { class: 'rpd-row' }, [presetHelp]), presetWarnings);

    // Table
    const table = el('table', { class: 'rpd-bands' });
    const head = el('tr');
    head.append(
      el('th', { text: 'Row', title: TIP.id }),
      el('th', { text: 'From ≥ (0–1)', title: TIP.from }),
      el('th', { text: 'To < (0–1)', title: TIP.to }),
      el('th', { text: 'Result', title: TIP.threshold, class: method === 'threshold' ? '' : 'rpd-dim' }),
    );
    draft.outcomes.forEach((o, i) => {
      const nameInput = el('input', { type: 'text', class: 'text_pole rpd-name', value: o.name, title: TIP.name, maxlength: String(NAME_MAX_LENGTH), spellcheck: 'false', 'data-col': String(i) });
      nameInput.addEventListener('input', () => { const clean = sanitizeName(nameInput.value); if (clean !== nameInput.value) nameInput.value = clean; });
      nameInput.addEventListener('change', () => {
        const clean = sanitizeName(nameInput.value, true);
        if (!clean) { nameInput.value = o.name; return; }
        draft = renameOutcome(draft, i, clean);
        render();
      });
      const cell = el('div', { class: 'rpd-colhead' }, [el('span', { class: 'rpd-prefix', text: 'Chance (0–1)', title: TIP.prefix }), nameInput]);
      if (canRemoveOutcome(draft)) {
        const x = el('span', { class: 'rpd-x interactable', text: '×', title: TIP.removeCol, tabindex: '0', role: 'button', 'aria-label': `Remove outcome ${o.name}` });
        x.addEventListener('click', () => { draft = removeOutcome(draft, i); render(); });
        cell.append(x);
      }
      head.append(el('th', { class: method === 'sample' ? '' : 'rpd-dim' }, [cell]));
    });
    head.append(el('th', { text: 'Total (0–1)', title: TIP.sum, class: method === 'sample' ? '' : 'rpd-dim' }));
    const addColCell = el('th');
    if (canAddOutcome(draft)) addColCell.append(button('rpd-col-add', '+ column', TIP.addCol, () => { draft = addOutcome(draft); render(); }));
    head.append(addColCell);
    table.append(head);

    // What the writer is told
    const told = el('tr', { class: 'rpd-meta' });
    told.append(el('td', { colspan: '4', class: 'rpd-meta-label', text: `Writer instruction (max ${INSTRUCTION_MAX_LENGTH} characters)`, title: TIP.instruction }));
    draft.outcomes.forEach((o, i) => {
      const area = el('textarea', { class: 'text_pole rpd-instruction', rows: '5', title: TIP.instruction, maxlength: String(INSTRUCTION_MAX_LENGTH), placeholder: 'Write the ruling as an order to the writer.', 'data-col': String(i) });
      area.value = o.instruction;
      area.classList.toggle('rpd-bad', !o.instruction.trim());
      area.addEventListener('input', () => { draft.outcomes[i]!.instruction = area.value; area.classList.toggle('rpd-bad', !area.value.trim()); refreshDirty(); });
      told.append(el('td', {}, [area]));
    });
    told.append(el('td'), el('td'));
    table.append(told);

    // Band rows
    draft.bands.forEach((band, r) => {
      const isLast = r === draft.bands.length - 1;
      const from = el('input', { type: 'number', value: String(band.lowerInclusive), title: TIP.from, readonly: 'readonly', tabindex: '-1', class: 'rpd-readonly' });
      const to = el('input', { type: 'number', step: '0.01', min: '0', max: '1', value: String(band.upper), title: isLast ? TIP.toLast : TIP.to });
      if (isLast) { to.setAttribute('readonly', 'readonly'); to.classList.add('rpd-readonly'); to.tabIndex = -1; }
      else to.addEventListener('change', () => { draft = setBandUpper(draft, r, Number(to.value)); render(); });

      const threshold = el('input', { type: 'text', class: 'text_pole rpd-threshold', value: band.thresholdOutcome, title: TIP.threshold, maxlength: String(NAME_MAX_LENGTH), spellcheck: 'false' });
      const markThreshold = () => threshold.classList.toggle('rpd-bad', !outcomeNames.includes(sanitizeName(threshold.value, true)));
      threshold.addEventListener('input', () => { const clean = sanitizeName(threshold.value); if (clean !== threshold.value) threshold.value = clean; markThreshold(); });
      threshold.addEventListener('change', () => { threshold.value = sanitizeName(threshold.value, true); draft.bands[r]!.thresholdOutcome = threshold.value; markThreshold(); refreshDirty(); });
      markThreshold();

      const sumCell = el('td', { class: 'rpd-sum', title: TIP.sum });
      const showSum = () => {
        const s = weightSum(draft.bands[r]!, outcomeNames);
        sumCell.textContent = s.toFixed(4).replace(/\.?0+$/, '') || '0';
        sumCell.classList.toggle('rpd-bad', Math.abs(s - 1) > 1e-9);
      };

      const row = el('tr');
      row.append(el('td', { text: band.id, title: TIP.id }), el('td', {}, [from]), el('td', {}, [to]), el('td', { class: method === 'threshold' ? '' : 'rpd-dim' }, [threshold]));
      for (const name of outcomeNames) {
        const w = el('input', { type: 'number', step: '0.0001', min: '0', max: '1', value: String(band.sampleWeights[name] ?? 0), title: TIP.weight });
        w.addEventListener('input', () => { draft.bands[r]!.sampleWeights[name] = Number(w.value); showSum(); refreshDirty(); });
        row.append(el('td', { class: method === 'sample' ? '' : 'rpd-dim' }, [w]));
      }
      showSum();
      if (method !== 'sample') sumCell.classList.add('rpd-dim');
      row.append(sumCell);
      const removeCell = el('td');
      if (canRemoveBand(draft)) {
        const x = el('span', { class: 'rpd-x interactable', text: '×', title: TIP.removeRow, tabindex: '0', role: 'button', 'aria-label': `Remove row ${r + 1}` });
        x.addEventListener('click', () => { draft = removeBand(draft, r); render(); });
        removeCell.append(x);
      }
      row.append(removeCell);
      table.append(row);
    });
    host.append(el('div', { class: 'rpd-table-scroll' }, [table]));

    // Row controls and size note
    const sizeNote = el('span', { class: 'rpd-muted', text: `${draft.bands.length} row${draft.bands.length === 1 ? '' : 's'}, ${draft.outcomes.length} outcome column${draft.outcomes.length === 1 ? '' : 's'}.` });
    const rowControls = el('div', { class: 'rpd-row' });
    if (canAddBand(draft)) rowControls.append(button('rpd-row-add', '+ row', TIP.addRow, () => { draft = addBand(draft); render(); }));
    rowControls.append(sizeNote);
    host.append(rowControls);

    // Actions
    const dirty = el('span', { id: 'rpd-table-dirty', class: 'rpd-muted' });
    const result = el('div', { id: 'rpd-table-result', class: 'rpd-table-result' });
    const apply = button('rpd-bands-apply', 'Apply table', TIP.apply, () => {
      const v = validateTable(draft);
      if (!v.ok) {
        report = { status: 'fail', headline: 'Table not applied. Fix these first:', lines: v.errors };
        controller.host.toast('error', 'Table needs changes: ' + tableReportText(v.errors[0] ?? 'Check the rows.'));
        showReport(result);
        return;
      }
      const overrides = controller.settings.profileOverrides;
      const id = controller.profile.id;
      overrides[id] = { ...(overrides[id] ?? {}), outcomes: cloneTable(draft).outcomes, bands: cloneTable(draft).bands, resolutionMethod: method, ...(pendingPresetActorPolicy ? { actorPolicy: pendingPresetActorPolicy } : {}) };
      controller.host.saveSettings();
      controller.reloadProfile();
      report = { status: 'info', headline: 'Table applied.', lines: [] };
      controller.host.toast('success', 'Table applied.');
      reload();
    });
    const reset = button('rpd-bands-reset', 'Restore defaults', TIP.reset, () => {
      const keptMethod = controller.profile.resolutionMethod;
      delete controller.settings.profileOverrides[controller.profile.id];
      setResolutionMethod(controller.settings, controller.profile.id, keptMethod);
      pendingPresetActorPolicy = null;
      controller.host.saveSettings();
      controller.reloadProfile();
      report = { status: 'info', headline: 'Default table restored.', lines: [] };
      reload();
    });
    const test = button('rpd-bands-test', 'Test table (1 request)', TIP.test, () => {
      if (testing) return;
      testing = true;
      showReport(result);
      void controller.testTable(cloneTable(draft), method).then(r => { report = r; }, e => { report = { status: 'fail', headline: 'The test could not run.', lines: [String((e as Error)?.message ?? e)] }; }).finally(() => {
        testing = false;
        const box = host.querySelector<HTMLElement>('#rpd-table-result');
        if (box) showReport(box);
      });
    });
    host.append(el('div', { class: 'rpd-row' }, [apply, reset, test, dirty]), result);
    if (controller.profileWarnings.length) host.append(el('div', { class: 'rpd-muted', text: controller.profileWarnings.map(tableReportText).join(' | ') }));
    showReport(result);
    refreshDirty();
  }

  function refreshDirty(): void {
    const node = host.querySelector('#rpd-table-dirty');
    if (node) node.textContent = isDirty() ? 'Choose Apply table to save these changes.' : '';
  }

  reload();
  return { element: host, reload, isDirty };
}

/** Diagnostics use the same row terminology as the editor. */
function tableReportText(text: string): string {
  return text.replace(/\bbands\b/gi, 'rows').replace(/\bband\b/gi, 'row')
    .replace(/\btable_signal\b/g, 'Judge score').replace(/\btable_outcome\b/g, 'Result name').replace(/\btable_band\b/g, 'Row')
    .replace(/\bSignal: (?:Noul|Score) [\d.]+ → x = /g, 'Score: ')
    .replace(/with a sample roll of ([\d.]+)/g, (_match, value: string) => `with a roll of ${Math.round(Number(value) * 100)}/100`)
    .replace(/\bOne judge call\b/g, '1 judge request');
}

function presetHint(text: string): string {
  return text.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text;
}
