import { corpusConfig } from '../src/corpus-config.js';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { createAikidoMcpServer } from '../src/server.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { runProcess } from '../src/process.js';
import * as processes from '../src/process.js';
import { sourceSnapshot } from '../src/index-basis.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-semantic-test-'));
  directories.push(root);
  await mkdir(path.join(root, 'prompts/spec'), { recursive: true });
  await mkdir(path.join(root, 'prompts/hard_points/commands'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# AI-KIDO knowledge');
  await writeFile(path.join(root, 'prompts/secrets.md'), 'Never store passwords or API keys in source code. Use a vault and rotate credentials regularly.');
  await writeFile(path.join(root, 'prompts/cooking.md'), 'Pour faire un gateau, melanger la farine, les oeufs et le sucre.');
  await writeFile(path.join(root, 'prompts/hard_points/commands/protect.md'), 'Prepare release notes and tag versions before packaging.');
  await writeFile(path.join(root, 'prompts/spec/private.md'), 'Secret vault passwords confidential credentials.');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  directories.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return knowledge;
}

it('reuses a fresh semantic index at startup instead of rebuilding it', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const current = await sourceSnapshot(knowledge);
  await mkdir(knowledge.searchIndex.directory, { recursive: true });
  await writeFile(path.join(knowledge.searchIndex.directory, 'semantic-basis.json'), JSON.stringify({
    attempt: 'previous', phase: 'ready', lastSuccessful: { ...current, indexedAt: '2026-10-24T00:00:00.000Z' },
  }));
  const run = vi.spyOn(processes, 'runProcess');
  try {
    knowledge.semanticIndex.warmup();
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({
      phase: 'ready', operation: 'update', indexedAt: '2026-10-24T00:00:00.000Z',
    });
    expect(run.mock.calls.some(([executable]) => executable.includes('kimono-semantic'))).toBe(false);
  } finally {
    run.mockRestore();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
  }
});

it('reports semantic indexing stage and progress during startup preparation', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const realRunProcess = processes.runProcess;
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":1,"total":2}\n');
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 2, embedded: 2, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  try {
    knowledge.semanticIndex.warmup();
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({
      phase: 'ready', stage: 'document_embedding', progress: { completed: 1, total: 2 },
    });
  } finally {
    run.mockRestore();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
  }
});

it('publishes live file, token and chunk counters with ETA to a status file shared across processes', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const realRunProcess = processes.runProcess;
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const observed: unknown[] = [];
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":0,"total":4}\n');
    await new Promise(resolve => setTimeout(resolve, 20));
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":2,"total":4}\n');
    observed.push(knowledge.semanticIndex.status());
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":4,"total":4}\n');
    observed.push(JSON.parse(await readFile(knowledge.semanticIndex.statusFile, 'utf8')));
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 4, embedded: 4, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  try {
    knowledge.semanticIndex.warmup();
    await knowledge.semanticIndex.idle();
    const files = knowledge.corpusStatus.files;
    expect(files).toBeGreaterThan(0);
    expect(observed[0]).toMatchObject({ phase: 'running', stage: 'document_embedding',
      files: { completed: files, total: files }, embedded: { completed: 2, total: 4 } });
    expect((observed[0] as { etaSeconds: number }).etaSeconds).toBeGreaterThan(0);
    expect((observed[0] as { estimatedTokens: { completed: number } }).estimatedTokens.completed).toBeGreaterThan(0);
    expect(observed[1]).toMatchObject({ phase: 'running', pid: process.pid, embedded: { completed: 4, total: 4 } });
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', chunks: 4, etaSeconds: 0,
      files: { completed: files, total: files }, embedded: { completed: 4, total: 4 } });
    const shared = JSON.parse(await readFile(knowledge.semanticIndex.statusFile, 'utf8'));
    expect(shared).toMatchObject({ phase: 'ready', chunks: 4, pid: process.pid });
    const statusName = path.basename(knowledge.semanticIndex.statusFile);
    expect((await readdir(path.dirname(knowledge.semanticIndex.statusFile))).filter(name => name.startsWith(statusName))).toEqual([statusName]);

    // Another process on the same ROOT sees the live state of the writer.
    const observer = new AikidoKnowledgeBase(knowledge.root, false, corpusConfig({ mode: 'aikido' }));
    await writeFile(observer.semanticIndex.statusFile, JSON.stringify({ ...shared, phase: 'running', pid: process.ppid }));
    expect(observer.semanticIndex.status()).toMatchObject({ phase: 'running', source: 'another-process' });
    await writeFile(observer.semanticIndex.statusFile, JSON.stringify({ ...shared, phase: 'running', pid: 2 ** 31 - 2 }));
    expect(observer.semanticIndex.status()).toMatchObject({ phase: 'unknown', stage: 'interrupted' });
  } finally {
    run.mockRestore();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
  }
});

it('reuses one measured provider selection across concurrent roots and exposes runtime and batch timing', async () => {
  const first = await fixture(), second = await fixture();
  vi.stubEnv('KIMONO_MODEL_DIR', path.join(first.root, 'test-model'));
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'auto');
  const realRunProcess = processes.runProcess;
  const devices: Array<string | undefined> = [];
  const runtime = { executionProvider: 'cpu', gpuExecutionVerified: false, workers: 1, threads: 2, batch: 8,
    benchmarks: [{ executionProvider: 'cpu', medianMs: 20, error: null },
      { executionProvider: 'coreml', medianMs: 200, error: null }] };
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    devices.push(environment?.KIMONO_SEMANTIC_DEVICE);
    const report = { ...runtime, benchmarks: environment?.KIMONO_SEMANTIC_DEVICE === 'cpu' ? [] : runtime.benchmarks };
    await new Promise(resolve => setTimeout(resolve, 20));
    onStderr?.(`KIMONO_PROGRESS ${JSON.stringify({ phase: 'runtime_configured', completed: 0, total: 0, runtime: report })}\n`);
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":2,"total":2,"batchMs":40}\n');
    onStderr?.('KIMONO_PROGRESS {"phase":"document_embedding","completed":1,"total":2,"batchMs":99}\n');
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 2, embedded: 2, count: 0, results: [], runtime: report,
      changes: { added: [], modified: [], deleted: [] } }), stderr: '', exitCode: 0 };
  });
  try {
    const results = await Promise.all([first.semanticIndex.run('update'), second.semanticIndex.run('update')]);
    expect(devices).toEqual(['auto', 'cpu']);
    expect(results.map(result => result.runtime)).toEqual([runtime, runtime]);
    expect(first.semanticIndex.status()).toMatchObject({ runtime, batchMs: 40, progress: { completed: 2, total: 2 } });
  } finally { run.mockRestore(); vi.unstubAllEnvs(); }
});

it('rejects malformed runtime telemetry instead of reporting a successful GPU selection', async () => {
  const knowledge = await fixture();
  vi.stubEnv('KIMONO_MODEL_DIR', path.join(knowledge.root, 'test-model'));
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  const realRunProcess = processes.runProcess;
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, ...args) =>
    executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')
      ? realRunProcess(executable, ...args)
      : { stdout: JSON.stringify({ runtime: { executionProvider: 'cuda', gpuExecutionVerified: 'yes' } }), stderr: '', exitCode: 0 });
  try {
    await expect(knowledge.semanticIndex.run('update')).rejects.toThrow('Invalid semantic runtime response');
    expect(knowledge.semanticIndex.status().phase).toBe('error');
  } finally { run.mockRestore(); vi.unstubAllEnvs(); }
});

it('waits for another live indexer and reclaims a lock left by a dead process', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const realRunProcess = processes.runProcess;
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 1, embedded: 1, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  const lock = path.join(knowledge.searchIndex.directory, 'semantic-basis.lock');
  try {
    await mkdir(knowledge.searchIndex.directory, { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: process.ppid, host: (await import('node:os')).hostname() }));
    knowledge.semanticIndex.warmup();
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'waiting', stage: 'waiting_for_other_indexer' });

    await writeFile(lock, JSON.stringify({ pid: 2 ** 31 - 2, host: (await import('node:os')).hostname() }));
    knowledge.semanticIndex.warmup();
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', chunks: 1 });
    await expect(access(lock)).rejects.toThrow();
  } finally {
    run.mockRestore();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
  }
});

describe.skipIf(!process.env.KIMONO_MODEL_DIR)('real multilingual ONNX semantic search', () => {
  it('searches supplied vectors through MCP with model checks, filters and fresh index contents', async () => {
    const knowledge = await fixture();
    const server = createAikidoMcpServer(knowledge);
    const client = new Client({ name: 'vector-search-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const runtime = runtimeFor(knowledge);
    let snapshotId = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' })).snapshotId;
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: name === 'aikido_search' || name === 'aikido'
        ? { detail: args.contextLines === undefined ? 'locations' : 'excerpts', ...args, snapshotId } : args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      if (!Array.isArray(response.content) || response.content[0]?.type !== 'text') throw new Error('Expected text result');
      return JSON.parse(response.content[0].text);
    };
    try {
      const query = 'Comment proteger les identifiants secrets ?';
      const embedding = await call('aikido_embed', { text: query, usage: 'query' });
      const args = { mode: 'semantic', vector: embedding.vector, embeddingModel: embedding.model, limit: 4 };
      const textResult = await call('aikido_search', { mode: 'semantic', query, limit: 4 });
      const vectorResult = await call('aikido_search', args);
      expect(vectorResult.embedded).toBe(0);
      expect(vectorResult.results.map((hit: { path: string }) => hit.path)).toEqual(textResult.results.map((hit: { path: string }) => hit.path));
      vectorResult.results.forEach((hit: { score: number }, index: number) => {
        expect(hit.score).toBeCloseTo(textResult.results[index].score, 5);
      });
      const scaled = await call('aikido_search', { ...args, vector: embedding.vector.map((value: number) => value * 1e25) });
      expect(scaled.results[0].score).toBeCloseTo(vectorResult.results[0].score, 5);
      const filtered = await call('aikido', { operation: 'search', ...args, kind: 'command', limit: 1, detail: 'excerpts' });
      expect(filtered.results).toHaveLength(1);
      expect(filtered.results[0].kind).toBe('command');
      const pathFiltered = await call('aikido_search', { ...args, pathPrefix: 'prompts/cooking.md', limit: 1, contextLines: 0 });
      expect(pathFiltered.results).toHaveLength(1);
      expect(pathFiltered.results[0].path).toBe('prompts/cooking.md');
      expect(pathFiltered.embedded).toBe(0);
      expect(pathFiltered.documents[pathFiltered.results[0].file_id]).toMatchObject({ lines: 1, type: 'markdown' });
      expect((await call('aikido_search', { ...args, scope: 'code' })).results).toEqual([]);
      const document = await call('aikido_embed', { text: 'Never store passwords or API keys in source code.', usage: 'document' });
      const similar = await call('aikido_search', { ...args, vector: document.vector, embeddingModel: document.model, limit: 1 });
      expect(similar.results[0].path).toBe('prompts/secrets.md');
      await writeFile(path.join(knowledge.root, 'prompts/new.md'), 'Protect access tokens with a secrets manager.');
      expect((await call('aikido_search', args)).chunks).toBe(4);
      await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
      snapshotId = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' })).snapshotId;
      expect((await call('aikido_search', args)).chunks).toBe(5);
      await rm(path.join(knowledge.root, 'prompts/secrets.md'));
      await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
      snapshotId = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' })).snapshotId;
      const afterDeletion = await call('aikido_search', args);
      expect(afterDeletion.chunks).toBe(4);
      expect(afterDeletion.results.some((hit: { path: string }) => hit.path === 'prompts/secrets.md')).toBe(false);
      for (const invalid of [
        { ...args, query }, { ...args, embeddingModel: 'different-model' },
        { ...args, embeddingModel: undefined }, { ...args, vector: [1, 2] },
        { ...args, vector: Array(384).fill(0) }, { ...args, vector: [] },
        { ...args, vector: [1e100] }, { ...args, vector: ['bad'] },
        { ...args, mode: 'literal' }, { ...args, regex: true },
      ]) {
        expect((await client.callTool({ name: 'aikido_search', arguments: { ...invalid, snapshotId } })).isError).toBe(true);
      }
      await expect(runtime.call('aikido_search', { ...args, snapshotId, vector: [NaN] })).rejects.toThrow('finite');
      await expect(runtime.call('aikido_search', { ...args, snapshotId, vector: [Infinity] })).rejects.toThrow('finite');
    } finally {
      await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
      await client.close();
      await server.close();
    }
  }, 90_000);

  it('returns real normalized query/document embeddings through MCP without a ROOT or index', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'kimono-embed-test-'));
    directories.push(parent);
    const knowledge = new AikidoKnowledgeBase(path.join(parent, 'absent-root'), false, corpusConfig({ mode: 'aikido' }));
    const server = createAikidoMcpServer(knowledge);
    const client = new Client({ name: 'embedding-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const infoResponse = await client.callTool({ name: 'aikido_embed', arguments: { operation: 'info' } });
      expect(infoResponse.isError, JSON.stringify(infoResponse)).not.toBe(true);
      if (!Array.isArray(infoResponse.content) || infoResponse.content[0]?.type !== 'text') throw new Error('Expected text info');
      const info = JSON.parse(infoResponse.content[0].text);
      expect(info).toMatchObject({ engine: 'embsearch-core', version: '0.3.4', dimensions: 384,
        normalized: true, maxTokens: 512, pooling: 'mean', queryPrefix: 'query: ', documentPrefix: 'passage: ' });
      expect(info.vector).toBeUndefined();
      for (const file of ['model.onnx', 'tokenizer.json', 'model.json']) {
        const bytes = await readFile(path.join(process.env.KIMONO_MODEL_DIR!, file));
        expect(info.sha256[file]).toBe(createHash('sha256').update(bytes).digest('hex'));
      }
      expect(info.compatibility).toContain('provenance');
      const embed = async (usage?: string) => {
        const response = await client.callTool({ name: 'aikido_embed',
          arguments: { text: 'Comment proteger les identifiants secrets ?', ...(usage ? { usage } : {}) } });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const content = response.content;
        if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected text result');
        const result = JSON.parse(content[0].text);
        expect(result).toMatchObject({ engine: 'embsearch-core', version: '0.3.4',
          usage: usage ?? 'query', dimensions: 384, normalized: true, maxTokens: 512 });
        expect(result.model).toContain('multilingual-e5-small');
        expect(result.model).toBe(info.model);
        expect(result.vector).toHaveLength(384);
        expect(result.vector.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
        const norm = Math.sqrt(result.vector.reduce((sum: number, value: number) => sum + value * value, 0));
        expect(norm).toBeCloseTo(1, 5);
        return result.vector;
      };
      const query = await embed();
      const document = await embed('document');
      expect(document).not.toEqual(query);
      expect(await embed('query')).toEqual(query);
      for (const args of [{ text: '   ' }, { text: 'x', usage: 'invalid' },
        { text: 'é'.repeat(16385) }, { text: 123 }, { operation: 'unknown' },
        { operation: 'info', text: 'unexpected' }]) {
        const response = await client.callTool({ name: 'aikido_embed', arguments: args });
        expect(response.isError).toBe(true);
      }
      await expect(access(knowledge.root)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(knowledge.searchIndex.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);

  it('retrieves by meaning across languages with bounded sorted scores and kind filters', async () => {
    const knowledge = await fixture();
    const query = 'Comment proteger les identifiants secrets ?';
    expect(await knowledge.search(query)).toEqual([]);
    const result = await knowledge.semanticIndex.run('search', { query, limit: 1 });
    expect(result.engine).toBe('embsearch-core');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ path: 'prompts/secrets.md', line: 1 });
    expect(result.results[0].score).toBeGreaterThan(0.70);
    expect(result.chunks).toBe(4);
    const filtered = await knowledge.semanticIndex.run('search', { query, kind: 'command', limit: 1 });
    expect(filtered.results[0].kind).toBe('command');
    expect(filtered.embedded).toBe(0);
    expect(filtered.results.some((result) => result.path.includes('/spec/'))).toBe(false);
    const sorted = await knowledge.semanticIndex.run('search', { query, limit: 4 });
    expect(sorted.results.map((hit) => hit.score)).toEqual(sorted.results.map((hit) => hit.score).sort((a, b) => b - a));
  }, 60_000);

  it('persists vectors, incrementally handles edits/additions/deletions and rebuilds/compacts', async () => {
    const knowledge = await fixture();
    expect(knowledge.semanticIndex.status().phase).toBe('unknown');
    const indexing = runtimeFor(knowledge).call('aikido_index', { operation: 'update', mode: 'semantic' });
    await vi.waitFor(() => expect(knowledge.semanticIndex.status().phase).toBe('running'));
    const running = JSON.parse(await runtimeFor(knowledge).call('aikido_index', { operation: 'status', mode: 'semantic' }));
    expect(running.phase).toBe('running');
    const first = JSON.parse(await indexing);
    expect(first.embedded).toBe(4);
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', chunks: 4,
      progress: { completed: 4, total: 4 } });
    expect((await knowledge.semanticIndex.run('stats')).embedded).toBe(0);
    await writeFile(path.join(knowledge.root, 'prompts/secrets.md'), 'Protect access tokens with a secrets manager and never disclose credentials.');
    expect((await knowledge.semanticIndex.run('update')).embedded).toBe(1);
    await writeFile(path.join(knowledge.root, 'prompts/new.md'), 'Rotate compromised passwords immediately.');
    await knowledge.refresh();
    expect((await knowledge.semanticIndex.run('update')).embedded).toBe(1);
    await rm(path.join(knowledge.root, 'prompts/new.md'));
    await knowledge.refresh();
    const removed = await knowledge.semanticIndex.run('update');
    expect(removed.embedded).toBe(0);
    expect(removed.chunks).toBe(4);
    expect((await knowledge.semanticIndex.run('compact')).chunks).toBe(4);
    expect((await knowledge.semanticIndex.run('rebuild')).embedded).toBe(4);
  }, 120_000);

  it('exposes semantic search/index through MCP and rejects invalid mode combinations without fallback', async () => {
    const knowledge = await fixture();
    const server = createAikidoMcpServer(knowledge);
    const client = new Client({ name: 'semantic-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const runtime = runtimeFor(knowledge);
    const { snapshotId } = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    try {
      const response = await client.callTool({ name: 'aikido_search',
        arguments: { snapshotId, mode: 'semantic', query: 'Comment proteger les identifiants secrets ?', limit: 1, detail: 'locations' } });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"engine":"embsearch-core"') }] });
      const alias = await client.callTool({ name: 'aikido',
        arguments: { snapshotId, operation: 'search', mode: 'semantic', query: 'garder les mots de passe en securite', limit: 2 } });
      expect(alias.isError, JSON.stringify(alias)).not.toBe(true);
      for (const mode of ['semantic', 'hybrid']) {
        const batch = JSON.parse(await runtime.call('aikido_search', {
          snapshotId, mode, queries: ['Comment proteger les identifiants secrets ?', 'garder les mots de passe en securite'],
          limit: 1, pathPrefix: 'prompts/secrets.md',
        }));
        expect(batch.snapshotId).toBe(snapshotId);
        expect(batch.searches).toHaveLength(2);
        expect(batch.searches.every((search: { results: Array<{ path: string }> }) =>
          search.results[0]?.path === 'prompts/secrets.md')).toBe(true);
      }
      const stats = await client.callTool({ name: 'aikido_index', arguments: { operation: 'status', mode: 'semantic' } });
      expect(stats.isError).not.toBe(true);
      await expect(runtime.call('aikido_search', { snapshotId, mode: 'semantic', regex: true, query: 'secrets' })).rejects.toThrow('conflicts');
      await expect(runtime.call('aikido_search', { snapshotId, mode: 'semantic', query: 'secrets', limit: 101 })).rejects.toThrow('1 and 100');
      const previous = process.env.KIMONO_MODEL_DIR;
      process.env.KIMONO_MODEL_DIR = path.join(knowledge.root, 'missing-model');
      try {
        const error = await client.callTool({ name: 'aikido_search', arguments: { snapshotId, mode: 'semantic', query: 'secrets' } });
        expect(error.isError, JSON.stringify(error)).toBe(true);
        const failedBatch = JSON.parse(await runtime.call('aikido_search', { snapshotId, mode: 'semantic', queries: ['secrets', 'passwords'] }));
        expect(failedBatch.searches).toHaveLength(2);
        expect(failedBatch.searches.every((search: { error?: string }) => !!search.error)).toBe(true);
        const status = await client.callTool({ name: 'aikido_index', arguments: { operation: 'status', mode: 'semantic' } });
        expect(status.isError).not.toBe(true);
        if (!Array.isArray(status.content) || status.content[0]?.type !== 'text') throw new Error('Expected status text');
        expect(JSON.parse(status.content[0].text)).toMatchObject({ phase: 'unknown' });
      } finally { process.env.KIMONO_MODEL_DIR = previous; }
    } finally {
      await runtime.call('aikido_snapshot', { operation: 'end', snapshotId });
      await client.close();
      await server.close();
    }
  }, 60_000);

  it('handles an empty corpus and rejects a corrupt generation without reading outside its cache', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kimono-empty-semantic-'));
    directories.push(directory);
    const cache = path.join(directory, 'cache');
    const request = path.join(directory, 'request.json');
    await writeFile(request, JSON.stringify({ operation: 'search', model: process.env.KIMONO_MODEL_DIR,
      cache, documents: [], query: 'secrets', limit: 1 }), { mode: 0o600 });
    const result = await runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic', [request], directory);
    expect(JSON.parse(result.stdout)).toMatchObject({ count: 0, chunks: 0, results: [] });
    await writeFile(path.join(cache, 'state.json'), JSON.stringify({ generation: '../outside', chunks: {}, model: '' }));
    await expect(runProcess(process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic', [request], directory)).rejects.toThrow('Invalid semantic generation');
  }, 30_000);
});
