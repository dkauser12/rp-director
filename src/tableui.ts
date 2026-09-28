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
  'The judge answers with one number from 0 (nothing supports the gain) to 1 (clearly justified). Each row is a band of that number.',
  'Binding: the row the number lands in names the ruling directly, using the "outcome" column.',
  'Binding + dice: the row gives the odds instead. Each "w:" cell is the chance of that ruling, and one recorded roll picks it.',
  'Columns are the possible rulings, and every part of a ruling is yours to define: its name, exactly what the writer is told, what gets recorded when you accept the reply, and whether that record settles the matter. A ruling can be a real failure, a cost, a complication, or anything else you write.',
  'Presets load a ready-made table into the editor. Optional local presets live in gitignored profiles/local/presets.json. Nothing in the table changes in play until you press Apply table; the resolution method applies as soon as you change it.',
  'The table is applied in code. The judge never reads it during play, so "w:" and "b0" are labels of this extension, not a model format.',
];

export const TIP = {
  method: 'How a row becomes a ruling. threshold: the row\'s outcome is the ruling. sample: the row\'s weights are odds and one recorded roll decides. Takes effect as soon as you change it; loading a preset never changes it. Rulings already frozen keep the method they were made with.',
  id: 'Band id. Auto-numbered b0, b1, b2 … and written into every ruling so you can see which row decided. Not editable; add or remove rows instead.',
  from: 'Lower edge of this band, included. It always equals the "to" of the row above, so it is filled in for you.',
  to: 'Upper edge of this band, not included. Editing it moves the "from" of the next row. The last row always ends at 1 and includes it.',
  toLast: 'The last band always ends at 1 and includes it.',
  threshold: 'Binding: the ruling when the judge\'s number lands in this band. Type the name of one of the outcome columns. Spaces become underscores; other symbols are removed.',
  prefix: '"w:" means weight. It is a fixed label of this table, not part of the name and not something the model sees.',
  name: `Name of this outcome. Letters, digits and underscores, starting with a letter, up to ${NAME_MAX_LENGTH} characters. Spaces become underscores and other symbols are removed as you type. Jev accepts any text as an option name; this stricter set also keeps the name safe as a saved variable and for other backends. Renaming updates every row that uses the name.`,
  instruction: `Exactly what the writer is told when this is the ruling. This is the whole meaning of the outcome, so write it as an order: what happens, what must not happen, what it costs. You can use {{gain}}, {{action}}, {{target}}, {{player}} and {{speaker}}. Example of a real failure: "The attempt fails and {{target}} will not reconsider. Show the door closing." Up to ${INSTRUCTION_MAX_LENGTH} characters.`,
  records: 'What gets written to this gain\'s variable when you Accept the reply, for example achieved, partial, failed, blocked. Letters, digits and underscores; spaces become underscores. Leave empty to record nothing. It shows in the Inspector and decides what "stands once accepted" matches on.',
  final: 'On: once you Accept this ruling, it stands for the declaration\'s scope. Attempt scope never settles a future retry; scene scope lasts until New scene; persistent scope stands until relevant history changes. The frozen meaning survives later table edits. Needs a recorded value. Off: the result can be attempted and judged again.',
  preset: 'A ready-made table for a genre, with its own named rulings, instructions and recorded values. Loading one replaces the table below in the editor only. Review it, edit anything, then press Apply table.',
  weight: 'Binding + dice: chance of this outcome when the judge\'s number lands in this band. From 0 to 1 in steps of 0.0001. Every row must add up to exactly 1.',
  sum: 'Sum of this row\'s weights. It must be exactly 1.',
  removeRow: 'Remove this band. Its range goes to the row above (or below, for the first row).',
  removeCol: `Remove this outcome column. At least ${MIN_OUTCOMES} columns are required.`,
  addRow: `Add a band by splitting the widest row in half; the new row copies its outcome and weights. Up to ${MAX_BANDS} rows: Jev accepts at most 255 options in one Choice question, and the table test asks one over the band ids.`,
  addCol: `Add an outcome column. Up to ${MAX_OUTCOMES} columns, for the same 255-option limit.`,
  apply: 'Check the table and start using it. Creates a new profile revision; rulings already frozen keep the table they were made with.',
  reset: 'Discard your table and go back to the profile\'s built-in one. Your resolution method is kept.',
  test: 'Send this table, as edited, through one call to the selected judge connection. Passes only if every answer comes back in the expected format and resolves to one of your outcome columns. Costs one judge call.',
};

export function buildTableEditor(controller: Controller): { element: HTMLElement; reload: () => void } {
  const host = el('div', { id: 'rpd-bands' });
  let draft: PolicyTable = { outcomes: [], bands: [] };
  let method: 'threshold' | 'sample' = 'threshold';
  let report: TableTestReport | { status: 'info' | 'fail'; headline: string; lines: string[] } | null = null;
  let testing = false;
  let presetChoice = TABLE_PRESETS[0]?.id ?? 'standard';
  let pendingPresetActorPolicy: ActorPolicy | null = null;
  let localPresetWarnings: string[] = [];

  void loadLocalPresets().then(result => {
    localPresetWarnings = result.warnings;
    if (result.loaded.length) {
      presetChoice = result.loaded[0]!;
      controller.host.toast('success', `Loaded ${result.loaded.length} local-only RP Director preset${result.loaded.length === 1 ? '' : 's'}.`);
    }
    if (result.warnings.length) console.warn('[RP Director] local presets:', ...result.warnings);
    render();
  });

  const names = () => draft.outcomes.map(o => o.name);
  const isDirty = () => JSON.stringify({ o: draft.outcomes, b: draft.bands, m: method }) !== JSON.stringify({ o: controller.profile.outcomes, b: controller.profile.bands, m: controller.profile.resolutionMethod });

  const reload = () => {
    draft = cloneTable({ outcomes: controller.profile.outcomes, bands: controller.profile.bands });
    method = controller.profile.resolutionMethod;
    render();
  };

  const showReport = (box: HTMLElement) => {
    box.replaceChildren();
    box.dataset.status = report ? report.status : 'none';
    if (testing) { box.dataset.status = 'info'; box.append(el('div', { class: 'rpd-result-head', text: 'Testing… one judge call in flight.' })); return; }
    if (!report) return;
    box.append(el('div', { class: 'rpd-result-head', text: report.headline }));
    for (const line of report.lines) box.append(el('div', { class: 'rpd-result-line', text: line }));
  };

  function render(): void {
    host.replaceChildren();
    const outcomeNames = names();

    // Explanation
    const help = el('div', { class: 'rpd-help' });
    for (const line of TABLE_HELP) help.append(el('div', { text: line }));
    host.append(help);

    // Method
    const methodSelect = el('select', { class: 'text_pole', title: TIP.method });
    for (const m of ['threshold', 'sample'] as const) methodSelect.append(el('option', { value: m, text: m === 'threshold' ? 'threshold (Binding)' : 'sample (Binding + dice)' }));
    methodSelect.value = method;
    methodSelect.addEventListener('change', () => {
      // The method is a mode, not table data: it applies now, without Apply table.
      method = methodSelect.value as 'threshold' | 'sample';
      setResolutionMethod(controller.settings, controller.profile.id, method);
      controller.host.saveSettings();
      controller.reloadProfile();
      controller.host.toast('success', method === 'sample' ? 'Resolution method: dice (sample).' : 'Resolution method: threshold.');
      render();
    });
    const uses = el('span', { class: 'rpd-muted', text: method === 'threshold' ? 'Using the "outcome" column. Weights are kept but ignored.' : 'Using the "w:" weights. The "outcome" column is kept but ignored.' });
    host.append(el('div', { class: 'rpd-row' }, [el('label', { text: 'Resolution method', title: TIP.method }), methodSelect, uses]));

    // Presets
    const presetSelect = el('select', { id: 'rpd-preset', class: 'text_pole', title: TIP.preset });
    for (const p of TABLE_PRESETS) presetSelect.append(el('option', { value: p.id, text: p.label, title: p.description }));
    presetSelect.value = presetChoice;
    const presetHelp = el('span', { class: 'rpd-muted', text: TABLE_PRESETS.find(p => p.id === presetChoice)?.description ?? '' });
    presetSelect.addEventListener('change', () => { presetChoice = presetSelect.value; presetHelp.textContent = TABLE_PRESETS.find(p => p.id === presetChoice)?.description ?? ''; });
    const loadPreset = button('rpd-preset-load', 'Load preset', TIP.preset, () => {
      const preset = presetById(presetSelect.value);
      if (!preset) return;
      const loaded = presetDraft(preset, method);
      draft = cloneTable(loaded.table);
      pendingPresetActorPolicy = preset.actorPolicy ?? null;
      report = { status: 'info', headline: `Loaded the "${preset.label}" preset into the editor. Press Apply table to use it.`, lines: loaded.note ? [loaded.note] : [] };
      render();
    });
    host.append(el('div', { class: 'rpd-row' }, [el('label', { text: 'Preset', title: TIP.preset }), presetSelect, loadPreset]), el('div', { class: 'rpd-row' }, [presetHelp]));

    // Table
    const table = el('table', { class: 'rpd-bands' });
    const head = el('tr');
    head.append(
      el('th', { text: 'id', title: TIP.id }),
      el('th', { text: 'from ≥', title: TIP.from }),
      el('th', { text: 'to <', title: TIP.to }),
      el('th', { text: 'outcome', title: TIP.threshold, class: method === 'threshold' ? '' : 'rpd-dim' }),
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
      const cell = el('div', { class: 'rpd-colhead' }, [el('span', { class: 'rpd-prefix', text: 'w:', title: TIP.prefix }), nameInput]);
      if (canRemoveOutcome(draft)) {
        const x = el('span', { class: 'rpd-x interactable', text: '×', title: TIP.removeCol, tabindex: '0', role: 'button', 'aria-label': `Remove outcome ${o.name}` });
        x.addEventListener('click', () => { draft = removeOutcome(draft, i); render(); });
        cell.append(x);
      }
      head.append(el('th', { class: method === 'sample' ? '' : 'rpd-dim' }, [cell]));
    });
    head.append(el('th', { text: 'sum', title: TIP.sum, class: method === 'sample' ? '' : 'rpd-dim' }));
    const addColCell = el('th');
    if (canAddOutcome(draft)) addColCell.append(button('rpd-col-add', '+ column', TIP.addCol, () => { draft = addOutcome(draft); render(); }));
    head.append(addColCell);
    table.append(head);

    // What the writer is told
    const told = el('tr', { class: 'rpd-meta' });
    told.append(el('td', { colspan: '4', class: 'rpd-meta-label', text: 'what the writer is told →', title: TIP.instruction }));
    draft.outcomes.forEach((o, i) => {
      const area = el('textarea', { class: 'text_pole rpd-instruction', rows: '5', title: TIP.instruction, maxlength: String(INSTRUCTION_MAX_LENGTH), placeholder: 'Write the ruling as an order to the writer.', 'data-col': String(i) });
      area.value = o.instruction;
      area.classList.toggle('rpd-bad', !o.instruction.trim());
      area.addEventListener('input', () => { draft.outcomes[i]!.instruction = area.value; area.classList.toggle('rpd-bad', !area.value.trim()); refreshDirty(); });
      told.append(el('td', {}, [area]));
    });
    told.append(el('td'), el('td'));
    table.append(told);

    // What gets recorded
    const recorded = el('tr', { class: 'rpd-meta' });
    recorded.append(el('td', { colspan: '4', class: 'rpd-meta-label', text: 'records on accept →', title: TIP.records }));
    draft.outcomes.forEach((o, i) => {
      const input = el('input', { type: 'text', class: 'text_pole rpd-records', value: o.records, placeholder: 'nothing', title: TIP.records, maxlength: String(NAME_MAX_LENGTH), spellcheck: 'false', 'data-col': String(i) });
      input.addEventListener('input', () => { const clean = sanitizeName(input.value); if (clean !== input.value) input.value = clean; });
      input.addEventListener('change', () => { input.value = sanitizeName(input.value, true); draft.outcomes[i]!.records = input.value; render(); });
      recorded.append(el('td', {}, [input]));
    });
    recorded.append(el('td'), el('td'));
    table.append(recorded);

    // Whether the ruling stands
    const stands = el('tr', { class: 'rpd-meta' });
    stands.append(el('td', { colspan: '4', class: 'rpd-meta-label', text: 'stands once accepted →', title: TIP.final }));
    draft.outcomes.forEach((o, i) => {
      const box = el('input', { type: 'checkbox', class: 'rpd-final', title: TIP.final, 'data-col': String(i) });
      box.checked = o.final;
      if (!o.records) { box.disabled = true; box.checked = false; draft.outcomes[i]!.final = false; }
      box.addEventListener('change', () => { draft.outcomes[i]!.final = box.checked; refreshDirty(); });
      stands.append(el('td', { title: TIP.final }, [box]));
    });
    stands.append(el('td'), el('td'));
    table.append(stands);

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
        const x = el('span', { class: 'rpd-x interactable', text: '×', title: TIP.removeRow, tabindex: '0', role: 'button', 'aria-label': `Remove band ${band.id}` });
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
        controller.host.toast('error', 'Table rejected: ' + v.errors[0]);
        showReport(result);
        return;
      }
      const overrides = controller.settings.profileOverrides;
      const id = controller.profile.id;
      overrides[id] = { ...(overrides[id] ?? {}), outcomes: cloneTable(draft).outcomes, bands: cloneTable(draft).bands, resolutionMethod: method, ...(pendingPresetActorPolicy ? { actorPolicy: pendingPresetActorPolicy } : {}) };
      controller.host.saveSettings();
      controller.reloadProfile();
      report = { status: 'info', headline: `Applied. Profile revision ${controller.profile.revision}.`, lines: [] };
      controller.host.toast('success', 'Policy table applied.');
      reload();
    });
    const reset = button('rpd-bands-reset', 'Reset to profile default', TIP.reset, () => {
      const keptMethod = controller.profile.resolutionMethod;
      delete controller.settings.profileOverrides[controller.profile.id];
      setResolutionMethod(controller.settings, controller.profile.id, keptMethod);
      pendingPresetActorPolicy = null;
      controller.host.saveSettings();
      controller.reloadProfile();
      report = { status: 'info', headline: 'Reset to the profile\'s built-in table.', lines: [] };
      reload();
    });
    const test = button('rpd-bands-test', 'Test table', TIP.test, () => {
      if (testing) return;
      testing = true;
      showReport(result);
      void controller.testTable(cloneTable(draft), method).then(r => { report = r; }, e => { report = { status: 'fail', headline: 'The test could not run.', lines: [String((e as Error)?.message ?? e)] }; }).finally(() => {
        testing = false;
        const box = document.getElementById('rpd-table-result');
        if (box) showReport(box);
      });
    });
    host.append(el('div', { class: 'rpd-row' }, [apply, reset, test, dirty]), result);
    if (controller.profileWarnings.length) host.append(el('div', { class: 'rpd-muted', text: controller.profileWarnings.join(' | ') }));
    if (localPresetWarnings.length) host.append(el('div', { class: 'rpd-muted', text: `Local preset warnings: ${localPresetWarnings.join(' | ')}` }));
    host.append(el('div', { class: 'rpd-muted', text: `Profile revision ${controller.profile.revision}. Connection for the test: ${controller.settings.connection.kind}${controller.settings.connection.model ? ' / ' + controller.settings.connection.model : ''}.` }));
    showReport(result);
    refreshDirty();
  }

  function refreshDirty(): void {
    const node = document.getElementById('rpd-table-dirty') ?? host.querySelector('#rpd-table-dirty');
    if (node) node.textContent = isDirty() ? 'Unsaved changes. "Test table" uses what you see; play uses the applied table.' : '';
  }

  reload();
  return { element: host, reload };
}
