import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AikidoKnowledgeBase, FileMetadata } from './knowledge.js';
import { AikidoKnowledgeBase as KnowledgeBase } from './knowledge.js';
import { sourceSnapshot } from './index-basis.js';
import { readRemoteSourceMetadata } from './project-policy.js';
import { synchronizationPaths, within } from './synchronization.js';

interface SnapshotManifest {
  snapshotId: string;
  version: string;
  expiresAt: number;
  bytes: number;
  documents: number;
}

export interface KnowledgeSnapshot {
  readonly snapshotId: string;
  readonly version: string;
  readonly expiresAt: string;
  readonly capturedAt: string;
  readonly provenance: {
    source: 'filesystem';
    head: string | null;
    branch: string | null;
    dirty: boolean | null;
    statusFingerprint: string | null;
    indexedSource: {
      gitUrl: string;
      branch: string;
      commit: string;
      syncedAt: string;
      indexedAt?: string;
      corpusFingerprint: string;
    } | null;
  };
  readonly knowledge: AikidoKnowledgeBase;
  readonly bytes: number;
  readonly documents: number;
  readonly paths?: string[];
  uses: number;
  closing: boolean;
}

export class SnapshotManager {
  private readonly snapshots = new Map<string, KnowledgeSnapshot>();
  private readonly snapshotsRoot: string;
  private readonly cacheRoot: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly source: AikidoKnowledgeBase) {
    this.cacheRoot = path.dirname(source.searchIndex.directory);
    this.snapshotsRoot = path.join(source.searchIndex.directory, 'snapshots');
  }

  async begin(paths?: string[]): Promise<Record<string, unknown>> {
    const scopes = synchronizationPaths(paths);
    const action = this.pending.then(() => this.capture(scopes));
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

  private async capture(paths?: string[]): Promise<Record<string, unknown>> {
    const limits = this.source.config;
    await this.collectExpired();
    if (this.snapshots.size >= limits.maxSnapshots) throw new Error(`Snapshot limit reached (maximum ${limits.maxSnapshots}); end an unused snapshot`);

    await this.source.refresh();
    const before = await sourceSnapshot(this.source, paths);
    const entries = this.source.list().filter(entry => within(entry.path, paths)).sort((a, b) => a.path.localeCompare(b.path));
    const id = randomUUID();
    const directory = path.join(this.snapshotsRoot, id);
    const corpusRoot = path.join(directory, 'corpus');
    let bytes = 0;
    let documents = 0;
    const metadata = new Map<string, FileMetadata>();
    let snapshotCache: string | undefined;
    const inUseBytes = [...this.snapshots.values()].reduce((total, item) => total + item.bytes, 0);
    try {
      await mkdir(corpusRoot, { recursive: true, mode: 0o700 });
      const canonicalCache = await realpath(this.cacheRoot);
      const canonicalSnapshotRoot = await realpath(this.snapshotsRoot);
      if (!isWithin(canonicalCache, canonicalSnapshotRoot) || canonicalSnapshotRoot === canonicalCache) {
        throw new Error('Snapshot directory must remain inside the external cache');
      }
      const canonicalCorpus = await realpath(corpusRoot);
      if (!isWithin(canonicalSnapshotRoot, canonicalCorpus)) throw new Error('Snapshot corpus escaped its cache directory');

      const fingerprint = createHash('sha256');
      for (const entry of entries) {
        const document = await this.source.tryRead(entry.path);
        if (!document) continue;
        const { content } = document;
        bytes += Buffer.byteLength(content);
        if (bytes > limits.snapshotMaxBytes) throw new Error(`Snapshot exceeds the ${limits.snapshotMaxBytes} byte corpus limit; use begin paths or raise snapshotMaxBytes`);
        if (inUseBytes + bytes > limits.snapshotsTotalBytes) throw new Error(`Active snapshots exceed the ${limits.snapshotsTotalBytes} byte total limit`);
        const destination = path.resolve(canonicalCorpus, entry.path);
        if (!isWithin(canonicalCorpus, destination)) throw new Error(`Unsafe snapshot document path: ${entry.path}`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
        documents++;
        if (document.entry.metadata) metadata.set(entry.path, { ...document.entry.metadata });
        fingerprint.update(JSON.stringify([entry.path, entry.kind, content]));
      }

      const version = fingerprint.digest('hex');
      const after = await sourceSnapshot(this.source, paths);
      if (JSON.stringify(before) !== JSON.stringify(after) || before.corpusFingerprint !== version) {
        throw new Error('Knowledge base changed while the snapshot was being captured; retry');
      }
      const remoteSource = paths ? null : await readRemoteSourceMetadata(this.source.searchIndex.directory);
      const indexedSource = remoteSource?.corpusFingerprint === version
        ? { ...remoteSource, corpusFingerprint: version }
        : null;

      // Preserve original paths while storing only canonical extracted UTF-8 text.
      const knowledge = new KnowledgeBase(corpusRoot, true, this.source.config, this.source.isMemoryRoot, true, metadata);
      snapshotCache = knowledge.searchIndex.directory;
      await knowledge.initialize();
      await knowledge.semanticIndex.seedFrom(this.source.semanticIndex, version);
      const expiresAt = Date.now() + limits.snapshotTtlMs;
      const snapshot: KnowledgeSnapshot = {
        snapshotId: id,
        version,
        expiresAt: new Date(expiresAt).toISOString(),
        capturedAt: new Date().toISOString(),
        provenance: {
          source: 'filesystem',
          head: before.head,
          branch: before.branch,
          dirty: before.dirty,
          statusFingerprint: before.statusFingerprint,
          indexedSource,
        },
        knowledge,
        bytes,
        documents,
        ...(paths ? { paths } : {}),
        uses: 0,
        closing: false,
      };
      const manifest: SnapshotManifest = { snapshotId: id, version, expiresAt, bytes, documents };
      await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
      this.snapshots.set(id, snapshot);
      return this.describe(snapshot);
    } catch (error) {
      if (snapshotCache) await this.removeArtifacts(directory, snapshotCache);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async end(snapshotId: string): Promise<Record<string, unknown>> {
    const snapshot = this.require(snapshotId);
    snapshot.closing = true;
    if (snapshot.uses === 0) await this.dispose(snapshot);
    return { operation: 'end', snapshotId, ended: true };
  }

  async withSnapshot<T>(snapshotId: string, action: (snapshot: KnowledgeSnapshot) => Promise<T>): Promise<T> {
    const snapshot = this.require(snapshotId);
    if (snapshot.closing) throw new Error(`Snapshot ${snapshotId} has ended`);
    if (Date.now() >= Date.parse(snapshot.expiresAt)) {
      snapshot.closing = true;
      if (snapshot.uses === 0) await this.dispose(snapshot);
      throw new Error(`Snapshot ${snapshotId} has expired; begin a new snapshot`);
    }
    snapshot.uses++;
    try {
      return await action(snapshot);
    } finally {
      snapshot.uses--;
      if (snapshot.closing && snapshot.uses === 0) await this.dispose(snapshot);
    }
  }

  private require(snapshotId: string): KnowledgeSnapshot {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
      throw new Error('snapshotId must be a UUID returned by aikido_snapshot begin');
    }
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) throw new Error(`Snapshot ${snapshotId} is unknown or stale; begin a new snapshot`);
    return snapshot;
  }

  private describe(snapshot: KnowledgeSnapshot) {
    return {
      operation: 'begin',
      snapshotId: snapshot.snapshotId,
      version: snapshot.version,
      expiresAt: snapshot.expiresAt,
      capturedAt: snapshot.capturedAt,
      documents: snapshot.documents,
      bytes: snapshot.bytes,
      paths: snapshot.paths ?? null,
      limits: {
        maxBytes: this.source.config.snapshotMaxBytes,
        totalBytes: this.source.config.snapshotsTotalBytes,
        maxSnapshots: this.source.config.maxSnapshots,
        ttlMs: this.source.config.snapshotTtlMs,
      },
      provenance: snapshot.provenance,
    };
  }

  private async collectExpired(): Promise<void> {
    for (const snapshot of this.snapshots.values()) {
      if (Date.now() >= Date.parse(snapshot.expiresAt)) {
        snapshot.closing = true;
        if (snapshot.uses === 0) await this.dispose(snapshot);
      }
    }
    await mkdir(this.snapshotsRoot, { recursive: true, mode: 0o700 });
    const canonicalCache = await realpath(this.cacheRoot);
    const canonicalRoot = await realpath(this.snapshotsRoot);
    if (!isWithin(canonicalCache, canonicalRoot) || canonicalRoot === canonicalCache) {
      throw new Error('Snapshot directory must remain inside the external cache');
    }
    for (const name of await readdir(canonicalRoot)) {
      if (!/^[0-9a-f-]{36}$/i.test(name)) continue;
      const directory = path.join(canonicalRoot, name);
      try {
        if (!(await lstat(directory)).isDirectory()) continue;
        const raw: unknown = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'));
        if (!isManifest(raw)) continue;
        if (raw.expiresAt <= Date.now() || !this.snapshots.has(raw.snapshotId)) {
          const indexDirectory = new KnowledgeBase(path.join(directory, 'corpus'), true, this.source.config).searchIndex.directory;
          await this.removeArtifacts(directory, indexDirectory);
        }
      } catch (error) {
        if (missing(error) || error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }

  private async dispose(snapshot: KnowledgeSnapshot): Promise<void> {
    if (this.snapshots.get(snapshot.snapshotId) !== snapshot) return;
    this.snapshots.delete(snapshot.snapshotId);
    await this.removeArtifacts(path.join(this.snapshotsRoot, snapshot.snapshotId), snapshot.knowledge.searchIndex.directory);
  }

  private async removeArtifacts(directory: string, cacheDirectory: string): Promise<void> {
    const cacheRoot = path.resolve(this.cacheRoot);
    if (path.dirname(path.resolve(cacheDirectory)) !== cacheRoot) {
      throw new Error('Refusing to remove a snapshot index outside the cache root');
    }
    await rm(cacheDirectory, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
}

const managers = new WeakMap<AikidoKnowledgeBase, SnapshotManager>();

export function snapshotsFor(knowledge: AikidoKnowledgeBase): SnapshotManager {
  let manager = managers.get(knowledge);
  if (!manager) {
    manager = new SnapshotManager(knowledge);
    managers.set(knowledge, manager);
  }
  return manager;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isManifest(value: unknown): value is SnapshotManifest {
  return Boolean(value && typeof value === 'object'
    && typeof (value as SnapshotManifest).snapshotId === 'string'
    && typeof (value as SnapshotManifest).version === 'string'
    && typeof (value as SnapshotManifest).expiresAt === 'number'
    && Number.isSafeInteger((value as SnapshotManifest).expiresAt)
    && typeof (value as SnapshotManifest).bytes === 'number'
    && typeof (value as SnapshotManifest).documents === 'number');
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
