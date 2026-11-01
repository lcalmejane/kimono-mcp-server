import { corpusConfig } from '../src/corpus-config.js';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { plannedSearch } from '../src/planned-search.js';
import { lexicalPattern } from '../src/query-plan.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-lexical-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Index');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  cleanup.push(knowledge.searchIndex.directory);
  return { root, knowledge };
}

it('retrieves and ranks real fgr matches after 500 noisy lines, including a late exact phrase', async () => {
  const { root, knowledge } = await fixture();
  await writeFile(path.join(root, 'prompts/a-noise.md'), Array(700).fill('The project uses text.').join('\n'));
  await writeFile(path.join(root, 'prompts/z-rules.md'), '# Project rules\nFollow the project rules.');
  await writeFile(path.join(root, 'prompts/b-late.md'), [
    ...Array(100).fill('project information'),
    '# Project rules',
  ].join('\n'));
  await knowledge.initialize();
  const result = await plannedSearch(knowledge, await knowledge.vocabulary.plan('project rules'),
    'text', undefined, () => true, 5);
  expect(result.metadata.status, JSON.stringify(result.metadata)).toBe('ok');
  expect(result.results[0]).toMatchObject({ path: 'prompts/z-rules.md', line: 1 });
  expect(result.results.slice(0, 2).map(hit => hit.path)).toContain('prompts/b-late.md');
  expect(result.metadata.branches[0].candidatesTruncated).toBe(true);
});

it('expands only declared project aliases and respects scoped, ignored and superseded files', async () => {
  const { root, knowledge } = await fixture();
  await writeFile(path.join(root, 'prompts/glossary.md'), '| Term | Synonyms | Definition |\n|---|---|---|\n| Rules | règles, regles | Project constraints |');
  await writeFile(path.join(root, 'prompts/rules.md'), '# Rules\nProject rules.');
  await writeFile(path.join(root, 'prompts/french.md'), '# RÈGLES\nLes re\u0300gles du projet.');
  await writeFile(path.join(root, 'prompts/false.md'), 'Dereglementation, constraints only.');
  await writeFile(path.join(root, '.gitignore'), 'prompts/ignored.md');
  await writeFile(path.join(root, 'prompts/ignored.md'), 'règles rules');
  await knowledge.initialize();
  const plan = await knowledge.vocabulary.plan('regles');
  const result = await plannedSearch(knowledge, plan, 'text', undefined, () => true, 10);
  expect(result.metadata.status, JSON.stringify(result.metadata)).toBe('ok');
  expect(result.results.map(hit => hit.path)).toContain('prompts/rules.md');
  expect(result.results.map(hit => hit.path)).toContain('prompts/french.md');
  expect(result.results.map(hit => hit.path)).not.toContain('prompts/false.md');
  expect(result.results.map(hit => hit.path)).not.toContain('prompts/ignored.md');
  const scoped = await plannedSearch(knowledge, plan, 'text', undefined, entry => entry.path === 'prompts/rules.md', 10);
  expect(scoped.results.every(hit => hit.path === 'prompts/rules.md')).toBe(true);
  const literal = await knowledge.searchIndex.search('regles', undefined, 10);
  expect(literal.map(hit => hit.path)).not.toContain('prompts/rules.md');
  await writeFile(path.join(root, 'prompts/rules.md'), '# Changed\nNo relevant content.');
  await knowledge.refresh();
  const updated = await knowledge.searchIndex.searchCandidates(lexicalPattern(plan), undefined, 100, true);
  expect(updated.matches.map(hit => hit.path)).not.toContain('prompts/rules.md');
  expect(updated.truncated).toBe(false);
});

it('breaks equal textual evidence in favour of the file whose name carries a query term', async () => {
  const { root, knowledge } = await fixture();
  await writeFile(path.join(root, 'prompts/README.md'),
    '# Hub\nIntelligent file merge with the fusion agent.');
  await writeFile(path.join(root, 'prompts/agent-fusion.md'),
    '# Agent\nIntelligent file merge with the fusion agent.');
  await knowledge.initialize();
  const result = await plannedSearch(knowledge, await knowledge.vocabulary.plan('intelligent file merge fusion'),
    'text', undefined, () => true, 5);
  expect(result.results[0].path).toBe('prompts/agent-fusion.md');
  expect(result.results[0].scoreDetails?.path).toBeGreaterThan(0);
  expect(result.results.find(hit => hit.path === 'prompts/README.md')?.scoreDetails?.path).toBe(0);
});

it.each(['rag', 'aikido'] as const)('anchors basename includes to ROOT in %s mode, including immutable snapshots', async mode => {
  const { root } = await fixture();
  await mkdir(path.join(root, 'prompts/nested'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Root agent');
  await writeFile(path.join(root, 'prompts/nested/README.md'), '# Nested agent');
  for (const immutable of [false, true]) {
    const knowledge = new AikidoKnowledgeBase(root, immutable, corpusConfig({ mode }), false);
    cleanup.push(knowledge.searchIndex.directory);
    await knowledge.initialize();
    const result = await knowledge.searchIndex.searchCandidates('agent', undefined, 10, false,
      entry => entry.path === 'README.md');
    expect(result.matches.map(hit => hit.path)).toEqual(['README.md']);
    expect(result.truncated).toBe(false);
  }
});

it('skips the full rescan for unchanged files yet still sees in-place edits without reindexing', async () => {
  const { root, knowledge } = await fixture();
  await writeFile(path.join(root, 'prompts/rules.md'), '# Rules\nAlpha content.');
  await knowledge.initialize();
  const search = async (query: string) => (await plannedSearch(knowledge, await knowledge.vocabulary.plan(query),
    'text', undefined, () => true, 5)).results.map(hit => hit.path);
  expect(await search('alpha')).toEqual(['prompts/rules.md']);
  const update = vi.spyOn(knowledge.searchIndex as unknown as { update: () => Promise<unknown> }, 'update');
  expect(await search('alpha')).toEqual(['prompts/rules.md']);
  expect(update).not.toHaveBeenCalled();
  await writeFile(path.join(root, 'prompts/rules.md'), '# Rules\nBravo content, rewritten in place.');
  expect(await search('bravo')).toEqual(['prompts/rules.md']);
  expect(await search('alpha')).toEqual([]);
  expect(update).toHaveBeenCalledTimes(1);
});

// Wraps the real fgr so each search (not index) invocation is counted.
async function countingFgr() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimono-fgr-count-'));
  cleanup.push(directory);
  const log = path.join(directory, 'calls.log');
  const wrapper = path.join(directory, 'fgr-wrapper.sh');
  await writeFile(wrapper, '#!/bin/sh\ncase " $* " in *" --format "*) echo 1 >> "$FGR_CALL_LOG";; esac\nexec fgr "$@"\n');
  await chmod(wrapper, 0o755);
  await writeFile(log, '');
  process.env.FGR_BIN = wrapper;
  process.env.FGR_CALL_LOG = log;
  return async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
}
afterEach(() => { delete process.env.FGR_BIN; delete process.env.FGR_CALL_LOG; });

it.skipIf(process.platform === 'win32')('answers an unfiltered search with a single fgr call instead of one per file batch', async () => {
  const calls = await countingFgr();
  const { root, knowledge } = await fixture();
  for (let index = 0; index < 40; index++) {
    await writeFile(path.join(root, `prompts/${'long-document-name-'.repeat(4)}${index}.md`), index % 2 ? 'needle here' : 'nothing');
  }
  await knowledge.initialize();
  const before = await calls();
  const result = await knowledge.searchIndex.searchCandidates('needle', undefined, 100, false);
  expect(await calls() - before).toBe(1);
  expect(result.matches).toHaveLength(20);
  expect(result.truncated).toBe(false);
});

it.skipIf(process.platform === 'win32')('falls back to scoped batches when the fgr cap was spent on out-of-scope files', async () => {
  const calls = await countingFgr();
  const { root, knowledge } = await fixture();
  for (let index = 0; index < 10; index++) await writeFile(path.join(root, `prompts/aaa-out-${index}.md`), 'needle');
  for (let index = 0; index < 12; index++) await writeFile(path.join(root, `prompts/zzz-in-${index}.md`), index < 6 ? 'needle' : 'nothing');
  await knowledge.initialize();
  const before = await calls();
  const result = await knowledge.searchIndex.searchCandidates('needle', undefined, 5, false, entry => entry.path.includes('zzz-in-'));
  expect(result.matches.map(hit => hit.path).every(file => file.includes('zzz-in-'))).toBe(true);
  expect(result.matches).toHaveLength(5);
  expect(result.truncated).toBe(true);
  expect(await calls() - before).toBe(2);
});

it.skipIf(process.platform === 'win32')('returns the same matches whether a narrow scope runs as one or several concurrent batches', async () => {
  const calls = await countingFgr();
  const { root, knowledge } = await fixture();
  const name = (index: number) => `prompts/${'scoped-batch-document-'.repeat(4)}${String(index).padStart(3, '0')}.md`;
  for (let index = 0; index < 300; index++) await writeFile(path.join(root, name(index)), 'needle');
  await knowledge.initialize();
  const wanted = new Set(Array.from({ length: 300 }, (_, index) => index).filter(index => index % 3 === 0).map(name));
  const before = await calls();
  const result = await knowledge.searchIndex.searchCandidates('needle', undefined, 1000, false, entry => wanted.has(entry.path));
  expect(await calls() - before).toBeGreaterThan(1);
  expect(result.matches.map(hit => hit.path).sort()).toEqual([...wanted].sort());
  expect(result.truncated).toBe(false);
});
