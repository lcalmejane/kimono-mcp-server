import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { corpusConfig } from '../src/corpus-config.js';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { declaredRepositories, parseRepositories, repositoryOf, resolveRepository } from '../src/repositories.js';
import { nestedRepositoryStates } from '../src/repository.js';
import { sourceSnapshot } from '../src/index-basis.js';

const scratch: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

async function fixture(options: Record<string, unknown> = {}) {
  const parent = await mkdtemp(path.join(process.cwd(), '.local-runtime-repositories-'));
  scratch.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  // ROOT repository ignores the independent sub-repositories, as tatami-core does.
  await write('.gitignore', '/agent/\n/other/\n*.secret.txt\n');
  await write('README.md', '# root');
  await write('agent/.gitignore', 'node_modules/\ngenerated/\n');
  await write('agent/src/AgentApprovalForm.tsx', 'export function AgentApprovalForm() { return null; }');
  await write('agent/generated/out.ts', 'export const generated = 1;');
  await write('agent/notes.secret.txt', 'indexed: the parent rule does not apply inside the sub-repository');
  await write('other/src/hidden.ts', 'export const hidden = 1;');
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'root');
  const agent = path.join(root, 'agent');
  git(agent, 'init', '-q', '-b', 'main'); git(agent, 'add', '-A'); git(agent, 'commit', '-qm', 'agent');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag', ...options }));
  await knowledge.initialize();
  return { root, agent, knowledge, write };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('keeps parent-ignored repositories out unless they are declared', async () => {
  const { knowledge } = await fixture();
  expect(knowledge.list().map(entry => entry.path)).toEqual(['.gitignore', 'README.md']);
});

it('indexes a declared nested repository under its own ignore rules only', async () => {
  const { knowledge } = await fixture({ repositories: [{ path: 'agent' }] });
  const paths = knowledge.list().map(entry => entry.path);
  expect(paths).toContain('agent/src/AgentApprovalForm.tsx');
  expect(paths).toContain('agent/notes.secret.txt');
  expect(paths).not.toContain('agent/generated/out.ts');
  expect(paths.some(file => file.startsWith('other/'))).toBe(false);
  expect(paths.some(file => file.includes('/.git/'))).toBe(false);
  const visible = (await knowledge.visibleFiles()).map(file => file.path);
  expect(visible).toContain('agent/src/AgentApprovalForm.tsx');
  expect(visible).not.toContain('agent/generated/out.ts');
});

it('validates repository declarations', () => {
  expect(parseRepositories([{ path: 'agent/' }, { path: '', gitUrl: 'https://github.com/o/r.git' }]))
    .toEqual([{ path: '', name: 'root', gitUrl: 'https://github.com/o/r.git' }, { path: 'agent', name: 'agent' }]);
  for (const bad of [[{ path: '../x' }], [{ path: '/abs' }], [{ path: 'a/*' }], [{ path: 'a' }, { path: 'a/' }],
    [{ path: 'a', name: 'x' }, { path: 'b', name: 'x' }], [{ path: 'a', gitUrl: 'https://u:p@h/r.git' }], [{ path: 'a', extra: 1 }], {}]) {
    expect(() => parseRepositories(bad)).toThrow();
  }
  expect(() => corpusConfig({ repositories: [{ path: '..' }] })).toThrow();
});

it('resolves repositories by name or path and merges the project policy', () => {
  const repositories = parseRepositories([{ path: 'agent', name: 'tatami-agent' }, { path: 'agent/sub' }]);
  expect(repositoryOf('agent/sub/x.ts', repositories)).toBe('agent/sub');
  expect(repositoryOf('agent/x.ts', repositories)).toBe('agent');
  expect(repositoryOf('README.md', repositories)).toBe('');
  expect(resolveRepository('tatami-agent', repositories).path).toBe('agent');
  expect(resolveRepository(undefined, repositories)).toEqual({ path: '', name: 'root' });
  expect(() => resolveRepository('nope', repositories)).toThrow(/Unknown repository/);
  const merged = declaredRepositories({ repositories: parseRepositories([{ path: 'agent', name: 'a' }]) },
    { gitUrl: 'https://github.com/o/root.git', repositories: parseRepositories([{ path: 'agent', name: 'b' }, { path: 'kimono' }]) });
  expect(merged.map(repository => [repository.path, repository.name])).toEqual([['', 'root'], ['agent', 'a'], ['kimono', 'kimono']]);
});

it('reports nested Git state and invalidates the index basis on nested changes', async () => {
  const { root, agent, knowledge, write } = await fixture({ repositories: [{ path: 'agent' }, { path: 'other' }] });
  const states = await nestedRepositoryStates(root, knowledge.config.repositories);
  expect(states.map(state => [state.path, state.available, state.dirty])).toEqual([['agent', true, false], ['other', false, null]]);
  const before = await sourceSnapshot(knowledge);
  await write('agent/src/AgentApprovalForm.tsx', 'export function AgentApprovalForm() { return 1; }');
  const dirty = await sourceSnapshot(knowledge, undefined, before);
  expect(dirty.dirty).toBe(true);
  expect(dirty.dirtyPaths).toContain('agent/src/AgentApprovalForm.tsx');
  git(agent, 'commit', '-qam', 'change');
  const committed = await sourceSnapshot(knowledge, undefined, before);
  expect(committed.configFingerprint).not.toBe(before.configFingerprint);
  expect(committed.documentFingerprints['agent/src/AgentApprovalForm.tsx'])
    .not.toBe(before.documentFingerprints['agent/src/AgentApprovalForm.tsx']);
});

it('filters search by declared repository', async () => {
  const { knowledge } = await fixture({ repositories: [{ path: 'agent', name: 'tatami-agent' }] });
  const { runtimeFor } = await import('../src/runtime-tools.js');
  const runtime = runtimeFor(knowledge);
  const snapshotId = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' })).snapshotId;
  const search = async (input: Record<string, unknown>) =>
    JSON.parse(await runtime.call('aikido_search', { snapshotId, query: 'AgentApprovalForm', ...input })).results
      .map((hit: { path: string }) => hit.path);
  expect(await search({})).toEqual(['agent/src/AgentApprovalForm.tsx']);
  expect(await search({ repository: 'tatami-agent' })).toEqual(['agent/src/AgentApprovalForm.tsx']);
  expect(await search({ repository: 'root' })).toEqual([]);
  await expect(runtime.call('aikido_search', { snapshotId, query: 'x', repository: 'nope' })).rejects.toThrow(/Unknown repository/);
});

it('merges KIMONO_REPOSITORIES into the corpus config', async () => {
  const { loadCorpusConfig } = await import('../src/corpus-config.js');
  vi.stubEnv('KIMONO_REPOSITORIES', JSON.stringify([{ path: 'agent', name: 'tatami-agent' }, { path: 'kimono' }]));
  expect(loadCorpusConfig().repositories.map(repository => [repository.path, repository.name]))
    .toEqual([['agent', 'tatami-agent'], ['kimono', 'kimono']]);
  vi.stubEnv('KIMONO_REPOSITORIES', '{bad');
  expect(() => loadCorpusConfig()).toThrow(/JSON array/);
  vi.stubEnv('KIMONO_REPOSITORIES', JSON.stringify([{ path: '../x' }]));
  expect(() => loadCorpusConfig()).toThrow();
});
