import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function knowledgeAt(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `kimono-seed-${name}-`));
  directories.push(root);
  await writeFile(path.join(root, 'a.md'), '# a\n');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  directories.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return knowledge;
}

it('seeds a snapshot from a dirty-tree index whose corpus fingerprint is null, by per-document basis', async () => {
  const source = await knowledgeAt('source');
  const directory = source.searchIndex.directory;
  const generation = `store-${'a'.repeat(24)}`;
  await mkdir(path.join(directory, 'semantic', generation), { recursive: true });
  await writeFile(path.join(directory, 'semantic', generation, 'vectors.bin'), 'v');
  await writeFile(path.join(directory, 'semantic', 'state.json'), JSON.stringify({ generation }));
  const basisFingerprint = 'b'.repeat(64);
  // Incremental update of a dirty tree: only the per-document basis is recorded.
  await writeFile(path.join(directory, 'semantic-basis.json'), JSON.stringify({ phase: 'ready',
    lastSuccessful: { corpusFingerprint: null, basisFingerprint, indexedAt: new Date().toISOString() } }));
  vi.spyOn(source.semanticIndex, 'status').mockReturnValue({ phase: 'ready' } as never);
  vi.spyOn(source.semanticIndex, 'activeSelection').mockResolvedValue(undefined);

  const other = await knowledgeAt('mismatch');
  expect(await other.semanticIndex.seedFrom(source.semanticIndex, 'c'.repeat(64), 'd'.repeat(64))).toBe(false);

  const snapshot = await knowledgeAt('snapshot');
  expect(await snapshot.semanticIndex.seedFrom(source.semanticIndex, 'c'.repeat(64), basisFingerprint)).toBe(true);
  const copied = JSON.parse(await readFile(path.join(snapshot.searchIndex.directory, 'semantic', 'state.json'), 'utf8'));
  expect(copied.generation).toBe(generation);
});
