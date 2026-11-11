import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import { snapshotsFor } from '../src/snapshots.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function knowledge() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-scope-'));
  directories.push(root);
  await writeFile(path.join(root, 'a.md'), '# a\n');
  const base = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  directories.push(base.searchIndex.directory);
  await base.initialize();
  return base;
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it('prompt scope: delegated begins share one snapshot, end only releases, idle closes it for sure', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  vi.stubEnv('KIMONO_SNAPSHOT_IDLE_MS', '1000');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const orchestrator = await manager.begin();
  const delegated = await manager.begin();
  expect(delegated).toMatchObject({ snapshotId: orchestrator.snapshotId, reused: true, scope: 'prompt' });
  expect(await manager.end(String(delegated.snapshotId))).toMatchObject({ retained: true, holders: 1 });
  expect(await manager.end(String(orchestrator.snapshotId))).toMatchObject({ retained: true, holders: 0 });
  // Still usable right after the last end (next sequence of the same prompt).
  await manager.withSnapshot(String(orchestrator.snapshotId), async () => undefined);
  expect((await manager.begin()).snapshotId).toBe(orchestrator.snapshotId);
  await manager.end(String(orchestrator.snapshotId));
  await wait(1300);
  await expect(manager.withSnapshot(String(orchestrator.snapshotId), async () => undefined)).rejects.toThrow(/unknown|ended/);
});

it('prompt scope: a begin after the idle gap closes the released snapshot and captures a fresh one', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  vi.stubEnv('KIMONO_SNAPSHOT_IDLE_MS', '1000');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const first = await manager.begin();
  await manager.end(String(first.snapshotId));
  await wait(1100);
  const second = await manager.begin();
  expect(second).toMatchObject({ reused: false });
  expect(second.snapshotId).not.toBe(first.snapshotId);
  await expect(manager.withSnapshot(String(first.snapshotId), async () => undefined)).rejects.toThrow(/unknown|ended/);
  await manager.closeAll();
});

it('scopes are per user and path set; call scope keeps one snapshot per begin', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const alice = await manager.begin(undefined, 'alice');
  const bob = await manager.begin(undefined, 'bob');
  const scoped = await manager.begin(['a.md'], 'alice');
  expect(new Set([alice.snapshotId, bob.snapshotId, scoped.snapshotId]).size).toBe(3);
  await manager.closeAll();
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'call');
  const one = await manager.begin();
  const two = await manager.begin();
  expect(one.snapshotId).not.toBe(two.snapshotId);
  expect(await manager.end(String(one.snapshotId))).not.toHaveProperty('retained');
  await manager.closeAll();
});

// ---- Documented use cases (docs/retrieval.md, docs/usage.*.md, Tatami architecture) under the default prompt scope.
import { mkdir } from 'node:fs/promises';
import { runtimeFor } from '../src/runtime-tools.js';
import { withPrincipal } from '../src/principal.js';

const header = '> **Version**: 1.0 | **Date**: 2026-10-31 | **Statut**: Active\n';
async function aikidoFixture() {
  const base = await mkdtemp(path.resolve('.scope-test-'));
  directories.push(base);
  const root = path.join(base, 'root');
  const workspace = path.join(base, 'workspace');
  await mkdir(path.join(root, 'prompts/gen/concepts'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Index\n');
  await writeFile(path.join(root, 'prompts/gen/concepts/index.md'), `${header}# Concepts\n`);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(base, 'cache'));
  vi.stubEnv('FGR_BIN', 'fgr-test');
  const base_ = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await base_.initialize();
  return { root, workspace, knowledge: base_ };
}

it('released snapshot + source edit: the next begin sees the edit ("open a new snapshot to see edits")', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const first = await manager.begin();
  await manager.end(String(first.snapshotId));
  await writeFile(path.join(base.root, 'a.md'), '# edited\n');
  const second = await manager.begin();
  expect(second).toMatchObject({ reused: false });
  expect(second.version).not.toBe(first.version);
  // Unchanged source: released snapshot reused, no churn.
  await manager.end(String(second.snapshotId));
  expect(await manager.begin()).toMatchObject({ snapshotId: second.snapshotId, reused: true });
  await manager.closeAll();
});

it('a change during a held snapshot gives the next begin a new capture; the holder keeps reading its own; fresh forces one', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const orchestrator = await manager.begin();
  // Unchanged corpus: delegated begins reuse it.
  expect(await manager.begin()).toMatchObject({ snapshotId: orchestrator.snapshotId, reused: true });
  await writeFile(path.join(base.root, 'a.md'), '# edited during the prompt\n');
  const changed = await manager.begin();
  expect(changed).toMatchObject({ reused: false });
  // The orchestrator's snapshot is still readable and can be ended by its holders.
  await manager.withSnapshot(String(orchestrator.snapshotId), async () => undefined);
  expect(await manager.end(String(orchestrator.snapshotId))).toMatchObject({ retained: true });
  const fresh = await manager.begin(undefined, undefined, true);
  expect(fresh.snapshotId).not.toBe(changed.snapshotId);
  await manager.withSnapshot(String(changed.snapshotId), async () => undefined);
  expect(await manager.begin()).toMatchObject({ snapshotId: fresh.snapshotId, reused: true });
  await manager.closeAll();
});

it('a holder that never ends is closed after the held idle window (guaranteed closing)', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  vi.stubEnv('KIMONO_SNAPSHOT_IDLE_MS', '1000');
  vi.stubEnv('KIMONO_SNAPSHOT_HELD_IDLE_MS', '1000');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const forgotten = await manager.begin();
  await wait(1700);
  await expect(manager.withSnapshot(String(forgotten.snapshotId), async () => undefined)).rejects.toThrow(/unknown|ended/);
});

it('Tatami: one instance per project, snapshots are per trusted principal, never shared across users', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  const alice = await withPrincipal('alice', () => manager.begin());
  const bob = await withPrincipal('bob', () => manager.begin());
  const aliceAgain = await withPrincipal('alice', () => manager.begin());
  expect(bob.snapshotId).not.toBe(alice.snapshotId);
  expect(aliceAgain).toMatchObject({ snapshotId: alice.snapshotId, reused: true });
  await manager.closeAll();
});

it('with many concurrent users, released snapshots are evicted instead of hitting the 8-snapshot limit', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const base = await knowledge();
  const manager = snapshotsFor(base);
  for (let user = 0; user < 12; user++) {
    const snapshot = await withPrincipal(`user${user}`, () => manager.begin());
    await manager.end(String(snapshot.snapshotId));
  }
  await manager.closeAll();
});

it('owner overlay: a newly staged edit gives a fresh owner snapshot; other users still see the shared ROOT', async () => {
  vi.stubEnv('KIMONO_SNAPSHOT_SCOPE', 'prompt');
  const { workspace, knowledge: base } = await aikidoFixture();
  const runtime = runtimeFor(base);
  const manager = snapshotsFor(base);
  const before = await manager.begin(undefined, 'alice');
  await manager.end(String(before.snapshotId));
  await runtime.call('aikido_collaboration', { clientRoot: workspace, operation: 'stage', owner: 'alice',
    changes: [{ path: 'prompts/gen/concepts/new.md', content: `${header}# New\n` }] });
  const after = await manager.begin(undefined, 'alice');
  expect(after).toMatchObject({ reused: false });
  expect(after.provenance).toMatchObject({ overlay: { owner: 'alice', files: 1 } });
  const shared = await manager.begin();
  expect((shared.provenance as { overlay?: unknown }).overlay).toBeUndefined();
  await manager.closeAll();
});
