import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { shutdownSemanticWorkers } from '../src/semantic-worker.js';

const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('vectorizes and searches PHP, Markdown and plain text with the persistent native worker', async () => {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-rag-content-'));
  scratch.push(parent);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  vi.stubEnv('KIMONO_SEMANTIC_PERSISTENT_WORKER', 'true');
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  const files = {
    'service.php': '<?php\nclass Authentication {\n    public function authenticate() { return true; }\n}',
    'guide.md': '# Authentication guide\n\nCheck credentials before granting access.',
    'notes.txt': 'Rotate credentials and keep passwords in a vault.',
  };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig());
  await knowledge.initialize();
  try {
    const updated = await knowledge.semanticIndex.run('update');
    expect(updated.changes.added).toEqual(Object.keys(files).sort());
    expect(updated.embedded).toBeGreaterThanOrEqual(3);
    expect(updated.skippedChunks ?? 0).toBe(0);
    expect(knowledge.semanticIndex.status().runtime).toMatchObject({ executionProvider: 'cpu' });
    for (const file of Object.keys(files)) {
      const result = await knowledge.semanticIndex.run('search', {
        query: 'Authentication credentials passwords', paths: [file], limit: 1,
      });
      expect(result.results[0].path).toBe(file);
      expect(result.results[0].score).toBeGreaterThan(0);
      expect(result.embedded).toBe(0);
    }
  } finally { await shutdownSemanticWorkers(); }
}, 60_000);

it('packs small code definitions without dropping source and reuses the resulting native index', async () => {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-rag-packing-'));
  scratch.push(parent);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  vi.stubEnv('KIMONO_SEMANTIC_PERSISTENT_WORKER', 'true');
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  const content = Array.from({ length: 20 }, (_, index) =>
    `export function symbol_${index}() { return ${index}; }\n`).join('');
  await writeFile(path.join(root, 'symbols.ts'), content);
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  try {
    expect(await knowledge.semanticIndex.info()).toMatchObject({
      passageChars: 500, smallFragmentChars: 200,
    });
    const updated = await knowledge.semanticIndex.run('update');
    expect(updated.chunkerVersion).toContain('lines-v7');
    expect(updated.chunks).toBeLessThanOrEqual(3);
    expect(updated.embedded).toBe(updated.chunks);
    expect(updated.skippedChunks ?? 0).toBe(0);
    const manifest = JSON.parse(await readFile(
      path.join(knowledge.searchIndex.directory, 'semantic/state.json'), 'utf8')) as {
      chunks: Record<string, { line: number; text: string }>;
    };
    const chunks = Object.entries(manifest.chunks).sort(([a], [b]) =>
      Number(a.slice(a.lastIndexOf('#') + 1)) - Number(b.slice(b.lastIndexOf('#') + 1)));
    expect(chunks.map(([, chunk]) => chunk.text).join('')).toBe(content);
    for (const [, chunk] of chunks) {
      expect([...chunk.text].length).toBeLessThanOrEqual(500);
      expect(content.split('\n')[chunk.line - 1]).toBe(chunk.text.split('\n')[0]);
    }
    const reused = await knowledge.semanticIndex.run('update');
    expect(reused.embedded).toBe(0);
    expect(reused.chunks).toBe(updated.chunks);
  } finally { await shutdownSemanticWorkers(); }
}, 60_000);

it('searches native lexical and semantic generic code, including scoped snapshots without AI-KIDO entry points', async () => {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-rag-'));
  scratch.push(parent);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const root = path.join(parent, 'repo');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'other'));
  await writeFile(path.join(root, 'src/server.rs'), '// Secure authentication checks tokens before granting access.\nfn authenticate() {}\n');
  await writeFile(path.join(root, 'other/app.tsx'), 'export const App = () => <main>Dashboard</main>;\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await writeFile(path.join(root, 'src/.gitignore'), 'generated.rs\n');
  await mkdir(path.join(root, 'ignored'));
  await mkdir(path.join(root, 'src/node_modules/pkg'), { recursive: true });
  for (const file of ['ignored/secret.rs', 'src/generated.rs', 'src/node_modules/pkg/index.ts']) {
    await writeFile(path.join(root, file), 'excluded_sentinel authentication authenticate');
  }
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig());
  await knowledge.initialize();
  const runtime = runtimeFor(knowledge);
  const updated = JSON.parse(await runtime.call('aikido_index', { operation: 'update', mode: 'all' }));
  const indexedFiles = ['.gitignore', 'other/app.tsx', 'src/.gitignore', 'src/server.rs'];
  expect(updated.indexes.literal.changes.added).toEqual(indexedFiles);
  expect(updated.indexes.semantic.changes.added).toEqual(indexedFiles);
  const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin', paths: ['src'] }));
  try {
    for (const mode of ['literal', 'text', 'semantic', 'hybrid']) {
      const search = JSON.parse(await runtime.call('aikido_search', { snapshotId, mode,
        query: mode === 'semantic' || mode === 'hybrid' ? 'secure authentication' : 'authenticate' }));
      expect(search.status).not.toBe('not-ready');
      expect(JSON.stringify(search)).toContain('src/server.rs');
      expect(JSON.stringify(search)).not.toContain('other/app.tsx');
      expect(JSON.stringify(search)).not.toMatch(/secret\.rs|generated\.rs|node_modules/);
      expect(search.results.every((file: Record<string, unknown>) =>
        JSON.stringify(Object.keys(file).sort()) === (file.contentStatus === 'metadata-only'
          ? '["contentStatus","path","ranges"]' : '["path","ranges"]'))).toBe(true);
      expect(JSON.stringify(search)).not.toMatch(/"content"|"excerpt"|"score"|Secure authentication checks tokens/);
    }
    for (const mode of ['literal', 'text', 'semantic', 'hybrid']) {
      const hidden = JSON.parse(await runtime.call('aikido_search', { snapshotId, mode, query: 'excluded_sentinel' }));
      expect(hidden.status).not.toBe('not-ready');
      expect(JSON.stringify(hidden)).not.toMatch(/secret\.rs|generated\.rs|node_modules/);
    }
    const ranges = JSON.parse(await runtime.call('aikido_file', { snapshotId, operation: 'ranges',
      ranges: [{ path: 'src/server.rs', startLine: 1, endLine: 2 }] }));
    expect(JSON.stringify(ranges)).toContain('fn authenticate');
  } finally { await runtime.call('aikido_snapshot', { operation: 'end', snapshotId }); }
}, 60_000);

it('bounds native lexical command arguments across large file catalogues without losing later matching files', async () => {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-rag-batch-'));
  scratch.push(parent);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const root = path.join(parent, 'repo');
  await mkdir(root);
  for (let index = 0; index < 250; index++) {
    await writeFile(path.join(root, `source-file-${String(index).padStart(4, '0')}-${'x'.repeat(80)}.go`),
      index === 249 ? 'package target // unique_late_evidence' : 'package placeholder');
  }
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  const { snapshotId } = JSON.parse(await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'begin' }));
  const result = JSON.parse(await runtimeFor(knowledge).call('aikido_search', { snapshotId, query: 'unique_late_evidence' }));
  expect(JSON.stringify(result)).toContain('source-file-0249');
  await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'end', snapshotId });
}, 30_000);
