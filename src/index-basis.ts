import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { AikidoKnowledgeBase } from './knowledge.js';
import { RepositoryAccess } from './repository.js';
import { readRemoteSourceMetadata } from './project-policy.js';
import { within } from './synchronization.js';

type Engine = 'literal' | 'semantic';
interface Snapshot {
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  statusFingerprint: string | null;
  configFingerprint: string;
  corpusFingerprint: string | null;
  basisFingerprint?: string;
  documentFingerprints?: Record<string, string>;
  dirtyPaths?: string[];
}
interface BasisState {
  attempt: string;
  phase: 'running' | 'ready' | 'partial' | 'failed' | 'concurrent-change';
  lastSuccessful: (Snapshot & { indexedAt: string }) | null;
}

export function corpusFingerprint(documents: Array<{ path: string; kind: string; content: string }>): string {
  const hash = createHash('sha256');
  for (const entry of [...documents].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify([entry.path, entry.kind, entry.content]));
  }
  return hash.digest('hex');
}

function basisFingerprint(documents: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const [file, digest] of Object.entries(documents).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(JSON.stringify([file, digest]));
  }
  return hash.digest('hex');
}

function validDocumentFingerprints(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([file, digest]) => file.length > 0
      && !path.posix.isAbsolute(file) && !/[\\\0\r\n]/.test(file)
      && !file.split('/').some(part => !part || part === '.' || part === '..')
      && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest));
}

export async function sourceSnapshot(
  knowledge: AikidoKnowledgeBase,
  paths?: string[],
  previous?: Snapshot,
): Promise<Snapshot> {
  const state = await new RepositoryAccess(knowledge.root).infos().catch(() => null);
  const configFingerprint = createHash('sha256').update(JSON.stringify(knowledge.config)).digest('hex');
  if (!paths && state && !state.dirty && previous?.dirty === false
    && previous.basisFingerprint && validDocumentFingerprints(previous.documentFingerprints)
    && previous.head === state.head && previous.branch === state.branch
    && previous.statusFingerprint === state.statusFingerprint
    && previous.configFingerprint === configFingerprint) {
    return {
      head: state.head,
      branch: state.branch,
      dirty: state.dirty,
      statusFingerprint: state.statusFingerprint,
      configFingerprint,
      corpusFingerprint: previous.corpusFingerprint,
      basisFingerprint: previous.basisFingerprint,
      documentFingerprints: previous.documentFingerprints ?? {},
      dirtyPaths: [],
    };
  }

  const scan = new AikidoKnowledgeBase(knowledge.root, knowledge.immutable, knowledge.config,
    knowledge.immutable ? knowledge.isMemoryRoot : undefined, knowledge.materializedText, knowledge.snapshotMetadata);
  await scan.initialize();
  const entries = scan.list().filter(entry => within(entry.path, paths)).sort((a, b) => a.path.localeCompare(b.path));
  const currentDirtyPaths = state?.dirtyFiles.flatMap(file => [file.path, ...(file.oldPath ? [file.oldPath] : [])]) ?? [];
  const dirtyPaths = [...new Set([...currentDirtyPaths, ...(previous?.dirtyPaths ?? [])])].sort();
  const canReuse = !paths && state && previous && validDocumentFingerprints(previous.documentFingerprints)
    && previous.head === state.head && previous.branch === state.branch
    && previous.configFingerprint === configFingerprint
    && !(state.dirty === false && previous.corpusFingerprint === null)
    && !dirtyPaths.some(file => path.posix.basename(file) === '.gitignore');
  if (canReuse) {
    const previousDocuments = previous.documentFingerprints!;
    const changed = new Set(dirtyPaths);
    const fingerprints: Record<string, string> = {};
    for (const entry of entries) {
      const prior = previousDocuments[entry.path];
      if (prior && !changed.has(entry.path)) {
        fingerprints[entry.path] = prior;
        continue;
      }
      const document = await scan.tryRead(entry.path);
      if (document) fingerprints[entry.path] = createHash('sha256')
        .update(JSON.stringify([entry.kind, document.content])).digest('hex');
    }
    const sameDocuments = Object.keys(fingerprints).length === Object.keys(previousDocuments).length
      && Object.entries(fingerprints).every(([file, digest]) => previousDocuments[file] === digest);
    return {
      head: state.head,
      branch: state.branch,
      dirty: state.dirty,
      statusFingerprint: state.statusFingerprint,
      configFingerprint,
      corpusFingerprint: sameDocuments ? previous.corpusFingerprint : null,
      basisFingerprint: basisFingerprint(fingerprints),
      documentFingerprints: fingerprints,
      dirtyPaths,
    };
  }

  // Full reads remain the fallback for unknown Git state, changed revisions or ignore rules.
  const fingerprint = createHash('sha256');
  const documentFingerprints: Record<string, string> = {};
  for (const entry of entries) {
    const document = await scan.tryRead(entry.path);
    if (!document) continue;
    fingerprint.update(JSON.stringify([entry.path, entry.kind, document.content]));
    documentFingerprints[entry.path] = createHash('sha256')
      .update(JSON.stringify([entry.kind, document.content])).digest('hex');
  }
  return { head: state?.head ?? null, branch: state?.branch ?? null, dirty: state?.dirty ?? null,
    statusFingerprint: state?.statusFingerprint ?? null, configFingerprint,
    corpusFingerprint: fingerprint.digest('hex'), basisFingerprint: basisFingerprint(documentFingerprints),
    documentFingerprints, dirtyPaths };
}

async function load(knowledge: AikidoKnowledgeBase, engine: Engine): Promise<BasisState | null> {
  try {
    const state = JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, `${engine}-basis.json`), 'utf8'));
    if (!state || typeof state !== 'object' || typeof state.attempt !== 'string'
      || !['running', 'ready', 'partial', 'failed', 'concurrent-change'].includes(state.phase)
      || !(state.lastSuccessful === null || (state.lastSuccessful && typeof state.lastSuccessful === 'object'
        && (state.lastSuccessful.corpusFingerprint === null
          || typeof state.lastSuccessful.corpusFingerprint === 'string'
            && /^[a-f0-9]{64}$/.test(state.lastSuccessful.corpusFingerprint))
        && (state.lastSuccessful.basisFingerprint === undefined
          || typeof state.lastSuccessful.basisFingerprint === 'string' && /^[a-f0-9]{64}$/.test(state.lastSuccessful.basisFingerprint))
        && (state.lastSuccessful.documentFingerprints === undefined
          || validDocumentFingerprints(state.lastSuccessful.documentFingerprints))
        && typeof state.lastSuccessful.indexedAt === 'string'))) return null;
    return state;
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
    throw error;
  }
}

async function save(knowledge: AikidoKnowledgeBase, engine: Engine, state: BasisState) {
  const directory = knowledge.searchIndex.directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = path.join(directory, `${engine}-basis-${randomUUID()}.pending`);
  try {
    await writeFile(pending, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(pending, path.join(directory, `${engine}-basis.json`));
  } finally { await rm(pending, { force: true }); }
}

export class IndexLockedError extends Error {
  constructor(engine: Engine) {
    super(`${engine} index is locked by another writer; if it crashed, stop all writers before removing the cache lock`);
  }
}

export function processAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function acquire(lockPath: string, engine: Engine) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      return lock;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      // Reclaim only provably dead writers of this host (VS Code may kill servers without cleanup).
      const owner: unknown = await readFile(lockPath, 'utf8').then(JSON.parse, () => undefined);
      if (attempt > 0 || !owner || typeof owner !== 'object' || (owner as { host?: unknown }).host !== hostname()
        || processAlive((owner as { pid?: unknown }).pid)) throw new IndexLockedError(engine);
      await rm(lockPath, { force: true });
    }
  }
  throw new IndexLockedError(engine);
}

export async function trackIndex<T>(
  knowledge: AikidoKnowledgeBase,
  engine: Engine,
  paths: string[] | undefined,
  action: (
    observed: (fingerprint: string, partial?: boolean) => void,
    reusableFingerprint?: string,
    reusableDocuments?: Record<string, string>,
  ) => Promise<T>,
): Promise<T> {
  const lockPath = path.join(knowledge.searchIndex.directory, `${engine}-basis.lock`);
  await mkdir(knowledge.searchIndex.directory, { recursive: true, mode: 0o700 });
  const lock = await acquire(lockPath, engine);
  try {
    const previous = await load(knowledge, engine);
    const state: BasisState = { attempt: randomUUID(), phase: 'running', lastSuccessful: previous?.lastSuccessful ?? null };
    await save(knowledge, engine, state);
    try {
      const before = paths ? null : await sourceSnapshot(knowledge, undefined,
        engine === 'literal' ? undefined : previous?.lastSuccessful ?? undefined);
      const last = previous?.lastSuccessful;
      const reusableFingerprint = before?.basisFingerprint && previous?.phase === 'ready' && last
        && before.head === last.head && before.branch === last.branch
        && before.configFingerprint === last.configFingerprint
        && before.basisFingerprint === last.basisFingerprint
        ? before.basisFingerprint : undefined;
      const reusableDocuments = previous?.phase === 'ready' && before && last
        && before.dirty !== null && before.statusFingerprint !== null
        && before.head === last.head && before.branch === last.branch
        && before.configFingerprint === last.configFingerprint && last.documentFingerprints
        ? Object.fromEntries(Object.entries(last.documentFingerprints)
          .filter(([file]) => !before.dirtyPaths?.includes(file)))
        : undefined;
      let indexedFingerprint: string | undefined;
      let partial = false;
      const result = await action((value, incomplete = false) => {
        indexedFingerprint = value;
        partial = incomplete;
      }, reusableFingerprint, reusableDocuments);
      const after = paths ? null : await sourceSnapshot(knowledge, undefined,
        engine === 'literal' ? undefined : before ?? undefined);
      const latest = await load(knowledge, engine);
      const expectedFingerprint = engine === 'semantic' ? after?.basisFingerprint : after?.corpusFingerprint;
      const stable = before && JSON.stringify(before) === JSON.stringify(after)
        && (indexedFingerprint === expectedFingerprint || indexedFingerprint === after?.corpusFingerprint);
      state.phase = latest?.attempt !== state.attempt ? 'concurrent-change' : paths || partial ? 'partial' : stable ? 'ready' : 'concurrent-change';
      if (state.phase === 'ready' && after) state.lastSuccessful = { ...after, indexedAt: new Date().toISOString() };
      await save(knowledge, engine, state);
      return result;
    } catch (error) {
      state.phase = 'failed';
      await save(knowledge, engine, state);
      throw error;
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function indexInfos(knowledge: AikidoKnowledgeBase) {
  const engines = ['literal', 'semantic'] as const;
  const states = await Promise.all(engines.map(engine => load(knowledge, engine)));
  const current = await sourceSnapshot(knowledge);
  const storedRemote = await readRemoteSourceMetadata(knowledge.searchIndex.directory);
  const indexedSource = storedRemote?.corpusFingerprint === current.corpusFingerprint ? storedRemote : null;
  const indexes: Record<string, unknown> = {};
  for (const [index, engine] of engines.entries()) {
    const state = states[index];
    const basis = state?.lastSuccessful ?? null;
    const sameSource = basis && basis.head === current.head && basis.branch === current.branch
      && basis.dirty === current.dirty && basis.statusFingerprint === current.statusFingerprint
      && basis.configFingerprint === current.configFingerprint
      && (engine === 'semantic'
        ? basis.basisFingerprint !== undefined && basis.basisFingerprint === current.basisFingerprint
        : basis.corpusFingerprint === current.corpusFingerprint);
    const freshness = !state ? 'unknown' : state.phase !== 'ready' ? state.phase
      : sameSource ? 'fresh' : 'stale';
    indexes[engine] = { lastIndexedSha: basis?.head ?? null, freshness, basis };
  }
  return { corpusFingerprint: current.corpusFingerprint, indexedSource, indexes };
}
