import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const header = '> **Version**: 1.0 | **Date**: 2026-10-31 | **Statut**: Active\n';

async function fixture() {
  const base = await mkdtemp(path.resolve('.delta-test-'));
  directories.push(base);
  const root = path.join(base, 'kimono-root');
  const workspace = path.join(base, 'user-workspace');
  await mkdir(path.join(root, 'prompts/gen/concepts'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Index\n');
  await writeFile(path.join(root, 'prompts/gen/concepts/index.md'), `${header}# Concepts\n`);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(base, 'cache'));
  vi.stubEnv('FGR_BIN', 'fgr-test');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const runtime = runtimeFor(knowledge);
  const call = async (input: Record<string, unknown>) =>
    JSON.parse(await runtime.call('aikido_collaboration', { clientRoot: workspace, ...input }));
  return { base, root, workspace, knowledge, call };
}

describe('collaboration mode detection', () => {
  it('reports same-root when the client workspace is the exact ROOT, replica otherwise', async () => {
    const { root, call } = await fixture();
    expect(await call({ operation: 'mode', clientRoot: root })).toMatchObject({ mode: 'same-root', verified: true });
    expect(await call({ operation: 'mode' })).toMatchObject({ mode: 'replica', verified: true });
  });
});

describe('same-root: files are already synchronized', () => {
  it('never stages, publishes or writes anything, and tells the caller to reindex', async () => {
    const { root, call, knowledge } = await fixture();
    const before = await readFile(path.join(root, 'prompts/index.md'), 'utf8');
    for (const input of [
      { operation: 'stage', changes: [{ path: 'prompts/gen/concepts/x.md', content: `${header}# X` }] },
      { operation: 'sync', changes: [{ path: 'prompts/gen/concepts/x.md', content: `${header}# X` }] },
      { operation: 'overlay' }, { operation: 'discard', paths: ['prompts/gen/concepts/x.md'] },
    ]) expect(await call({ ...input, clientRoot: root })).toMatchObject({ mode: 'same-root', skipped: true });
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).toBe(before);
    await expect(readFile(path.join(root, 'prompts/gen/concepts/x.md'))).rejects.toThrow();
    await expect(readdir(path.join(knowledge.searchIndex.directory, 'collaboration', 'overlays'))).rejects.toThrow();
  });
});

describe('replica: per-user overlay synchronized into the shared ROOT', () => {
  it('keeps staged files in the overlay without touching ROOT, then publishes them with sync', async () => {
    const { root, call } = await fixture();
    const fiche = `${header}# Fiche\n[source](fiche.md) [index](index.md)\n[cassé](absent.md)\n`;
    const staged = await call({ operation: 'stage', owner: 'alice', changes: [{ path: 'prompts/gen/concepts/fiche.md', content: fiche }] });
    expect(staged).toMatchObject({ mode: 'replica', owner: 'alice', staged: ['prompts/gen/concepts/fiche.md'] });
    expect(staged.items).toEqual([expect.objectContaining({
      path: 'prompts/gen/concepts/fiche.md', op: 'put', status: 'pending', warnings: ['broken relative link: absent.md'],
    })]);
    await expect(readFile(path.join(root, 'prompts/gen/concepts/fiche.md'))).rejects.toThrow();
    expect((await call({ operation: 'overlay', owner: 'alice' })).items).toHaveLength(1);
    expect((await call({ operation: 'overlay', owner: 'bob' })).items).toHaveLength(0);

    const synced = await call({ operation: 'sync', owner: 'alice' });
    expect(synced).toMatchObject({
      published: ['prompts/gen/concepts/fiche.md'], integrated: [], conflicts: [], remaining: [],
      reindexPaths: ['prompts/gen/concepts/fiche.md'],
    });
    expect(await readFile(path.join(root, 'prompts/gen/concepts/fiche.md'), 'utf8')).toBe(fiche);
    expect((await call({ operation: 'overlay', owner: 'alice' })).items).toHaveLength(0);
    const again = await call({ operation: 'sync', owner: 'alice' });
    expect(again).toMatchObject({ published: [], integrated: [], conflicts: [], reindexPaths: [] });
  });

  it('accepts inline changes in sync (stage + publish in one call), including deletions', async () => {
    const { root, call } = await fixture();
    await writeFile(path.join(root, 'prompts/gen/concepts/old.md'), `${header}# Old\n`);
    const result = await call({ operation: 'sync', owner: 'alice', changes: [
      { path: 'prompts/gen/concepts/new.md', content: `${header}# New\n` },
      { path: 'prompts/gen/concepts/old.md', content: null },
    ] });
    expect(result.published.sort()).toEqual(['prompts/gen/concepts/new.md', 'prompts/gen/concepts/old.md']);
    expect(await readFile(path.join(root, 'prompts/gen/concepts/new.md'), 'utf8')).toContain('# New');
    await expect(readFile(path.join(root, 'prompts/gen/concepts/old.md'))).rejects.toThrow();
  });

  it('drops staged files the global repository already contains (integrated) and publishes nothing for them', async () => {
    const { root, call } = await fixture();
    const content = `${header}# Same\n`;
    await call({ operation: 'stage', owner: 'alice', changes: [{ path: 'prompts/gen/concepts/same.md', content }] });
    // The same file reaches the global repository by another route (git pull, teammate, remote sync...).
    await writeFile(path.join(root, 'prompts/gen/concepts/same.md'), content);
    const synced = await call({ operation: 'sync', owner: 'alice' });
    expect(synced).toMatchObject({ published: [], integrated: ['prompts/gen/concepts/same.md'], conflicts: [], remaining: [] });
    expect((await call({ operation: 'overlay', owner: 'alice' })).items).toHaveLength(0);
  });

  it('reports conflicts and resolves them only with explicit local/shared choices', async () => {
    const { root, call } = await fixture();
    const file = 'prompts/gen/concepts/shared.md';
    await writeFile(path.join(root, file), `${header}# v1\n`);
    await call({ operation: 'stage', owner: 'alice', changes: [{ path: file, content: `${header}# alice\n` }] });
    await writeFile(path.join(root, file), `${header}# bob got there first\n`);

    const blocked = await call({ operation: 'sync', owner: 'alice' });
    expect(blocked.published).toEqual([]);
    expect(blocked.conflicts).toEqual([expect.objectContaining({ path: file })]);
    expect(await readFile(path.join(root, file), 'utf8')).toContain('bob got there first');
    expect((await call({ operation: 'overlay', owner: 'alice' })).items[0]).toMatchObject({ path: file, status: 'conflict' });

    await expect(call({ operation: 'sync', owner: 'alice', resolutions: { 'prompts/gen/concepts/other.md': 'local' } }))
      .rejects.toThrow('does not apply');
    const kept = await call({ operation: 'sync', owner: 'alice', resolutions: { [file]: 'shared' } });
    expect(kept).toMatchObject({ published: [], discarded: [file], conflicts: [], remaining: [] });
    expect(await readFile(path.join(root, file), 'utf8')).toContain('bob got there first');

    await call({ operation: 'stage', owner: 'alice', changes: [{ path: file, content: `${header}# alice again\n` }] });
    await writeFile(path.join(root, file), `${header}# bob again\n`);
    const forced = await call({ operation: 'sync', owner: 'alice', resolutions: { [file]: 'local' } });
    expect(forced).toMatchObject({ published: [file], conflicts: [] });
    expect(await readFile(path.join(root, file), 'utf8')).toContain('alice again');
  });

  it('lets two users sync different files in parallel without losing either', async () => {
    const { root, call } = await fixture();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => call({
      operation: 'sync', owner: `user${index}`,
      changes: [{ path: `prompts/gen/concepts/parallel-${index}.md`, content: `${header}# Parallel ${index}\n` }],
    })));
    for (const [index, result] of results.entries()) expect(result.published).toEqual([`prompts/gen/concepts/parallel-${index}.md`]);
    for (let index = 0; index < 6; index++) {
      expect(await readFile(path.join(root, `prompts/gen/concepts/parallel-${index}.md`), 'utf8')).toContain(`Parallel ${index}`);
    }
  });

  it('discards staged paths and rejects invalid input', async () => {
    const { call } = await fixture();
    await call({ operation: 'stage', owner: 'alice', changes: [{ path: 'prompts/gen/concepts/tmp.md', content: `${header}# Tmp\n` }] });
    const discarded = await call({ operation: 'discard', owner: 'alice', paths: ['prompts/gen/concepts/tmp.md'] });
    expect(discarded).toMatchObject({ discarded: ['prompts/gen/concepts/tmp.md'], items: [] });
    await expect(call({ operation: 'stage', owner: '../evil', changes: [{ path: 'prompts/a.md', content: 'x' }] })).rejects.toThrow('owner');
    await expect(call({ operation: 'stage', owner: 'alice', changes: [{ path: '../x.md', content: 'x' }] })).rejects.toThrow('Unsafe');
    await expect(call({ operation: 'stage', owner: 'alice' })).rejects.toThrow('at least one change');
    await expect(call({ operation: 'overlay', owner: 'alice', bogus: 1 })).rejects.toThrow('Unknown');
  });
});
