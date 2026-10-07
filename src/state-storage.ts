/** Lossless storage-only sharing of repeated frozen prose. Runtime stays expanded. */
import type { DirectorChatRecord } from './types.ts';

interface SharedStorage {
  version: 1;
  strings: string[];
  shapes: string[][];
  actions: Record<string, string>;
}

const TEXT = '$t';
const OBJECT = '$o';
const VALUES = '$v';
const lines = (text: string): string[] => text.split(/(?<=\n)/);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** Match ordinary JSON omission before converting an object's fields to an array. */
const entries = (value: Record<string, unknown>): [string, unknown][] => Object.entries(value).filter(([, item]) => item !== undefined);

/**
 * Two linear walks share repeated strings, including repeated lines inside an
 * otherwise unique instruction. No compression library, asynchronous work, or
 * change to exact writer bytes is needed. Small chats retain the old layout.
 */
export function encodeRecordForStorage(record: DirectorChatRecord): unknown {
  if (Object.keys(record.attempts).length <= 20) return structuredClone(record);
  const input = structuredClone(record);
  const actions: Record<string, string> = {};
  for (const [id, resolution] of Object.entries(input.resolutions)) {
    const action = input.actions[resolution.actionId];
    if (action && JSON.stringify(action) === JSON.stringify(resolution.action)) {
      actions[resolution.actionId] = id;
      delete input.actions[resolution.actionId];
    }
  }
  const counts = new Map<string, number>();
  const shapeCounts = new Map<string, number>();
  const count = (text: string): void => { if (text.length >= 40) counts.set(text, (counts.get(text) ?? 0) + 1); };
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      count(value);
      const parts = lines(value);
      if (parts.length > 1) parts.forEach(count);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (object(value)) {
      const shape = JSON.stringify(entries(value).map(([key]) => key));
      if (shape.length >= 32) shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
      entries(value).forEach(([, item]) => visit(item));
    }
  };
  visit(input);
  const strings: string[] = [];
  const indexes = new Map<string, number>();
  const shapes: string[][] = [];
  const shapeIndexes = new Map<string, number>();
  const share = (text: string): number | string => {
    if ((counts.get(text) ?? 0) < 2) return text;
    let index = indexes.get(text);
    if (index === undefined) { index = strings.length; strings.push(text); indexes.set(text, index); }
    return index;
  };
  const encode = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const full = share(value);
      const parts = typeof full === 'number' ? [full] : lines(value).map(share);
      if (!parts.some(part => typeof part === 'number')) return value;
      return { [TEXT]: parts };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (!object(value)) return value;
    // A user-authored evidence object can use any key. Escape reserved shapes
    // so decoding never mistakes literal evidence for a storage reference.
    const fields = entries(value);
    if (Object.hasOwn(value, TEXT) || Object.hasOwn(value, OBJECT) || Object.hasOwn(value, VALUES)) return { [OBJECT]: fields.map(([key, item]) => [key, encode(item)]) };
    const keys = fields.map(([key]) => key);
    const shape = JSON.stringify(keys);
    if ((shapeCounts.get(shape) ?? 0) > 1) {
      let index = shapeIndexes.get(shape);
      if (index === undefined) { index = shapes.length; shapes.push(keys); shapeIndexes.set(shape, index); }
      return { [VALUES]: [index, ...fields.map(([, item]) => encode(item))] };
    }
    return Object.fromEntries(fields.map(([key, item]) => [key, encode(item)]));
  };
  const encoded = encode(input) as Record<string, unknown>;
  encoded.sharedStorage = { version: 1, strings, shapes, actions } satisfies SharedStorage;
  return encoded;
}

/** Decode before normalizing untrusted chat metadata. Plain old records pass through. */
export function decodeRecordStorage(raw: unknown): unknown {
  if (!object(raw)) return raw;
  const storage = raw.sharedStorage;
  if (!object(storage) || storage.version !== 1 || !Array.isArray(storage.strings) || !storage.strings.every(value => typeof value === 'string')) return raw;
  const strings = storage.strings as string[];
  const shapes = Array.isArray(storage.shapes) ? storage.shapes : [];
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (!object(value)) return value;
    if (Object.keys(value).length === 1 && [TEXT, OBJECT, VALUES].some(key => Object.hasOwn(value, key) && !Array.isArray(value[key]))) return undefined;
    if (Object.keys(value).length === 1 && Array.isArray(value[VALUES])) {
      const [index, ...items] = value[VALUES];
      const keys = Number.isInteger(index) ? shapes[index as number] : null;
      if (Array.isArray(keys) && keys.length === items.length && keys.every(key => typeof key === 'string')) {
        return Object.fromEntries(keys.map((key, position) => [key, decode(items[position])]).filter(([, item]) => item !== undefined));
      }
      return undefined;
    }
    if (Object.keys(value).length === 1 && Array.isArray(value[TEXT])) {
      const parts = value[TEXT];
      if (parts.every(part => typeof part === 'string' || Number.isInteger(part) && typeof strings[part as number] === 'string')) {
        return parts.map(part => typeof part === 'number' ? strings[part] : part).join('');
      }
      return undefined;
    }
    if (Object.keys(value).length === 1 && Array.isArray(value[OBJECT])) {
      const entries = value[OBJECT];
      if (entries.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string')) {
        return Object.fromEntries(entries.map(entry => [entry[0], decode(entry[1])]));
      }
      return undefined;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]).filter(([, item]) => item !== undefined));
  };
  const expanded = decode(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'sharedStorage')));
  if (!object(expanded)) return expanded;
  if (object(expanded.actions) && object(expanded.resolutions) && object(storage.actions)) {
    for (const [actionId, resolutionId] of Object.entries(storage.actions)) {
      const resolution = typeof resolutionId === 'string' ? expanded.resolutions[resolutionId] : null;
      if (object(resolution) && object(resolution.action) && !Object.hasOwn(expanded.actions, actionId)) {
        Object.defineProperty(expanded.actions, actionId, { value: structuredClone(resolution.action), enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return expanded;
}
