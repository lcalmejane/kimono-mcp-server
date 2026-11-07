import path from 'node:path';
import { integer } from './retrieval.js';
import { synchronizationPaths } from './synchronization.js';
import { readHead, type TypeResolver } from './structure-types.js';
import type { VisibleFile } from './knowledge.js';

/**
 * Compact tree of the files visible in a snapshot.
 *
 * Folders are keys ending in "/" (a chain of single-child folders is folded into one key, "a/b/");
 * a file is `[type, idx, size]`; a folder cut by `depth` is its file count. Paths are never repeated:
 * the path of an entry is the concatenation of the keys leading to it.
 */

export type FileRecord = [type: string, idx: 0 | 1, size: number | null];
export interface TreeNode { [key: string]: TreeNode | FileRecord | number }

export interface StructureSource {
  structure: readonly VisibleFile[];
  structureVersion: string;
  /** Directory holding the snapshot's indexed documents (overlay-merged). */
  corpusRoot: string;
  /** Shared ROOT, used for files that are visible but not indexed. */
  sourceRoot: string;
}

const DEFAULT_LIMIT = 5000;
const BATCH = 64;

interface Folder { children: Map<string, Folder | FileRecord>; count: number }

export async function buildStructure(source: StructureSource, input: Record<string, unknown>, resolver: TypeResolver): Promise<Record<string, unknown>> {
  const allowed = ['snapshotId', 'path', 'depth', 'type', 'idx', 'since', 'format', 'legend', 'limit'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown aikido_structure option: ${key}`);
  const version = source.structureVersion + (resolver.customRules ? `.${resolver.fingerprint}` : '');
  if (input.since !== undefined) {
    if (typeof input.since !== 'string') throw new Error('since must be a v value returned by aikido_structure');
    if (input.since === version) return { v: version, unchanged: true };
  }
  const scope = input.path === undefined ? undefined : scopeOf(input.path);
  const depth = input.depth === undefined ? undefined : integer(input, 'depth', 1, 1, 64);
  const limit = integer(input, 'limit', DEFAULT_LIMIT, 1, 50_000);
  const types = input.type === undefined ? undefined : typeFilter(input.type);
  const idx = input.idx === undefined ? undefined : flag(input.idx, 'idx');
  const legend = input.legend === undefined ? true : input.legend === true || input.legend === 1;
  const format = input.format ?? 'tree';
  if (format !== 'tree' && format !== 'text') throw new Error('format must be tree or text');

  const exactFile = scope !== undefined && source.structure.some(file => file.path === scope);
  const base = scope === undefined ? '' : exactFile ? path.posix.dirname(scope) === '.' ? '' : path.posix.dirname(scope) : scope;
  const selected = source.structure.filter(file => scope === undefined || file.path === scope || file.path.startsWith(`${scope}/`));

  const root: Folder = { children: new Map(), count: 0 };
  const used = new Set<string>();
  let total = 0;
  let indexed = 0;
  let truncated = false;
  for (let from = 0; from < selected.length && !truncated; from += BATCH) {
    const batch = selected.slice(from, from + BATCH);
    const resolved = await Promise.all(batch.map(file => resolver.resolve(file.path, () =>
      readHead(path.join(file.indexed ? source.corpusRoot : source.sourceRoot, file.path)))));
    for (let i = 0; i < batch.length; i++) {
      const file = batch[i];
      const type = resolved[i];
      if (types && !types.has(type)) continue;
      if (idx !== undefined && (file.indexed ? 1 : 0) !== idx) continue;
      if (total >= limit) { truncated = true; break; }
      total++;
      if (file.indexed) indexed++;
      used.add(type);
      insert(root, base ? file.path.slice(base.length + 1) : file.path, [type, file.indexed ? 1 : 0, file.size]);
    }
  }

  const result: Record<string, unknown> = { v: version };
  if (scope !== undefined) result.path = scope;
  result.n = total;
  result.idx = indexed;
  if (truncated) result.truncated = true;
  if (legend) {
    const table: Record<string, [string, string]> = {};
    for (const id of [...used].sort()) { const info = resolver.info(id); table[id] = [info.label, info.group]; }
    result.types = table;
  }
  const tree = convert(root, 1, depth);
  if (format === 'text') result.text = render(tree, 0).join('\n');
  else result.data = tree;
  return result;
}

function scopeOf(value: unknown): string {
  const scopes = synchronizationPaths(value);
  if (!scopes || scopes.length !== 1) throw new Error('path must be one ROOT-relative file or directory');
  return scopes[0];
}

function flag(value: unknown, name: string): 0 | 1 {
  if (value === 1 || value === true || value === '1') return 1;
  if (value === 0 || value === false || value === '0') return 0;
  throw new Error(`${name} must be 1 or 0`);
}

function typeFilter(value: unknown): Set<string> {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.length > 64 || !list.every(item => typeof item === 'string' && item)) {
    throw new Error('type must be a type id or an array of up to 64 type ids');
  }
  return new Set(list as string[]);
}

function insert(root: Folder, relative: string, record: FileRecord): void {
  const parts = relative.split('/');
  let folder = root;
  folder.count++;
  for (const part of parts.slice(0, -1)) {
    let child = folder.children.get(part);
    if (!child || Array.isArray(child)) { child = { children: new Map(), count: 0 }; folder.children.set(part, child); }
    folder = child;
    folder.count++;
  }
  folder.children.set(parts.at(-1)!, record);
}

function convert(folder: Folder, level: number, depth: number | undefined): TreeNode {
  const node: TreeNode = {};
  for (const [name, child] of folder.children) {
    if (Array.isArray(child)) { node[name] = child; continue; }
    let key = name;
    let current = child;
    while (current.children.size === 1) {
      const [[next, only]] = [...current.children];
      if (Array.isArray(only)) break;
      key += `/${next}`;
      current = only;
    }
    node[`${key}/`] = depth !== undefined && level >= depth ? current.count : convert(current, level + 1, depth);
  }
  return node;
}

function render(node: TreeNode, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) lines.push(`${pad}${key} ${value[0]} ${value[1]}${value[2] === null ? '' : ` ${value[2]}`}`);
    else if (typeof value === 'number') lines.push(`${pad}${key} (${value})`);
    else { lines.push(`${pad}${key}`); lines.push(...render(value, indent + 1)); }
  }
  return lines;
}
