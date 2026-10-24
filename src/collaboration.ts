import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AikidoKnowledgeBase } from './knowledge.js';
import { isKnowledgeFile, isSensitiveKnowledgePath } from './knowledge.js';
import { synchronizeKnowledgeRoot } from './remote-sync.js';

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_SIZE = 100;
const MAX_PUBLISH_REQUEST_BYTES = 512 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.ssh', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__',
  '.next', '.nuxt', '.cache', '.nyc_output', 'temp', 'credentials', 'secrets',
]);

type Manifest = Record<string, string>;
interface Revision {
  version: string;
  manifest: Manifest;
}
interface Change {
  path: string;
  content: string | null;
}
type ChangeKind = 'addition' | 'modification' | 'deletion' | 'conflict';
interface ComparedChange {
  path: string;
  kind: ChangeKind;
  baseHash: string | null;
  localHash: string | null;
  sharedHash: string | null;
}
interface Comparison {
  localChanges: ComparedChange[];
  sharedChanges: ComparedChange[];
  conflicts: ComparedChange[];
}
interface RootConflict {
  path: string;
  baseHash: string | null;
  rootHash: string | null;
  sharedHash: string | null;
}
interface RefreshResult {
  local: Awaited<ReturnType<KnowledgeCollaboration['localManifest']>>;
  shared: Revision;
  rootConflicts: RootConflict[];
}

export class KnowledgeCollaboration {
  private readonly directory: string;
  private readonly blobs: string;

  constructor(private readonly knowledge: AikidoKnowledgeBase) {
    this.directory = path.join(knowledge.searchIndex.directory, 'collaboration');
    this.blobs = path.join(this.directory, 'blobs');
  }

  async call(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const operation = input.operation;
    if (operation === 'guidance') {
      rejectUnknown(input, ['operation']);
      return {
        workflow: [
          'Call status before editing to capture the shared base revision.',
          'Compare a local manifest with the base and current shared revision; read shared file contents before pulling.',
          'Write pulled content using the client’s own file tools, then publish explicitly; publication materializes the accepted merged revision in this configured shared ROOT.',
          'Shared knowledge publication and Git publication are separate; no Git operation is performed here.',
          'Never resolve conflicts by last-write-wins. Refresh status and compare after a stale revision response.',
          'If the client edits the exact configured local ROOT (verified embedded stdio only), do not reconcile or publish a replica: call aikido_index update after edits. Never infer same-directory access for HTTP or another remote MCP endpoint.',
          'Collaboration revisions never mutate ROOT or an existing research snapshot. After shared-directory edits, update indexes and begin a new aikido_snapshot to see the changes; an existing snapshot remains pinned.',
        ],
        modes: {
          sharedDirectory: 'Embedded stdio with verified access to this exact ROOT: edit files with client tools, then call aikido_index update. No pull/publish or replica conflict workflow.',
          personalReplica: 'Any remote endpoint or separate workspace: use status, compare, read and explicit publish. Maintain baseVersion in the client.',
        },
        model: 'base, local and shared are distinct versions; publish uses an optimistic shared-version guard and explicit conflict resolutions, then synchronizes the merged documents into the configured shared ROOT.',
        limits: { files: MAX_FILES, perFileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES, pageSize: MAX_PAGE_SIZE },
      };
    }
    if (operation === 'status') {
      rejectUnknown(input, ['operation', 'sharedVersion']);
      const { local, shared, rootConflicts } = await this.refreshCurrentRevision();
      const requestedVersion = input.sharedVersion === undefined ? shared.version : string(input.sharedVersion, 'sharedVersion');
      const requestedRevision = requestedVersion === shared.version ? shared : await this.readRevision(requestedVersion);
      return {
        localVersion: manifestVersion(local.manifest),
        localManifest: local.manifest,
        sharedVersion: shared.version,
        sharedManifest: shared.manifest,
        requestedRevision: { version: requestedRevision.version, manifest: requestedRevision.manifest },
        revisionIsCurrent: requestedRevision.version === shared.version,
        rootConflicts,
        limits: { files: MAX_FILES, perFileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES, pageSize: MAX_PAGE_SIZE },
      };
    }
    if (operation === 'compare') {
      rejectUnknown(input, ['operation', 'localManifest', 'baseVersion', 'offset', 'limit']);
      const snapshot = await this.refreshCurrentRevision();
      const local = input.localManifest === undefined ? snapshot.local.manifest : validateManifest(input.localManifest);
      const shared = snapshot.shared;
      const base = input.baseVersion === undefined ? undefined : await this.readRevision(string(input.baseVersion, 'baseVersion'));
      const offset = integer(input.offset, 'offset', 0, 0, MAX_FILES * 3);
      const limit = integer(input.limit, 'limit', MAX_PAGE_SIZE, 1, MAX_PAGE_SIZE);
      const comparison = compareManifests(local, shared.manifest, base?.manifest);
      const records = comparisonRecords(comparison);
      const page = records.slice(offset, offset + limit);
      const manifestEntries = Object.entries(shared.manifest).sort(([a], [b]) => comparePath(a, b));
      const manifestPage = Object.fromEntries(manifestEntries.slice(offset, offset + limit));
      return {
        sharedVersion: shared.version,
        baseVersion: base?.version ?? null,
        rootConflicts: snapshot.rootConflicts,
        manifestPage,
        manifestCount: manifestEntries.length,
        changes: page.map(record => ({
          path: record.path,
          status: record.conflict ? 'conflict' : record.localChange && !record.sharedChange ? 'local' : 'shared',
          ...(record.conflict ?? record.sharedChange ?? record.localChange),
        })),
        additions: page.flatMap(record => record.sharedChange?.kind === 'addition' ? [record.sharedChange] : []),
        modifications: page.flatMap(record => record.sharedChange?.kind === 'modification' ? [record.sharedChange] : []),
        deletions: page.flatMap(record => record.sharedChange?.kind === 'deletion' ? [record.sharedChange] : []),
        localChanges: page.flatMap(record => record.localChange ? [record.localChange] : []),
        conflicts: page.flatMap(record => record.conflict ? [record.conflict] : []),
        changeCount: records.length,
        nextOffset: offset + limit < Math.max(records.length, manifestEntries.length) ? offset + limit : null,
      };
    }
    if (operation === 'read') {
      rejectUnknown(input, ['operation', 'sharedVersion', 'paths']);
      const version = string(input.sharedVersion, 'sharedVersion');
      const revision = await this.readRevision(version);
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_PAGE_SIZE
        || !input.paths.every((value): value is string => typeof value === 'string')) {
        throw new Error(`paths must contain 1-${MAX_PAGE_SIZE} relative knowledge paths`);
      }
      const files: Record<string, string | null> = {};
      for (const raw of input.paths) {
        const file = validatePath(raw);
        const hash = revision.manifest[file];
        files[file] = hash === undefined ? null : await this.readBlob(hash);
      }
      return { sharedVersion: revision.version, files };
    }
    if (operation === 'publish') {
      rejectUnknown(input, ['operation', 'expectedSharedVersion', 'baseVersion', 'localManifest', 'changes', 'resolutions']);
      return this.publish(input);
    }
    throw new Error('operation must be guidance, status, compare, read or publish');
  }

  private async localManifest(): Promise<{ manifest: Manifest; contents: Map<string, string>; totalBytes: number }> {
    await this.knowledge.refresh();
    const manifest: Manifest = {};
    const contents = new Map<string, string>();
    let totalBytes = 0;
    const entries = this.knowledge.list().sort((a, b) => comparePath(a.path, b.path));
    if (entries.length > MAX_FILES) throw new Error(`Collaboration is limited to ${MAX_FILES} files; larger knowledge remains available for research and read-only use`);
    for (const entry of entries) {
      const file = validatePath(entry.path);
      const { content } = await this.knowledge.read(file);
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FILE_BYTES) throw new Error(`Collaboration cannot sync ${file}: file exceeds ${MAX_FILE_BYTES} bytes; it remains available for research and read-only use`);
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Collaboration is limited to ${MAX_TOTAL_BYTES} total bytes; larger knowledge remains available for research and read-only use`);
      manifest[file] = sha256(content);
      contents.set(file, content);
    }
    return { manifest, contents, totalBytes };
  }

  private async refreshCurrentRevision(): Promise<RefreshResult> {
    return this.withLock(() => this.refreshCurrentRevisionLocked());
  }

  private async refreshCurrentRevisionLocked(): Promise<RefreshResult> {
    const [local, previous] = await Promise.all([this.localManifest(), this.readCurrentPointer()]);
    const rootBaseline = await this.readRootBaseline(previous?.manifest);
    const rootConflicts = await this.readRootConflicts();
    if (manifestVersion(rootBaseline) === manifestVersion(local.manifest)) {
      if (previous) {
        await this.writeRootBaseline(rootBaseline);
        return { local, shared: previous, rootConflicts };
      }
      for (const [file, content] of local.contents) await this.writeBlob(local.manifest[file], content);
      const revision: Revision = { version: manifestVersion(local.manifest), manifest: sortedManifest(local.manifest) };
      await this.saveRevision(revision);
      await this.writePointer(revision.version);
      await this.writeRootBaseline(local.manifest);
      return { local, shared: revision, rootConflicts };
    }

    const merged: Manifest = { ...(previous?.manifest ?? rootBaseline) };
    const conflictsByPath = new Map(rootConflicts.map(conflict => [conflict.path, conflict]));
    const changedPaths = changedManifestPaths(rootBaseline, local.manifest);
    for (const file of changedPaths) {
      const baseHash = rootBaseline[file] ?? null;
      const rootHash = local.manifest[file] ?? null;
      const sharedHash = (previous?.manifest ?? rootBaseline)[file] ?? null;
      if (sharedHash !== baseHash && sharedHash !== rootHash) {
        conflictsByPath.set(file, { path: file, baseHash, rootHash, sharedHash });
      } else {
        conflictsByPath.delete(file);
      }
      if (rootHash === null) delete merged[file];
      else merged[file] = rootHash;
      const content = local.contents.get(file);
      if (content !== undefined) await this.writeBlob(rootHash!, content);
    }
    const sortedMerged = sortedManifest(merged);
    await this.validateRevisionSize(sortedMerged, new Map());
    let shared = previous;
    if (!previous || previous.version !== manifestVersion(sortedMerged)) {
      shared = { version: manifestVersion(sortedMerged), manifest: sortedMerged };
      await this.saveRevision(shared);
      await this.writePointer(shared.version);
    }
    await this.writeRootBaseline(local.manifest);
    await this.writeRootConflicts([...conflictsByPath.values()]);
    return { local, shared: shared!, rootConflicts: [...conflictsByPath.values()] };
  }

  private async readRootBaseline(fallback?: Manifest): Promise<Manifest> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.directory, 'root-baseline.json'), 'utf8'));
      return validateManifest(parsed);
    } catch (error) {
      if (isMissing(error)) return fallback ? sortedManifest(fallback) : {};
      throw error;
    }
  }

  private async writeRootBaseline(manifest: Manifest): Promise<void> {
    await writeAtomic(path.join(this.directory, 'root-baseline.json'), Buffer.from(JSON.stringify(sortedManifest(manifest))));
  }

  private async readRootConflicts(): Promise<RootConflict[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.directory, 'root-conflicts.json'), 'utf8'));
      if (!Array.isArray(parsed) || parsed.length > MAX_FILES) throw new Error('Invalid stored ROOT collaboration conflicts');
      return parsed.map(value => {
        if (!isRecord(value)) throw new Error('Invalid stored ROOT collaboration conflict');
        const file = validatePath(value.path);
        const hash = (candidate: unknown): string | null => {
          if (candidate !== null && (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate))) {
            throw new Error(`Invalid stored ROOT conflict hash for ${file}`);
          }
          return candidate;
        };
        return {
          path: file,
          baseHash: hash(value.baseHash),
          rootHash: hash(value.rootHash),
          sharedHash: hash(value.sharedHash),
        };
      });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async writeRootConflicts(conflicts: RootConflict[]): Promise<void> {
    await writeAtomic(path.join(this.directory, 'root-conflicts.json'), Buffer.from(JSON.stringify(conflicts)));
  }

  private async publish(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_PUBLISH_REQUEST_BYTES) {
      throw new Error(`publish request exceeds ${MAX_PUBLISH_REQUEST_BYTES} bytes`);
    }
    const expected = string(input.expectedSharedVersion, 'expectedSharedVersion');
    const local = validateManifest(input.localManifest);
    const changes = validateChanges(input.changes, local);
    const resolutions = validateResolutions(input.resolutions);
    const base = input.baseVersion === undefined ? undefined : await this.readRevision(string(input.baseVersion, 'baseVersion'));

    return this.withLock(async () => {
      const { local: refreshedLocal, shared, rootConflicts: refreshedRootConflicts } = await this.refreshCurrentRevisionLocked();
      if (shared.version !== expected) throw new Error(`Shared knowledge changed: expected ${expected}, current ${shared.version}; refresh status and compare before publishing`);

      const changedPaths = base
        ? changedManifestPaths(base.manifest, local)
        : changes.map(change => change.path);
      const contentByPath = new Map(changes.map(change => [change.path, change.content]));
      const changedSet = new Set(changedPaths);
      const unrepresented = changedPaths.filter(file => !contentByPath.has(file));
      const unexpected = changes.map(change => change.path).filter(file => !changedSet.has(file));
      if (unrepresented.length) throw new Error(`publish is missing content for local changes: ${unrepresented.slice(0, 10).join(', ')}`);
      if (base && unexpected.length) throw new Error(`publish contains paths that are unchanged from baseVersion: ${unexpected.slice(0, 10).join(', ')}`);

      const resultManifest: Manifest = { ...shared.manifest };
      const conflicts: ComparedChange[] = [];
      const conflictPaths = new Set<string>();
      const blobsToWrite = new Map<string, string>();
      for (const file of changedPaths) {
        const baseHash = base?.manifest[file] ?? null;
        const localHash = local[file] ?? null;
        const sharedHash = shared.manifest[file] ?? null;
        const localChanged = !base ? true : localHash !== baseHash;
        const sharedChanged = !base
          ? sharedHash !== null && sharedHash !== localHash
          : sharedHash !== baseHash;
        const divergent = localChanged && sharedChanged && localHash !== sharedHash;
        if (divergent) {
          conflictPaths.add(file);
          const choice = resolutions[file];
          if (!choice) {
            conflicts.push({ path: file, kind: 'conflict', baseHash, localHash, sharedHash });
            continue;
          }
          if (choice === 'shared') continue;
        }
        const content = contentByPath.get(file)!;
        if (content === null) delete resultManifest[file];
        else {
          const hash = sha256(content);
          blobsToWrite.set(hash, content);
          resultManifest[file] = hash;
        }
      }
      const unexpectedResolution = Object.keys(resolutions).find(file => !conflictPaths.has(file));
      if (unexpectedResolution) throw new Error(`Resolution does not apply to a conflict: ${unexpectedResolution}`);
      if (conflicts.length) return {
        sharedVersion: shared.version,
        manifest: shared.manifest,
        conflicts,
        published: false,
        message: 'Resolve each conflict explicitly as local or shared, then retry against the current sharedVersion.',
      };
      await this.validateRevisionSize(resultManifest, blobsToWrite);
      for (const [hash, content] of blobsToWrite) await this.writeBlob(hash, content);
      const revision = { version: manifestVersion(resultManifest), manifest: sortedManifest(resultManifest) };
      const desired = new Map<string, string>();
      for (const [file, hash] of Object.entries(revision.manifest)) desired.set(file, await this.readBlob(hash));
      const rootPublication = await synchronizeKnowledgeRoot(this.knowledge, desired, refreshedLocal.manifest);
      try {
        await this.saveRevision(revision);
        await this.writeRootBaseline(revision.manifest);
        await this.writeRootConflicts([]);
        await this.writePointer(revision.version);
        await rootPublication.finalize();
      } catch (error) {
        await rootPublication.rollback();
        await this.writeRootBaseline(refreshedLocal.manifest);
        await this.writeRootConflicts(refreshedRootConflicts);
        throw error;
      }
      return { sharedVersion: revision.version, manifest: revision.manifest, conflicts: [], published: true };
    });
  }

  private async readCurrentPointer(): Promise<Revision | null> {
    try {
      const version = (await readFile(path.join(this.directory, 'current'), 'utf8')).trim();
      return await this.readRevision(version);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async readRevision(version: string): Promise<Revision> {
    if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('Revision version must be a SHA-256 hex string');
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path.join(this.directory, 'revisions', `${version}.json`), 'utf8')); }
    catch (error) {
      if (isMissing(error)) throw new Error(`Unknown shared revision: ${version}`);
      throw error;
    }
    if (!isRecord(parsed) || parsed.version !== version) throw new Error(`Invalid stored collaboration revision: ${version}`);
    const manifest = validateManifest(parsed.manifest);
    if (manifestVersion(manifest) !== version) throw new Error(`Stored collaboration revision hash mismatch: ${version}`);
    return { version, manifest };
  }

  private async saveRevision(revision: Revision): Promise<void> {
    await mkdir(path.join(this.directory, 'revisions'), { recursive: true, mode: 0o700 });
    const target = path.join(this.directory, 'revisions', `${revision.version}.json`);
    try { await readFile(target); }
    catch (error) {
      if (!isMissing(error)) throw error;
      await writeAtomic(target, Buffer.from(JSON.stringify(revision)));
    }
  }

  private async writePointer(version: string): Promise<void> {
    await writeAtomic(path.join(this.directory, 'current'), Buffer.from(`${version}\n`));
  }

  private async readBlob(hash: string): Promise<string> {
    const content = await readFile(path.join(this.blobs, hash));
    if (sha256(content) !== hash) throw new Error(`Stored collaboration content failed integrity check: ${hash}`);
    if (content.byteLength > MAX_FILE_BYTES) throw new Error(`Stored collaboration content exceeds ${MAX_FILE_BYTES} bytes`);
    return content.toString('utf8');
  }

  private async writeBlob(hash: string, content: string): Promise<void> {
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    const target = path.join(this.blobs, hash);
    try { await readFile(target); }
    catch (error) {
      if (!isMissing(error)) throw error;
      await writeAtomic(target, Buffer.from(content, 'utf8'));
    }
  }

  private async validateRevisionSize(manifest: Manifest, newBlobs: Map<string, string>): Promise<void> {
    if (Object.keys(manifest).length > MAX_FILES) throw new Error(`Published revision exceeds the ${MAX_FILES} file limit`);
    let totalBytes = 0;
    for (const hash of Object.values(manifest)) {
      const replacement = newBlobs.get(hash);
      totalBytes += replacement === undefined ? Buffer.byteLength(await this.readBlob(hash)) : Buffer.byteLength(replacement);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Published revision exceeds the ${MAX_TOTAL_BYTES} byte limit`);
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory, 'publish.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Another collaboration publication is active; retry after it completes');
      }
      throw error;
    }
    try { return await action(); }
    finally { await lock.close(); await rm(lockPath, { force: true }); }
  }
}

function compareManifests(local: Manifest, shared: Manifest, base?: Manifest): Comparison {
  const paths = new Set([...Object.keys(local), ...Object.keys(shared), ...Object.keys(base ?? {})]);
  const result: Comparison = { localChanges: [], sharedChanges: [], conflicts: [] };
  for (const file of [...paths].sort(comparePath)) {
    const localHash = local[file] ?? null;
    const sharedHash = shared[file] ?? null;
    const baseHash = base?.[file] ?? null;
    const localChanged = base ? localHash !== baseHash : localHash !== null && sharedHash === null;
    const sharedChanged = base ? sharedHash !== baseHash : sharedHash !== null && localHash === null;
    const divergent = base
      ? localChanged && sharedChanged && localHash !== sharedHash
      : localHash !== null && sharedHash !== null && localHash !== sharedHash;
    if (localChanged) {
      result.localChanges.push({ path: file, kind: changeKind(localHash, baseHash), baseHash, localHash, sharedHash });
    }
    if (sharedChanged) {
      result.sharedChanges.push({ path: file, kind: changeKind(sharedHash, baseHash), baseHash, localHash, sharedHash });
    }
    if (divergent) result.conflicts.push({ path: file, kind: 'conflict', baseHash, localHash, sharedHash });
  }
  return result;
}

function comparisonRecords(comparison: Comparison): Array<{
  path: string;
  localChange?: ComparedChange;
  sharedChange?: ComparedChange;
  conflict?: ComparedChange;
}> {
  const byPath = new Map<string, { path: string; localChange?: ComparedChange; sharedChange?: ComparedChange; conflict?: ComparedChange }>();
  for (const change of comparison.localChanges) {
    const record = byPath.get(change.path) ?? { path: change.path };
    record.localChange = change;
    byPath.set(change.path, record);
  }
  for (const change of comparison.sharedChanges) {
    const record = byPath.get(change.path) ?? { path: change.path };
    record.sharedChange = change;
    byPath.set(change.path, record);
  }
  for (const change of comparison.conflicts) {
    const record = byPath.get(change.path) ?? { path: change.path };
    record.conflict = change;
    byPath.set(change.path, record);
  }
  return [...byPath.values()].sort((a, b) => comparePath(a.path, b.path));
}

function changeKind(hash: string | null, baseHash: string | null): Exclude<ChangeKind, 'conflict'> {
  return hash === null ? 'deletion' : baseHash === null ? 'addition' : 'modification';
}

function changedManifestPaths(base: Manifest, local: Manifest): string[] {
  const paths = new Set([...Object.keys(base), ...Object.keys(local)]);
  return [...paths].filter(file => (base[file] ?? null) !== (local[file] ?? null)).sort(comparePath);
}

function validateManifest(value: unknown): Manifest {
  if (!isRecord(value)) throw new Error('localManifest must be an object mapping relative paths to SHA-256 hashes');
  const entries = Object.entries(value);
  if (entries.length > MAX_FILES) throw new Error(`Manifest exceeds the ${MAX_FILES} file limit`);
  const sorted: Manifest = {};
  let serializedBytes = 0;
  for (const [rawPath, rawHash] of entries.sort(([a], [b]) => comparePath(a, b))) {
    const file = validatePath(rawPath);
    if (typeof rawHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawHash)) throw new Error(`Invalid SHA-256 hash for ${file}`);
    serializedBytes += Buffer.byteLength(file) + 64;
    if (serializedBytes > MAX_TOTAL_BYTES) throw new Error('Manifest exceeds the collaboration byte limit');
    sorted[file] = rawHash;
  }
  return sorted;
}

function validateChanges(value: unknown, manifest: Manifest): Change[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`changes must be an array of at most ${MAX_FILES} entries`);
  const seen = new Set<string>();
  let totalBytes = 0;
  const result: Change[] = [];
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).some(key => !['path', 'content'].includes(key))) {
      throw new Error('Each change must contain only path and content');
    }
    const file = validatePath(item.path);
    if (seen.has(file)) throw new Error(`Duplicate change path: ${file}`);
    seen.add(file);
    if (item.content !== null && typeof item.content !== 'string') throw new Error(`Content for ${file} must be a UTF-8 string or null`);
    const content = item.content as string | null;
    if (content !== null) {
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FILE_BYTES) throw new Error(`Content for ${file} exceeds ${MAX_FILE_BYTES} bytes`);
      totalBytes += bytes;
      if (sha256(content) !== manifest[file]) throw new Error(`Content hash does not match localManifest for ${file}`);
    } else if (manifest[file] !== undefined) throw new Error(`Deleted path ${file} must be absent from localManifest`);
    result.push({ path: file, content });
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Changes exceed the ${MAX_TOTAL_BYTES} byte limit`);
  return result;
}

function validateResolutions(value: unknown): Record<string, 'local' | 'shared'> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('resolutions must map conflict paths to local or shared');
  const result: Record<string, 'local' | 'shared'> = {};
  for (const [rawPath, resolution] of Object.entries(value)) {
    const file = validatePath(rawPath);
    if (resolution !== 'local' && resolution !== 'shared') throw new Error(`Resolution for ${file} must be local or shared`);
    result[file] = resolution;
  }
  return result;
}

function validatePath(file: unknown): string {
  if (typeof file !== 'string' || !file || Buffer.byteLength(file) > 1024 || file.startsWith('/')
    || /^[a-z]:/i.test(file) || file.includes('\\') || /[\u0000-\u001f\u007f]/.test(file)
    || file.split('/').some(part => !part || part === '.' || part === '..' || EXCLUDED_DIRECTORIES.has(part.toLowerCase()))
    || (process.env.AIKIDO_INCLUDE_SPEC !== 'true' && (file === 'spec' || file.startsWith('spec/') || file === 'prompts/spec' || file.startsWith('prompts/spec/')))
    || path.posix.normalize(file) !== file || !isKnowledgeFile(file) || isSensitiveKnowledgePath(file)) {
    throw new Error(`Unsafe or ineligible relative knowledge path: ${String(file)}`);
  }
  return file;
}

function manifestVersion(manifest: Manifest): string {
  return sha256(JSON.stringify(Object.entries(sortedManifest(manifest))));
}

function sortedManifest(manifest: Manifest): Manifest {
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => comparePath(a, b)));
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function rejectUnknown(input: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(input).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown aikido_collaboration argument: ${unknown}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function writeAtomic(target: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const pending = `${target}.${randomUUID()}.pending`;
  try {
    await writeFile(pending, content, { mode: 0o600, flag: 'wx' });
    await rename(pending, target);
  } finally {
    await rm(pending, { force: true });
  }
}
