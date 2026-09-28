/**
 * Lore trees: what the lore stage walks. One tree per lorebook, built from the
 * book's own entries and, when the user has built one, its TunnelVision index
 * (labels and summaries written for exactly this purpose).
 *
 * Every node is either internal (children only) or a leaf (entries only), so a
 * frontier question is always "which of these children", never a mix. A node
 * never offers more than `maxOptions` children: larger sets are split into
 * labelled groups, which adds a level instead of a 255-option question.
 */

export interface LoreEntry {
  world: string;
  uid: number;
  /** The entry's comment, or its keys when it has no comment. */
  title: string;
  keys: string[];
  content: string;
  constant: boolean;
  disabled: boolean;
}

export interface LoreNode {
  id: string;
  label: string;
  summary: string;
  /** Leaf only: entries this node stands for. */
  entryUids: number[];
  /** Internal only. */
  children: LoreNode[];
}

export interface LoreTree {
  world: string;
  source: 'tunnelvision' | 'derived';
  root: LoreNode;
  /** Every selectable entry of the book by uid. */
  entries: Map<number, LoreEntry>;
}

/** TunnelVision's stored node shape (extension_settings.tunnelvision.trees[book].root). */
export interface TunnelVisionNode {
  id?: unknown;
  label?: unknown;
  summary?: unknown;
  entryUids?: unknown;
  children?: unknown;
}

export interface TreeOptions {
  /** Children offered at one frontier (NONE comes on top). */
  maxOptions: number;
  /** A TunnelVision leaf holding more entries than this is split into one leaf per entry. */
  maxLeafEntries: number;
  /** Summary length for leaves derived from entry text. */
  excerptChars: number;
  /**
   * Books with at most this many pickable entries are offered flat, one option
   * per entry, even when an index exists: a hierarchy only pays when a book is
   * wider than one question, and section labels can hide where an entry lives.
   */
  flatLimit: number;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = { maxOptions: 40, maxLeafEntries: 3, excerptChars: 240, flatLimit: 40 };

/** Entries the lore stage may choose: enabled and not already always-on. */
export function selectable(entry: LoreEntry): boolean {
  return !entry.disabled && !entry.constant && entry.content.trim().length > 0;
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** TunnelVision appends "[Keywords: …]" to summaries; the judge reads the prose, not the key list. */
function cleanSummary(value: unknown): string {
  return String(value ?? '').replace(/\n?\[Keywords:[^\]]*\]\s*$/i, '').replace(/\s+/g, ' ').trim();
}

function entryLeaf(entry: LoreEntry, options: TreeOptions): LoreNode {
  return { id: `e${entry.uid}`, label: entry.title || `Entry ${entry.uid}`, summary: excerpt(entry.content, options.excerptChars), entryUids: [entry.uid], children: [] };
}

function uidList(value: unknown): number[] {
  return Array.isArray(value) ? value.map(Number).filter(n => Number.isInteger(n)) : [];
}

/**
 * Converts a TunnelVision node. Entries attached to an internal node become
 * leaves beside its children; a leaf with too many entries is split. Subtrees
 * with no selectable entry are dropped. `claimed` collects uids placed.
 */
function fromTunnelVision(raw: TunnelVisionNode, entries: Map<number, LoreEntry>, options: TreeOptions, claimed: Set<number>, path: string): LoreNode | null {
  const own = uidList(raw.entryUids).filter(uid => entries.has(uid) && !claimed.has(uid));
  const rawChildren = Array.isArray(raw.children) ? raw.children as TunnelVisionNode[] : [];
  const label = String(raw.label ?? '').trim() || 'Untitled section';
  const summary = cleanSummary(raw.summary);
  const id = `t${path}`;
  if (rawChildren.length === 0 && own.length <= options.maxLeafEntries) {
    if (own.length === 0) return null;
    own.forEach(uid => claimed.add(uid));
    return { id, label, summary, entryUids: own, children: [] };
  }
  const children: LoreNode[] = [];
  rawChildren.forEach((child, index) => {
    const node = fromTunnelVision(child, entries, options, claimed, `${path}.${index}`);
    if (node) children.push(node);
  });
  for (const uid of own) {
    if (claimed.has(uid)) continue;
    claimed.add(uid);
    children.push(entryLeaf(entries.get(uid)!, options));
  }
  if (children.length === 0) return null;
  if (children.length === 1 && path !== '') return { ...children[0]!, label: `${label}: ${children[0]!.label}` };
  return { id, label, summary, entryUids: [], children };
}

/** Splits any over-wide node into labelled groups, recursively. */
function bound(node: LoreNode, options: TreeOptions): LoreNode {
  if (node.children.length === 0) return node;
  let children = node.children.map(child => bound(child, options));
  const width = Math.max(2, options.maxOptions);
  while (children.length > width) {
    const size = Math.ceil(children.length / Math.ceil(children.length / width));
    const groups: LoreNode[] = [];
    for (let i = 0; i < children.length; i += size) {
      const members = children.slice(i, i + size);
      const titles = members.map(m => m.label);
      groups.push({
        id: `${node.id}.g${groups.length + 1}`,
        label: members.length > 1 ? `${titles[0]} … ${titles.at(-1)}` : titles[0]!,
        summary: excerpt(`Contains: ${titles.join('; ')}`, 400),
        entryUids: [],
        children: members,
      });
    }
    children = groups;
  }
  return { ...node, children };
}

export function buildTree(world: string, allEntries: LoreEntry[], tunnelVisionRoot: TunnelVisionNode | null, options: TreeOptions = DEFAULT_TREE_OPTIONS): LoreTree | null {
  const entries = new Map<number, LoreEntry>();
  for (const entry of allEntries) if (entry.world === world && selectable(entry)) entries.set(entry.uid, entry);
  if (entries.size === 0) return null;
  const claimed = new Set<number>();
  let root: LoreNode | null = null;
  let source: LoreTree['source'] = 'derived';
  if (tunnelVisionRoot && typeof tunnelVisionRoot === 'object' && entries.size > options.flatLimit) {
    root = fromTunnelVision(tunnelVisionRoot, entries, options, claimed, '');
    if (root) source = 'tunnelvision';
  }
  // Entries the index does not cover (added after it was built) stay reachable.
  const loose = [...entries.values()].filter(entry => !claimed.has(entry.uid)).map(entry => entryLeaf(entry, options));
  if (!root) root = { id: 'root', label: world, summary: '', entryUids: [], children: loose };
  else if (root.children.length === 0) root = { id: 'root', label: world, summary: '', entryUids: [], children: [root, ...loose] };
  else root = { ...root, id: 'root', children: [...root.children, ...loose] };
  return { world, source, root: bound(root, options), entries };
}

/** All entry uids under a node, in tree order. */
export function entriesUnder(node: LoreNode): number[] {
  if (node.children.length === 0) return node.entryUids.slice();
  return node.children.flatMap(entriesUnder);
}
