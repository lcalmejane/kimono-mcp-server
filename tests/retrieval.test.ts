import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'vitest';
import { AikidoKnowledgeBase, fileId } from '../src/knowledge.js';
import { createAikidoMcpServer } from '../src/server.js';
import { Retrieval } from '../src/retrieval.js';
import { runtimeFor } from '../src/runtime-tools.js';

const cleanup: string[] = [];
const exec = promisify(execFile);
const docPath = 'prompts/gen/concepts/design.md';
const doc = ['---', 'title: Design', 'last_check:', '  status: validated', '  validator: qa', '---',
  '# Design', '', '> Version: 1.0', '', '## Isolation', 'Keep each agent scoped.', 'needle and accents éà.',
  '### Details', 'Never load unrelated files.', '## Deployment', 'Use Docker.', '```md', '## Not a section', '```', ''].join('\n');

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-retrieval-'));
  cleanup.push(root);
  await mkdir(path.join(root, 'prompts/gen/concepts'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# Index\n');
  await writeFile(path.join(root, docPath), doc);
  await writeFile(path.join(root, 'src/example.ts'), '// needle from source\n');
  const knowledge = new AikidoKnowledgeBase(root);
  cleanup.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return { root, knowledge, retrieval: new Retrieval(knowledge) };
}

afterEach(async () => { await Promise.all(cleanup.splice(0).map(file => rm(file, { recursive: true, force: true }))); });

it('matches the local structure V3.1 path hash and returns header/type/line/size metadata without the body', async () => {
  const { knowledge, retrieval, root } = await fixture();
  const metadata = JSON.parse(await retrieval.read({ operation: 'metadata' }, docPath));
  expect(metadata).toMatchObject({ file_id: createHash('sha256').update(docPath).digest('hex').slice(0, 12),
    path: docPath, type: 'concept', extension: 'md', lines: 20, size_bytes: Buffer.byteLength(doc),
    check_status: 'present', modified: expect.stringMatching(/^\d{4}-/),
    header: { startLine: 1, endLine: 6, content: expect.stringContaining('validator: qa'), truncated: false } });
  expect(metadata.content).toBeUndefined();
  expect(JSON.stringify(metadata)).not.toContain('Never load unrelated');
  await expect(knowledge.read(metadata.file_id)).resolves.toMatchObject({ content: doc });
  // Compare against the actual canonical shell helper, not its illustrative IDs.
  const helper = path.resolve('../prompts/hard_points/system/structure/scripts/lib/hash-utils.sh');
  try {
    await readFile(helper);
    const result = await exec('bash', ['-c', 'source "$1"; generate_file_id "$2"', 'hash-check', helper, docPath]);
    expect(result.stdout.trim()).toBe(metadata.file_id);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await writeFile(path.join(root, docPath), doc.replace('validated', 'review-required'));
  expect(JSON.parse(await retrieval.read({ operation: 'metadata' }, metadata.file_id)).header.content).toContain('review-required');
});

it('retrieves inclusive source lines, sections, outline and exact full contents with explicit continuation', async () => {
  const { retrieval } = await fixture();
  const range = JSON.parse(await retrieval.read({ startLine: 11, endLine: 15 }, docPath));
  expect(range).toMatchObject({ startLine: 11, endLine: 15, truncated: false, nextLine: 16,
    content: doc.split('\n').slice(10, 15).join('\n') });
  const section = JSON.parse(await retrieval.read({ section: 'Isolation' }, fileId(docPath)));
  expect(section.content).toBe(range.content);
  const outline = JSON.parse(await retrieval.read({ operation: 'outline', limit: 2 }, docPath));
  expect(outline).toMatchObject({ count: 2, total: 4, nextOffset: 2 });
  expect(outline.headings[1]).toMatchObject({ title: 'Isolation', startLine: 11, endLine: 15 });
  expect(JSON.stringify(outline)).not.toContain('Not a section');
  expect(JSON.parse(await retrieval.read({ full: true }, docPath)).content).toBe(doc);
  for (const options of [{ startLine: 0 }, { startLine: 15, endLine: 1 }, { startLine: 999 },
    { full: true, section: 'Isolation' }, { section: 'missing' }, { section: 'Isolation', startLine: 1 }]) {
    await expect(retrieval.read(options, docPath)).rejects.toThrow();
  }
});

it('paginates catalogue metadata by filters and real UTF-8 JSON budget without skipping entries', async () => {
  const { retrieval, root } = await fixture();
  for (let i = 0; i < 12; i++) await writeFile(path.join(root, `prompts/gen/concepts/doc-${i}.md`), `# Document ${i}\n\nbody`);
  let offset = 0;
  const seen: string[] = [];
  do {
    const raw = await retrieval.list({ pathPrefix: 'prompts/gen', type: 'concept', extension: 'md', limit: 3, offset, maxBytes: 2048 });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2048);
    const page = JSON.parse(raw);
    seen.push(...page.entries.map((entry: { path: string }) => entry.path));
    offset = page.nextOffset;
  } while (offset !== null);
  expect(new Set(seen).size).toBe(13);
  expect(seen).toHaveLength(13);
  expect(JSON.parse(await retrieval.list({ scope: 'code' })).entries.map((entry: { path: string }) => entry.path)).toEqual(['src/example.ts']);
  expect(JSON.parse(await retrieval.list({ pathPrefix: 'prompts/gen/concept' })).count).toBe(0);
});

it('excludes nested gitignored content, dependency/cache files, symlinks and private specs from every retrieval path', async () => {
  const { root, knowledge, retrieval } = await fixture();
  await writeFile(path.join(root, '.gitignore'), 'prompts/ignored.md\nsrc/*.ts\n!src/example.ts\n');
  await writeFile(path.join(root, 'prompts/.gitignore'), 'nested-*.md\n!nested-keep.md\n');
  const omitted = ['prompts/ignored.md', 'prompts/nested-secret.md', '.env.json',
    'node_modules/dep.md', '.cache/cache.md', 'prompts/spec/private.md'];
  for (const file of [...omitted, 'prompts/nested-keep.md']) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '# needle\n');
  }
  await symlink(path.join(root, docPath), path.join(root, 'prompts/link.md'));
  await knowledge.refresh();
  const paths = knowledge.list().map(entry => entry.path);
  for (const file of [...omitted, 'prompts/link.md']) {
    expect(paths).not.toContain(file);
    await expect(retrieval.read({}, file)).rejects.toThrow('not found');
  }
  expect(paths).toContain('prompts/nested-keep.md');
  expect(paths).toContain('src/example.ts');
  await expect(retrieval.list({ pathPrefix: '../private' })).rejects.toThrow('ROOT-relative');
});

it('supports a Memory Bank directory as ROOT without treating its hard points as source code or exposing specs', async () => {
  const { root } = await fixture();
  await mkdir(path.join(root, 'prompts/spec'), { recursive: true });
  await writeFile(path.join(root, 'prompts/spec/private.md'), '# private');
  const knowledge = new AikidoKnowledgeBase(path.join(root, 'prompts'));
  const retrieval = new Retrieval(knowledge);
  const memory = JSON.parse(await retrieval.list({ scope: 'memory' }));
  expect(memory.total).toBe(2);
  expect(JSON.parse(await retrieval.list({ scope: 'code' })).total).toBe(0);
  expect(JSON.parse(await retrieval.read({ operation: 'metadata' }, 'gen/concepts/design.md')).check_status).toBe('present');
  await expect(retrieval.read({}, 'spec/private.md')).rejects.toThrow('not found');
});

it('bounds long reads by serialized bytes and resumes at exact lines without data loss', async () => {
  const { root, retrieval } = await fixture();
  const lines = Array.from({ length: 100 }, (_, i) => `${i}: ${'é"\\'.repeat(35)}`);
  await writeFile(path.join(root, docPath), lines.join('\n'));
  let next = 1;
  const received: string[] = [];
  do {
    const raw = await retrieval.read({ startLine: next, endLine: 100, maxBytes: 2048 }, docPath);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2048);
    const page = JSON.parse(raw);
    received.push(...page.content.split('\n'));
    next = page.nextLine;
  } while (next !== null);
  expect(received).toEqual(lines);
  await writeFile(path.join(root, docPath), `# Duplicate\n## Same\none\n## Same\ntwo`);
  await expect(retrieval.read({ section: 'Same' }, docPath)).rejects.toThrow('ambiguous');
});

it('keeps MCP discovery, bounded read and legacy full read interoperable without write permissions', async () => {
  const { root, knowledge } = await fixture();
  const server = createAikidoMcpServer(knowledge);
  const client = new Client({ name: 'progressive-retrieval-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const runtime = runtimeFor(knowledge);
    const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { ...args, snapshotId } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      if (!Array.isArray(result.content) || result.content[0]?.type !== 'text') throw new Error('Expected JSON text');
      return JSON.parse(result.content[0].text);
    };
    const metadata = await call('aikido_file', { operation: 'metadata', path: docPath });
    const block = await call('aikido_file', { operation: 'read', path: metadata.file_id, startLine: 11, endLine: 13 });
    expect(block.content).toContain('needle');
    expect(await call('aikido', { operation: 'read', id: metadata.file_id, startLine: 11, endLine: 13 })).toEqual(block);
    const full = await call('aikido', { operation: 'read', id: docPath });
    expect(full).toMatchObject({ content: doc, snapshotId });
    const page = await call('aikido', { operation: 'list', scope: 'memory', limit: 1 });
    expect(page).toMatchObject({ count: 1, total: 2, nextOffset: 1 });
    await writeFile(path.join(root, '.gitignore'), `${docPath}\n`);
    expect((await call('aikido', { operation: 'read', id: docPath })).content).toBe(doc);
    const fresh = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    const ignored = await client.callTool({ name: 'aikido', arguments: { operation: 'read', id: docPath, snapshotId: fresh.snapshotId } });
    expect(ignored.isError).toBe(true);
    await expect(client.readResource({ uri: `aikido://${encodeURIComponent(docPath)}` })).rejects.toThrow('not found');
    await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
    await runtime.call('aikido_snapshot', { operation: 'end', snapshotId: fresh.snapshotId });
  } finally { await client.close(); await server.close(); }
});

it('marks incomplete headers explicitly and ignores fenced fake headings', async () => {
  const { root, retrieval } = await fixture();
  const largeHeader = ['---', ...Array.from({ length: 45 }, (_, i) => `key${i}: value`), 'last_check: pending', '---',
    '# C#', '```', '## Fake', '```', '## Real', 'tail'].join('\n');
  await writeFile(path.join(root, docPath), largeHeader);
  const metadata = JSON.parse(await retrieval.read({ operation: 'metadata' }, docPath));
  expect(metadata).toMatchObject({ check_status: 'unknown-truncated-header', header: { endLine: 40, truncated: true } });
  const outline = JSON.parse(await retrieval.read({ operation: 'outline' }, docPath));
  expect(outline.headings.map((item: { title: string }) => item.title)).toEqual(['C#', 'Real']);
  expect(JSON.parse(await retrieval.read({ section: 'Real' }, docPath)).content).toBe('## Real\ntail');
  const result = JSON.parse(await retrieval.search({ contextLines: 0 }, [{
    id: docPath, path: docPath, kind: 'knowledge', title: 'Design', line: 1, excerpt: '---',
  }], { engine: 'test' }));
  expect(result.documents[fileId(docPath)].header.truncated).toBe(true);
});

it('paginates MCP resource/prompt catalogues rather than flooding the harness on discovery', async () => {
  const { root, knowledge } = await fixture();
  for (let i = 0; i < 53; i++) await writeFile(path.join(root, `prompts/doc-${i}.md`), `# Entry ${i}\n`);
  await knowledge.refresh();
  const server = createAikidoMcpServer(knowledge);
  const client = new Client({ name: 'catalogue-pages-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const resources: string[] = [], prompts: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listResources(cursor ? { cursor } : undefined);
      expect(result.resources.length).toBeLessThanOrEqual(25);
      resources.push(...result.resources.map(item => item.uri));
      cursor = result.nextCursor;
    } while (cursor);
    do {
      const result = await client.listPrompts(cursor ? { cursor } : undefined);
      expect(result.prompts.length).toBeLessThanOrEqual(25);
      prompts.push(...result.prompts.map(item => item.name));
      cursor = result.nextCursor;
    } while (cursor);
    expect(new Set(resources).size).toBe(56);
    expect(new Set(prompts).size).toBe(56);
    await expect(client.listResources({ cursor: '-1' })).rejects.toThrow('cursor');
  } finally { await client.close(); await server.close(); }
});

it('uses real fast-grep with pre-limit filters and compact source-grounded excerpts/headers', async () => {
  const { root, knowledge } = await fixture();
  for (let i = 0; i < 15; i++) await writeFile(path.join(root, `src/match-${i}.ts`), '// needle\n');
  const { snapshotId } = JSON.parse(await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'begin' }));
  const input = { snapshotId, query: 'needle', pathPrefix: 'prompts/gen', contextLines: 1, limit: 1, maxBytes: 4096 };
  const raw = await runtimeFor(knowledge).call('aikido_search', input);
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4096);
  const result = JSON.parse(raw);
  expect(result).toMatchObject({ engine: 'fast-grep', count: 1, results: [{ path: docPath, line: 13, startLine: 12, endLine: 14 }] });
  expect(result.results[0].excerpt).toBe(doc.split('\n').slice(11, 14).join('\n'));
  expect(Object.keys(result.documents)).toEqual([fileId(docPath)]);
  expect(result.documents[fileId(docPath)].header.content).toContain('last_check:');
  expect(raw).not.toContain('Use Docker.');
  const regex = JSON.parse(await runtimeFor(knowledge).call('aikido_search', { ...input, mode: 'regex', query: 'n[e]{2}dle' }));
  expect(regex.results[0].path).toBe(docPath);
  const capped = await runtimeFor(knowledge).call('aikido_search', { snapshotId, query: 'needle', limit: 2, maxBytes: 2048 });
  expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(2048);
  expect(JSON.parse(capped).truncated).toBe(true);
  await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'end', snapshotId });
});

it('deduplicates file headers and returns under 10% of full-file bytes on a 500-line targeted lookup', async () => {
  const { root, knowledge } = await fixture();
  const lines = Array.from({ length: 500 }, (_, i) => `Source ${i + 1}: ${'unrelated content '.repeat(6)}`);
  lines[0] = '# Large AI-KIDO document';
  lines[249] = 'needle first decision';
  lines[349] = 'needle second decision';
  const full = lines.join('\n') + '\n';
  await writeFile(path.join(root, docPath), full);
  const { snapshotId } = JSON.parse(await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'begin' }));
  const raw = await runtimeFor(knowledge).call('aikido_search', {
    snapshotId, query: 'needle', pathPrefix: docPath, contextLines: 1, limit: 5,
  });
  const parsed = JSON.parse(raw);
  expect(parsed.count).toBe(2);
  expect(Object.keys(parsed.documents)).toHaveLength(1);
  expect(parsed.results.map((result: { line: number }) => result.line)).toEqual([250, 350]);
  expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(full) * 0.10);
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(16384);
  const expanded = JSON.parse(await runtimeFor(knowledge).call('aikido_file', {
    snapshotId, operation: 'read', path: parsed.results[0].file_id, startLine: 249, endLine: 251,
  }));
  expect(expanded.content).toBe(lines.slice(248, 251).join('\n'));
  await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'end', snapshotId });
});

it('defaults search to token-frugal locations grouped by file, then serves passages in one merged ranges batch', async () => {
  const { root, knowledge } = await fixture();
  const lines = Array.from({ length: 500 }, (_, i) => `Source ${i + 1}: ${'unrelated content '.repeat(6)}`);
  lines[249] = 'needle first decision';
  lines[251] = 'needle second decision';
  await writeFile(path.join(root, docPath), lines.join('\n') + '\n');
  const runtime = runtimeFor(knowledge);
  const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
  const raw = await runtime.call('aikido_search', { snapshotId, query: 'needle', limit: 10 });
  const located = JSON.parse(raw);
  expect(located).toMatchObject({ engine: 'fast-grep', count: 3, files: 2, truncated: false });
  expect(located.results).toEqual(expect.arrayContaining([
    { path: docPath, lines: 500, hits: [250, 252] }, { path: 'src/example.ts', lines: 1, hits: [1] }]));
  expect(raw).not.toMatch(/excerpt|documents|scoreDetails|unrelated content/);
  const excerpts = await runtime.call('aikido_search', { snapshotId, query: 'needle', limit: 10, detail: 'excerpts' });
  expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(excerpts) / 3);
  await expect(runtime.call('aikido_search', { snapshotId, query: 'needle', detail: 'locations', contextLines: 1 })).rejects.toThrow('contextLines requires detail=excerpts');

  const batch = JSON.parse(await runtime.call('aikido_file', { snapshotId, operation: 'ranges', contextLines: 1, ranges: [
    { path: docPath, startLine: 250 }, { path: docPath, startLine: 252 }, { path: 'src/example.ts', startLine: 1 },
    { path: 'missing.md', startLine: 1 }, { path: docPath, startLine: 9999 }] }));
  expect(batch).toMatchObject({ count: 2, truncated: false, passages: [
    { path: docPath, startLine: 249, endLine: 253, content: lines.slice(248, 253).join('\n') },
    { path: 'src/example.ts', startLine: 1, endLine: 1, content: '// needle from source' }] });
  expect(batch.errors.map((item: { path: string }) => item.path)).toEqual(['missing.md']);

  const budget = JSON.parse(await runtime.call('aikido_file', { snapshotId, operation: 'ranges', maxBytes: 2048,
    ranges: [{ path: docPath, startLine: 1, endLine: 200 }, { path: 'src/example.ts', startLine: 1 }] }));
  expect(budget.truncated).toBe(true);
  expect(budget.passages[0].endLine).toBeLessThan(200);
  expect(budget.remaining).toEqual([{ path: docPath, startLine: budget.passages[0].endLine + 1, endLine: 200 },
    { path: 'src/example.ts', startLine: 1, endLine: 1 }]);
  await expect(runtime.call('aikido_file', { snapshotId, operation: 'ranges', path: docPath, ranges: [{ path: docPath, startLine: 1 }] })).rejects.toThrow('operation=ranges takes ranges[]');
  await expect(runtime.call('aikido_file', { snapshotId, operation: 'ranges', ranges: [{ path: '../etc/passwd', startLine: 1 }] }))
    .resolves.toContain('"errors"');
  await expect(runtime.call('aikido_file', { snapshotId, operation: 'read', path: docPath, contextLines: 1 })).rejects.toThrow('require operation=ranges');
  await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
});

it('reports semantic chunks as inclusive [start,end] locations without passage text', async () => {
  const { knowledge, retrieval } = await fixture();
  const located = JSON.parse(await retrieval.search({}, [
    { id: docPath, path: docPath, kind: 'knowledge', title: 'Design', line: 11, excerpt: '## Isolation\nKeep each agent scoped.\nneedle', score: 0.91 },
    { id: docPath, path: docPath, kind: 'knowledge', title: 'Design', line: 12, excerpt: 'Keep each agent scoped.', score: 0.5 },
  ], { engine: 'embsearch-core', model: 'm', status: 'ok', chunks: 9, queryPlan: { terms: ['needle'], expansions: [
    { term: 'aiguille', relation: 'alias', concept: 'Needle', path: 'prompts/glossary.md', line: 4 }], warnings: [], semanticQuery: 'x', policy: 'long' },
  branches: [{ mode: 'semantic', status: 'ok', ms: 12.345, engine: 'embsearch-core', count: 2 }] }));
  expect(located).toEqual({ engine: 'embsearch-core', model: 'm', status: 'ok', count: 1, files: 1, truncated: false,
    query: { terms: ['needle'], expansions: [{ term: 'aiguille', concept: 'Needle', relation: 'alias', source: 'prompts/glossary.md:4' }] },
    results: [{ path: docPath, lines: 20, score: 0.91, hits: [[11, 13]] }] });
  expect(knowledge).toBeDefined();
});

it('publishes the token-frugal search protocol to any MCP client at initialization', async () => {
  const { knowledge } = await fixture();
  const server = createAikidoMcpServer(knowledge);
  const client = new Client({ name: 'instructions-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    expect(client.getInstructions()).toMatch(/detail=locations[\s\S]*ONE aikido_file operation=ranges/);
    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === 'aikido_file')?.inputSchema.properties).toHaveProperty('ranges');
    expect(tools.find(tool => tool.name === 'aikido_search')?.inputSchema.properties).toHaveProperty('detail');
  } finally { await client.close(); await server.close(); }
});
