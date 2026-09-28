/**
 * Settings panel for lore selection: one row per lorebook the open chat can
 * draw on, with its mode and visibility, plus the beam limits. Rows are
 * rebuilt when the chat or the lore settings change.
 */
import type { Controller } from './controller.ts';
import type { LoreBookMode } from './types.ts';
import { el } from './dom.ts';

const MODE_LABELS: Record<LoreBookMode, string> = {
  off: 'Off',
  judge: 'Rulings only',
  assist: 'Rulings + writer',
  managed: 'Director decides',
};

const MODE_TIPS: Record<LoreBookMode, string> = {
  off: 'The Director ignores this book.',
  judge: 'Rulings may read the entries the Director picks. The writer keeps SillyTavern\'s keyword activation only.',
  assist: 'As Rulings only, and the picked entries are also activated for the writer, beside the keyword matches.',
  managed: 'Keyword activation of this book is switched off; the writer gets exactly the entries the Director picks (constant entries stay on).',
};

function modeSelect(value: LoreBookMode, onChange: (mode: LoreBookMode) => void, id: string): HTMLSelectElement {
  const select = el('select', { id, class: 'text_pole', title: MODE_TIPS[value] });
  for (const mode of Object.keys(MODE_LABELS) as LoreBookMode[]) select.append(el('option', { value: mode, text: MODE_LABELS[mode], title: MODE_TIPS[mode] }));
  select.value = value;
  select.addEventListener('change', () => { select.title = MODE_TIPS[select.value as LoreBookMode]; onChange(select.value as LoreBookMode); });
  return select;
}

export function buildLorePanel(controller: Controller): HTMLElement {
  const lore = controller.settings.lore;
  const defaultMode = modeSelect(lore.defaultMode, mode => { controller.settings.lore.defaultMode = mode; controller.host.saveSettings(); void refreshLorePanel(controller, true); }, 'rpd-lore-default');
  const number = (id: string, current: () => number, min: number, max: number, step: string, tip: string, save: (n: number) => void) => {
    const input = el('input', { id, type: 'number', class: 'text_pole', min: String(min), max: String(max), step, value: String(current()), title: tip, style: 'width: 5em;' });
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (!Number.isFinite(n) || n < min || n > max) { input.value = String(current()); return; }
      save(n);
      controller.host.saveSettings();
    });
    return input;
  };
  const maxEntries = number('rpd-lore-max', () => controller.settings.lore.maxEntries, 1, 20, '1', 'Most entries picked per turn, across all books.', n => { controller.settings.lore.maxEntries = Math.round(n); });
  const width = number('rpd-lore-width', () => controller.settings.lore.width, 1, 6, '1', 'Most sections kept at each level of a book.', n => { controller.settings.lore.width = Math.round(n); });
  const judgeChars = number('rpd-lore-judge-chars', () => controller.settings.lore.judgeChars, 1000, 40000, '500', 'Characters of lore a ruling may read.', n => { controller.settings.lore.judgeChars = Math.round(n); });
  return el('div', { id: 'rpd-lore' }, [
    el('div', { class: 'rpd-note', text: 'Each turn the judge walks the lorebooks of the chat\'s cast (using TunnelVision\'s index where you built one) and picks the entries the scene depends on. Rulings read the picks; depending on the mode, the writer gets them too. Swipes and continues reuse the turn\'s picks. Discovery rulings (search, read someone) only ever see books marked public.' }),
    el('div', { class: 'rpd-row' }, [el('label', { text: 'Other books', title: 'Mode for books without their own setting' }), defaultMode]),
    el('div', { class: 'rpd-row' }, [
      el('label', { class: 'rpd-inline' }, ['Entries per turn ', maxEntries]),
      el('label', { class: 'rpd-inline' }, ['Width ', width]),
      el('label', { class: 'rpd-inline' }, ['Ruling characters ', judgeChars]),
    ]),
    el('div', { id: 'rpd-lore-books' }, [el('div', { class: 'rpd-muted', text: 'Open a chat to list its lorebooks.' })]),
    el('div', { id: 'rpd-lore-status', class: 'rpd-note' }),
  ]);
}

let loreSignature = '';
let loreSeq = 0;

export async function refreshLorePanel(controller: Controller, force = false): Promise<void> {
  const host = document.getElementById('rpd-lore-books');
  if (!host) return;
  const status = document.getElementById('rpd-lore-status');
  if (status) {
    status.textContent = !controller.loreHooked
      ? 'This SillyTavern version lacks the World Info hooks, so picks reach rulings only.'
      : !controller.settings.modules.lore ? 'Lore selection is off (Modules).' : '';
  }
  const activation = controller.loreActivationForUi();
  const signature = JSON.stringify([controller.host.chatKey(), controller.settings.lore, controller.actorsForUi().map(a => a.actorId), activation?.at ?? null]);
  if (!force && signature === loreSignature) return;
  loreSignature = signature;
  const seq = ++loreSeq;
  let books: Awaited<ReturnType<Controller['loreBooksForUi']>>;
  try { books = await controller.loreBooksForUi(); } catch (error) {
    if (seq === loreSeq) host.replaceChildren(el('div', { class: 'rpd-muted', text: `Could not list lorebooks: ${(error as Error).message}` }));
    return;
  }
  if (seq !== loreSeq) return;
  if (!books.length) { host.replaceChildren(el('div', { class: 'rpd-muted', text: 'This chat has no lorebooks.' })); return; }
  host.replaceChildren(...books.map((book, index) => {
    const mode = modeSelect(book.mode, value => controller.setLoreBook(book.world, { mode: value }), `rpd-lore-mode-${index}`);
    const pub = el('input', { id: `rpd-lore-public-${index}`, type: 'checkbox', title: 'Public: discovery rulings may read this book. Leave off for books that hold secrets, private thoughts or authorial truth.' });
    pub.checked = book.public;
    pub.addEventListener('change', () => controller.setLoreBook(book.world, { public: pub.checked }));
    const facts = [book.source, `${book.selectable} of ${book.entries} entries pickable`, book.index === 'tunnelvision' ? 'TunnelVision index' : 'no index (entries listed directly)'];
    if (book.tunnelVisionManages) facts.push('TunnelVision is managing it, so rulings only');
    const last = activation?.books[book.world];
    const cost = last ? `Last reply: ${last.entries} entr${last.entries === 1 ? 'y' : 'ies'} in the prompt, about ${Math.round(last.chars / 4).toLocaleString()} tokens${last.picked ? ` (${last.picked} picked by the Director)` : ''}.` : '';
    return el('div', { class: 'rpd-lore-book' }, [
      el('div', {}, [el('b', { text: book.world }), el('span', { class: 'rpd-muted', text: ` — ${facts.join(' · ')}` })]),
      ...(cost ? [el('div', { class: 'rpd-muted', text: cost })] : []),
      el('div', { class: 'rpd-row' }, [mode, el('label', { title: pub.title }, [pub, ' Public'])]),
    ]);
  }));
}
