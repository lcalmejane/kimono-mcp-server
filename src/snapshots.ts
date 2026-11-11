import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AikidoKnowledgeBase, FileMetadata, VisibleFile } from './knowledge.js';
import { AikidoKnowledgeBase as KnowledgeBase, classify } from './knowledge.js';
import { UserOverlay, validateOwner } from './overlay.js';
import { sourceSnapshot, basisFingerprint } from './index-basis.js';
import { currentPrincipal } from './principal.js';
import { readRemoteSourceMetadata } from './project-policy.js';
import { synchronizationPaths, within } from './synchronization.js';
import { clearSearchCache } from './search-cache.js';

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
  /** Per-document basis fingerprint (index-basis format), when the snapshot is the plain ROOT (no staged overlay). */
  readonly basisVersion?: string;
  /** Source state at capture (index-basis snapshot), to tell whether a released snapshot is still current. */
  readonly sourceBasis?: string;
  /** Staged overlay entries merged at capture (owner snapshots), to detect the owner's own new staged edits. */
  readonly overlayBasis?: string;
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
    /** Present when the snapshot merges the shared ROOT with a user's staged overlay. */
    overlay?: { owner: string; files: number };
  };
  readonly knowledge: AikidoKnowledgeBase;
  /** Files visible under the Kimono ignore rules (indexed or not), overlay-merged, sorted by path. */
  readonly structure: readonly VisibleFile[];
  /** Fingerprint of the structure (paths, idx flags, sizes): changes when files appear, vanish or change. */
  readonly structureVersion: string;
  readonly bytes: number;
  readonly documents: number;
  readonly paths?: string[];
  uses: number;
  closing: boolean;
}

/**
 * How long one snapshot serves a user (KIMONO_SNAPSHOT_SCOPE):
 * - prompt (default): begin reuses the user's snapshot while searches keep coming (idle gap below
 *   KIMONO_SNAPSHOT_IDLE_MS), so a prompt, its swarm and delegated agents share one consistent corpus;
 * - session: reused for the server session, until its lifetime ends;
 * - call: legacy, every begin captures and every end disposes.
 * In prompt and session scopes, end only releases: the snapshot closes by itself once idle, and the next begin
 * after that closes it too. The lifetime slides with use, capped by KIMONO_SNAPSHOT_MAX_MS.
 */
export type SnapshotScope = 'prompt' | 'session' | 'call';
export function snapshotScope(): SnapshotScope {
  const value = process.env.KIMONO_SNAPSHOT_SCOPE || 'prompt';
  if (value !== 'prompt' && value !== 'session' && value !== 'call') throw new Error('KIMONO_SNAPSHOT_SCOPE must be prompt, session or call');
  return value;
}
function durationEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 24 * 60 * 60 * 1000) throw new Error(`${name} must be 1000..86400000 ms`);
  return value;
}
interface SnapshotLease { snapshotId: string; holders: number; lastUsed: number }

export class SnapshotManager {
  private readonly snapshots = new Map<string, KnowledgeSnapshot>();
  /** One shared snapshot per user and path scope (prompt/session scopes). */
  private readonly leases = new Map<string, SnapshotLease>();
  private sweeper: NodeJS.Timeout | undefined;
  private readonly snapshotsRoot: string;
  private readonly cacheRoot: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly source: AikidoKnowledgeBase) {
    this.cacheRoot = path.dirname(source.searchIndex.directory);
    this.snapshotsRoot = path.join(source.searchIndex.directory, 'snapshots');
  }

  async begin(paths?: string[], owner?: string, fresh = false): Promise<Record<string, unknown>> {
    const scopes = synchronizationPaths(paths);
    const user = owner === undefined ? undefined : validateOwner(owner);
    const action = this.pending.then(() => this.lease(scopes, user, fresh));
    this.pending = action.then(() => undefined, () => undefined);
    return action;
  }

  /**
   * Shared snapshot of one user (trusted principal), overlay owner and path scope, reused only while the source corpus
   * (and the owner's overlay) is unchanged: documented behaviour holds, a begin after any change sees it, and a prompt
   * and its delegates stop opening and closing snapshots when nothing changed. A swarm that must stay on one corpus
   * while files change passes its snapshotId to delegates (search skill).
   */
  private async lease(paths?: string[], owner?: string, fresh = false): Promise<Record<string, unknown>> {
    const scope = snapshotScope();
    if (scope === 'call') return this.capture(paths, owner);
    this.sweep();
    const key = JSON.stringify([currentPrincipal() ?? null, owner ?? null, paths ?? null]);
    const lease = this.leases.get(key);
    const current = lease && this.snapshots.get(lease.snapshotId);
    const live = Boolean(lease && current && !current.closing && Date.now() < Date.parse(current.expiresAt));
    const idle = durationEnv('KIMONO_SNAPSHOT_IDLE_MS', 120_000);
    const recent = scope === 'session' || Boolean(lease && Date.now() - lease.lastUsed <= idle);
    // fresh: an explicit new capture (e.g. after an edit), which becomes the user's shared snapshot.
    if (!fresh && lease && current && live && recent && await this.sourceUnchanged(current, paths, owner)) {
      lease.holders++;
      this.touch(lease, current);
      return { ...this.describe(current), reused: true, scope };
    }
    // A held snapshot replaced by fresh stays readable for its holders until they end it or it idles out.
    // A replaced snapshot (changed corpus or fresh) that still has holders stays readable for them.
    if (lease && lease.holders > 0) {
      // Re-keyed: still ended by its holders and closed by the sweep, but no longer handed out by begin.
      this.leases.delete(key);
      this.leases.set(`${key}#replaced:${lease.snapshotId}`, lease);
    } else if (lease) await this.drop(key);
    await this.makeRoom();
    let created: Record<string, unknown>;
    try { created = await this.capture(paths, owner); }
    catch (error) {
      // Count and byte budgets are shared: retry once after closing every released snapshot.
      if (!(error instanceof Error && /limit|exceed/i.test(error.message)) || !await this.evictReleased(Infinity)) throw error;
      created = await this.capture(paths, owner);
    }
    this.leases.set(key, { snapshotId: String(created.snapshotId), holders: 1, lastUsed: Date.now() });
    this.schedule();
    return { ...created, reused: false, scope };
  }

  /** Cheap check (Git fast path; dirty trees reread only changed files) that the source still matches the capture. */
  private async sourceUnchanged(snapshot: KnowledgeSnapshot, paths?: string[], owner?: string): Promise<boolean> {
    if (!snapshot.sourceBasis) return false;
    try {
      // An owner snapshot merges that user's overlay: a newly staged edit must also give a fresh snapshot.
      if (owner !== undefined && JSON.stringify(await new UserOverlay(this.cacheRoot_(), owner).entries()) !== snapshot.overlayBasis) return false;
      // The capture state is the baseline: clean Git reads nothing, a dirty tree rereads only changed files.
      const before = JSON.parse(snapshot.sourceBasis) as Awaited<ReturnType<typeof sourceSnapshot>>;
      const after = await sourceSnapshot(this.source, paths, before);
      return after.basisFingerprint === before.basisFingerprint && after.configFingerprint === before.configFingerprint;
    } catch { return false; }
  }

  /** Slides the lifetime with use, never beyond KIMONO_SNAPSHOT_MAX_MS after capture. */
  private touch(lease: SnapshotLease, snapshot: KnowledgeSnapshot): void {
    lease.lastUsed = Date.now();
    const cap = Date.parse(snapshot.capturedAt) + durationEnv('KIMONO_SNAPSHOT_MAX_MS', 60 * 60 * 1000);
    const slid = Math.min(cap, Date.now() + this.source.config.snapshotTtlMs);
    if (slid > Date.parse(snapshot.expiresAt)) (snapshot as { expiresAt: string }).expiresAt = new Date(slid).toISOString();
  }

  /** Removes a lease and closes its snapshot (after in-flight uses). */
  private async drop(key: string): Promise<void> {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);
    const snapshot = this.snapshots.get(lease.snapshotId);
    if (snapshot) { snapshot.closing = true; if (snapshot.uses === 0) await this.dispose(snapshot); }
  }

  /** Keeps the count under maxSnapshots by closing released snapshots, least recently used first. */
  private async makeRoom(): Promise<void> {
    const excess = this.snapshots.size - this.source.config.maxSnapshots + 1;
    if (excess > 0) await this.evictReleased(excess);
  }

  private async evictReleased(count: number): Promise<boolean> {
    const released = [...this.leases].filter(([, lease]) => lease.holders === 0)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed).slice(0, count);
    for (const [key] of released) await this.drop(key);
    return released.length > 0;
  }

  /**
   * Guaranteed closing, whatever the clients do: a released snapshot closes once idle (session scope: at expiry);
   * a held one whose holder never ended (crashed or forgetful agent) after KIMONO_SNAPSHOT_HELD_IDLE_MS without use;
   * an expired one as soon as no search uses it.
   */
  private sweep(): void {
    const now = Date.now();
    const scope = snapshotScope();
    const idle = durationEnv('KIMONO_SNAPSHOT_IDLE_MS', 120_000);
    const heldIdle = durationEnv('KIMONO_SNAPSHOT_HELD_IDLE_MS', this.source.config.snapshotTtlMs);
    for (const [key, lease] of [...this.leases]) {
      const snapshot = this.snapshots.get(lease.snapshotId);
      const quiet = now - lease.lastUsed;
      if (!snapshot || now >= Date.parse(snapshot.expiresAt)
        || lease.holders === 0 && scope !== 'session' && quiet > idle
        || lease.holders > 0 && quiet > heldIdle) {
        this.leases.delete(key);
        if (snapshot) {
          snapshot.closing = true;
          if (snapshot.uses === 0) {
            const action = this.pending.then(() => this.dispose(snapshot));
            this.pending = action.then(() => undefined, () => undefined);
          }
        }
      }
    }
    if (!this.leases.size && this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
  }

  private schedule(): void {
    if (this.sweeper) return;
    const every = Math.max(250, Math.min(30_000, Math.floor(durationEnv('KIMONO_SNAPSHOT_IDLE_MS', 120_000) / 4)));
    this.sweeper = setInterval(() => this.sweep(), every);
    this.sweeper.unref?.();
  }

  private leaseOf(snapshotId: string): [string, SnapshotLease] | undefined {
    return [...this.leases].find(([, lease]) => lease.snapshotId === snapshotId);
  }

  /** Closes every snapshot (server shutdown). */
  async closeAll(): Promise<void> {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = undefined; }
    for (const key of [...this.leases.keys()]) await this.drop(key);
    for (const snapshot of [...this.snapshots.values()]) {
      snapshot.closing = true;
      if (snapshot.uses === 0) await this.dispose(snapshot);
    }
  }

  private async capture(paths?: string[], owner?: string): Promise<Record<string, unknown>> {
    const limits = this.source.config;
    await this.collectExpired();
    if (this.snapshots.size >= limits.maxSnapshots) throw new Error(`Snapshot limit reached (maximum ${limits.maxSnapshots}); end an unused snapshot`);

    await this.source.refresh();
    const before = await sourceSnapshot(this.source, paths);
    const visible = new Map((await this.source.visibleFiles(paths)).map(file => [file.path, file]));
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

      // The user's staged overlay (replica workflow) is merged over the shared ROOT: puts replace or add files,
      // deletes hide them. Stability is still checked against the ROOT alone, so the shared state is what must not move.
      const overlay = owner === undefined ? undefined : new UserOverlay(this.cacheRoot_(), owner);
      const staged = overlay ? await overlay.entries() : {};
      const stagedPaths = Object.keys(staged).filter(file => within(file, paths)).sort();
      const store = async (file: string, content: string) => {
        bytes += Buffer.byteLength(content);
        if (bytes > limits.snapshotMaxBytes) throw new Error(`Snapshot exceeds the ${limits.snapshotMaxBytes} byte corpus limit; use begin paths or raise snapshotMaxBytes`);
        if (inUseBytes + bytes > limits.snapshotsTotalBytes) throw new Error(`Active snapshots exceed the ${limits.snapshotsTotalBytes} byte total limit`);
        const destination = path.resolve(canonicalCorpus, file);
        if (!isWithin(canonicalCorpus, destination)) throw new Error(`Unsafe snapshot document path: ${file}`);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content, { mode: 0o600, flag: 'wx' });
        documents++;
      };

      const fingerprint = createHash('sha256');
      const documentFingerprints: Record<string, string> = {};
      const merged: Array<{ path: string; kind: string; content: string }> = [];
      const handled = new Set<string>();
      for (const entry of entries) {
        const document = await this.source.tryRead(entry.path);
        if (!document) continue;
        handled.add(entry.path);
        fingerprint.update(JSON.stringify([entry.path, entry.kind, document.content]));
        documentFingerprints[entry.path] = createHash('sha256').update(JSON.stringify([entry.kind, document.content])).digest('hex');
        const change = Object.hasOwn(staged, entry.path) ? staged[entry.path] : undefined;
        if (change?.op === 'delete') continue;
        const content = change ? (await overlay!.content(entry.path)) as string : document.content;
        await store(entry.path, content);
        if (!change && document.entry.metadata) metadata.set(entry.path, { ...document.entry.metadata });
        merged.push({ path: entry.path, kind: entry.kind, content });
      }
      for (const file of stagedPaths) {
        if (handled.has(file) || staged[file].op === 'delete') continue;
        const content = (await overlay!.content(file)) as string;
        await store(file, content);
        merged.push({ path: file, kind: classify(file), content });
      }
      for (const file of stagedPaths) {
        if (staged[file].op === 'delete') visible.delete(file);
        else visible.set(file, { path: file, indexed: true, size: Buffer.byteLength((await overlay!.content(file)) as string) });
      }
      const structure = [...visible.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const structureHash = createHash('sha256');
      for (const file of structure) structureHash.update(`${file.path}\0${file.indexed ? 1 : 0}\0${file.size ?? ''}\n`);
      const structureVersion = structureHash.digest('hex');

      const rootVersion = fingerprint.digest('hex');
      let version = rootVersion;
      if (stagedPaths.length) {
        const combined = createHash('sha256');
        for (const item of merged.sort((a, b) => a.path.localeCompare(b.path))) {
          combined.update(JSON.stringify([item.path, item.kind, item.content]));
        }
        version = combined.digest('hex');
      }
      const after = await sourceSnapshot(this.source, paths);
      if (JSON.stringify(before) !== JSON.stringify(after) || before.corpusFingerprint !== rootVersion) {
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
      const basisVersion = stagedPaths.length ? undefined : basisFingerprint(documentFingerprints);
      await knowledge.semanticIndex.seedFrom(this.source.semanticIndex, version, basisVersion);
      const expiresAt = Date.now() + limits.snapshotTtlMs;
      const snapshot: KnowledgeSnapshot = {
        snapshotId: id,
        version,
        ...(basisVersion ? { basisVersion } : {}),
        sourceBasis: JSON.stringify(before),
        overlayBasis: JSON.stringify(staged),
        expiresAt: new Date(expiresAt).toISOString(),
        capturedAt: new Date().toISOString(),
        provenance: {
          source: 'filesystem',
          head: before.head,
          branch: before.branch,
          dirty: before.dirty,
          statusFingerprint: before.statusFingerprint,
          indexedSource,
          ...(overlay && stagedPaths.length ? { overlay: { owner: overlay.owner, files: stagedPaths.length } } : {}),
        },
        knowledge,
        structure,
        structureVersion,
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
    const leased = this.leaseOf(snapshotId);
    if (leased) {
      // Shared snapshot: release only; it closes once idle (or at the user's next begin after that).
      const [, lease] = leased;
      lease.holders = Math.max(0, lease.holders - 1);
      lease.lastUsed = Date.now();
      return { operation: 'end', snapshotId, ended: true, retained: true, holders: lease.holders,
        closesAfterIdleMs: snapshotScope() === 'session' ? null : durationEnv('KIMONO_SNAPSHOT_IDLE_MS', 120_000) };
    }
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
    const leased = this.leaseOf(snapshotId);
    if (leased) this.touch(leased[1], snapshot);
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

  private cacheRoot_(): string {
    return this.source.searchIndex.directory;
  }

  private describe(snapshot: KnowledgeSnapshot) {
    return {
      operation: 'begin',
      snapshotId: snapshot.snapshotId,
      version: snapshot.version,
      structureVersion: snapshot.structureVersion,
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
    clearSearchCache(snapshot.knowledge);
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
