import { corpusConfig } from '../src/corpus-config.js';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { runtimeFor } from '../src/runtime-tools.js';
import * as processes from '../src/process.js';

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

describe('explicit remote knowledge sync', () => {
  it('uses request-resolved credentials for read-only sync and reports indexed provenance', async () => {
    const base = await mkdtemp(path.resolve('.remote-sync-test-'));
    directories.push(base);
    const root = path.join(base, 'knowledge');
    const remote = path.join(base, 'remote');
    const cache = path.join(base, 'cache');
    await mkdir(path.join(root, 'prompts'), { recursive: true });
    await mkdir(path.join(remote, 'prompts'), { recursive: true });
    await writeFile(path.join(root, 'prompts/index.md'), '# Local unpublished\nKeep this seed');
    await writeFile(path.join(remote, 'prompts/index.md'), '# Remote source\nRead-only update');
    await writeFile(path.join(remote, 'prompts/remote.md'), 'Remote-only document');
    await exec('git', ['init', '--initial-branch=main'], { cwd: remote });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: remote });
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: remote });
    await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: remote });
    await exec('git', ['add', '.'], { cwd: remote });
    await exec('git', ['commit', '-m', 'remote knowledge'], { cwd: remote });

    vi.stubEnv('KIMONO_CACHE_DIR', cache);
    vi.stubEnv('FGR_BIN', 'fgr-test');
    const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
    await knowledge.initialize();
    const runtime = runtimeFor(knowledge);
    await runtime.call('aikido_git', {
      operation: 'retarget',
      gitUrl: 'https://git.example.invalid/team/knowledge.git',
    });

    const realRun = processes.runProcess;
    let observedAskpass = '';
    let resolvedRequest: Record<string, unknown> | undefined;
    const token = 'request-scoped-secret';
    let expectedToken: string | undefined = token;
    vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
      const [executable, originalArgs, cwd, allowedCodes, timeout, stderr, environment] = args;
      if (executable === 'fgr-test') return { stdout: '', stderr: '', exitCode: 0 };
      if (executable === 'git' && originalArgs.includes('clone')) {
        expect(environment?.KIMONO_GIT_TOKEN).toBe(expectedToken);
        observedAskpass = environment?.GIT_ASKPASS ?? '';
        const clonePosition = originalArgs.indexOf('clone');
        const rewritten = [...originalArgs];
        const separator = rewritten.indexOf('--', clonePosition);
        rewritten[separator + 1] = remote;
        rewritten.splice(clonePosition, 0, '-c', 'protocol.file.allow=always');
        return realRun(executable, rewritten, cwd, allowedCodes, timeout, stderr, environment);
      }
      return realRun(...args);
    });

    const sync = JSON.parse(await runtime.call('aikido_git', {
      operation: 'sync',
      mode: 'literal',
      connectionId: 'conn_123',
    }, {
      allowLocalGitProfile: false,
      resolveGitProfile: async request => {
        resolvedRequest = request;
        return {
          host: 'git.example.invalid',
          transport: 'https',
          username: 'copilot',
          secret: token,
        };
      },
    }));

    const commit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: remote })).stdout.trim();
    expect(resolvedRequest).toEqual({
      gitUrl: 'https://git.example.invalid/team/knowledge.git',
      branch: undefined,
      connectionId: 'conn_123',
    });
    expect(sync).toMatchObject({
      operation: 'sync',
      remoteSynchronized: true,
      gitUrl: 'https://git.example.invalid/team/knowledge.git',
      branch: 'main',
      commit,
      corpusFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).toContain('Remote source');
    expect(await readFile(path.join(root, 'prompts/remote.md'), 'utf8')).toContain('Remote-only');
    expect(await readFile(path.join(root, 'local-seed/prompts/index.md'), 'utf8')).toContain('Keep this seed');
    const syncedInfos = JSON.parse(await runtime.call('aikido_git', { operation: 'infos' }));
    expect(syncedInfos.indexedSource).toBeNull();
    expect(syncedInfos.lastSyncedSource.commit).toBe(commit);
    expect(syncedInfos.localChanges.changes).toContainEqual(expect.objectContaining({
      path: 'local-seed/prompts/index.md', kind: 'addition',
    }));
    const collaborationBase = JSON.parse(await runtime.call('aikido_collaboration', { operation: 'status' }));
    const sharedEdit = 'Local edit after sync';
    const collaborationPublish = JSON.parse(await runtime.call('aikido_collaboration', {
      operation: 'publish',
      expectedSharedVersion: collaborationBase.sharedVersion,
      baseVersion: collaborationBase.sharedVersion,
      localManifest: {
        ...collaborationBase.localManifest,
        'prompts/remote.md': createHash('sha256').update(sharedEdit).digest('hex'),
      },
      changes: [{ path: 'prompts/remote.md', content: sharedEdit }],
    }));
    expect(collaborationPublish.published).toBe(true);
    const changedInfos = JSON.parse(await runtime.call('aikido_git', { operation: 'infos' }));
    expect(changedInfos.indexedSource).toBeNull();
    expect(changedInfos.lastSyncedSource.commit).toBe(commit);
    expect(changedInfos.localChanges.changes).toContainEqual(expect.objectContaining({
      path: 'prompts/remote.md', kind: 'modification',
    }));
    await expect(runtime.call('aikido_git', { operation: 'sync', mode: 'literal' }, {
      gitProfile: { host: 'git.example.invalid', transport: 'https', username: 'copilot', secret: token },
    })).rejects.toThrow('conflicts with unpublished local knowledge: prompts/remote.md');
    expect(await readFile(path.join(root, 'prompts/remote.md'), 'utf8')).toBe('Local edit after sync');
    await rm(path.join(root, 'prompts/remote.md'));
    await expect(runtime.call('aikido_git', { operation: 'sync', mode: 'literal' }, {
      gitProfile: { host: 'git.example.invalid', transport: 'https', username: 'copilot', secret: token },
    })).rejects.toThrow('conflicts with unpublished local knowledge: prompts/remote.md');
    await expect(readFile(path.join(root, 'prompts/remote.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(root, 'prompts/remote.md'), 'Remote-only document');
    expect(await readFile(observedAskpass, 'utf8').catch(error => error.code)).toBe('ENOENT');
    expect(await readdir(path.join(knowledge.searchIndex.directory, 'remote-staging'))).toEqual([]);
    const cacheContents = await readFile(path.join(knowledge.searchIndex.directory, 'project-remote.json'), 'utf8');
    expect(cacheContents).not.toContain(token);
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).not.toContain(token);
    const profileFile = path.join(base, 'profile.json');
    await writeFile(profileFile, JSON.stringify({
      host: 'git.example.invalid', transport: 'https', username: 'standalone', secret: token,
    }), { mode: 0o600 });
    vi.stubEnv('KIMONO_GIT_PROFILE_FILE', profileFile);
    await runtime.call('aikido_git', { operation: 'sync', mode: 'literal' });
    expectedToken = undefined;
    const resolver = vi.fn(async () => { throw new Error('Anonymous sync must not resolve credentials'); });
    await runtime.call('aikido_git', { operation: 'sync', mode: 'literal', connectionId: '' }, {
      gitProfile: { host: 'git.example.invalid', transport: 'https', username: 'unused', secret: token },
      resolveGitProfile: resolver,
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires an explicit retarget and never selects a policy URL implicitly', async () => {
    const base = await mkdtemp(path.resolve('.remote-sync-policy-test-'));
    directories.push(base);
    const root = path.join(base, 'knowledge');
    await mkdir(path.join(root, 'prompts'), { recursive: true });
    await writeFile(path.join(root, 'prompts/index.md'), '# Local knowledge');
    const cache = path.join(base, 'cache');
    vi.stubEnv('KIMONO_CACHE_DIR', cache);
    const policy = path.join(base, 'policy.json');
    await writeFile(policy, JSON.stringify({ projectId: 'p1', gitUrl: 'https://github.com/org/catalog.git' }));
    vi.stubEnv('KIMONO_PROJECT_POLICY_FILE', policy);
    const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
    await knowledge.initialize();
    await expect(runtimeFor(knowledge).call('aikido_git', { operation: 'sync' }))
      .rejects.toThrow('Retarget an explicit');
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).toContain('Local knowledge');
  });

  it('syncs using a secure standalone SSH profile with strict host checking and no receive-pack', async () => {
    const base = await mkdtemp(path.resolve('.remote-sync-ssh-test-'));
    directories.push(base);
    const root = path.join(base, 'knowledge');
    const remote = path.join(base, 'remote');
    const cache = path.join(base, 'cache');
    await mkdir(root);
    await mkdir(remote);
    await writeFile(path.join(root, 'index.md'), '# Local knowledge');
    await writeFile(path.join(remote, 'index.md'), '# Private SSH knowledge');
    await exec('git', ['init', '--initial-branch=main'], { cwd: remote });
    await exec('git', ['add', '.'], { cwd: remote });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'SSH source'], { cwd: remote });
    const key = path.join(base, 'test-key');
    await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    const publicKey = (await readFile(`${key}.pub`, 'utf8')).split(' ').slice(0, 2).join(' ');
    const file = path.join(base, 'profile.json');
    await writeFile(file, JSON.stringify({
      transport: 'ssh', host: 'git.example.invalid', username: 'git',
      secret: await readFile(key, 'utf8'), knownHosts: `git.example.invalid ${publicKey}`,
    }), { mode: 0o600 });
    const bin = path.join(base, 'bin');
    await mkdir(bin);
    const observed = path.join(base, 'used-key');
    await writeFile(path.join(bin, 'ssh'), `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(!args.includes('StrictHostKeyChecking=yes') || !args.includes('IdentityAgent=none') || !args.includes('-i')) process.exit(91);
writeFileSync(${JSON.stringify(observed)}, args[args.indexOf('-i')+1]);
if(!args.at(-1).startsWith('git-upload-pack ')) process.exit(92);
const result=spawnSync('git-upload-pack', [${JSON.stringify(remote)}], {stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv('KIMONO_CACHE_DIR', cache);
    vi.stubEnv('KIMONO_GIT_PROFILE_FILE', file);
    vi.stubEnv('FGR_BIN', 'fgr-test');
    const realRun = processes.runProcess;
    vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) =>
      args[0] === 'fgr-test' ? { stdout: '', stderr: '', exitCode: 0 } : realRun(...args));
    const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
    await knowledge.initialize();
    const runtime = runtimeFor(knowledge);
    await runtime.call('aikido_git', { operation: 'retarget', gitUrl: 'git@git.example.invalid:team/knowledge.git' });
    const sync = JSON.parse(await runtime.call('aikido_git', { operation: 'sync', mode: 'literal' }));
    expect(sync).toMatchObject({ remoteSynchronized: true, branch: 'main' });
    expect(await readFile(path.join(root, 'index.md'), 'utf8')).toContain('Private SSH knowledge');
    const temporaryKey = await readFile(observed, 'utf8');
    await expect(readFile(temporaryKey)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(file, JSON.stringify({
      transport: 'ssh', host: 'another.example.invalid', username: 'git',
      secret: await readFile(key, 'utf8'), knownHosts: `another.example.invalid ${publicKey}`,
    }));
    await expect(runtime.call('aikido_git', { operation: 'sync', mode: 'literal' }))
      .rejects.toThrow('Managed Git operation failed');
  });
});
