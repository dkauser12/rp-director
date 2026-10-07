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
  judge: 'The judge reads the picks, while the writer keeps the usual keyword matches.',
  assist: 'The judge and writer both read the picks alongside keyword matches.',
  managed: 'The writer reads the picks and always-on entries instead of keyword matches.',
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
  const nearEnd = el('input', { id: 'rpd-lore-near-end', type: 'checkbox' });
  nearEnd.checked = lore.placeNearEnd;
  nearEnd.addEventListener('change', () => { controller.settings.lore.placeNearEnd = nearEnd.checked; controller.host.saveSettings(); });
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
  const maxEntries = number('rpd-lore-max', () => controller.settings.lore.maxEntries, 1, 20, '1', 'Limit the entries picked across all books.', n => { controller.settings.lore.maxEntries = Math.round(n); });
  const width = number('rpd-lore-width', () => controller.settings.lore.width, 1, 6, '1', 'Limit the sections searched at each level of a book.', n => { controller.settings.lore.width = Math.round(n); });
  const judgeChars = number('rpd-lore-judge-chars', () => controller.settings.lore.judgeChars, 1000, 40000, '500', 'Limit how much lore the judge reads.', n => { controller.settings.lore.judgeChars = Math.round(n); });
  return el('div', { id: 'rpd-lore' }, [
    el('div', { class: 'rpd-note', text: 'Choose which books the judge and writer may read.' }),
    el('div', { class: 'rpd-note', text: 'Moves that uncover information read only books marked Public.' }),
    el('div', { class: 'rpd-row' }, [el('label', { text: 'Other books', title: 'Choose the mode for books without their own setting.' }), defaultMode]),
    el('label', { class: 'rpd-inline', title: 'Keep new picks near the reply so earlier prompt text stays unchanged.' }, [nearEnd, ' Place picks near the end']),
    el('div', { class: 'rpd-row' }, [
      el('label', { class: 'rpd-inline' }, ['Picks (entries/turn) ', maxEntries]),
      el('label', { class: 'rpd-inline' }, ['Search (sections/level) ', width]),
      el('label', { class: 'rpd-inline' }, ['Judge limit (characters) ', judgeChars]),
    ]),
    el('div', { id: 'rpd-lore-books' }, [el('div', { class: 'rpd-muted', text: 'Open a chat to list its lorebooks.' })]),
    el('div', { id: 'rpd-lore-status', class: 'rpd-note' }),
  ]);
}

// A reopened workspace owns new rows even if its settings have not changed.
const loreRefreshes = new WeakMap<HTMLElement, { signature: string; sequence: number }>();

export async function refreshLorePanel(controller: Controller, force = false): Promise<void> {
  const host = document.getElementById('rpd-lore-books');
  if (!host) return;
  const status = document.getElementById('rpd-lore-status');
  if (status) {
    status.textContent = !controller.loreHooked
      ? 'This SillyTavern version can share picks with the judge only.'
      : !controller.settings.modules.lore ? 'Turn on Lore in Settings to select entries.' : '';
  }
  const activation = controller.loreActivationForUi();
  const signature = JSON.stringify([controller.host.chatKey(), controller.settings.lore, controller.actorsForUi().map(a => a.actorId), activation?.at ?? null]);
  const refresh = loreRefreshes.get(host) ?? { signature: '', sequence: 0 };
  loreRefreshes.set(host, refresh);
  if (!force && signature === refresh.signature) return;
  refresh.signature = signature;
  const seq = ++refresh.sequence;
  const isCurrent = () => seq === refresh.sequence && document.getElementById('rpd-lore-books') === host;
  let books: Awaited<ReturnType<Controller['loreBooksForUi']>>;
  try { books = await controller.loreBooksForUi(); } catch (error) {
    if (isCurrent()) {
      refresh.signature = '';
      host.replaceChildren(el('div', { class: 'rpd-muted', text: 'Could not list lorebooks; reopen this tab to try again.' }));
    }
    return;
  }
  if (!isCurrent()) return;
  if (!books.length) { host.replaceChildren(el('div', { class: 'rpd-muted', text: 'This chat has no lorebooks.' })); return; }
  host.replaceChildren(...books.map((book, index) => {
    const mode = modeSelect(book.mode, value => controller.setLoreBook(book.world, { mode: value }), `rpd-lore-mode-${index}`);
    const pub = el('input', { id: `rpd-lore-public-${index}`, type: 'checkbox', title: 'Allow moves that uncover information to read this book only if it contains no private information.' });
    pub.checked = book.public;
    pub.addEventListener('change', () => controller.setLoreBook(book.world, { public: pub.checked }));
    const facts = [book.source, `${book.selectable} of ${book.entries} entries available`, book.index === 'tunnelvision' ? 'TunnelVision index' : 'Entry list'];
    if (book.tunnelVisionManages) facts.push('TunnelVision controls writer picks');
    const last = activation?.books[book.world];
    const cost = last ? `Last reply: ${last.entries} entr${last.entries === 1 ? 'y' : 'ies'} in the prompt, about ${Math.round(last.chars / 4).toLocaleString()} tokens${last.picked ? ` (${last.picked} picked by the Director)` : ''}.` : '';
    return el('div', { class: 'rpd-lore-book' }, [
      el('div', {}, [el('b', { text: book.world }), el('span', { class: 'rpd-muted', text: ` — ${facts.join(' · ')}` })]),
      ...(cost ? [el('div', { class: 'rpd-muted', text: cost })] : []),
      el('div', { class: 'rpd-row' }, [mode, el('label', { title: pub.title }, [pub, ' Public'])]),
    ]);
  }));
}
