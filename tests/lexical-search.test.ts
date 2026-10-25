import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
