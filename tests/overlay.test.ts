import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/collab-util.js';
import { UserOverlay, markdownWarnings, validateOwner } from '../src/overlay.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function cache() {
  const directory = await mkdtemp(path.resolve('.overlay-test-'));
  directories.push(directory);
  return directory;
}

const fiche = '> **Version**: 1.0\n# Fiche\n[source](a.mmd) [index](index.md)\n';

describe('per-user overlay', () => {
  it('persists staged additions, modifications and deletions across instances, with pending status', async () => {
    const directory = await cache();
    const shared = { 'prompts/gen/old.md': sha256('old'), 'prompts/gen/gone.md': sha256('gone') };
    const overlay = new UserOverlay(directory, 'alice');
    const result = await overlay.stage([
      { path: 'prompts/gen/new.md', content: fiche },
      { path: 'prompts/gen/old.md', content: 'old, edited' },
      { path: 'prompts/gen/gone.md', content: null },
    ], shared);
    expect(result).toEqual({ staged: ['prompts/gen/gone.md', 'prompts/gen/new.md', 'prompts/gen/old.md'], unchanged: [] });

    const reopened = new UserOverlay(directory, 'alice');
    expect(await reopened.content('prompts/gen/new.md')).toBe(fiche);
    expect(await reopened.content('prompts/gen/gone.md')).toBeNull();
    expect(await reopened.content('prompts/gen/absent.md')).toBeUndefined();
    const items = await reopened.items(shared);
    expect(items.map(item => [item.path, item.op, item.status])).toEqual([
      ['prompts/gen/gone.md', 'delete', 'pending'],
      ['prompts/gen/new.md', 'put', 'pending'],
      ['prompts/gen/old.md', 'put', 'pending'],
    ]);
  });

  it('drops changes identical to the global files and keeps users isolated', async () => {
    const directory = await cache();
    const shared = { 'prompts/a.md': sha256('same') };
    const alice = new UserOverlay(directory, 'alice');
    expect(await alice.stage([{ path: 'prompts/a.md', content: 'same' }, { path: 'prompts/none.md', content: null }], shared))
      .toEqual({ staged: [], unchanged: ['prompts/a.md', 'prompts/none.md'] });
    expect(await alice.entries()).toEqual({});
    await alice.stage([{ path: 'prompts/a.md', content: 'alice only' }], shared);
    expect(Object.keys(await new UserOverlay(directory, 'bob').entries())).toEqual([]);
    expect(await UserOverlay.owners(directory)).toEqual(['alice']);
  });

  it('detects integrated and conflicting changes against the current global manifest', async () => {
    const directory = await cache();
    const base = { 'prompts/a.md': sha256('v1'), 'prompts/b.md': sha256('b1'), 'prompts/c.md': sha256('c1') };
    const overlay = new UserOverlay(directory, 'alice');
    await overlay.stage([
      { path: 'prompts/a.md', content: 'v2' },
      { path: 'prompts/b.md', content: 'b2' },
      { path: 'prompts/c.md', content: null },
      { path: 'prompts/d.md', content: 'd1' },
    ], base);
    const moved = { 'prompts/a.md': sha256('v2'), 'prompts/b.md': sha256('someone else'), 'prompts/d.md': sha256('d-other') };
    const status = Object.fromEntries((await overlay.items(moved)).map(item => [item.path, item.status]));
    expect(status).toEqual({
      'prompts/a.md': 'integrated', // global already has the same content
      'prompts/b.md': 'conflict', // global changed to something else since staging
      'prompts/c.md': 'integrated', // deletion already applied globally
      'prompts/d.md': 'conflict', // someone added the same path with other content
    });
    expect(await overlay.remove(['prompts/a.md', 'prompts/c.md', 'prompts/zzz.md'])).toEqual(['prompts/a.md', 'prompts/c.md']);
    expect(Object.keys(await overlay.entries())).toEqual(['prompts/b.md', 'prompts/d.md']);
  });

  it('garbage-collects unreferenced blobs when entries are removed', async () => {
    const directory = await cache();
    const overlay = new UserOverlay(directory, 'alice');
    await overlay.stage([{ path: 'prompts/a.md', content: 'one' }, { path: 'prompts/b.md', content: 'two' }], {});
    const blobs = path.join(directory, 'collaboration', 'overlays', 'alice', 'blobs');
    expect(await readdir(blobs)).toHaveLength(2);
    await overlay.remove(['prompts/a.md']);
    expect(await readdir(blobs)).toEqual([sha256('two')]);
  });

  it('rejects unsafe or ineligible input without storing anything', async () => {
    const directory = await cache();
    const overlay = new UserOverlay(directory, 'alice');
    for (const bad of [
      { path: '../escape.md', content: 'x' }, { path: '/abs.md', content: 'x' }, { path: 'prompts/.env', content: 'x' },
      { path: 'prompts/secrets/a.md', content: 'x' }, { path: 'prompts/visual.html', content: '<p>' },
      { path: 'prompts/bin.md', content: 'a\0b' }, { path: 'prompts/big.md', content: 'x'.repeat(256 * 1024 + 1) },
      { path: 'prompts/num.md', content: 42 as unknown as string },
    ]) await expect(overlay.stage([bad], {})).rejects.toThrow();
    await expect(overlay.stage([{ path: 'prompts/a.md', content: '1' }, { path: 'prompts/a.md', content: '2' }], {})).rejects.toThrow('Duplicate');
    await expect(overlay.stage([], {})).rejects.toThrow();
    expect(await overlay.entries()).toEqual({});
  });

  it('serializes concurrent staging for the same owner without losing updates', async () => {
    const directory = await cache();
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      new UserOverlay(directory, 'alice').stage([{ path: `prompts/f${index}.md`, content: `content ${index}` }], {})));
    expect(Object.keys(await new UserOverlay(directory, 'alice').entries())).toHaveLength(12);
  });

  it('validates owner identifiers', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a b', 'x'.repeat(65), undefined, 42]) expect(() => validateOwner(bad)).toThrow();
    expect(validateOwner('alice.dev_1-x')).toBe('alice.dev_1-x');
  });

  it('warns about broken relative links and a missing header in the merged view, ignoring non-knowledge targets', () => {
    const present = new Set(['prompts/gen/index.md']);
    const exists = (file: string) => present.has(file);
    expect(markdownWarnings('prompts/gen/f.md', fiche, exists)).toEqual([]); // a.mmd is not a knowledge file; index.md exists
    const broken = '# T\n[x](missing.md) [y](https://e.org/a.md) [z](#top) [w](../../../outside.md) [d](dir/)\n';
    expect(markdownWarnings('prompts/gen/f.md', broken, exists)).toEqual([
      'broken relative link: missing.md',
      'link leaves the knowledge root: ../../../outside.md',
      'missing AI-KIDO header (> **Version**: ...)',
    ]);
    expect(markdownWarnings('prompts/gen/f.txt', broken, exists)).toEqual([]);
  });
});
