import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { corpusConfig, loadCorpusConfig } from '../src/corpus-config.js';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { Retrieval } from '../src/retrieval.js';
import { sourceSnapshot } from '../src/index-basis.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { snapshotsFor } from '../src/snapshots.js';

const scratch: string[] = [];
async function fixture(options: Record<string, unknown> = {}) {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-corpus-'));
  scratch.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const write = async (file: string, content: string | Buffer) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag', ...options }));
  return { parent, root, knowledge, write };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('defaults to RAG and requires an entry point only for explicitly selected AI-KIDO', async () => {
  const { root, knowledge, write } = await fixture();
  vi.stubEnv('KIMONO_CORPUS_MODE', undefined);
  vi.stubEnv('KIMONO_CONFIG_FILE', undefined);
  const aikido = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await expect(aikido.initialize()).rejects.toThrow('No AI-KIDO entry point');
  const originalKey = createHash('sha256').update(root).digest('hex').slice(0, 24);
  expect(path.basename(aikido.searchIndex.directory)).toBe(originalKey);
  expect(path.basename(knowledge.searchIndex.directory)).not.toBe(originalKey);
  await write('src/agents/worker.tsx', 'export const worker = <main>Local RAG</main>;');
  await write('spec/api.go', 'package api');
  await write('Dockerfile', 'FROM node:24');
  await knowledge.initialize();
  const standard = new AikidoKnowledgeBase(root);
  await standard.initialize();
  expect(standard.corpusStatus.mode).toBe('rag');
  expect(standard.list()).toEqual(knowledge.list());
  expect(knowledge.list().map(entry => [entry.path, entry.kind])).toEqual([
    ['Dockerfile', 'knowledge'], ['spec/api.go', 'knowledge'], ['src/agents/worker.tsx', 'knowledge'],
  ]);
  expect(knowledge.isMemoryRoot).toBe(false);
  const retrieval = new Retrieval(knowledge);
  const { snapshotId } = JSON.parse(await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'begin' }));
  expect(JSON.parse(await retrieval.list({ scope: 'code' })).total).toBe(3);
  await runtimeFor(knowledge).call('aikido_snapshot', { operation: 'end', snapshotId });
  expect(corpusConfig().snapshotMaxBytes).toBe(256 * 1024 * 1024);
  expect(corpusConfig({ mode: 'aikido' }).snapshotMaxBytes).toBe(64 * 1024 * 1024);
});

it('indexes common source languages and extensionless files, with custom replacement allowlists and glob restrictions', async () => {
  const { root, knowledge, write } = await fixture({ include: ['src/**', 'Dockerfile'], exclude: ['**/*.generated.*'] });
  for (const extension of ['tsx', 'jsx', 'java', 'go', 'rs', 'php', 'cpp', 'h', 'cs', 'swift', 'vue', 'sql']) {
    await write(`src/file.${extension}`, 'source');
  }
  await write('src/file.generated.ts', 'generated');
  await write('docs/readme.md', '# Excluded');
  await write('Dockerfile', 'FROM node:24');
  await knowledge.initialize();
  expect(knowledge.list()).toHaveLength(13);
  expect(knowledge.list().some(entry => /generated|readme/.test(entry.path))).toBe(false);
  await write('src/extra.custom', 'custom source');
  const configured = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag', extensions: ['.custom'], filenames: ['Dockerfile'] }));
  await configured.initialize();
  expect(configured.list().filter(entry => !entry.metadata).map(entry => entry.path)).toEqual(['Dockerfile', 'src/extra.custom']);
  expect(configured.list().find(entry => entry.path === 'docs/readme.md')?.metadata?.contentStatus).toBe('metadata-only');
  expect(configured.searchIndex.directory).not.toBe(knowledge.searchIndex.directory);
});

it('preserves gitignore and non-overridable secret/dependency exclusions, skips symlinks and binary samples', async () => {
  const { parent, root, knowledge, write } = await fixture();
  await write('.gitignore', 'src/ignored/**\n*.generated.ts\n');
  for (const file of ['src/ignored/foo.rs', 'src/foo.generated.ts', '.env.json', 'secrets/key.json', 'node_modules/x.ts', '.ssh/config.txt']) {
    await write(file, 'excluded');
  }
  await write('src/valid.rs', 'fn main() {}');
  await write('src/binary.ts', Buffer.from([1, 0, 2]));
  await writeFile(path.join(parent, 'outside.ts'), 'outside');
  await symlink(path.join(parent, 'outside.ts'), path.join(root, 'src/link.ts'));
  await knowledge.initialize();
  expect(knowledge.list().filter(entry => !entry.metadata).map(entry => entry.path)).toEqual(['src/valid.rs']);
  expect(knowledge.list().find(entry => entry.path === 'src/binary.ts')?.metadata?.contentStatus).toBe('metadata-only');
  expect(knowledge.list().some(entry => /ignored|generated|secret|node_modules|link/.test(entry.path))).toBe(false);
  expect(knowledge.corpusStatus.binary).toBe(1);
  await write('src/invalid.ts', Buffer.from([0xff, 0xfe]));
  await knowledge.refresh();
  await expect(knowledge.read('src/invalid.ts')).resolves.toMatchObject({ content: expect.any(String) });
});

it('indexes non-UTF-8 documents (Windows-1252, UTF-16) instead of failing', async () => {
  const { knowledge, write } = await fixture();
  await write('src/latin1.ts', Buffer.from('// caf\xe9 \xe0 la cr\xe8me', 'latin1'));
  await write('src/utf16.ts', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('// bonjour', 'utf16le')]));
  await write('src/broken.ts', Buffer.from([0x66, 0xc3, 0x28, 0xa0, 0xa1]));
  await write('src/utf8.ts', '// café');
  await knowledge.initialize();
  expect(knowledge.list().map(entry => entry.path)).toEqual(['src/broken.ts', 'src/latin1.ts', 'src/utf16.ts', 'src/utf8.ts']);
  expect((await knowledge.read('src/latin1.ts')).content).toBe('// café à la crème');
  expect((await knowledge.read('src/utf16.ts')).content).toBe('// bonjour');
  await expect(knowledge.read('src/broken.ts')).resolves.toBeDefined();
});

it('retains unreadable document metadata with a trace instead of aborting indexing', async () => {
  const { knowledge, write } = await fixture();
  await write('src/ok.ts', 'ok');
  await write('src/gone.ts', 'soon removed');
  await knowledge.initialize();
  await rm(path.join(knowledge.root, 'src/gone.ts'));
  const trace = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(knowledge.tryRead('src/gone.ts')).resolves.toMatchObject({
      entry: { metadata: { contentStatus: 'metadata-only' } },
      content: expect.stringContaining('Path: "src/gone.ts"'),
    });
    await expect(knowledge.tryRead('src/ok.ts')).resolves.toMatchObject({ content: 'ok' });
    // Production logs one bounded reason; per-file paths stay in corpus status (debug logs them).
    expect(trace).toHaveBeenCalledWith(expect.stringContaining('content unavailable'));
    expect(trace).not.toHaveBeenCalledWith(expect.stringContaining('src/gone.ts'));
    expect(knowledge.corpusStatus.skipped).toBe(1);
    expect(JSON.stringify(knowledge.corpusStatus)).toContain('src/gone.ts');
  } finally { trace.mockRestore(); }
});

it.each(['rag', 'aikido'] as const)('applies inherited and nested gitignore to %s discovery, targeted refresh and snapshots', async mode => {
  const { root, write } = await fixture();
  await write('index.md', '# Entry');
  await write('.gitignore', '*.generated.ts\nignored/\n');
  await write('src/.gitignore', '!keep.generated.ts\nlocal/\n');
  for (const file of ['ignored/a.ts', 'src/drop.generated.ts', 'src/local/a.ts', 'src/node_modules/pkg/a.ts', 'src/dist/a.ts']) {
    await write(file, 'excluded sentinel');
  }
  await write('src/keep.generated.ts', 'included override');
  await write('src/main.ts', 'included source');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode, include: ['src/**', 'ignored/**'] }));
  await knowledge.initialize();
  const expected = ['src/keep.generated.ts', 'src/main.ts'];
  expect(knowledge.list().map(entry => entry.path)).toEqual(expected);
  await knowledge.refresh(['src']);
  expect(knowledge.list().map(entry => entry.path)).toEqual(expected);
  await expect(knowledge.read('src/local/a.ts')).rejects.toThrow('not found');
  const manager = snapshotsFor(knowledge);
  const begin = await manager.begin(['src']);
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    expect(snapshot.knowledge.list().map(entry => entry.path)).toEqual(expected);
  });
  await manager.end(String(begin.snapshotId));
});

it('reports oversized files and rejects aggregate/file-count limits instead of returning a partial corpus', async () => {
  const { root, knowledge, write } = await fixture({ maxFileBytes: 5, maxFiles: 2, maxCorpusBytes: 1024 });
  await write('a.ts', 'a');
  await write('big.rs', '012345');
  await knowledge.initialize();
  expect(knowledge.corpusStatus).toMatchObject({ files: 2, oversized: 1, metadataOnly: 1 });
  expect((await knowledge.read('big.rs')).content).toContain('metadata-only');
  await write('b.ts', 'b');
  await expect(knowledge.refresh()).rejects.toThrow('Corpus limit exceeded');
  const bytesLimit = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag', maxCorpusBytes: 1 }));
  await expect(bytesLimit.initialize()).rejects.toThrow('Corpus limit exceeded');
});

it('validates host-only configuration, environment precedence and unknown/malformed options', async () => {
  const { parent, root, write } = await fixture();
  await write('.kimono.json', '{"mode":"rag"}');
  vi.stubEnv('KIMONO_CORPUS_MODE', '');
  expect(() => loadCorpusConfig()).toThrow('mode');
  vi.stubEnv('KIMONO_CORPUS_MODE', 'aikido');
  const filename = path.join(parent, 'config.json');
  await writeFile(filename, '{"mode":"rag","extensions":[".JAVA"],"maxFiles":123}');
  vi.stubEnv('KIMONO_CONFIG_FILE', filename);
  expect(loadCorpusConfig()).toMatchObject({ mode: 'aikido', extensions: ['.java'], maxFiles: 123 });
  vi.stubEnv('KIMONO_CONFIG_FILE', 'relative.json');
  expect(() => loadCorpusConfig()).toThrow('absolute');
  for (const input of [null, [], { surprise: true }, { extensions: ['tsx'] }, { maxFiles: -1 },
    { include: ['../outside'] }, { exclude: ['!src/**'] }, { snapshotMaxBytes: 20, snapshotsTotalBytes: 10 }]) {
    expect(() => corpusConfig(input)).toThrow();
  }
  await expect(new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' })).initialize()).rejects.toThrow('entry point');
});

it('uses scoped immutable snapshots without an entry point and preserves exact config/fingerprint', async () => {
  const { knowledge, write } = await fixture({ include: ['src/**'], extensions: ['.rs'] });
  await write('src/a/main.rs', 'fn first() {}');
  await write('src/b/main.rs', 'fn second() {}');
  const manager = snapshotsFor(knowledge);
  const begin = await manager.begin(['src/a']);
  expect(begin).toMatchObject({ documents: 1, paths: ['src/a'] });
  await write('src/a/main.rs', 'fn changed() {}');
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    expect(snapshot.knowledge.config).toEqual(knowledge.config);
    expect(snapshot.knowledge.list().map(entry => entry.path)).toEqual(['src/a/main.rs']);
    expect((await snapshot.knowledge.read('src/a/main.rs')).content).toContain('first');
    expect((await sourceSnapshot(snapshot.knowledge)).corpusFingerprint).toBe(begin.version);
  });
  await manager.end(String(begin.snapshotId));
  await expect(manager.begin(['../outside'])).rejects.toThrow();
});

it('preserves AI-KIDO memory/code scope when a scoped snapshot omits the entry point', async () => {
  const { root, write } = await fixture();
  await write('prompts/index.md', '# AI-KIDO');
  await write('src/app.ts', 'export const project = true;');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  const manager = snapshotsFor(knowledge);
  const begin = await manager.begin(['src']);
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    expect(snapshot.knowledge.isMemoryRoot).toBe(false);
    const retrieval = new Retrieval(snapshot.knowledge);
    expect(JSON.parse(await retrieval.list({ scope: 'code' })).total).toBe(1);
    expect(JSON.parse(await retrieval.list({ scope: 'memory' })).total).toBe(0);
  });
  await manager.end(String(begin.snapshotId));
});

it('enforces snapshot count independently of byte limits', async () => {
  const { knowledge, write } = await fixture({ maxSnapshots: 1 });
  await write('src.rs', 'a');
  const manager = snapshotsFor(knowledge);
  const begin = await manager.begin();
  await expect(manager.begin()).rejects.toThrow('Snapshot limit reached');
  await manager.end(String(begin.snapshotId));
});

it('enforces configurable snapshot bytes, TTL, count and concurrent reservations and cleans failed captures', async () => {
  const { knowledge, write } = await fixture({ snapshotMaxBytes: 8, snapshotsTotalBytes: 10, maxSnapshots: 2, snapshotTtlMs: 1000 });
  await write('a.rs', '123456');
  const manager = snapshotsFor(knowledge);
  const results = await Promise.allSettled([manager.begin(), manager.begin()]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(results[1]).toMatchObject({ reason: expect.objectContaining({ message: expect.stringContaining('total limit') }) });
  if (results[0].status !== 'fulfilled') throw new Error('Expected the first snapshot to succeed');
  const id = String(results[0].value.snapshotId);
  const directories = await readdir(path.join(knowledge.searchIndex.directory, 'snapshots'));
  expect(directories).toEqual([id]);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 1001);
  try { await expect(manager.withSnapshot(id, async () => undefined)).rejects.toThrow('expired'); }
  finally { vi.useRealTimers(); }
  await write('a.rs', '123456789');
  await expect(manager.begin()).rejects.toThrow('use begin paths');
  expect(await readdir(path.join(knowledge.searchIndex.directory, 'snapshots'))).toEqual([]);
});

it('captures more than the former 64 MiB ceiling using bounded per-document hashing', async () => {
  const MIB = 1024 * 1024;
  const { knowledge, write } = await fixture({ maxFileBytes: 16 * MIB, snapshotMaxBytes: 80 * MIB, snapshotsTotalBytes: 80 * MIB });
  const content = Buffer.alloc(13 * MIB, 'a');
  for (let index = 0; index < 5; index++) await write(`large-${index}.txt`, content);
  const manager = snapshotsFor(knowledge);
  const begin = await manager.begin();
  expect(begin).toMatchObject({ documents: 5, bytes: 65 * MIB });
  await manager.end(String(begin.snapshotId));
}, 60_000);

it('reports corpus mode/limits via MCP and refuses publication/sync in RAG mode', async () => {
  const { knowledge, write } = await fixture();
  await write('src/lib.rs', 'pub fn local() {}');
  await knowledge.initialize();
  const runtime = runtimeFor(knowledge);
  expect(JSON.parse(await runtime.call('aikido_root', { operation: 'status' })).corpus).toMatchObject({ mode: 'rag', files: 1 });
  for (const [name, operation] of [['aikido_collaboration', 'publish'], ['aikido_git', 'sync'], ['aikido_git', 'retarget']]) {
    await expect(runtime.call(name, { operation })).rejects.toThrow('local read-only retrieval');
  }
  expect(await readFile(path.join(knowledge.root, 'src/lib.rs'), 'utf8')).toBe('pub fn local() {}');
});
