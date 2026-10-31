import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { isKnowledgeFile } from './knowledge.js';
import {
  MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, comparePath, isMissing, isRecord, sha256, validatePath, writeAtomic,
} from './collab-util.js';

/**
 * Persistent per-user delta ("overlay") on top of the shared knowledge ROOT.
 *
 * A user working on a replica (a workspace that is not the server ROOT) stages added, modified or deleted knowledge
 * files here. They stay until the global repository contains them, are visible to that user's snapshots, and can be
 * published into the shared ROOT at any time (no Git involved).
 */
export type OverlayStatus = 'pending' | 'integrated' | 'conflict';

export interface OverlayEntry {
  op: 'put' | 'delete';
  /** SHA-256 of the staged content; null for a deletion. */
  hash: string | null;
  /** Hash of the global file when this change was staged (null if absent); anchors conflict detection. */
  baseHash: string | null;
  bytes: number;
  stagedAt: string;
}

export interface OverlayChange {
  path: string;
  /** UTF-8 text, or null to delete the file. */
  content: string | null;
}

export interface OverlayItem {
  path: string;
  op: 'put' | 'delete';
  status: OverlayStatus;
  hash: string | null;
  baseHash: string | null;
  sharedHash: string | null;
  stagedAt: string;
  warnings: string[];
}

type Manifest = Record<string, string>;

const OWNER = /^[A-Za-z0-9_.-]{1,64}$/;
const chains = new Map<string, Promise<unknown>>();

export function validateOwner(value: unknown): string {
  if (typeof value !== 'string' || !OWNER.test(value) || /^\.+$/.test(value)) {
    throw new Error('owner must be 1-64 characters from A-Z a-z 0-9 _ . -');
  }
  return value;
}

export function validateOverlayContent(file: string, content: unknown): string {
  if (typeof content !== 'string') throw new Error(`Content for ${file} must be a UTF-8 string or null`);
  if (content.includes('\0')) throw new Error(`Content for ${file} is binary (contains NUL)`);
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error(`Content for ${file} exceeds ${MAX_FILE_BYTES} bytes`);
  return content;
}

/** Non-blocking quality hints for a Markdown file, resolved against the merged (global + overlay) view. */
export function markdownWarnings(file: string, content: string, exists: (candidate: string) => boolean): string[] {
  if (!file.endsWith('.md')) return [];
  const warnings: string[] = [];
  const directory = path.posix.dirname(file);
  const seen = new Set<string>();
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = match[1].split('#')[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.endsWith('/')) continue;
    let target: string;
    try { target = decodeURI(raw); } catch { continue; }
    const resolved = path.posix.normalize(path.posix.join(directory, target));
    if (resolved === '..' || resolved.startsWith('../')) { warnings.push(`link leaves the knowledge root: ${raw}`); continue; }
    if (!isKnowledgeFile(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    if (!exists(resolved)) warnings.push(`broken relative link: ${raw}`);
  }
  if (file.startsWith('prompts/') && !/\*\*Version\*\*/.test(content.split('\n', 20).join('\n'))) {
    warnings.push('missing AI-KIDO header (> **Version**: ...)');
  }
  return warnings;
}

export class UserOverlay {
  private readonly directory: string;
  private readonly blobs: string;

  constructor(cacheDirectory: string, readonly owner: string) {
    validateOwner(owner);
    this.directory = path.join(cacheDirectory, 'collaboration', 'overlays', owner);
    this.blobs = path.join(this.directory, 'blobs');
  }

  static async owners(cacheDirectory: string): Promise<string[]> {
    try {
      return (await readdir(path.join(cacheDirectory, 'collaboration', 'overlays'), { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && OWNER.test(entry.name)).map(entry => entry.name).sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async entries(): Promise<Record<string, OverlayEntry>> {
    return this.serial(() => this.read());
  }

  /** Stage changes, re-anchoring each on the current global manifest. Changes identical to the global are dropped. */
  async stage(changes: OverlayChange[], shared: Manifest): Promise<{ staged: string[]; unchanged: string[] }> {
    if (!Array.isArray(changes) || !changes.length || changes.length > MAX_FILES) {
      throw new Error(`changes must contain 1-${MAX_FILES} entries`);
    }
    const prepared = new Map<string, { content: string | null }>();
    for (const change of changes) {
      if (!isRecord(change) || Object.keys(change).some(key => !['path', 'content'].includes(key))) {
        throw new Error('Each change must contain only path and content');
      }
      const file = validatePath(change.path);
      if (prepared.has(file)) throw new Error(`Duplicate change path: ${file}`);
      prepared.set(file, { content: change.content === null ? null : validateOverlayContent(file, change.content) });
    }
    return this.serial(async () => {
      const next = { ...await this.read() };
      const staged: string[] = [];
      const unchanged: string[] = [];
      const blobs = new Map<string, string>();
      for (const [file, { content }] of [...prepared].sort(([a], [b]) => comparePath(a, b))) {
        const baseHash = shared[file] ?? null;
        const hash = content === null ? null : sha256(content);
        if (hash === baseHash) { delete next[file]; unchanged.push(file); continue; }
        next[file] = { op: content === null ? 'delete' : 'put', hash, baseHash,
          bytes: content === null ? 0 : Buffer.byteLength(content), stagedAt: new Date().toISOString() };
        if (content !== null) blobs.set(hash!, content);
        staged.push(file);
      }
      if (Object.keys(next).length > MAX_FILES) throw new Error(`Overlay is limited to ${MAX_FILES} files`);
      if (Object.values(next).reduce((total, entry) => total + entry.bytes, 0) > MAX_TOTAL_BYTES) {
        throw new Error(`Overlay is limited to ${MAX_TOTAL_BYTES} bytes`);
      }
      for (const [hash, content] of blobs) await writeAtomic(path.join(this.blobs, hash), Buffer.from(content, 'utf8'));
      await this.write(next);
      return { staged, unchanged };
    });
  }

  /** Staged content: a string for a put, null for a delete, undefined when the path is not in the overlay. */
  async content(file: string): Promise<string | null | undefined> {
    const entry = (await this.entries())[file];
    if (!entry) return undefined;
    return entry.op === 'delete' ? null : this.readBlob(entry.hash!);
  }

  async items(shared: Manifest, exists?: (candidate: string) => boolean): Promise<OverlayItem[]> {
    const entries = await this.entries();
    const visible = exists ?? ((candidate: string) => {
      const entry = entries[candidate];
      return entry ? entry.op === 'put' : shared[candidate] !== undefined;
    });
    const items: OverlayItem[] = [];
    for (const file of Object.keys(entries).sort(comparePath)) {
      const entry = entries[file];
      const sharedHash = shared[file] ?? null;
      const status: OverlayStatus = sharedHash === entry.hash ? 'integrated'
        : sharedHash !== entry.baseHash ? 'conflict' : 'pending';
      const warnings = entry.op === 'put' && status !== 'integrated'
        ? markdownWarnings(file, await this.readBlob(entry.hash!), visible) : [];
      items.push({ path: file, op: entry.op, status, hash: entry.hash, baseHash: entry.baseHash, sharedHash, stagedAt: entry.stagedAt, warnings });
    }
    return items;
  }

  /** Remove entries (integrated, discarded) and garbage-collect unreferenced blobs. Returns the removed paths. */
  async remove(paths: string[]): Promise<string[]> {
    return this.serial(async () => {
      const entries = { ...await this.read() };
      const removed = paths.filter(file => Object.hasOwn(entries, file));
      for (const file of removed) delete entries[file];
      if (removed.length) await this.write(entries);
      return removed;
    });
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = chains.get(this.directory) ?? Promise.resolve();
    const result = previous.then(action, action);
    const tail = result.then(() => undefined, () => undefined);
    chains.set(this.directory, tail);
    try { return await result; }
    finally { if (chains.get(this.directory) === tail) chains.delete(this.directory); }
  }

  private async read(): Promise<Record<string, OverlayEntry>> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path.join(this.directory, 'overlay.json'), 'utf8')); }
    catch (error) {
      if (isMissing(error)) return {};
      throw error;
    }
    if (!isRecord(parsed) || parsed.owner !== this.owner || !isRecord(parsed.entries)) throw new Error('Invalid stored overlay');
    const hashOrNull = (value: unknown) => {
      if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid stored overlay hash');
      return value as string | null;
    };
    const entries: Record<string, OverlayEntry> = {};
    for (const [rawPath, value] of Object.entries(parsed.entries)) {
      const file = validatePath(rawPath);
      if (!isRecord(value) || (value.op !== 'put' && value.op !== 'delete') || typeof value.bytes !== 'number'
        || typeof value.stagedAt !== 'string') throw new Error(`Invalid stored overlay entry: ${file}`);
      const hash = hashOrNull(value.hash);
      if ((value.op === 'put') !== (hash !== null)) throw new Error(`Invalid stored overlay entry: ${file}`);
      entries[file] = { op: value.op, hash, baseHash: hashOrNull(value.baseHash), bytes: value.bytes, stagedAt: value.stagedAt };
    }
    return entries;
  }

  private async write(entries: Record<string, OverlayEntry>): Promise<void> {
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => comparePath(a, b)));
    await writeAtomic(path.join(this.directory, 'overlay.json'), Buffer.from(JSON.stringify({ owner: this.owner, entries: sorted })));
    const referenced = new Set(Object.values(sorted).flatMap(entry => entry.hash ? [entry.hash] : []));
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.blobs)) {
      if (!referenced.has(name) && /^[a-f0-9]{64}$/.test(name)) await rm(path.join(this.blobs, name), { force: true });
    }
  }

  private async readBlob(hash: string): Promise<string> {
    const content = await readFile(path.join(this.blobs, hash));
    if (sha256(content) !== hash) throw new Error(`Stored overlay content failed integrity check: ${hash}`);
    return content.toString('utf8');
  }
}
