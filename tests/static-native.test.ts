import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import { EMBEDDING_CATALOGUE, modelDescriptor, modelDirectory, readEmbeddingSettings } from '../src/embedding-models.js';
import { shutdownSemanticWorkers } from '../src/semantic-worker.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { snapshotsFor } from '../src/snapshots.js';

const directories: string[] = [];
afterEach(async () => {
  await shutdownSemanticWorkers();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const native = process.env.KIMONO_SEMANTIC_BIN;
it.skipIf(!native)('indexes and searches two static models through the real persistent worker without ONNX', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-static-native-'));
  directories.push(parent);
  const root = path.join(parent, 'corpus');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  vi.stubEnv('KIMONO_MODELS_DIR', path.join(parent, 'models'));
  vi.stubEnv('KIMONO_EMBEDDING_POLICY', 'auto-speed');
  vi.stubEnv('KIMONO_SEMANTIC_DEVICE', 'cpu');
  vi.stubEnv('KIMONO_SEMANTIC_WORKERS', '2');
  vi.stubEnv('KIMONO_SEMANTIC_THREADS', '1');
  vi.stubEnv('KIMONO_SEMANTIC_BATCH', '2');
  vi.stubEnv('KIMONO_SEMANTIC_PERSISTENT_WORKER', 'true');
  vi.stubEnv('KIMONO_CODE_PROFILE_ENABLED', 'false');
  vi.stubEnv('ORT_DYLIB_PATH', path.join(parent, 'must-not-load-onnx'));
  vi.stubEnv('KIMONO_MODEL_DIR', '');
  const tokenizer = {
    version: '1.0', truncation: null, padding: null, added_tokens: [],
    normalizer: null, pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
    model: { type: 'WordLevel', vocab: { '[UNK]': 0, bonjour: 1, hello: 2, password: 3, database: 4, reset: 5 }, unk_token: '[UNK]' },
  };
  const originals = EMBEDDING_CATALOGUE.map(model => model.files);
  try {
    for (const [index, model] of EMBEDDING_CATALOGUE.slice(0, 2).entries()) {
      const directory = modelDirectory(root, model.id);
      await mkdir(directory, { recursive: true });
      const width = index === 0 ? 2 : 4;
      const data = Buffer.alloc(6 * 256 * width);
      for (let row = 1; row < 6; row++) {
        const column = row === 1 || row === 2 ? 0 : row === 4 ? 2 : 1;
        if (width === 2) data.writeUInt16LE(0x3c00, (row * 256 + column) * width);
        else data.writeFloatLE(1, (row * 256 + column) * width);
      }
      let header = JSON.stringify({ embeddings: { dtype: width === 2 ? 'F16' : 'F32', shape: [6, 256], data_offsets: [0, data.length] } });
      header = header.padEnd(Math.ceil(header.length / 8) * 8, ' ');
      const size = Buffer.alloc(8);
      size.writeBigUInt64LE(BigInt(Buffer.byteLength(header)));
      const files = {
        'model.safetensors': Buffer.concat([size, Buffer.from(header), data]),
        'tokenizer.json': Buffer.from(JSON.stringify(tokenizer)),
        'config.json': Buffer.from('{"normalize":true}'), 'README.md': Buffer.from('Synthetic MIT test weights, not a downloaded model.'),
      };
      model.files = [];
      for (const [name, bytes] of Object.entries(files)) {
        await writeFile(path.join(directory, name), bytes);
        model.files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      await writeFile(path.join(directory, 'model.json'), JSON.stringify(modelDescriptor(model)));
    }
    await writeFile(path.join(root, 'hello.ts'), 'hello bonjour');
    await writeFile(path.join(root, 'access.md'), 'password reset');
    await writeFile(path.join(root, 'storage.txt'), 'database');
    const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
    await knowledge.initialize();
    const configured = await knowledge.semanticIndex.configureModels('auto-speed', true);
    expect(configured.phase).toBe('building');
    await knowledge.semanticIndex.idle();
    expect(knowledge.semanticIndex.status()).toMatchObject({ phase: 'ready', chunks: 3 });
    expect(await knowledge.semanticIndex.models()).toMatchObject({ activePolicy: 'auto-speed', phase: 'ready' });
    const settings = await readEmbeddingSettings(knowledge);
    expect(settings?.active?.profiles.map(profile => profile.model)).toEqual(['code', 'multilingual-fast']);
    const update = await knowledge.semanticIndex.run('update');
    expect(update).toMatchObject({ chunks: 3, embedded: 0 });
    const info = await knowledge.semanticIndex.info();
    expect(info).toMatchObject({ backend: 'model2vec', truncation: false, dimensions: 256, passageChars: 750 });
    const vector = await knowledge.semanticIndex.embed('password reset', 'query');
    expect(vector).toMatchObject({ backend: 'model2vec', truncation: false, dimensions: 256 });
    expect(Math.hypot(...vector.vector)).toBeCloseTo(1);
    const search = await knowledge.semanticIndex.run('search', { query: 'password', paths: ['access.md'] });
    expect(search.results[0]?.path).toBe('access.md');
    const snapshot = await snapshotsFor(knowledge).begin();
    const searchResult = JSON.parse(await runtimeFor(knowledge).call('aikido_search', {
      snapshotId: snapshot.snapshotId, mode: 'semantic', query: 'password', limit: 1,
    }));
    expect(searchResult.results[0]?.path).toBe('access.md');
    await snapshotsFor(knowledge).end(String(snapshot.snapshotId));
    const active = (await readEmbeddingSettings(knowledge))!.active!;
    const base = path.join(knowledge.searchIndex.directory, 'semantic-models', active.signature, active.generation ?? 'initial');
    const code = JSON.parse(await readFile(path.join(base, 'code/state.json'), 'utf8'));
    const document = JSON.parse(await readFile(path.join(base, 'multilingual/state.json'), 'utf8'));
    expect(Object.keys(code.documents)).toEqual(['hello.ts']);
    expect(Object.keys(document.documents).sort()).toEqual(['access.md', 'storage.txt']);
    expect((await readdir(root)).sort()).toEqual(['access.md', 'hello.ts', 'storage.txt']);
  } finally { EMBEDDING_CATALOGUE.forEach((model, index) => { model.files = originals[index]!; }); }
}, 60_000);
