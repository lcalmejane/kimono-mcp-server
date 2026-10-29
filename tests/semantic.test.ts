import { corpusConfig } from '../src/corpus-config.js';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { shutdownSemanticWorkers } from '../src/semantic-worker.js';

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

it('publishes live worker transitions to the shared status file', async () => {
  const knowledge = await fixture();
  const binary = path.join(knowledge.root, 'fake-semantic-worker');
  const statusFile = path.join(knowledge.root, 'semantic-status.json');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const respond = result => process.stdout.write(JSON.stringify({
    version: 1, id: request.id, ok: true, result
  }) + '\\n');
  if (request.operation === 'shutdown') { respond({ shutdown: true }); process.exit(0); }
  const payload = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
  if (payload.operation === 'search') {
    respond({ engine: 'embsearch-core', version: 'test', model: 'test-model', chunks: 1, embedded: 0,
      count: 1, results: [{ path: 'prompts/index.md', line: 1, score: 0.9, excerpt: '# AI-KIDO knowledge' }],
      changes: { added: [], modified: [], deleted: [] }, hotIndexes: 1, hotIndexEstimatedBytes: 1024 });
    return;
  }
  respond({ engine: 'embsearch-core', version: 'test', model: 'test-model', usage: payload.usage,
    normalized: true, dimensions: 2, maxTokens: 16, vector: [0.6, 0.8] });
});
`);
  await chmod(binary, 0o700);
  const originalEnvironment = Object.fromEntries([
    'KIMONO_MODEL_DIR', 'KIMONO_SEMANTIC_BIN', 'KIMONO_SEMANTIC_PERSISTENT_WORKER', 'KIMONO_STATUS_FILE',
  ].map(name => [name, process.env[name]]));
  process.env.KIMONO_MODEL_DIR = path.join(knowledge.root, 'model');
  process.env.KIMONO_SEMANTIC_BIN = binary;
  process.env.KIMONO_SEMANTIC_PERSISTENT_WORKER = 'true';
  process.env.KIMONO_STATUS_FILE = statusFile;
  try {
    await expect(knowledge.semanticIndex.embed('worker status query')).resolves.toMatchObject({
      model: 'test-model', usage: 'query', dimensions: 2,
    });
    expect(JSON.parse(await readFile(statusFile, 'utf8')).worker).toMatchObject({ phase: 'ready' });
    await expect(knowledge.semanticIndex.run('search')).resolves.toMatchObject({
      hotIndexes: 1, hotIndexEstimatedBytes: 1024,
    });
    expect(JSON.parse(await readFile(statusFile, 'utf8'))).toMatchObject({
      hotIndexes: 1, hotIndexEstimatedBytes: 1024, worker: { phase: 'ready' },
    });
    await shutdownSemanticWorkers();
    expect(JSON.parse(await readFile(statusFile, 'utf8')).worker).toEqual({ phase: 'stopped' });
  } finally {
    await shutdownSemanticWorkers();
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

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

it('uses a clean Git and matching corpus configuration as a bounded freshness fast path', async () => {
  const knowledge = await fixture();
  await runProcess('git', ['init', '-q'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'add', '--all'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'commit', '-qm', 'fixture'], knowledge.root, [0]);
  const baseline = await sourceSnapshot(knowledge);
  const read = vi.spyOn(AikidoKnowledgeBase.prototype, 'tryRead');
  try {
    const unchanged = await sourceSnapshot(knowledge, undefined, baseline);
    expect(unchanged.corpusFingerprint).toBe(baseline.corpusFingerprint);
    expect(read).not.toHaveBeenCalled();

    await writeFile(path.join(knowledge.root, 'prompts/secrets.md'), 'Updated secret handling guidance.');
    const changed = await sourceSnapshot(knowledge, undefined, baseline);
    expect(changed.corpusFingerprint).toBeNull();
    expect(changed.basisFingerprint).not.toBe(baseline.basisFingerprint);
    expect(changed.dirty).toBe(true);
    expect(read).toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

it('reuses a complete compatible index without refreshing or rereading a clean unchanged corpus', async () => {
  const knowledge = await fixture();
  await runProcess('git', ['init', '-q'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'add', '--all'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'commit', '-qm', 'fixture'], knowledge.root, [0]);
  const baseline = await sourceSnapshot(knowledge);
  const fingerprint = 'a'.repeat(64);
  const documents = Object.fromEntries(knowledge.list().map(entry => [entry.path, 'b'.repeat(64)]));
  const chunks = Object.fromEntries(knowledge.list().map(entry => [`${entry.path}#0`, {
    path: entry.path, kind: entry.kind, line: 1, text: entry.path, hash: 'c'.repeat(64),
  }]));
  const cache = path.join(knowledge.searchIndex.directory, 'semantic');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'state.json'), JSON.stringify({
    generation: `store-${'d'.repeat(24)}`, model: fingerprint, index_version: '0.3.4', documents, chunks,
  }));
  await writeFile(path.join(knowledge.searchIndex.directory, 'semantic-basis.json'), JSON.stringify({
    attempt: 'previous', phase: 'ready',
    lastSuccessful: { ...baseline, indexedAt: '2026-10-24T00:00:00.000Z' },
  }));
  vi.stubEnv('KIMONO_MODEL_DIR', 'unused-test-model');
  const realRunProcess = processes.runProcess;
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>;
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint,
    }), stderr: '', exitCode: 0 };
    expect(request.operation).toBe('stats');
    expect(request).not.toHaveProperty('documents');
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: Object.keys(chunks).length, embedded: 0, count: 0, results: [],
      changes: { added: [], modified: [], deleted: [] } }), stderr: '', exitCode: 0 };
  });
  const refresh = vi.spyOn(knowledge, 'refresh');
  const read = vi.spyOn(AikidoKnowledgeBase.prototype, 'tryRead');
  try {
    const result = await knowledge.semanticIndex.run('update');
    expect(result.chunks).toBe(4);
    expect(run.mock.calls.filter(([executable]) =>
      executable === (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic'))).toHaveLength(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally {
    run.mockRestore();
    refresh.mockRestore();
    read.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('searches the persisted index without refreshing or serializing source documents', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const realRunProcess = processes.runProcess;
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const refresh = vi.spyOn(knowledge, 'refresh');
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8'));
    expect(request.operation).toBe('search');
    expect(request).not.toHaveProperty('documents');
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 0, embedded: 0, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  try {
    const result = await knowledge.semanticIndex.run('search', { query: 'find a symbol' });
    expect(result.results).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  } finally {
    run.mockRestore();
    refresh.mockRestore();
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
    const request = JSON.parse(await readFile(args[0], 'utf8'));
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint: 'a'.repeat(64),
    }), stderr: '', exitCode: 0 };
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
    const request = JSON.parse(await readFile(args[0], 'utf8'));
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint: 'a'.repeat(64),
    }), stderr: '', exitCode: 0 };
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
    resources: { availableCpus: 4, cpuPercent: 80, cpuBudget: 3, availableMemoryBytes: 4_000_000_000,
      memoryPercent: 80, memoryBudgetBytes: 3_200_000_000, estimatedMemoryBytes: 1_000_000_000 },
    benchmarks: [{ executionProvider: 'cpu', medianMs: 20, error: null },
      { executionProvider: 'coreml', medianMs: 200, error: null }] };
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8'));
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint: 'a'.repeat(64),
    }), stderr: '', exitCode: 0 };
    devices.push(environment?.KIMONO_SEMANTIC_DEVICE);
    const report = { ...runtime,
      resources: { ...runtime.resources, availableMemoryBytes: devices.length === 2 ? 3_000_000_000 : 4_000_000_000,
        memoryBudgetBytes: devices.length === 2 ? 2_400_000_000 : 3_200_000_000 },
      benchmarks: environment?.KIMONO_SEMANTIC_DEVICE === 'cpu' ? [] : runtime.benchmarks };
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
    expect(results.map(result => result.runtime)).toEqual(expect.arrayContaining([runtime, { ...runtime, resources: {
      ...runtime.resources, availableMemoryBytes: 3_000_000_000, memoryBudgetBytes: 2_400_000_000,
    } }]));
    expect(first.semanticIndex.status()).toMatchObject({ runtime: results[0].runtime, batchMs: 40, progress: { completed: 2, total: 2 } });
  } finally { run.mockRestore(); vi.unstubAllEnvs(); }
});

it('rejects invalid resource-budget telemetry', async () => {
  const knowledge = await fixture();
  vi.stubEnv('KIMONO_MODEL_DIR', path.join(knowledge.root, 'test-model'));
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  const realRunProcess = processes.runProcess;
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, ...args) =>
    executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')
      ? realRunProcess(executable, ...args)
      : { stdout: JSON.stringify({ runtime: { executionProvider: 'cpu', gpuExecutionVerified: false,
        workers: 1, threads: 1, batch: 1, benchmarks: [], resources: { cpuPercent: 101 } } }), stderr: '', exitCode: 0 });
  try {
    await expect(knowledge.semanticIndex.run('update')).rejects.toThrow('Invalid semantic resource budget');
    expect(knowledge.semanticIndex.status().phase).toBe('error');
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
    const request = JSON.parse(await readFile(args[0], 'utf8'));
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint: 'a'.repeat(64),
    }), stderr: '', exitCode: 0 };
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

it.each([
  { name: 'legacy unversioned', version: undefined, generation: `store-${'c'.repeat(24)}`, valid: true },
  { name: 'invalid version type', version: 3, generation: `store-${'c'.repeat(24)}`, valid: false },
  { name: 'empty version', version: '', generation: `store-${'c'.repeat(24)}`, valid: false },
  { name: 'unsafe legacy generation', version: undefined, generation: '../outside', valid: false },
])('migrates only a valid $name manifest without an incremental shortcut', async ({ version, generation, valid }) => {
  const knowledge = await fixture();
  vi.stubEnv('KIMONO_MODEL_DIR', 'unused-test-model');
  const cache = path.join(knowledge.searchIndex.directory, 'semantic');
  await mkdir(cache, { recursive: true });
  const state = JSON.stringify({
    generation, model: 'a'.repeat(64), index_version: version,
    documents: { 'prompts/index.md': 'b'.repeat(64) },
    chunks: { 'prompts/index.md#0': { path: 'prompts/index.md', kind: 'knowledge',
      line: 1, text: '# AI-KIDO knowledge', hash: 'd'.repeat(64) } },
  });
  await writeFile(path.join(cache, 'state.json'), state);
  const realRunProcess = processes.runProcess;
  const requests: Record<string, unknown>[] = [];
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, ...args) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, ...args);
    }
    const request = JSON.parse(await readFile(args[0][0], 'utf8')) as Record<string, unknown>;
    requests.push(request);
    return { stdout: JSON.stringify(request.operation === 'profile'
      ? { engine: 'embsearch-core', fingerprint: 'a'.repeat(64) }
      : { engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
        chunks: 4, embedded: 4, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
    stderr: '', exitCode: 0 };
  });
  try {
    if (valid) {
      await expect(knowledge.semanticIndex.run('update')).resolves.toMatchObject({ embedded: 4 });
      expect(requests.map(request => request.operation)).toEqual(['profile', 'update']);
      expect(requests[1]).toMatchObject({ incremental: false, deletedPaths: [] });
      expect(requests[1].documents).toHaveLength(4);
    } else {
      await expect(knowledge.semanticIndex.run('update')).rejects.toThrow('Invalid semantic index manifest');
      expect(requests.map(request => request.operation)).toEqual(['profile']);
    }
    expect(await readFile(path.join(cache, 'state.json'), 'utf8')).toBe(state);
  } finally { run.mockRestore(); vi.unstubAllEnvs(); }
});

it('sends only changed documents and explicit scoped deletions for a compatible incremental index', async () => {
  const knowledge = await fixture();
  await runProcess('git', ['init', '-q'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'add', '--all'], knowledge.root, [0]);
  await runProcess('git', ['-c', 'user.name=Kimono test', '-c', 'user.email=kimono-test@example.invalid',
    'commit', '-qm', 'fixture'], knowledge.root, [0]);
  const baseline = await sourceSnapshot(knowledge);
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const fingerprint = 'a'.repeat(64);
  const documents: Record<string, string> = {};
  const chunks: Record<string, { path: string; kind: string; line: number; text: string; hash: string }> = {};
  for (const entry of knowledge.list()) {
    const document = await knowledge.tryRead(entry.id);
    if (!document) throw new Error(`Could not read fixture document: ${entry.path}`);
    documents[entry.path] = createHash('sha256')
      .update(JSON.stringify([entry.kind, document.content])).digest('hex');
    chunks[`${entry.path}#0`] = {
      path: entry.path, kind: entry.kind, line: 1, text: document.content,
      hash: createHash('sha256').update(document.content).digest('hex'),
    };
  }
  documents['prompts/removed.md'] = 'b'.repeat(64);
  chunks['prompts/removed.md#0'] = {
    path: 'prompts/removed.md', kind: 'knowledge', line: 1, text: 'removed',
    hash: createHash('sha256').update('removed').digest('hex'),
  };
  const cache = path.join(knowledge.searchIndex.directory, 'semantic');
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, 'state.json'), JSON.stringify({
    generation: `store-${'c'.repeat(24)}`, model: fingerprint, index_version: '0.3.4', documents, chunks,
  }));
  await writeFile(path.join(knowledge.searchIndex.directory, 'semantic-basis.json'), JSON.stringify({
    attempt: 'previous', phase: 'ready',
    lastSuccessful: { ...baseline, indexedAt: '2026-10-24T00:00:00.000Z' },
  }));
  await writeFile(path.join(knowledge.root, 'prompts/secrets.md'), 'Use managed credentials and rotate tokens.');
  await writeFile(path.join(knowledge.root, 'prompts/new.md'), 'Document a new retrieval source.');
  await knowledge.refresh();
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const realRunProcess = processes.runProcess;
  let updateRequest: Record<string, unknown> | undefined;
  const read = vi.spyOn(AikidoKnowledgeBase.prototype, 'tryRead');
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>;
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint,
    }), stderr: '', exitCode: 0 };
    updateRequest = request;
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: '0.3.4', model: 'test-model',
      chunks: 4, embedded: 0, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  try {
    await knowledge.semanticIndex.run('update');
    expect(updateRequest).toMatchObject({ incremental: true, deletedPaths: ['prompts/removed.md'] });
    const submitted = (updateRequest?.documents as Array<{ path: string }>).map(document => document.path).sort();
    expect(submitted).toEqual(['prompts/new.md', 'prompts/secrets.md']);
    const changedContentReads = read.mock.calls.map(([id]) =>
      knowledge.list().find(entry => entry.id === id || entry.path === id)?.path).filter(Boolean);
    expect(new Set(changedContentReads)).toEqual(new Set(['prompts/new.md', 'prompts/secrets.md']));
  } finally {
    run.mockRestore();
    read.mockRestore();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
  }
});

it('does not load or search a configured code model while its paused profile is disabled', async () => {
  const knowledge = await fixture();
  await mkdir(knowledge.searchIndex.directory, { recursive: true });
  vi.stubEnv('KIMONO_MODEL_DIR', 'multilingual-model');
  vi.stubEnv('KIMONO_CODE_MODEL_DIR', 'code-model');
  vi.stubEnv('KIMONO_CODE_PROFILE_ENABLED', 'false');
  const realRunProcess = processes.runProcess;
  const models: string[] = [];
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>;
    models.push(String(request.model));
    if (request.operation === 'info') return { stdout: JSON.stringify({
      engine: 'embsearch-core', version: 'test', model: 'multilingual-model', name: 'multilingual-model',
      dimensions: 384, normalized: true, maxTokens: 512, pooling: 'mean',
      queryPrefix: null, documentPrefix: null, compatibility: 'test',
      sha256: { 'model.onnx': 'a'.repeat(64), 'tokenizer.json': 'b'.repeat(64), 'model.json': 'c'.repeat(64) },
    }), stderr: '', exitCode: 0 };
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model: 'multilingual-model',
      chunks: 0, embedded: 0, count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  try {
    const info = await knowledge.semanticIndex.info();
    expect(info).not.toHaveProperty('profiles');
    const result = await knowledge.semanticIndex.run('search', { query: 'retrieval' });
    expect(result.model).toBe('multilingual-model');
    expect(models).toEqual(['multilingual-model', 'multilingual-model']);
  } finally {
    run.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('keeps code embeddings in a separate opt-in index and fuses profile search ranks', async () => {
  const knowledge = await fixture();
  const originalModel = process.env.KIMONO_MODEL_DIR;
  const originalCodeModel = process.env.KIMONO_CODE_MODEL_DIR;
  await mkdir(path.join(knowledge.root, 'src'), { recursive: true });
  await writeFile(path.join(knowledge.root, 'src/retrieval.ts'), 'export function retrieveSymbol() { return true; }');
  await knowledge.refresh();
  vi.stubEnv('KIMONO_MODEL_DIR', 'multilingual-model');
  vi.stubEnv('KIMONO_CODE_MODEL_DIR', 'code-model');
  vi.stubEnv('KIMONO_CODE_PROFILE_ENABLED', 'true');
  const realRunProcess = processes.runProcess;
  const updates: Array<{ cache: string; model: string; paths: string[] }> = [];
  const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment);
    }
    const request = JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>;
    const model = String(request.model);
    if (request.operation === 'profile') return { stdout: JSON.stringify({
      engine: 'embsearch-core', fingerprint: model === 'code-model' ? 'c'.repeat(64) : 'd'.repeat(64),
    }), stderr: '', exitCode: 0 };
    if (request.operation === 'info') return { stdout: JSON.stringify({
      engine: 'embsearch-core', version: 'test', model, name: model,
      dimensions: model === 'code-model' ? 768 : 384, normalized: true, maxTokens: 512,
      pooling: 'mean', queryPrefix: null, documentPrefix: null, compatibility: 'test',
      sha256: { 'model.onnx': 'a'.repeat(64), 'tokenizer.json': 'b'.repeat(64), 'model.json': 'c'.repeat(64) },
    }), stderr: '', exitCode: 0 };
    if (request.operation === 'update') {
      const documents = request.documents as Array<{ path: string }>;
      updates.push({ cache: String(request.cache), model, paths: documents.map(document => document.path) });
      return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model,
        chunks: documents.length, embedded: documents.length, count: 0, results: [],
        changes: { added: [], modified: [], deleted: [] } }), stderr: '', exitCode: 0 };
    }
    const code = String(request.cache).endsWith('semantic-code');
    const hit = code
      ? { path: 'src/retrieval.ts', line: 1, score: 0.9, excerpt: 'export function retrieveSymbol() {}' }
      : { path: 'prompts/index.md', line: 1, score: 0.8, excerpt: '# AI-KIDO knowledge' };
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model,
      chunks: 1, embedded: 0, count: 1, results: [hit],
      changes: { added: [], modified: [], deleted: [] } }), stderr: '', exitCode: 0 };
  });
  try {
    await knowledge.semanticIndex.run('update');
    const documentIndex = updates.find(update => update.cache.endsWith('/semantic'));
    const codeIndex = updates.find(update => update.cache.endsWith('/semantic-code'));
    expect(documentIndex?.model).toBe('multilingual-model');
    expect(documentIndex?.paths).toContain('src/retrieval.ts');
    expect(codeIndex?.model).toBe('code-model');
    expect(codeIndex?.paths).toEqual(['src/retrieval.ts']);

    const info = await knowledge.semanticIndex.info();
    expect(info.profiles).toMatchObject({
      multilingual: { model: 'multilingual-model', dimensions: 384 },
      code: { model: 'code-model', dimensions: 768 },
    });
    const result = await knowledge.semanticIndex.run('search', { query: 'retrieveSymbol', limit: 5 });
    expect(result.model).toBe('multilingual-model+code-model');
    expect(result.results.map(hit => hit.path)).toEqual(['prompts/index.md', 'src/retrieval.ts']);
    expect(result.results.every(hit => hit.score > 0 && hit.score < 1)).toBe(true);
  } finally {
    run.mockRestore();
    vi.unstubAllEnvs();
    if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
    else process.env.KIMONO_MODEL_DIR = originalModel;
    if (originalCodeModel === undefined) delete process.env.KIMONO_CODE_MODEL_DIR;
    else process.env.KIMONO_CODE_MODEL_DIR = originalCodeModel;
  }
});

describe.skipIf(!process.env.KIMONO_MODEL_DIR)('real multilingual ONNX semantic search', () => {
  it('migrates a real unversioned generation and reuses the migrated index on the next update', async () => {
    const knowledge = await fixture();
    await knowledge.semanticIndex.run('update');
    const stateFile = path.join(knowledge.searchIndex.directory, 'semantic/state.json');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    delete state.index_version;
    state.model = 'b'.repeat(64);
    await writeFile(stateFile, JSON.stringify(state));
    const migrated = await knowledge.semanticIndex.run('update');
    expect(migrated.embedded).toBe(4);
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
      index_version: 'kimono-semantic-v2',
    });
    expect((await knowledge.semanticIndex.run('update')).embedded).toBe(0);
    const result = await knowledge.semanticIndex.run('search', { query: 'Protect passwords and credentials', limit: 1 });
    expect(result.results[0].path).toBe('prompts/secrets.md');
    const generation = JSON.parse(await readFile(stateFile, 'utf8')).generation;
    knowledge.semanticIndex.warmup();
    const started = JSON.parse(await runtimeFor(knowledge).call('aikido_index', {
      operation: 'rebuild', mode: 'semantic', background: true,
    }));
    expect(started).toMatchObject({ phase: 'running', operation: 'rebuild' });
    await expect(runtimeFor(knowledge).call('aikido_index', {
      operation: 'rebuild', mode: 'semantic', background: true,
    })).rejects.toThrow('already running');
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', operation: 'rebuild' });
    expect(JSON.parse(await readFile(stateFile, 'utf8')).generation).not.toBe(generation);
    expect((await knowledge.semanticIndex.run('update')).embedded).toBe(0);
    const healthyState = await readFile(stateFile, 'utf8');
    vi.stubEnv('KIMONO_MODEL_DIR', path.join(knowledge.root, 'missing-model'));
    try {
      await runtimeFor(knowledge).call('aikido_index', { operation: 'rebuild', mode: 'semantic', background: true });
      await knowledge.semanticIndex.idle();
      expect(knowledge.semanticIndex.status().phase).toBe('error');
      expect(await readFile(stateFile, 'utf8')).toBe(healthyState);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);

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
      const percentage = (value: string | undefined) => !value || value === 'auto' ? 80 : Number(value);
      const resources = info.runtime.resources;
      expect(resources.cpuPercent).toBe(percentage(process.env.KIMONO_SEMANTIC_CPU_PERCENT));
      expect(resources.memoryPercent).toBe(percentage(process.env.KIMONO_SEMANTIC_MEMORY_PERCENT));
      expect(resources.cpuBudget).toBe(Math.max(1, Math.floor(resources.availableCpus * resources.cpuPercent / 100)));
      expect(resources.memoryBudgetBytes).toBe(Math.floor(resources.availableMemoryBytes * resources.memoryPercent / 100));
      expect(resources.estimatedMemoryBytes).toBeGreaterThan(0);
      expect(resources.estimatedMemoryBytes).toBeLessThanOrEqual(resources.memoryBudgetBytes);
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
    await knowledge.semanticIndex.run('update');
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
    const sourceBeforeEdit = await sourceSnapshot(knowledge);
    await writeFile(path.join(knowledge.root, 'prompts/secrets.md'), 'Protect access tokens with a secrets manager and never disclose credentials.');
    const sourceAfterEdit = await sourceSnapshot(knowledge, undefined, sourceBeforeEdit);
    expect(sourceAfterEdit.basisFingerprint).not.toBe(sourceBeforeEdit.basisFingerprint);
    const refresh = vi.spyOn(knowledge, 'refresh');
    const realRunProcess = processes.runProcess;
    const requests: Record<string, unknown>[] = [];
    const run = vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes,
      timeout, onStderr, environment, maxBuffer, streamStderr) => {
      if (executable === (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
        requests.push(JSON.parse(await readFile(args[0], 'utf8')) as Record<string, unknown>);
      }
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr,
        environment, maxBuffer, streamStderr);
    });
    try {
      const changed = await knowledge.semanticIndex.run('update');
      expect(refresh).toHaveBeenCalled();
      expect(requests.find(request => request.operation === 'update')?.documents).toEqual([
        expect.objectContaining({ path: 'prompts/secrets.md',
          content: 'Protect access tokens with a secrets manager and never disclose credentials.' }),
      ]);
      expect(changed, JSON.stringify(changed)).toMatchObject({
        embedded: 1, changes: { modified: ['prompts/secrets.md'] },
      });
    } finally {
      run.mockRestore();
      refresh.mockRestore();
    }
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
