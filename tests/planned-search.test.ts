import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { plannedSearch } from '../src/planned-search.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('keeps enriched text search available while semantic indexing is still running', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-planned-search-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.md'), '# Project');
  const knowledge = new AikidoKnowledgeBase(root);
  await knowledge.initialize();
  const entry = knowledge.list()[0];
  vi.spyOn(knowledge.searchIndex, 'searchCandidates').mockResolvedValue({ matches: [{
    ...entry, line: 1, excerpt: 'Find shared project knowledge.',
  }], truncated: false });
  const semanticRun = vi.spyOn(knowledge.semanticIndex, 'run');
  const plan = await knowledge.vocabulary.plan('Find shared project knowledge');

  const result = await plannedSearch(knowledge, plan, 'hybrid', undefined, () => true, 5,
    { error: 'Semantic index is preparing. Poll status.', index: { phase: 'running' } });

  expect(result.metadata.status).toBe('partial');
  expect(result.results.map(hit => hit.path)).toEqual(['index.md']);
  expect(result.metadata.branches).toMatchObject([
    { mode: 'text', status: 'ok', count: 1 },
    { mode: 'semantic', status: 'not-ready', error: 'Semantic index is preparing. Poll status.' },
  ]);
  expect(semanticRun).not.toHaveBeenCalled();
});

it('ranks original whole terms above aliases, suppresses definition-only noise, and diversifies documents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-ranked-search-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.md'), '# Project');
  const knowledge = new AikidoKnowledgeBase(root);
  await knowledge.initialize();
  const entry = knowledge.list()[0];
  const candidate = (file: string, excerpt: string, line = 1) => ({ ...entry, path: file, title: file.replace('.md', ''), line, excerpt });
  const search = vi.spyOn(knowledge.searchIndex, 'searchCandidates').mockResolvedValue({
    matches: [
      candidate('a.md', 'unrelated definition security'),
      candidate('aliases.md', '# Policies'),
      candidate('b.md', 'règlementation'),
      ...Array.from({ length: 20 }, (_, i) => candidate('rules.md', 'Règles du projet', i + 2)),
      candidate('guide.md', '# Règles du projet'),
    ], truncated: true,
  });
  const plan = await knowledge.vocabulary.plan('règles');
  plan.expansions.push(
    { term: 'policies', relation: 'alias', concept: 'règles', path: 'glossaire.md', line: 3 },
    { term: 'security', relation: 'definition', concept: 'règles', path: 'glossaire.md', line: 3 },
  );
  const result = await plannedSearch(knowledge, plan, 'text', undefined, () => true, 5);
  expect(result.results[0].path).toBe('guide.md');
  expect(result.results.map(hit => hit.path)).not.toContain('a.md');
  expect(result.results.map(hit => hit.path)).not.toContain('b.md');
  expect(result.results[0].scoreDetails).toMatchObject({ coverage: 1, phrase: 0.4, heading: 0.15 });
  expect(result.metadata.branches[0].candidatesTruncated).toBe(true);
  expect(search).toHaveBeenCalledWith(expect.stringContaining('[^\\p{L}\\p{N}]'), undefined, 4000, true, expect.any(Function), 40);
});
