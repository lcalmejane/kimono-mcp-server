import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { snapshotsFor } from '../src/snapshots.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const header = '> **Version**: 1.0 | **Date**: 2026-10-31 | **Statut**: Active\n';
const dir = 'prompts/gen/concepts';

async function fixture() {
  const base = await mkdtemp(path.resolve('.snapshot-overlay-test-'));
  directories.push(base);
  const root = path.join(base, 'kimono-root');
  const workspace = path.join(base, 'user-workspace');
  await mkdir(path.join(root, dir), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Index\n');
  await writeFile(path.join(root, `${dir}/kept.md`), `${header}# Kept shared\n`);
  await writeFile(path.join(root, `${dir}/edited.md`), `${header}# Edited shared original\n`);
  await writeFile(path.join(root, `${dir}/removed.md`), `${header}# Removed shared\n`);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(base, 'cache'));
  vi.stubEnv('FGR_BIN', 'fgr-test');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const runtime = runtimeFor(knowledge);
  const collaboration = async (input: Record<string, unknown>) =>
    JSON.parse(await runtime.call('aikido_collaboration', { clientRoot: workspace, ...input }));
  const begin = async (owner?: string) =>
    JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin', ...(owner ? { owner } : {}) }));
  const read = async (snapshotId: string, file: string) =>
    JSON.parse(await runtime.call('aikido_file', { operation: 'read', path: file, full: true, snapshotId })).content as string;
  const end = (snapshotId: string) => runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
  return { root, knowledge, runtime, collaboration, begin, read, end };
}

describe('snapshot with a per-user overlay', () => {
  it('merges the owner overlay over the shared ROOT, hides deletions and leaves everyone else untouched', async () => {
    const { root, knowledge, collaboration, begin, read, end } = await fixture();
    await collaboration({ operation: 'stage', owner: 'alice', changes: [
      { path: `${dir}/added.md`, content: `${header}# Added by alice\n` },
      { path: `${dir}/edited.md`, content: `${header}# Edited by alice\n` },
      { path: `${dir}/removed.md`, content: null },
    ] });

    const plain = await begin();
    const alice = await begin('alice');
    const bob = await begin('bob');
    try {
      expect(plain.provenance.overlay).toBeUndefined();
      expect(bob.provenance.overlay).toBeUndefined();
      expect(bob.version).toBe(plain.version);
      expect(alice.provenance.overlay).toEqual({ owner: 'alice', files: 3 });
      expect(alice.version).toMatch(/^[a-f0-9]{64}$/);
      expect(alice.version).not.toBe(plain.version);
      expect(alice.documents).toBe(plain.documents); // +1 added, -1 removed

      expect(await read(alice.snapshotId, `${dir}/added.md`)).toContain('Added by alice');
      expect(await read(alice.snapshotId, `${dir}/edited.md`)).toContain('Edited by alice');
      expect(await read(alice.snapshotId, `${dir}/kept.md`)).toContain('Kept shared');
      await expect(read(alice.snapshotId, `${dir}/removed.md`)).rejects.toThrow();

      for (const snapshot of [plain, bob]) {
        await expect(read(snapshot.snapshotId, `${dir}/added.md`)).rejects.toThrow();
        expect(await read(snapshot.snapshotId, `${dir}/edited.md`)).toContain('Edited shared original');
        expect(await read(snapshot.snapshotId, `${dir}/removed.md`)).toContain('Removed shared');
      }

      const listed = (id: string) => snapshotsFor(knowledge).withSnapshot(id, async snapshot =>
        snapshot.knowledge.list().map(entry => entry.path));
      expect(await listed(alice.snapshotId)).toEqual(expect.arrayContaining([`${dir}/added.md`, `${dir}/kept.md`, `${dir}/edited.md`]));
      expect(await listed(alice.snapshotId)).not.toContain(`${dir}/removed.md`);
      expect(await listed(bob.snapshotId)).toContain(`${dir}/removed.md`);
      expect(await listed(bob.snapshotId)).not.toContain(`${dir}/added.md`);
    } finally {
      await end(plain.snapshotId); await end(alice.snapshotId); await end(bob.snapshotId);
    }
    await expect(readFile(path.join(root, `${dir}/added.md`))).rejects.toThrow();
    expect(await readFile(path.join(root, `${dir}/edited.md`), 'utf8')).toContain('Edited shared original');
    expect(await readFile(path.join(root, `${dir}/removed.md`), 'utf8')).toContain('Removed shared');
  });

  it('respects begin paths and returns to the shared view once the overlay is synchronized', async () => {
    const { runtime, collaboration, begin, read, end } = await fixture();
    await collaboration({ operation: 'stage', owner: 'alice', changes: [
      { path: `${dir}/added.md`, content: `${header}# Added by alice\n` },
      { path: 'prompts/other.md', content: '# Other\n' },
    ] });

    const scoped = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin', owner: 'alice', paths: [dir] }));
    try {
      expect(scoped.provenance.overlay).toEqual({ owner: 'alice', files: 1 });
      expect(await read(scoped.snapshotId, `${dir}/added.md`)).toContain('Added by alice');
      await expect(read(scoped.snapshotId, 'prompts/other.md')).rejects.toThrow();
    } finally { await end(scoped.snapshotId); }

    const synced = await collaboration({ operation: 'sync', owner: 'alice' });
    expect(synced.published.sort()).toEqual([`${dir}/added.md`, 'prompts/other.md']);
    const after = await begin('alice');
    const shared = await begin();
    try {
      expect(after.provenance.overlay).toBeUndefined(); // overlay is empty: nothing left to merge
      expect(after.version).toBe(shared.version);
      expect(await read(shared.snapshotId, `${dir}/added.md`)).toContain('Added by alice');
    } finally { await end(after.snapshotId); await end(shared.snapshotId); }
  });

  it('rejects an invalid owner and treats an owner without overlay as the plain shared view', async () => {
    const { runtime, begin, end } = await fixture();
    await expect(runtime.call('aikido_snapshot', { operation: 'begin', owner: '../evil' })).rejects.toThrow('owner');
    const plain = await begin();
    const nobody = await begin('nobody');
    try { expect(nobody.version).toBe(plain.version); expect(nobody.provenance.overlay).toBeUndefined(); }
    finally { await end(plain.snapshotId); await end(nobody.snapshotId); }
  });
});
