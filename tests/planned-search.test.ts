import { corpusConfig } from '../src/corpus-config.js';
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
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
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
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
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

it.each(['ts', 'php'])('boosts %s code symbol definitions and matching source filenames for identifier queries', async (extension) => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-symbol-search-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.md'), '# Project');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const entry = knowledge.list()[0];
  const candidate = (file: string, excerpt: string) => ({
    ...entry, path: file, title: file.split('/').pop()!, line: 1, excerpt,
  });
  const search = vi.spyOn(knowledge.searchIndex, 'searchCandidates').mockResolvedValue({
    matches: [
      candidate(`src/profile.${extension}`, `${extension === 'php' ? 'public' : 'export'} function loadUserProfile() { return profile; }`),
      candidate(`src/usage.${extension}`, '// load user profile before rendering'),
    ], truncated: false,
  });
  const plan = await knowledge.vocabulary.plan('loadUserProfile', false);
  const result = await plannedSearch(knowledge, plan, 'text', undefined, () => true, 5);

  expect(result.results[0].path).toBe(`src/profile.${extension}`);
  expect(result.metadata.queryIntent).toBe('identifier');
  expect(result.results[0].scoreDetails).toMatchObject({ identifier: 0.3, symbolDefinition: 0.2 });
  expect(result.results[1].scoreDetails?.identifier).toBeGreaterThan(0);
  const pattern = search.mock.calls[0][0];
  expect(new RegExp(pattern, 'u').test('user')).toBe(true);
  expect(new RegExp(pattern, 'u').test('profile')).toBe(true);
});

it('rewards cross-passage code coherence and conservatively penalizes test-only matches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-code-coherence-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.md'), '# Project');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const entry = knowledge.list()[0];
  const candidate = (file: string, excerpt: string, line = 1) => ({
    ...entry, path: file, title: file.split('/').pop()!, line, excerpt,
  });
  vi.spyOn(knowledge.searchIndex, 'searchCandidates').mockResolvedValue({
    matches: [
      candidate('src/auth.ts', 'secrets are stored safely', 1),
      candidate('src/auth.ts', 'rotate credentials after compromise', 2),
      candidate('src/credentials.ts', 'secrets rotate credentials together'),
      candidate('src/__tests__/auth.test.ts', 'secrets rotate credentials in test scenarios'),
      candidate('prompts/security.md', 'secrets are stored and credentials are rotated'),
    ], truncated: false,
  });
  const plan = await knowledge.vocabulary.plan('secrets rotate credentials', false);
  const result = await plannedSearch(knowledge, plan, 'text', undefined, () => true, 10);
  const auth = result.results.find(hit => hit.path === 'src/auth.ts');
  const test = result.results.find(hit => hit.path === 'src/__tests__/auth.test.ts');
  const prose = result.results.find(hit => hit.path === 'prompts/security.md');
  expect(auth?.scoreDetails?.coherence).toBeGreaterThan(0);
  expect(test?.scoreDetails?.noise).toBe(-0.25);
  expect(prose?.scoreDetails?.noise).toBe(0);
  expect(result.results.findIndex(hit => hit.path === 'src/credentials.ts'))
    .toBeLessThan(result.results.findIndex(hit => hit.path === 'src/__tests__/auth.test.ts'));
  const testQuery = await knowledge.vocabulary.plan('secrets rotate test credentials', false);
  const explicit = await plannedSearch(knowledge, testQuery, 'text', undefined, () => true, 10);
  expect(explicit.results.find(hit => hit.path === 'src/__tests__/auth.test.ts')?.scoreDetails?.noise).toBe(0);
});
