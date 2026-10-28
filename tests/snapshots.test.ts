import { corpusConfig } from '../src/corpus-config.js';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { FastGrepIndex } from '../src/search.js';
import { snapshotsFor } from '../src/snapshots.js';
import { searchCacheFor } from '../src/search-cache.js';

const roots: string[] = [];
const caches: string[] = [];
const originalCache = process.env.KIMONO_CACHE_DIR;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-snapshot-'));
  roots.push(root);
  const cache = path.join(path.dirname(root), `kimono-cache-${path.basename(root)}`);
  caches.push(cache);
  process.env.KIMONO_CACHE_DIR = cache;
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Project\nCaptured version');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  return { root, knowledge };
}

afterEach(async () => {
  vi.useRealTimers();
  if (originalCache === undefined) delete process.env.KIMONO_CACHE_DIR;
  else process.env.KIMONO_CACHE_DIR = originalCache;
  await Promise.all([...roots.splice(0), ...caches.splice(0)].map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('explicit research snapshots', () => {
  it('shares raw search results across formats, isolates parameters and clears on snapshot end', async () => {
    const { knowledge } = await fixture();
    const runtime = runtimeFor(knowledge);
    const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    const calls = vi.spyOn(FastGrepIndex.prototype, 'search');
    try {
      const input = { snapshotId, query: 'Captured', mode: 'literal' };
      const responses = await Promise.all([
        runtime.call('aikido_search', { ...input, detail: 'compact' }),
        runtime.call('aikido_search', { ...input, detail: 'excerpts', contextLines: 0 }),
      ]);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(JSON.parse(responses[0]).results).toHaveLength(1);
      expect(responses[1]).toContain('Captured version');
      await runtime.call('aikido_search', { ...input, limit: 1 });
      await runtime.call('aikido_search', { ...input, pathPrefix: 'prompts/index.md' });
      expect(calls).toHaveBeenCalledTimes(3);
      const cache = await snapshotsFor(knowledge).withSnapshot(snapshotId, async snapshot => searchCacheFor(snapshot.knowledge));
      await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
      const compute = vi.fn(async () => ({ results: [], metadata: {} }));
      await cache.search('closed', compute);
      await cache.search('closed', compute);
      expect(compute).toHaveBeenCalledTimes(2);
      await expect(runtime.call('aikido_search', input)).rejects.toThrow('unknown or stale');
    } finally { calls.mockRestore(); }
  });

  it('builds a literal index on captured paths and never searches the mutable source or copied absolute paths', async () => {
    const { root, knowledge } = await fixture();
    await knowledge.searchIndex.synchronize();
    const runtime = runtimeFor(knowledge);
    const search = async (snapshotId: string, query: string) => JSON.parse(await runtime.call('aikido_search', {
      snapshotId, query, mode: 'literal',
    }));
    const read = vi.spyOn(AikidoKnowledgeBase.prototype, 'read');
    let { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    read.mockClear();
    expect((await search(snapshotId, 'Captured')).results).toHaveLength(1);
    // Retrieval reads the hit once. A rebuild would read every document repeatedly.
    expect(read).toHaveBeenCalledTimes(1);
    await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });

    await writeFile(path.join(root, 'prompts/index.md'), '# Project\nUnindexed version');
    ({ snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' })));
    await writeFile(path.join(root, 'prompts/index.md'), '# Project\nLater version');
    expect((await search(snapshotId, 'Unindexed')).results).toHaveLength(1);
    expect((await search(snapshotId, 'Later')).results).toHaveLength(0);
    await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
    read.mockRestore();
  });
  it('keeps file reads pinned to captured content after the source changes', async () => {
    const { root, knowledge } = await fixture();
    const runtime = runtimeFor(knowledge);
    const begun = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    expect(begun).toMatchObject({
      operation: 'begin',
      snapshotId: expect.any(String),
      version: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: { source: 'filesystem' },
    });

    const corpus = path.join(knowledge.searchIndex.directory, 'snapshots', begun.snapshotId, 'corpus');
    const snapshotCache = new AikidoKnowledgeBase(corpus, false, corpusConfig({ mode: 'aikido' })).searchIndex.directory;
    expect(snapshotCache).not.toContain(path.join('snapshots', begun.snapshotId, 'corpus'));
    expect(await readFile(path.join(corpus, 'prompts/index.md'), 'utf8')).toContain('Captured version');

    await writeFile(path.join(root, 'prompts/index.md'), '# Project\nUpdated version');
    const captured = JSON.parse(await runtime.call('aikido_file', {
      operation: 'read', path: 'prompts/index.md', full: true, snapshotId: begun.snapshotId,
    }));
    expect(captured.snapshotId).toBe(begun.snapshotId);
    expect(captured.version).toBe(begun.version);
    expect(captured.content).toContain('Captured version');
    expect(captured.content).not.toContain('Updated version');

    expect(JSON.parse(await runtime.call('aikido_snapshot', { operation: 'end', snapshotId: begun.snapshotId })))
      .toMatchObject({ operation: 'end', ended: true });
    await expect(runtime.call('aikido_file', {
      operation: 'read', path: 'prompts/index.md', snapshotId: begun.snapshotId,
    })).rejects.toThrow('unknown or stale');
    await expect(readFile(path.join(corpus, 'prompts/index.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed and expired snapshot identifiers explicitly', async () => {
    const { knowledge } = await fixture();
    const runtime = runtimeFor(knowledge);
    await expect(runtime.call('aikido_file', { operation: 'read', path: 'prompts/index.md' }))
      .rejects.toThrow('snapshotId');
    await expect(runtime.call('aikido_file', {
      operation: 'read', path: 'prompts/index.md', snapshotId: 'not-a-snapshot',
    })).rejects.toThrow('snapshotId must be a UUID');
    const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    const cache = await snapshotsFor(knowledge).withSnapshot(snapshotId, async snapshot => searchCacheFor(snapshot.knowledge));
    const compute = vi.fn(async () => ({ results: [], metadata: {} }));
    await cache.search('expire', compute);
    await cache.search('expire', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
    await expect(runtime.call('aikido_file', {
      operation: 'read', path: 'prompts/index.md', snapshotId,
    })).rejects.toThrow('expired');
    await cache.search('expire', compute);
    await cache.search('expire', compute);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('keeps different knowledge roots isolated when they share the same cache parent', async () => {
    const { root, knowledge } = await fixture();
    const otherRoot = path.join(path.dirname(root), `${path.basename(root)}-other`);
    roots.push(otherRoot);
    await mkdir(otherRoot);
    await writeFile(path.join(otherRoot, 'index.md'), '# Other project');
    const other = new AikidoKnowledgeBase(otherRoot, false, corpusConfig({ mode: 'aikido' }));
    await other.initialize();
    const first = runtimeFor(knowledge);
    const second = runtimeFor(other);
    const a = JSON.parse(await first.call('aikido_snapshot', { operation: 'begin' }));
    const b = JSON.parse(await second.call('aikido_snapshot', { operation: 'begin' }));
    expect(JSON.parse(await first.call('aikido_file', {
      operation: 'read', path: 'prompts/index.md', snapshotId: a.snapshotId,
    })).content).toContain('Captured version');
    await first.call('aikido_snapshot', { operation: 'end', snapshotId: a.snapshotId });
    expect(JSON.parse(await second.call('aikido_file', {
      operation: 'read', path: 'index.md', snapshotId: b.snapshotId,
    })).content).toContain('Other project');
    await second.call('aikido_snapshot', { operation: 'end', snapshotId: b.snapshotId });
  });
});
