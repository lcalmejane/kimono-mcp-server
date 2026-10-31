import { corpusConfig } from '../src/corpus-config.js';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import * as processes from '../src/process.js';
import { configuredEmbeddingPolicy } from '../src/embedding-models.js';

const directories: string[] = [];
const originalModel = process.env.KIMONO_MODEL_DIR;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalModel === undefined) delete process.env.KIMONO_MODEL_DIR;
  else process.env.KIMONO_MODEL_DIR = originalModel;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-index-control-'));
  directories.push(root);
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# AI-KIDO knowledge');
  await writeFile(path.join(root, 'prompts/secrets.md'), 'Never store passwords in source code.');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  directories.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return knowledge;
}

const exists = (file: string) => access(file).then(() => true, () => false);
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

/** Fake native engine whose embedding call hangs until the caller's AbortSignal fires, like a long native batch. */
function hangingEngine() {
  const realRunProcess = processes.runProcess;
  const state = { embedding: 0, killed: 0, release: false };
  vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, exitCodes, timeout, onStderr, environment, maxBuffer, stream, signal) => {
    if (executable !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) {
      return realRunProcess(executable, args, cwd, exitCodes, timeout, onStderr, environment, maxBuffer, stream, signal);
    }
    const request = JSON.parse(await readFile(args[0]!, 'utf8'));
    if (request.operation === 'profile') return { stdout: JSON.stringify({ engine: 'embsearch-core', fingerprint: 'a'.repeat(64) }), stderr: '', exitCode: 0 };
    state.embedding++;
    if (state.release) {
      return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model: 'test-model', chunks: 2, embedded: 2,
        count: 0, results: [], changes: { added: [], modified: [], deleted: [] } }), stderr: '', exitCode: 0 };
    }
    await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => { state.killed++; reject(new Error('Process cancelled')); }, { once: true });
    });
    throw new Error('unreachable');
  });
  return state;
}

it('cancels a running semantic index, reports it as cancelled and allows a later update', async () => {
  const knowledge = await fixture();
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const engine = hangingEngine();
  knowledge.semanticIndex.warmup();
  await until(() => engine.embedding === 1);
  expect(knowledge.semanticIndex.status().phase).toBe('running');

  const cancelled = await knowledge.semanticIndex.cancel();
  expect(cancelled.cancelRequested).toBe(true);
  expect(engine.killed).toBe(1);
  expect(cancelled).toMatchObject({ phase: 'error', stage: 'cancelled' });
  expect(cancelled.error).toMatch(/cancelled/);

  // Nothing is left running: a second cancel is a no-op and a new update works normally.
  expect((await knowledge.semanticIndex.cancel()).cancelRequested).toBe(false);
  engine.release = true;
  knowledge.semanticIndex.warmup();
  await knowledge.semanticIndex.idle();
  expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', chunks: 2 });
});

it('refuses to delete the semantic index while indexing, then deletes every generation once stopped', async () => {
  const knowledge = await fixture();
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const engine = hangingEngine();
  const directory = knowledge.searchIndex.directory;

  knowledge.semanticIndex.warmup();
  await until(() => engine.embedding === 1);
  // Index files exist only from here on: an invalid fake manifest or a saved managed policy would stop the run
  // before it reaches the engine, and this test needs the run to be genuinely in flight.
  await mkdir(path.join(directory, 'semantic'), { recursive: true });
  await writeFile(path.join(directory, 'semantic', 'state.json'), '{}');
  await expect(knowledge.semanticIndex.reset()).rejects.toThrow(/cancel it/);
  expect(await exists(path.join(directory, 'semantic', 'state.json'))).toBe(true);

  await knowledge.semanticIndex.cancel();
  await mkdir(path.join(directory, 'semantic-models', 'sig', 'gen', 'multilingual'), { recursive: true });
  await writeFile(path.join(directory, 'literal-basis.json'), '{"keep":true}');
  await writeFile(path.join(directory, 'embedding-settings.json'), JSON.stringify({ version: 1, requestedPolicy: 'auto-speed' }));
  const status = await knowledge.semanticIndex.reset();
  expect(status.phase).toBe('unknown');
  expect(await exists(path.join(directory, 'semantic'))).toBe(false);
  expect(await exists(path.join(directory, 'semantic-models'))).toBe(false);
  // Only the semantic index is forgotten: the lexical basis and the chosen policy stay.
  expect(await exists(path.join(directory, 'literal-basis.json'))).toBe(true);
  expect(JSON.parse(await readFile(path.join(directory, 'embedding-settings.json'), 'utf8')).requestedPolicy).toBe('auto-speed');
});

it('exposes cancel and reset through aikido_index without waiting behind the running operation', async () => {
  const knowledge = await fixture();
  process.env.KIMONO_MODEL_DIR = 'unused-test-model';
  const engine = hangingEngine();
  const runtime = runtimeFor(knowledge);
  knowledge.semanticIndex.warmup();
  await until(() => engine.embedding === 1);

  await expect(runtime.call('aikido_index', { operation: 'cancel', mode: 'literal' })).rejects.toThrow(/requires mode=semantic/);
  const cancelled = JSON.parse(await runtime.call('aikido_index', { operation: 'cancel', mode: 'semantic' }));
  expect(cancelled).toMatchObject({ cancelRequested: true, phase: 'error', stage: 'cancelled' });
  const reset = JSON.parse(await runtime.call('aikido_index', { operation: 'reset', mode: 'semantic' }));
  expect(reset.phase).toBe('unknown');
});

it('defaults to auto-speed unless the host pins a policy, and keeps an explicit e5', () => {
  vi.stubEnv('KIMONO_EMBEDDING_POLICY', '');
  expect(configuredEmbeddingPolicy()).toBe('auto-speed');
  vi.stubEnv('KIMONO_EMBEDDING_POLICY', 'e5');
  expect(configuredEmbeddingPolicy()).toBe('e5');
  vi.stubEnv('KIMONO_EMBEDDING_POLICY', 'auto-balanced');
  expect(configuredEmbeddingPolicy()).toBe('auto-balanced');
});
