/** Tiny DOM helpers shared by the settings UI modules. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

export function button(id: string, label: string, title: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const b = el('button', { id, type: 'button', class: `menu_button interactable ${extraClass}`.trim(), title, text: label });
  b.addEventListener('click', onClick);
  return b;
}
