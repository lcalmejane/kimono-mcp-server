import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { corpusConfig } from '../src/corpus-config.js';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { defaultType, parseTypeRules, TypeResolver } from '../src/structure-types.js';

const scratch: string[] = [];
async function fixture(options: Record<string, unknown> = {}) {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-structure-'));
  scratch.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const write = async (file: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag', ...options }));
  const runtime = runtimeFor(knowledge);
  const begin = async (input: Record<string, unknown> = {}) =>
    JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin', ...input })).snapshotId as string;
  const structure = async (snapshotId: string, input: Record<string, unknown> = {}) =>
    JSON.parse(await runtime.call('aikido_structure', { snapshotId, ...input }));
  return { parent, root, knowledge, write, runtime, begin, structure };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('gives every visible file a type, an idx flag and never repeats a path', async () => {
  const { knowledge, write, begin, structure, runtime } = await fixture();
  await write('src/app.ts', 'export const a = 1;');
  await write('src/deep/only/leaf.go', 'package leaf');
  await write('docs/README.md', '# Hello');
  await write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  await write('Dockerfile', 'FROM node:24');
  await knowledge.initialize();
  const id = await begin();
  const result = await structure(id);
  expect(result.n).toBe(5);
  expect(result.data['Dockerfile']).toEqual(['docker', 1, 12]);
  expect(result.data['src/']['deep/only/']['leaf.go']).toEqual(['go', 1, 12]);
  expect(result.data['src/']['app.ts']).toEqual(['ts', 1, 19]);
  expect(result.types.docker).toEqual(['Dockerfile', 'infra']);
  expect(JSON.stringify(result.data)).not.toContain('src/app.ts');
  const binary = result.data['assets/']['logo.png'];
  expect(binary[0]).toBe('image');
  expect(binary[1]).toBe(0);
  expect(result.idx).toBeLessThanOrEqual(result.n);
  await runtime.call('aikido_snapshot', { operation: 'end', snapshotId: id });
});

it('follows the Kimono ignore rules and keeps non indexed files visible', async () => {
  const { knowledge, write, begin, structure } = await fixture({ exclude: ['private/**'] });
  await write('.gitignore', 'generated/\n');
  await write('generated/out.ts', 'x');
  await write('node_modules/pkg/index.js', 'x');
  await write('private/notes.md', 'secret');
  await write('.env', 'TOKEN=1');
  await write('keep/a.ts', 'a');
  await write('keep/big.bin', Buffer.alloc(5, 1));
  await knowledge.initialize();
  const result = await structure(await begin(), { legend: false });
  const text = JSON.stringify(result.data);
  for (const hidden of ['generated', 'node_modules', 'private', '.env']) expect(text).not.toContain(hidden);
  expect(result.data['keep/']['a.ts'][1]).toBe(1);
  expect(result.data['keep/']['big.bin'][0]).toBe('binary');
  expect(result.types).toBeUndefined();
});

it('scopes to a path, limits depth and filters by type or idx', async () => {
  const { knowledge, write, begin, structure } = await fixture();
  await write('a/x/one.ts', '1');
  await write('a/x/two.ts', '2');
  await write('a/y/three.md', '# 3');
  await write('b/four.ts', '4');
  await knowledge.initialize();
  const id = await begin();
  const scoped = await structure(id, { path: 'a' });
  expect(scoped.path).toBe('a');
  expect(scoped.n).toBe(3);
  expect(Object.keys(scoped.data).sort()).toEqual(['x/', 'y/']);
  const shallow = await structure(id, { depth: 1 });
  expect(shallow.data['a/']).toBe(3);
  expect(shallow.data['b/']).toBe(1);
  const typed = await structure(id, { type: 'md' });
  expect(typed.n).toBe(1);
  expect(JSON.stringify(typed.data)).toContain('three.md');
  expect((await structure(id, { idx: 0 })).n).toBe(0);
  const single = await structure(id, { path: 'b/four.ts' });
  expect(single.data['four.ts']).toBeDefined();
  const text = await structure(id, { format: 'text', legend: false });
  expect(text.text).toContain('a/');
  expect(text.data).toBeUndefined();
  await expect(structure(id, { path: '../x' })).rejects.toThrow('safe');
  await expect(structure(id, { surprise: 1 })).rejects.toThrow('Unknown');
});

it('reports unchanged structures and sees other users changes on the next snapshot', async () => {
  const { knowledge, write, begin, structure, root } = await fixture();
  await write('a.ts', '1');
  await knowledge.initialize();
  const first = await begin();
  const before = await structure(first);
  expect((await structure(first, { since: before.v })).unchanged).toBe(true);
  await write('b.ts', '22');
  // The existing snapshot is immutable: it keeps its own view.
  expect((await structure(first)).n).toBe(1);
  const second = await begin();
  const after = await structure(second);
  expect(after.n).toBe(2);
  expect(after.v).not.toBe(before.v);
  expect(await structure(second, { since: before.v })).toMatchObject({ n: 2 });
  expect(root).toBeTruthy();
});

it('merges the staged overlay of the caller into its own view only', async () => {
  const { knowledge, begin, structure, write, runtime, parent } = await fixture({ mode: 'aikido' });
  const header = '> **Version**: 1.0 | **Date**: 2026-10-31 | **Statut**: Active\n';
  await write('prompts/index.md', '# Index\n');
  await write('prompts/gen/concepts/kept.md', `${header}# Kept\n`);
  await write('prompts/gen/concepts/removed.md', `${header}# Removed\n`);
  await knowledge.initialize();
  const workspace = path.join(parent, 'user-workspace');
  await mkdir(workspace);
  await runtime.call('aikido_collaboration', { operation: 'stage', clientRoot: workspace, owner: 'alice', changes: [
    { path: 'prompts/gen/concepts/added.md', content: `${header}# Added\n` },
    { path: 'prompts/gen/concepts/removed.md', content: null },
  ] });
  const names = (data: Record<string, any>) => Object.keys(data['prompts/']?.['gen/concepts/'] ?? {}).sort();
  const plain = await structure(await begin());
  const alice = await structure(await begin({ owner: 'alice' }));
  const bob = await structure(await begin({ owner: 'bob' }));
  expect(names(plain.data)).toEqual(['kept.md', 'removed.md']);
  expect(names(alice.data)).toEqual(['added.md', 'kept.md']);
  expect(names(bob.data)).toEqual(['kept.md', 'removed.md']);
  expect(alice.v).not.toBe(plain.v);
  expect(bob.v).toBe(plain.v);
});

it('resolves types with defaults, path conventions and custom rules including a head match', async () => {
  expect(defaultType('prompts/hard_points/x.md')).toBe('hard_point');
  expect(defaultType('prompts/gen/concepts/x.md')).toBe('concept');
  expect(defaultType('README.fr.md')).toBe('readme');
  expect(defaultType('.github/workflows/ci.yml')).toBe('ci');
  expect(defaultType('src/a.test.ts')).toBe('test');
  expect(defaultType('foo/Dockerfile')).toBe('docker');
  expect(defaultType('x.unknownext')).toBe('file');
  expect(defaultType('fonts/a.woff2')).toBe('font');

  const rules = parseTypeRules([
    { pattern: 'docs/glossary/**', type: 'glossary', label: 'Glossary', group: 'doc' },
    { pattern: '*.md', type: 'product', label: 'Product sheet', head: '^type:\\s*product' },
  ]);
  const resolver = new TypeResolver(rules);
  expect(await resolver.resolve('docs/glossary/a.md')).toBe('glossary');
  expect(await resolver.resolve('x/b.md', async () => '---\ntype: product\n---')).toBe('product');
  expect(await resolver.resolve('x/b.md', async () => '---\ntype: other\n---')).toBe('md');
  expect(await resolver.resolve('x/b.md')).toBe('md');
  expect(resolver.info('glossary')).toEqual({ label: 'Glossary', group: 'doc' });

  expect(() => parseTypeRules([{ pattern: '/abs', type: 'a' }])).toThrow('ROOT-relative');
  expect(() => parseTypeRules([{ pattern: '*.md', type: 'bad type' }])).toThrow('type');
  expect(() => parseTypeRules([{ pattern: '*.md', type: 'a', head: '(' }])).toThrow('regex');
  expect(() => parseTypeRules([{ pattern: '*.md', type: 'a', extra: 1 }])).toThrow('unknown');
});

it('applies the KIMONO_TYPES_FILE definition to the structure', async () => {
  const { parent, knowledge, write, begin, structure } = await fixture();
  const file = path.join(parent, 'types.json');
  await writeFile(file, JSON.stringify({ rules: [
    { pattern: 'glossaire.md', type: 'glossaire', label: 'Glossaire', group: 'doc' },
    { pattern: '*.md', type: 'fiche', label: 'Fiche produit', head: '^kind: produit' },
  ] }));
  vi.stubEnv('KIMONO_TYPES_FILE', file);
  await write('glossaire.md', '# Termes');
  await write('p/sheet.md', 'kind: produit\n# A');
  await write('p/plain.md', '# B');
  await knowledge.initialize();
  const result = await structure(await begin());
  expect(result.data['glossaire.md'][0]).toBe('glossaire');
  expect(result.data['p/']['sheet.md'][0]).toBe('fiche');
  expect(result.data['p/']['plain.md'][0]).toBe('md');
  expect(result.types.fiche).toEqual(['Fiche produit', 'other']);
  const known = result.v as string;
  expect((await structure(await begin(), { since: known })).unchanged).toBe(true);
  vi.stubEnv('KIMONO_TYPES_FILE', 'relative.json');
  await expect(structure(await begin())).rejects.toThrow('absolute');
});
