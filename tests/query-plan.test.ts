import { corpusConfig } from '../src/corpus-config.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { lexicalPattern, normalize, queryIntent } from '../src/query-plan.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('distinguishes natural language, identifiers, qualified symbols, and source paths', () => {
  expect(queryIntent('How does authentication work?')).toBe('natural-language');
  expect(queryIntent('authenticateUser')).toBe('identifier');
  expect(queryIntent('AuthService.authenticate')).toBe('qualified-symbol');
  expect(queryIntent('src/auth/service.rs')).toBe('path');
  expect(queryIntent('service.rs')).toBe('path');
});

it('normalizes natural-language queries and expands repository glossary aliases with provenance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-vocabulary-'));
  roots.push(root);
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Project');
  await writeFile(path.join(root, 'prompts/glossaire-projet.md'), [
    '| Terme | Synonymes | Définition |',
    '|---|---|---|',
    '| **Base commune** | shared knowledge, dépôt partagé | Référentiel documentaire utilisé par tous les membres. |',
  ].join('\n'));
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();

  const plan = await knowledge.vocabulary.plan('Où trouver le dépôt partagé ?');
  expect(normalize('DÉPÔT partagé')).toBe('depot partage');
  expect(plan.vocabulary).toMatchObject({ sources: ['prompts/glossaire-projet.md'], concepts: 1, truncated: false });
  expect(plan.intent).toBe('natural-language');
  expect(plan.concepts[0]).toMatchObject({ term: 'Base commune', path: 'prompts/glossaire-projet.md', line: 3 });
  expect(plan.expansions.map(item => item.term)).toContain('shared knowledge');
  expect(plan.semanticQuery).toContain('shared knowledge');
  expect(lexicalPattern(plan)).toContain('[^\\p{L}\\p{N}]+');
  expect(new RegExp(lexicalPattern(plan), 'iu').test('shared knowledge')).toBe(true);
});

it('loads vocabulary only once for simultaneous searches and ignores glossary-generation commands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-vocabulary-concurrent-'));
  roots.push(root);
  await mkdir(path.join(root, 'prompts/hard_points/commands'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Project');
  await writeFile(path.join(root, 'prompts/hard_points/commands/init-glossaire.md'), '| Term | Synonyms |\n|---|---|\n| bogus | fabricated |');
  await writeFile(path.join(root, 'prompts/glossary.md'), [
    '| Term | Aliases | Definition |', '|---|---|---|',
    '| Rules | règles, regles | Project constraints |',
  ].join('\n'));
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const read = vi.spyOn(knowledge, 'read');
  const plans = await Promise.all(['regles', 'règles', 'rules'].map(query => knowledge.vocabulary.plan(query)));
  expect(read).toHaveBeenCalledTimes(1);
  for (const plan of plans) {
    expect(plan.vocabulary).toMatchObject({ sources: ['prompts/glossary.md'], concepts: 1, policy: 'project-only' });
    expect(plan.expansions.some(item => item.term === 'rules' || item.term === 'regles')).toBe(true);
  }
  const unenriched = await knowledge.vocabulary.plan('regles', false);
  expect(unenriched.expansions).toEqual([]);
  expect(unenriched.vocabulary.enabled).toBe(false);
  await writeFile(path.join(root, 'prompts/glossary.md'), '| Term | Aliases |\n|---|---|\n| Rules | directives |');
  await knowledge.vocabulary.refresh();
  expect((await knowledge.vocabulary.plan('directives')).expansions.map(item => item.term)).toContain('rules');
});

it('never invents translations and uses whole terms with flexible phrase punctuation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-vocabulary-empty-'));
  roots.push(root);
  await writeFile(path.join(root, 'index.md'), '# Rules');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const plan = await knowledge.vocabulary.plan('regles');
  expect(plan.expansions).toEqual([]);
  expect(plan.warnings[0]).toContain('does not translate');
  const pattern = new RegExp(lexicalPattern(plan), 'iu');
  expect(pattern.test('Les RÈGLES du projet')).toBe(true);
  expect(pattern.test('Les RE\u0300GLES du projet')).toBe(true);
  expect(pattern.test('mes_regles_projet')).toBe(true);
  expect(pattern.test('dereglementation')).toBe(false);
  const phrase = await knowledge.vocabulary.plan('base');
  phrase.expansions.push({ term: 'shared knowledge', relation: 'alias', concept: 'base', path: 'g.md', line: 1 });
  expect(new RegExp(lexicalPattern(phrase), 'iu').test('shared-knowledge')).toBe(true);
});
