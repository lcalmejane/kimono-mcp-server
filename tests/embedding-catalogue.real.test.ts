import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import { EMBEDDING_CATALOGUE, installEmbeddingModel } from '../src/embedding-models.js';
import { shutdownSemanticWorkers } from '../src/semantic-worker.js';
import { embeddedNativeEnvironment } from './native-env.js';

// Opt-in (KIMONO_TEST_MODEL_DOWNLOADS=1): downloads every pinned ONNX model, then indexes and searches
// with the real engine under the custom policy. Models are cached in KIMONO_TEST_MODELS_DIR across runs.
const native = process.env.KIMONO_TEST_MODEL_DOWNLOADS === '1' ? await embeddedNativeEnvironment() : undefined;
const models = EMBEDDING_CATALOGUE.filter(model => model.backend === 'onnx' && model.files.length);
const scratch: string[] = [];
afterAll(async () => {
  await shutdownSemanticWorkers();
  await Promise.all(scratch.map(directory => rm(directory, { recursive: true, force: true })));
});

it.skipIf(!native).each(models.map(model => model.id))('custom policy indexes and searches with %s', async id => {
  for (const [key, value] of Object.entries(native ?? {})) vi.stubEnv(key, value);
  vi.stubEnv('KIMONO_MODELS_DIR', process.env.KIMONO_TEST_MODELS_DIR ?? path.join(tmpdir(), 'kimono-test-models'));
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-catalogue-'));
  scratch.push(parent);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const root = path.join(parent, 'repo');
  await mkdir(root);
  await writeFile(path.join(root, 'auth.ts'), 'export function authenticate(user: string, password: string) {\n  return checkPassword(user, password);\n}\n');
  await writeFile(path.join(root, 'guide.md'), '# Deployment guide\n\nRotate the database credentials every month.\n');
  await writeFile(path.join(root, 'cooking.md'), '# Recipes\n\nBake the bread for forty minutes.\n');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  await installEmbeddingModel(root, id, true);
  await knowledge.semanticIndex.configureModels('custom', true, { code: id, documents: id });
  await knowledge.semanticIndex.idle();
  const models = await knowledge.semanticIndex.models();
  expect(models.phase, String(models.error ?? '')).toBe('ready');
  // Each profile ranks its own files; compare like with like.
  const documents = await knowledge.semanticIndex.run('search', { query: 'rotate database credentials', limit: 2, paths: ['guide.md', 'cooking.md'] });
  expect(documents.results[0]?.path).toBe('guide.md');
  expect(documents.results[0].score).toBeGreaterThan(documents.results[1]?.score ?? -1);
  vi.unstubAllEnvs();
}, 15 * 60_000);
