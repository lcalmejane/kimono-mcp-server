import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { synchronizationPaths } from '../src/synchronization.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  // Keep test data in the project rather than the host's temporary directory.
  const root = await mkdtemp(path.resolve('.sync-test-'));
  directories.push(root);
  await mkdir(path.join(root, 'prompts/selected'), { recursive: true });
  await mkdir(path.join(root, 'prompts/selected-neighbor'), { recursive: true });
  for (const file of ['index.md', 'selected/edit.md', 'selected/delete.md', 'selected/empty.md', 'selected-neighbor/keep.md']) {
    await writeFile(path.join(root, 'prompts', file), file.endsWith('empty.md') ? '' : `old ${file}`);
  }
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  directories.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return { root, knowledge, runtime: runtimeFor(knowledge) };
}

describe('synchronization path contract', () => {
  it('normalizes boundaries and overlaps without expanding unsafe paths', () => {
    expect(synchronizationPaths('src/file.ts')).toEqual(['src/file.ts']);
    expect(synchronizationPaths(['prompts/selected/edit.md', 'prompts/selected/', 'prompts/selected', 'prompts/selected-neighbor']))
      .toEqual(['prompts/selected', 'prompts/selected-neighbor']);
    for (const invalid of [[], [''], ['/'], ['/etc'], ['../file'], ['a/../file'], ['./a'], ['a\\b'], ['a//b'], [42], ['a\0']]) {
      expect(() => synchronizationPaths(invalid)).toThrow();
    }
  });
});

describe.skipIf(!process.env.KIMONO_MODEL_DIR)('real engines: targeted synchronization', () => {
  it('updates both independent baselines, deletes missing files, and never rereads or reembeds unselected documents', async () => {
    const { root, knowledge, runtime } = await fixture();
    const call = async (input: Record<string, unknown>) => JSON.parse(await runtime.call('aikido_index', input));
    await call({ operation: 'update', mode: 'all' });
    const stateFile = path.join(knowledge.searchIndex.directory, 'semantic/state.json');
    const before = JSON.parse(await readFile(stateFile, 'utf8'));
    const ownersBefore = JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, 'literal-state.json'), 'utf8'));
    await writeFile(path.join(root, 'prompts/selected/edit.md'), 'new targeted document');
    await writeFile(path.join(root, 'prompts/selected/new.md'), 'new targeted addition');
    await writeFile(path.join(root, 'prompts/selected-neighbor/keep.md'), 'unselected external mutation');
    await writeFile(path.join(root, 'prompts/index.md'), 'unselected entrypoint mutation');
    await rm(path.join(root, 'prompts/selected/delete.md'));
    await rm(path.join(root, 'prompts/selected/empty.md'));
    const read = vi.spyOn(knowledge, 'read');
    const result = await call({ operation: 'update', mode: 'all',
      paths: ['prompts/selected', 'prompts/selected/edit.md', 'prompts/selected/'] });
    expect(result.scope).toEqual(['prompts/selected']);
    const changes = { added: ['prompts/selected/new.md'], modified: ['prompts/selected/edit.md'],
      deleted: ['prompts/selected/delete.md', 'prompts/selected/empty.md'] };
    expect(result.indexes.literal.changes).toEqual(changes);
    expect(result.indexes.semantic.changes).toEqual(changes);
    expect(result.indexes.semantic.embedded).toBe(2);
    expect(read.mock.calls.map(([file]) => file).sort()).toEqual([
      'prompts/selected/edit.md', 'prompts/selected/edit.md', 'prompts/selected/new.md', 'prompts/selected/new.md',
    ]);
    expect(await readFile(path.join(knowledge.searchIndex.directory, 'documents/prompts/selected-neighbor/keep.md'), 'utf8'))
      .toBe('old selected-neighbor/keep.md');
    const after = JSON.parse(await readFile(stateFile, 'utf8'));
    expect(after.chunks['prompts/selected-neighbor/keep.md#0']).toEqual(before.chunks['prompts/selected-neighbor/keep.md#0']);
    const ownersAfter = JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, 'literal-state.json'), 'utf8'));
    expect(ownersAfter['prompts/selected-neighbor/keep.md']).toBe(ownersBefore['prompts/selected-neighbor/keep.md']);
    // A no-op targeted call must not invoke literal reindexing or document inference.
    const unchanged = await call({ operation: 'update', mode: 'all', paths: ['prompts/selected'] });
    expect(unchanged.indexes.literal.changes).toEqual({ added: [], modified: [], deleted: [] });
    expect(unchanged.indexes.semantic.embedded).toBe(0);
    expect(JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, 'literal-state.json'), 'utf8'))).toEqual(ownersAfter);
    read.mockRestore();
    // Literal-only refresh cannot advance the semantic baseline.
    const literal = await call({ operation: 'update', mode: 'literal', paths: ['prompts/selected-neighbor/keep.md'] });
    expect(literal.indexes.literal.changes.modified).toEqual(['prompts/selected-neighbor/keep.md']);
    const semantic = await call({ operation: 'update', mode: 'semantic', paths: ['prompts/selected-neighbor/keep.md'] });
    expect(semantic.indexes.semantic.changes.modified).toEqual(['prompts/selected-neighbor/keep.md']);
    expect(semantic.indexes.semantic.embedded).toBe(1);
    const full = await call({ operation: 'update', mode: 'all' });
    expect(full.indexes.literal.changes.modified).toEqual(['prompts/index.md']);
    expect(full.indexes.semantic.changes.modified).toEqual(['prompts/index.md']);
    expect((await knowledge.search('targeted')).map(hit => hit.path).sort()).toEqual([
      'prompts/selected/edit.md', 'prompts/selected/new.md',
    ]);
    expect((await knowledge.search('old')).map(hit => hit.path)).toEqual([]);
  }, 120_000);

  it('keeps a cold targeted cache partial and handles ignored/private/symlink scopes as deletions', async () => {
    const { root, knowledge, runtime } = await fixture();
    const call = async (paths: string[]) => JSON.parse(await runtime.call('aikido_index', { operation: 'update', mode: 'all', paths }));
    const read = vi.spyOn(knowledge, 'read');
    const cold = await call(['prompts/selected/edit.md']);
    expect(cold.indexes.semantic.chunks).toBe(1);
    expect(cold.indexes.literal.files).toBe(1);
    expect(read.mock.calls.every(([file]) => file === 'prompts/selected/edit.md')).toBe(true);
    await writeFile(path.join(root, '.gitignore'), 'prompts/selected/edit.md\n');
    const excluded = await call(['prompts/selected/edit.md']);
    for (const engine of ['literal', 'semantic']) {
      expect(excluded.indexes[engine].changes.deleted).toEqual(['prompts/selected/edit.md']);
    }
    await mkdir(path.join(root, 'prompts/spec'), { recursive: true });
    await writeFile(path.join(root, 'prompts/spec/private.md'), 'private');
    await writeFile(path.join(root, '.env.json'), 'private');
    await symlink(path.join(root, 'prompts/selected-neighbor'), path.join(root, 'link'));
    await symlink(path.join(root, 'prompts/index.md'), path.join(root, 'prompts/alias.md'));
    read.mockClear();
    const safe = await call(['prompts/spec', '.env.json', 'link', 'prompts/alias.md', 'missing/directory']);
    expect(read).not.toHaveBeenCalled();
    expect(safe.indexes.literal.files).toBe(0);
    expect(safe.indexes.semantic.chunks).toBe(0);
    await rm(path.join(root, '.gitignore'));
    await call(['prompts/selected']);
    await rm(path.join(root, 'prompts/selected'), { recursive: true });
    const removed = await call(['prompts/selected']);
    expect(removed.indexes.literal.changes.deleted).toHaveLength(3);
    expect(removed.indexes.semantic.changes.deleted).toHaveLength(3);
    for (const operation of ['status']) {
      await expect(runtime.call('aikido_index', { operation, mode: 'semantic', paths: ['prompts'] })).rejects.toThrow('paths');
    }
    for (const operation of ['stats', 'compact', 'rebuild']) {
      await expect(runtime.call('aikido_index', { operation, mode: 'semantic', paths: ['prompts'] })).rejects.toThrow('Only operation=update');
    }
  }, 120_000);
});
