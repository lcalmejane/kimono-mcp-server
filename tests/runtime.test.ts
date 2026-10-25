import { corpusConfig } from '../src/corpus-config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { installAikido, isOfficialRepository, RepositoryAccess } from '../src/repository.js';
import { runtimeFor } from '../src/runtime-tools.js';

const exec = promisify(execFile);
const temporary: string[] = [];
const caches: string[] = [];
const git = (root: string, ...args: string[]) => exec('git', args, { cwd: root });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-runtime-'));
  temporary.push(root);
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# AI-KIDO\ninitial searchable');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Kimono Test');
  await git(root, 'config', 'user.email', 'kimono@example.invalid');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  caches.push(knowledge.searchIndex.directory);
  await knowledge.initialize();
  return { root, knowledge };
}

afterEach(async () => {
  await Promise.all([...temporary.splice(0), ...caches.splice(0)].map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('scoped repository runtime', () => {
  it('clones a custom repository with complete history and validates its AI-KIDO root', async () => {
    const { root } = await fixture();
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'first');
    await writeFile(path.join(root, 'README.md'), '# Second');
    await git(root, 'add', '.');
    await git(root, 'commit', '-m', 'second');
    const target = path.join(await mkdtemp(path.join(tmpdir(), 'kimono-clone-')), 'project');
    temporary.push(path.dirname(target));
    await installAikido(target, 'main', root);
    expect((await git(target, 'rev-list', '--count', 'HEAD')).stdout.trim()).toBe('2');
    expect(await readFile(path.join(target, 'prompts/index.md'), 'utf8')).toContain('AI-KIDO');
  });

  it('recognizes official remote variants and blocks every mutating operation there', async () => {
    const { root } = await fixture();
    for (const url of ['https://github.com/lcalmejane/aikido.git', 'git@github.com:lcalmejane/aikido.git', 'ssh://git@ssh.github.com:443/lcalmejane/aikido.git']) {
      expect(isOfficialRepository(url)).toBe(true);
    }
    await git(root, 'remote', 'add', 'origin', 'https://github.com/lcalmejane/aikido.git');
    const repository = new RepositoryAccess(root, true);
    for (const operation of ['add', 'commit', 'push', 'pull', 'fetch', 'remote-add', 'reset', 'merge']) {
      await expect(repository.git({ operation, message: 'forbidden', paths: ['prompts/index.md'], confirm: true })).rejects.toThrow('read-only');
    }
    expect((await repository.git({ operation: 'status' })).exitCode).toBe(0);
  });

  it('allows project commits, disables hooks, requires approval and blocks official push URLs', async () => {
    const { root } = await fixture();
    const repository = new RepositoryAccess(root, true);
    await writeFile(path.join(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await repository.git({ operation: 'add', paths: ['prompts/index.md'] });
    await repository.git({ operation: 'commit', message: 'Create AI-KIDO project' });
    expect((await git(root, 'log', '-1', '--format=%s')).stdout.trim()).toBe('Create AI-KIDO project');
    await expect(repository.git({ operation: 'push' })).rejects.toThrow('confirm=true');
    await git(root, 'remote', 'add', 'other', 'https://github.com/lcalmejane/aikido.git');
    await expect(repository.git({ operation: 'push', remote: 'other', confirm: true })).rejects.toThrow('official');
    await expect(repository.git({ operation: 'add', paths: ['../outside'] })).rejects.toThrow('inside AIKIDO_ROOT');
    await expect(new RepositoryAccess(root, false).git({ operation: 'commit', message: 'no' })).rejects.toThrow('AIKIDO_WRITABLE');
  });

  it('pushes an approved project commit and fetches/pulls updates from a configured remote', async () => {
    const { root } = await fixture();
    const parent = await mkdtemp(path.join(tmpdir(), 'kimono-remote-'));
    temporary.push(parent);
    const remote = path.join(parent, 'project.git');
    await git(parent, 'init', '--bare', '-b', 'main', remote);
    const repository = new RepositoryAccess(root, true);
    await repository.git({ operation: 'add', paths: ['prompts/index.md'] });
    await repository.git({ operation: 'commit', message: 'project' });
    await repository.git({ operation: 'remote-add', name: 'origin', url: remote });
    await repository.git({ operation: 'push', ref: 'main', confirm: true });
    expect((await git(remote, 'log', '-1', '--format=%s')).stdout.trim()).toBe('project');
    await git(root, 'branch', '--set-upstream-to=origin/main', 'main');
    const contributor = path.join(parent, 'contributor');
    await git(parent, 'clone', remote, contributor);
    await git(contributor, 'config', 'user.name', 'Contributor');
    await git(contributor, 'config', 'user.email', 'contributor@example.invalid');
    await writeFile(path.join(contributor, 'prompts/remote.md'), '# Incoming');
    await git(contributor, 'add', '.');
    await git(contributor, 'commit', '-m', 'incoming');
    await git(contributor, 'push');
    await repository.git({ operation: 'fetch' });
    await repository.git({ operation: 'pull' });
    expect(await readFile(path.join(root, 'prompts/remote.md'), 'utf8')).toBe('# Incoming');
  });

  it('protects official URLs reached through Git URL rewrites or pushurl overrides', async () => {
    const { root } = await fixture();
    await git(root, 'remote', 'add', 'origin', 'https://example.invalid/my-fork.git');
    await git(root, 'config', 'url.https://github.com/lcalmejane/aikido.git.insteadOf', 'https://example.invalid/my-fork.git');
    const repository = new RepositoryAccess(root, true);
    await expect(repository.requireWritable()).rejects.toThrow('read-only');
    await git(root, 'config', '--unset-all', 'url.https://github.com/lcalmejane/aikido.git.insteadOf');
    await git(root, 'config', 'remote.origin.pushurl', 'git@github.com:lcalmejane/aikido.git');
    await expect(repository.requireWritable()).rejects.toThrow('read-only');
  });

  it('keeps ROOT initialization outside the MCP and accepts metadata-only retargeting', async () => {
    const { root } = await fixture();
    const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
    caches.push(knowledge.searchIndex.directory);
    await knowledge.initialize();
    const runtime = runtimeFor(knowledge);
    await expect(runtime.call('aikido_root', { operation: 'init', repository: root })).rejects.toThrow('Only operation=status');
    const retarget = JSON.parse(await runtime.call('aikido_git', {
      operation: 'retarget', gitUrl: 'https://github.com/example/project.git', branch: 'feature/docs',
    }));
    expect(retarget).toMatchObject({ operation: 'retarget', retarget: { gitUrl: 'https://github.com/example/project.git', branch: 'feature/docs' } });
    expect((await git(root, 'remote')).stdout).toBe('');
    await expect(runtime.call('aikido_git', {
      operation: 'retarget', gitUrl: 'https://user:token@example.com/org/repo.git',
    })).rejects.toThrow('credentials');
  });
});

describe('real fast-grep index', () => {
  it('searches content, regex, hidden capabilities and updates additions/edits/deletions without indexing private specs', async () => {
    const { root, knowledge } = await fixture();
    await mkdir(path.join(root, '.github/skills/test'), { recursive: true });
    await writeFile(path.join(root, '.github/skills/test/SKILL.md'), '# Hidden unique needle');
    await mkdir(path.join(root, 'prompts/spec'), { recursive: true });
    await writeFile(path.join(root, 'prompts/spec/private.md'), 'private hidden secret needle');
    let results = await knowledge.search('needle');
    expect(results.map((item) => item.path)).toEqual(['.github/skills/test/SKILL.md']);
    expect(results[0].line).toBe(1);
    await writeFile(path.join(root, 'prompts/new.md'), 'NEW needle UPDATED');
    results = await knowledge.search('UPDATED');
    expect(results[0].path).toBe('prompts/new.md');
    await writeFile(path.join(root, 'prompts/new.md'), 'changed entirely');
    expect(await knowledge.search('UPDATED')).toEqual([]);
    await rm(path.join(root, '.github/skills/test/SKILL.md'));
    expect(await knowledge.search('needle')).toEqual([]);
    await knowledge.refresh();
    const regex = await knowledge.searchIndex.search('changed.*entirely', undefined, 1, true);
    expect(regex).toHaveLength(1);
    expect(await knowledge.searchIndex.maintain('stats')).toBeTruthy();
    await knowledge.searchIndex.maintain('compact');
    await knowledge.searchIndex.maintain('rebuild');
    await expect(knowledge.searchIndex.search('[invalid', undefined, 10, true)).rejects.toThrow('fgr failed');
  });

  it('rejects all file mutations through MCP, regardless of AIKIDO_WRITABLE', async () => {
    const { root, knowledge } = await fixture();
    process.env.AIKIDO_WRITABLE = 'true';
    const runtime = runtimeFor(knowledge);
    const begun = JSON.parse(await runtime.call('aikido_snapshot', { operation: 'begin' }));
    await expect(runtime.call('aikido_file', {
      operation: 'write', path: 'prompts/index.md', snapshotId: begun.snapshotId, content: '# changed',
    })).rejects.toThrow('Only aikido_file ranges, metadata, outline and read');
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).toContain('initial searchable');
    await runtime.call('aikido_snapshot', { operation: 'end', snapshotId: begun.snapshotId });
    delete process.env.AIKIDO_WRITABLE;
  });
});
