import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AikidoKnowledgeBase } from './knowledge.js';
import { RepositoryAccess } from './repository.js';
import { readRemoteSourceMetadata } from './project-policy.js';

type Engine = 'literal' | 'semantic';
interface Snapshot {
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  statusFingerprint: string | null;
  corpusFingerprint: string;
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

export async function sourceSnapshot(knowledge: AikidoKnowledgeBase): Promise<Snapshot> {
  // An independent scan detects additions/deletions as well as edits during indexing.
  const scan = new AikidoKnowledgeBase(knowledge.root);
  await scan.initialize();
  const documents = [];
  for (const entry of scan.list().sort((a, b) => a.path.localeCompare(b.path))) {
    const { content } = await scan.read(entry.path);
    documents.push({ ...entry, content });
  }
  const state = await new RepositoryAccess(knowledge.root).infos().catch(() => null);
  return { head: state?.head ?? null, branch: state?.branch ?? null, dirty: state?.dirty ?? null,
    statusFingerprint: state?.statusFingerprint ?? null, corpusFingerprint: corpusFingerprint(documents) };
}

async function load(knowledge: AikidoKnowledgeBase, engine: Engine): Promise<BasisState | null> {
  try {
    const state = JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, `${engine}-basis.json`), 'utf8'));
    if (!state || typeof state !== 'object' || typeof state.attempt !== 'string'
      || !['running', 'ready', 'partial', 'failed', 'concurrent-change'].includes(state.phase)
      || !(state.lastSuccessful === null || (state.lastSuccessful && typeof state.lastSuccessful === 'object'
        && typeof state.lastSuccessful.corpusFingerprint === 'string' && /^[a-f0-9]{64}$/.test(state.lastSuccessful.corpusFingerprint)
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

export async function trackIndex<T>(knowledge: AikidoKnowledgeBase, engine: Engine, paths: string[] | undefined, action: (observed: (fingerprint: string) => void) => Promise<T>): Promise<T> {
  const lockPath = path.join(knowledge.searchIndex.directory, `${engine}-basis.lock`);
  await mkdir(knowledge.searchIndex.directory, { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`${engine} index is locked by another writer; if it crashed, stop all writers before removing the cache lock`);
    }
    throw error;
  });
  try {
    const previous = await load(knowledge, engine);
    const state: BasisState = { attempt: randomUUID(), phase: 'running', lastSuccessful: previous?.lastSuccessful ?? null };
    await save(knowledge, engine, state);
    try {
      const before = paths ? null : await sourceSnapshot(knowledge);
      let indexedFingerprint: string | undefined;
      const result = await action(value => { indexedFingerprint = value; });
      const after = paths ? null : await sourceSnapshot(knowledge);
      const latest = await load(knowledge, engine);
      const stable = before && JSON.stringify(before) === JSON.stringify(after) && indexedFingerprint === after?.corpusFingerprint;
      state.phase = latest?.attempt !== state.attempt ? 'concurrent-change' : paths ? 'partial' : stable ? 'ready' : 'concurrent-change';
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
  const current = await sourceSnapshot(knowledge);
  const storedRemote = await readRemoteSourceMetadata(knowledge.searchIndex.directory);
  const indexedSource = storedRemote?.corpusFingerprint === current.corpusFingerprint ? storedRemote : null;
  const indexes: Record<string, unknown> = {};
  for (const engine of ['literal', 'semantic'] as const) {
    const state = await load(knowledge, engine);
    const basis = state?.lastSuccessful ?? null;
    const { indexedAt: _indexedAt, ...snapshot } = basis ?? { indexedAt: null };
    const freshness = !state ? 'unknown' : state.phase !== 'ready' ? state.phase
      : JSON.stringify(snapshot) === JSON.stringify(current) ? 'fresh' : 'stale';
    indexes[engine] = { lastIndexedSha: basis?.head ?? null, freshness, basis };
  }
  return { corpusFingerprint: current.corpusFingerprint, indexedSource, indexes };
}
