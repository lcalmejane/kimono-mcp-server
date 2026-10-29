import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import {
  EMBEDDING_CATALOGUE, embeddingPolicy, installEmbeddingModel, modelDescriptor, modelDirectory,
  modelInstalled, modelsDirectory, readEmbeddingSettings, resolveEmbedding, saveEmbeddingSettings,
} from '../src/embedding-models.js';
import * as models from '../src/embedding-models.js';
import { runtimeFor } from '../src/runtime-tools.js';
import * as processes from '../src/process.js';
import { sourceSnapshot } from '../src/index-basis.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(files = ['app.ts', 'readme.md', 'notes.txt']) {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-models-'));
  directories.push(parent);
  const root = path.join(parent, 'root'), e5 = path.join(parent, 'e5');
  await mkdir(root);
  await mkdir(e5);
  await writeFile(path.join(e5, 'model.json'), '{}');
  await writeFile(path.join(e5, 'model.onnx'), '');
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  vi.stubEnv('KIMONO_MODELS_DIR', path.join(parent, 'models'));
  vi.stubEnv('KIMONO_MODEL_DIR', e5);
  vi.stubEnv('KIMONO_EMBEDDING_POLICY', 'e5');
  vi.stubEnv('KIMONO_SEMANTIC_PERSISTENT_WORKER', 'false');
  for (const file of files) await writeFile(path.join(root, file), `${file}\nsource text`);
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  return knowledge;
}

describe('embedding policies and persisted selection', () => {
  it('partitions mixed corpora without duplicating code in the documentation profile', async () => {
    const knowledge = await fixture();
    const balanced = resolveEmbedding(knowledge, 'auto-balanced');
    expect(balanced.profiles.map(({ model, scope }) => [model, scope])).toEqual([['code', 'code'], ['e5', 'documents']]);
    expect(resolveEmbedding(knowledge, 'auto-speed').profiles.map(({ model, scope }) => [model, scope]))
      .toEqual([['code', 'code'], ['multilingual-fast', 'documents']]);
    for (const policy of ['e5', 'code', 'multilingual-fast'] as const) {
      expect(resolveEmbedding(knowledge, policy).profiles).toMatchObject([{ model: policy, scope: 'all' }]);
    }
    expect(embeddingPolicy('auto-speed')).toBe('auto-speed');
    expect(() => embeddingPolicy('https://untrusted.invalid/model')).toThrow('Invalid');
  });
  it('keeps content type ahead of unmeasured size thresholds and distinguishes model identities', async () => {
    const knowledge = await fixture(['app.php']);
    const code = resolveEmbedding(knowledge, 'auto-balanced');
    expect(code.profiles).toMatchObject([{ model: 'code', scope: 'all' }]);
    expect(resolveEmbedding(knowledge, 'auto-speed').signature).toBe(code.signature);
    await saveEmbeddingSettings(knowledge, { version: 1, requestedPolicy: 'auto-balanced', active: code });
    expect(await readEmbeddingSettings(knowledge)).toEqual({ version: 1, requestedPolicy: 'auto-balanced', active: code });
    const settings = path.join(knowledge.searchIndex.directory, 'embedding-settings.json');
    await writeFile(settings, '{"version":1,"requestedPolicy":"invalid"}');
    await expect(readEmbeddingSettings(knowledge)).rejects.toThrow('Invalid embedding policy');
    expect((await readdir(knowledge.root)).sort()).toEqual(['app.php']);
    vi.stubEnv('KIMONO_MODELS_DIR', path.join(knowledge.root, 'models'));
    expect(() => modelsDirectory(knowledge.root)).toThrow('outside ROOT');
  });
  it('reports downloads explicitly, never downloads on status, and preserves active settings on a missing-model request', async () => {
    const knowledge = await fixture();
    const active = resolveEmbedding(knowledge, 'e5');
    await saveEmbeddingSettings(knowledge, { version: 1, requestedPolicy: 'e5', active });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(knowledge.semanticIndex.configureModels('auto-speed', false)).rejects.toThrow('confirmation');
    await expect(knowledge.semanticIndex.configureModels('auto-speed', true)).resolves.toMatchObject({
      requestedPolicy: 'auto-speed', activePolicy: 'e5', phase: 'download-required', missingModels: ['code', 'multilingual-fast'],
    });
    expect((await readEmbeddingSettings(knowledge))?.active).toEqual(active);
    await knowledge.semanticIndex.models();
    expect(fetch).not.toHaveBeenCalled();
    expect((await readdir(knowledge.root)).sort()).toEqual(['app.ts', 'notes.txt', 'readme.md']);
  });
  it('rejects invalid management requests and never infers download consent', async () => {
    const knowledge = await fixture();
    await expect(runtimeFor(knowledge).call('aikido_models', { operation: 'status', confirmed: true })).rejects.toThrow('Invalid');
    await expect(runtimeFor(knowledge).call('aikido_models', { operation: 'install', model: 'code' })).rejects.toThrow('confirmation');
    await expect(runtimeFor(knowledge).call('aikido_models', { operation: 'install', model: '../model', confirmed: true })).rejects.toThrow('Unknown');
    const status = JSON.parse(await runtimeFor(knowledge).call('aikido_models', { operation: 'status' }));
    expect(status.models.map((model: { id: string }) => model.id)).toEqual(['code', 'multilingual-fast', 'e5']);
  });

  it('reflects shared rebuild progress and errors in the model management status', async () => {
    const knowledge = await fixture();
    const active = resolveEmbedding(knowledge, 'e5');
    await saveEmbeddingSettings(knowledge, { version: 1, requestedPolicy: 'e5', active });
    const status = vi.spyOn(knowledge.semanticIndex, 'status').mockReturnValue({ phase: 'running', operation: 'rebuild', source: 'another-process' });
    expect(await knowledge.semanticIndex.models()).toMatchObject({ phase: 'building' });
    status.mockReturnValue({ phase: 'error', operation: 'rebuild', error: 'Native rebuild failed' });
    expect(await knowledge.semanticIndex.models()).toMatchObject({ phase: 'error', error: 'Native rebuild failed', activePolicy: 'e5' });
  });
});

describe('confirmed pinned downloads', () => {
  it('installs only verified files atomically, is idempotent and removes partial downloads on corruption', async () => {
    const knowledge = await fixture();
    const model = EMBEDDING_CATALOGUE[0]!, original = model.files;
    const data = Buffer.from('tiny verified download');
    model.files = [{ name: 'model.safetensors', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }];
    const fetch = vi.fn(async () => {
      const response = new Response(data);
      Object.defineProperty(response, 'url', { value: 'https://huggingface.co/public-fixture' });
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await installEmbeddingModel(knowledge.root, 'code', true);
      expect(await modelInstalled(knowledge.root, 'code')).toBe(true);
      expect(JSON.parse(await readFile(path.join(modelDirectory(knowledge.root, 'code'), 'model.json'), 'utf8')))
        .toEqual(modelDescriptor(model));
      expect(fetch.mock.calls).toHaveLength(1);
      await installEmbeddingModel(knowledge.root, 'code', true);
      expect(fetch.mock.calls).toHaveLength(1);
      await rm(modelDirectory(knowledge.root, 'code'), { recursive: true });
      model.files = [{ name: 'model.safetensors', bytes: data.length, sha256: '0'.repeat(64) }];
      await expect(installEmbeddingModel(knowledge.root, 'code', true)).rejects.toThrow('checksum');
      expect(await readdir(modelsDirectory(knowledge.root))).toEqual([]);
    } finally { model.files = original; }
  });
  it('cleans up oversized responses and refuses simultaneous installs', async () => {
    const knowledge = await fixture();
    const model = EMBEDDING_CATALOGUE[0]!, original = model.files;
    model.files = [{ name: 'model.safetensors', bytes: 1, sha256: '0'.repeat(64) }];
    vi.stubGlobal('fetch', vi.fn(async () => {
      const response = new Response('too large');
      Object.defineProperty(response, 'url', { value: 'https://huggingface.co/public-fixture' });
      return response;
    }));
    try {
      await expect(installEmbeddingModel(knowledge.root, 'code', true)).rejects.toThrow('pinned size');
      expect(await readdir(modelsDirectory(knowledge.root))).toEqual([]);
      await writeFile(`${modelDirectory(knowledge.root, 'code')}.lock`, '');
      await expect(installEmbeddingModel(knowledge.root, 'code', true)).rejects.toThrow('already being installed');
    } finally { model.files = original; }
  });
});

it('retains the old active selection when a confirmed rebuild fails', async () => {
  const knowledge = await fixture();
  const active = resolveEmbedding(knowledge, 'e5');
  await saveEmbeddingSettings(knowledge, { version: 1, requestedPolicy: 'e5', active });
  vi.spyOn(models, 'modelInstalled').mockResolvedValue(true);
  vi.spyOn(processes, 'runProcess').mockImplementation(async executable => {
    if (executable.includes('kimono-semantic')) throw new Error('inference failed');
    throw new Error('not a git repository');
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await knowledge.semanticIndex.configureModels('auto-speed', true);
  await knowledge.semanticIndex.idle();
  expect((await readEmbeddingSettings(knowledge))?.active).toEqual(active);
  expect((await readEmbeddingSettings(knowledge))?.error).toContain('inference failed');
  expect(await knowledge.semanticIndex.models()).toMatchObject({ activePolicy: 'e5', phase: 'error' });
  expect(error).toHaveBeenCalled();
  expect((await readdir(knowledge.searchIndex.directory)).some(file => file.endsWith('.lock'))).toBe(false);
});

it('activates only complete partitioned generations and pins both profiles into snapshots', async () => {
    const knowledge = await fixture();
    vi.spyOn(models, 'modelInstalled').mockResolvedValue(true);
    const calls: Array<{ operation: string; model: string; cache: string; documents?: Array<{ path: string; kind: string; content: string }> }> = [];
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const original = processes.runProcess;
    vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, ...rest) => {
      if (!executable.includes('kimono-semantic')) return original(executable, args, ...rest);
      const request = JSON.parse(await readFile(args[0]!, 'utf8'));
      calls.push(request);
      const { operation, model, cache } = request;
      const fingerprint = sha(model);
      if (operation === 'profile') return { stdout: JSON.stringify({ engine: 'embsearch-core', fingerprint }), stderr: '' };
      const generation = `store-${'a'.repeat(24)}`;
      if (operation === 'rebuild' || operation === 'update') {
        const documents = Object.fromEntries((request.documents ?? []).map((document: { path: string; kind: string; content: string }) =>
          [document.path, sha(JSON.stringify([document.kind, document.content]))]));
        const chunks = Object.fromEntries((request.documents ?? []).map((document: { path: string; kind: string; content: string }) =>
          [`${document.path}#0`, { path: document.path, kind: document.kind, text: document.content, line: 1, hash: sha(document.content) }]));
        await mkdir(path.join(cache, generation), { recursive: true });
        await writeFile(path.join(cache, 'state.json'), JSON.stringify({ generation, model: fingerprint, index_version: 'test', documents, chunks }));
      }
      const state = JSON.parse(await readFile(path.join(cache, 'state.json'), 'utf8'));
      const results = operation === 'search' ? Object.values(state.chunks).filter((chunk: unknown) =>
        chunk && typeof chunk === 'object' && 'path' in chunk && request.paths.includes(chunk.path)).map((chunk: unknown) => {
        if (!chunk || typeof chunk !== 'object' || !('path' in chunk) || !('text' in chunk)) throw new Error('Invalid test chunk');
        return { path: chunk.path, line: 1, score: 0.9, excerpt: chunk.text };
      }).slice(0, request.limit ?? 25) : [];
      return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model: path.basename(model),
        chunks: Object.keys(state.chunks).length, embedded: operation === 'rebuild' ? Object.keys(state.chunks).length : 0,
        count: results.length, results, changes: { added: [], modified: [], deleted: [] } }), stderr: '' };
    });
    const configured = await knowledge.semanticIndex.configureModels('auto-speed', true);
    expect(configured).toMatchObject({ phase: 'building' });
    await knowledge.semanticIndex.idle();
    const active = (await readEmbeddingSettings(knowledge))?.active;
    expect(active?.policy).toBe('auto-speed');
    const builds = calls.filter(call => call.operation === 'rebuild');
    expect(builds.map(call => call.documents?.map(document => document.path))).toEqual([['app.ts'], ['notes.txt', 'readme.md']]);
    expect(builds.every(call => call.cache.includes(path.join('semantic-models', active!.signature)))).toBe(true);
    expect(await knowledge.semanticIndex.models()).toMatchObject({ activePolicy: 'auto-speed', phase: 'ready' });
    const result = await knowledge.semanticIndex.run('search', { query: 'source', paths: ['app.ts', 'readme.md'] });
    expect(result.results.map(hit => hit.path).sort()).toEqual(['app.ts', 'readme.md']);
    expect(result.chunks).toBe(3);
    const before = await sourceSnapshot(knowledge);
    const snapshot = new AikidoKnowledgeBase(knowledge.root, true, knowledge.config);
    await snapshot.initialize();
    // Use a distinct snapshot cache while retaining source paths for this isolated unit test.
    Object.defineProperty(snapshot.searchIndex, 'directory', { value: path.join(path.dirname(knowledge.root), 'snapshot-cache') });
    expect(await snapshot.semanticIndex.seedFrom(knowledge.semanticIndex, before.corpusFingerprint!)).toBe(true);
    expect((await snapshot.semanticIndex.run('search', { query: 'source', paths: ['readme.md'] })).results.map(hit => hit.path)).toEqual(['readme.md']);
    expect(calls.filter(call => call.operation === 'search').slice(-2).every(call => call.cache.includes('snapshot-cache'))).toBe(true);
    await expect(snapshot.semanticIndex.configureModels('code', true)).rejects.toThrow('immutable');
    const implementation = vi.mocked(processes.runProcess).getMockImplementation()!;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(processes.runProcess).mockImplementation(async (executable, args, ...rest) => {
      if (executable.includes('kimono-semantic')) {
        const request = JSON.parse(await readFile(args[0]!, 'utf8'));
        if (request.operation === 'rebuild' && request.model.includes('multilingual-fast')) throw new Error('Second profile failed');
      }
      return implementation(executable, args, ...rest);
    });
    await knowledge.semanticIndex.configureModels('auto-speed', true);
    await knowledge.semanticIndex.idle();
    expect((await readEmbeddingSettings(knowledge))?.active).toEqual(active);
    for (const build of builds) {
      expect(JSON.parse(await readFile(path.join(build.cache, 'state.json'), 'utf8')).generation).toBe(`store-${'a'.repeat(24)}`);
    }
    expect((await knowledge.semanticIndex.run('search', { query: 'source', paths: ['app.ts', 'readme.md'] })).results).toHaveLength(2);
    const retainedSnapshot = new AikidoKnowledgeBase(knowledge.root, true, knowledge.config);
    await retainedSnapshot.initialize();
    Object.defineProperty(retainedSnapshot.searchIndex, 'directory', { value: path.join(path.dirname(knowledge.root), 'retained-snapshot-cache') });
    expect(await retainedSnapshot.semanticIndex.seedFrom(knowledge.semanticIndex, before.corpusFingerprint!)).toBe(true);
    expect((await retainedSnapshot.semanticIndex.run('search', { query: 'source', paths: ['readme.md'] })).results[0]?.path).toBe('readme.md');
});
