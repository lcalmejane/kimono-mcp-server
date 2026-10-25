import { corpusConfig } from '../src/corpus-config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import * as processes from '../src/process.js';
import { indexInfos, trackIndex } from '../src/index-basis.js';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(path.resolve('.repo-info-test-'));
  directories.push(directory);
  const root = path.join(directory, 'repository');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(directory, 'cache'));
  vi.stubEnv('FGR_BIN', 'fgr-test');
  vi.stubEnv('AIKIDO_WRITABLE', 'true');
  vi.stubEnv('KIMONO_GIT_PROFILE_FILE', '');
  const git = async (...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim();
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(root, 'index.md'), 'initial corpus');
  await git('add', '.');
  await git('commit', '-m', 'initial');
  const realRun = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
    if (args[0] === 'fgr-test') return { stdout: '', stderr: '', exitCode: 0 };
    return realRun(...args);
  });
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const runtime = runtimeFor(knowledge);
  const call = async (input: Record<string, unknown>) => JSON.parse(await runtime.call('aikido_git', input));
  return { root, directory, git, knowledge, runtime, call };
}

describe('repository infos and explicit synchronization', () => {
  it('reports unknown then persistent indexed basis, and detects dirty edits without changing HEAD', async () => {
    const { root, git, knowledge, runtime, call } = await fixture();
    const initial = await call({ operation: 'infos' });
    await expect(access(knowledge.searchIndex.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(initial.repository).toMatchObject({ branch: 'main', dirty: false, upstream: null, ahead: null, behind: null });
    expect(initial.indexes.literal).toMatchObject({ lastIndexedSha: null, freshness: 'unknown' });
    expect(initial.policy.execution).toBe('external-only');
    await runtime.call('aikido_index', { operation: 'update', mode: 'literal' });
    const synced = await call({ operation: 'infos' });
    expect(synced.indexes.literal).toMatchObject({ lastIndexedSha: initial.repository.head, freshness: 'fresh' });
    expect(synced.indexes.semantic.freshness).toBe('unknown');
    const restarted = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
    await restarted.initialize();
    expect((await indexInfos(restarted)).indexes.literal).toMatchObject({ freshness: 'fresh' });
    await writeFile(path.join(root, 'index.md'), 'external edit, same HEAD');
    const dirty = await call({ operation: 'infos' });
    expect(dirty.repository.head).toBe(initial.repository.head);
    expect(dirty.repository.dirty).toBe(true);
    expect(dirty.repository.dirtyFiles).toContainEqual({ path: 'index.md', status: ' M' });
    expect(dirty.indexedSource).toBeNull();
    expect(dirty.indexes.literal.freshness).toBe('stale');
    await runtime.call('aikido_index', { operation: 'update', mode: 'literal' });
    const updated = await call({ operation: 'infos' });
    expect(updated.indexes.literal.freshness).toBe('fresh');
    expect(updated.indexes.literal.basis.dirty).toBe(true);
    await git('add', '.');
    await git('commit', '-m', 'local write');
    expect((await call({ operation: 'infos' })).indexes.literal.freshness).toBe('stale');
    await expect(call({ operation: 'sync', expectedHead: initial.repository.head, expectedBranch: 'main', mode: 'literal' }))
      .rejects.toThrow('Retarget an explicit');
    expect(await readFile(path.join(knowledge.searchIndex.directory, 'literal-basis.json'), 'utf8')).toContain(initial.repository.head);
  });

  it('does not label partial, failed embedding batches or concurrent source changes as successful full indexes', async () => {
    const { root, git, knowledge, runtime, call } = await fixture();
    await runtime.call('aikido_index', { operation: 'update', mode: 'literal', paths: ['index.md'] });
    expect((await call({ operation: 'infos' })).indexes.literal).toMatchObject({ freshness: 'partial', lastIndexedSha: null });
    await runtime.call('aikido_index', { operation: 'update', mode: 'literal' });
    const oldHead = await git('rev-parse', 'HEAD');
    await writeFile(path.join(root, 'index.md'), 'new revision');
    await git('add', '.');
    await git('commit', '-m', 'new revision');
    await expect(trackIndex(knowledge, 'semantic', undefined, async () => {
      throw new Error('embedding batch failed');
    })).rejects.toThrow('embedding batch failed');
    const failed = await call({ operation: 'infos' });
    expect(failed.indexes.semantic).toMatchObject({ freshness: 'failed', lastIndexedSha: null });
    expect(failed.indexes.literal.lastIndexedSha).toBe(oldHead);
    const originalRead = knowledge.read.bind(knowledge);
    const read = vi.spyOn(knowledge, 'read').mockImplementation(async file => {
      const result = await originalRead(file);
      await writeFile(path.join(root, 'index.md'), 'changed during indexing');
      return result;
    });
    await knowledge.searchIndex.maintain('update');
    read.mockRestore();
    expect((await call({ operation: 'infos' })).indexes.literal).toMatchObject({ freshness: 'concurrent-change', lastIndexedSha: oldHead });
  });

  it('preserves a successful semantic basis when a later batch fails and serializes cache writers', async () => {
    const { knowledge } = await fixture();
    const snapshot = await import('../src/index-basis.js').then(module => module.sourceSnapshot(knowledge));
    await trackIndex(knowledge, 'semantic', undefined, async observed => { observed(snapshot.corpusFingerprint); });
    await expect(trackIndex(knowledge, 'semantic', undefined, async () => {
      throw new Error('later batch failed');
    })).rejects.toThrow('later batch failed');
    expect((await indexInfos(knowledge)).indexes.semantic).toMatchObject({ freshness: 'failed', lastIndexedSha: snapshot.head });
    await trackIndex(knowledge, 'literal', undefined, async observed => {
      await expect(trackIndex(knowledge, 'literal', undefined, async () => undefined)).rejects.toThrow('locked');
      observed(snapshot.corpusFingerprint);
    });
    await writeFile(path.join(knowledge.searchIndex.directory, 'literal-basis.json'), 'null');
    expect((await indexInfos(knowledge)).indexes.literal).toMatchObject({ freshness: 'unknown', lastIndexedSha: null });
  });

  it('requires an explicit remote target while local reindexing permits detached checkouts', async () => {
    const { git, runtime, call } = await fixture();
    const head = await git('rev-parse', 'HEAD');
    await expect(call({ operation: 'sync', mode: 'literal' })).rejects.toThrow('Retarget an explicit');
    await git('checkout', '--detach');
    const detached = await call({ operation: 'infos' });
    expect(detached.repository.branch).toBeNull();
    await runtime.call('aikido_index', { operation: 'update', mode: 'literal' });
    expect((await call({ operation: 'infos' })).repository.head).toBe(head);
  });

  it('retargets metadata without mutating local refs and advises about externally fetched divergence', async () => {
    const { root, directory, git, call } = await fixture();
    const remote = path.join(directory, 'remote.git');
    await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
    await git('remote', 'add', 'origin', remote);
    await git('push', '--set-upstream', 'origin', 'main');
    const head = await git('rev-parse', 'HEAD');
    const writer = path.join(directory, 'writer');
    await exec('git', ['clone', remote, writer]);
    await writeFile(path.join(writer, 'index.md'), 'remote revision');
    await exec('git', ['-C', writer, 'add', '.']);
    await exec('git', ['-C', writer, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'remote']);
    await exec('git', ['-C', writer, 'push']);
    expect((await call({ operation: 'infos' })).repository.behind).toBe(0);
    await expect(call({ operation: 'fetch', confirm: true })).rejects.toThrow('outside MCP');
    await git('branch', 'base');
    await call({ operation: 'retarget', gitUrl: 'https://github.com/example/knowledge.git', branch: 'docs' });
    expect(await git('rev-parse', 'HEAD')).toBe(head);
    expect(await git('remote', 'get-url', 'origin')).toBe(remote);
    await git('fetch', 'origin');
    const fetched = await call({ operation: 'infos' });
    expect(fetched.repository).toMatchObject({ head, branch: 'main', behind: 1 });
    expect(fetched.recommendation).toBe('fetch-review');
    expect(await git('rev-parse', 'base')).toBe(head);
    await writeFile(path.join(root, 'index.md'), 'local divergent revision');
    await git('add', '.');
    await git('commit', '-m', 'local divergent');
    const divergent = await call({ operation: 'infos' });
    expect(divergent.repository).toMatchObject({ ahead: 1, behind: 1 });
    expect(divergent.recommendation).toBe('review-divergence');
  });

  it('provides Git policy advice without invoking GitHub or performing remote actions', async () => {
    const { git, call } = await fixture();
    await git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    const realRun = vi.mocked(processes.runProcess).getMockImplementation()!;
    const calls: string[][] = [];
    vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
      if (args[0] !== 'gh') return realRun(...args);
      calls.push(args[1]);
      return { stdout: args[1][0] === 'repo' ? '{"nameWithOwner":"example/project"}'
        : args[1][0] === 'pr' ? '[]' : 'sensitive auth details', stderr: '', exitCode: 0 };
    });
    expect((await call({ operation: 'infos' })).policy.execution).toBe('external-only');
    expect(calls).toHaveLength(0);
    const info = await call({ operation: 'infos', github: true });
    expect(info.policy.gitPushAllowed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(info)).not.toContain('sensitive');
  });
});
