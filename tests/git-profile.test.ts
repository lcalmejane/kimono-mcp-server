import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { withGitProfile } from '../src/git-profile.js';
import { installAikido, RepositoryAccess } from '../src/repository.js';
import { runProcess } from '../src/process.js';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-profile-test-'));
  directories.push(parent);
  const root = path.join(parent, 'root');
  await mkdir(root);
  const file = path.join(parent, 'profile.json');
  const profile = { transport: 'https', host: 'git.example.invalid', username: 'test-user',
    secret: 'dummy-token-for-tests', authorName: 'Profile Author', authorEmail: 'profile@example.invalid' };
  await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
  vi.stubEnv('KIMONO_GIT_PROFILE_FILE', file);
  return { parent, root, file, profile };
}

it('loads rotated HTTPS credentials and identity on every operation without persisting them', async () => {
  const { root, file, profile } = await fixture();
  await execute('git', ['init', '-b', 'main'], { cwd: root });
  const repository = new RepositoryAccess(root, true);
  await writeFile(path.join(root, 'index.md'), '# Knowledge');
  await repository.git({ operation: 'add', paths: ['index.md'] });
  await repository.git({ operation: 'commit', message: 'profile identity' });
  expect((await execute('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root })).stdout.trim())
    .toBe('Profile Author <profile@example.invalid>');
  for (const token of [profile.secret, 'rotated-dummy-token']) {
    await writeFile(file, JSON.stringify({ ...profile, secret: token }));
    await withGitProfile(root, async (context) => {
      context.validateUrl('https://git.example.invalid/team/repo.git');
      const helper = context.env!.GIT_ASKPASS!;
      expect((await execute(helper, ['Username for HTTPS'], { env: context.env })).stdout).toBe(profile.username);
      expect((await execute(helper, ['Password for HTTPS'], { env: context.env })).stdout).toBe(token);
      expect(context.args).toContain('http.followRedirects=false');
      expect(context.env!.GIT_CONFIG_GLOBAL).toBe('/dev/null');
      const redacted = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.KIMONO_GIT_TOKEN)'],
        root, [0], 120_000, undefined, context.env);
      expect(redacted.stdout).toBe('[REDACTED]');
    });
  }
  expect(await readFile(path.join(root, '.git/config'), 'utf8')).not.toContain(profile.secret);
  expect(await readFile(path.join(root, '.git/config'), 'utf8')).not.toContain('credential');
  await writeFile(file, JSON.stringify({ ...profile, authorName: 'Rotated Author', authorEmail: 'rotated@example.invalid' }));
  await writeFile(path.join(root, 'index.md'), '# Updated knowledge');
  await repository.git({ operation: 'add', paths: ['index.md'] });
  await repository.git({ operation: 'commit', message: 'rotated identity' });
  expect((await execute('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root })).stdout.trim())
    .toBe('Rotated Author <rotated@example.invalid>');
});

it('rejects mismatched effective remotes, unsafe profiles and redacts helper failures', async () => {
  const { root, file, profile } = await fixture();
  await execute('git', ['init', '-b', 'main'], { cwd: root });
  await execute('git', ['remote', 'add', 'origin', 'https://other.invalid/repo'], { cwd: root });
  await expect(new RepositoryAccess(root, true).git({ operation: 'fetch' })).rejects.toThrow('Managed Git operation failed');
  await execute('git', ['remote', 'set-url', 'origin', 'https://git.example.invalid/repo'], { cwd: root });
  await execute('git', ['config', 'url.https://other.invalid/.insteadOf', 'https://git.example.invalid/'], { cwd: root });
  await expect(new RepositoryAccess(root, true).git({ operation: 'fetch' })).rejects.toThrow('Managed Git operation failed');
  await execute('git', ['config', '--unset-all', 'url.https://other.invalid/.insteadOf'], { cwd: root });
  await execute('git', ['remote', 'set-url', '--push', 'origin', 'https://other.invalid/repo'], { cwd: root });
  await expect(new RepositoryAccess(root, true).git({ operation: 'push', confirm: true })).rejects.toThrow('Managed Git operation failed');
  await execute('git', ['remote', 'set-url', 'origin', 'https://github.com/lcalmejane/aikido.git'], { cwd: root });
  await expect(new RepositoryAccess(root, true).git({ operation: 'push', confirm: true })).rejects.toThrow('read-only');
  for (const url of ['https://other.invalid/repo', 'ssh://git@git.example.invalid/repo', '/tmp/repo',
    'https://git.example.invalid:8443/repo', 'https://user:password@git.example.invalid/repo']) {
    await expect(withGitProfile(root, async (context) => context.validateUrl(url))).rejects.toThrow('Managed Git operation failed');
  }
  await expect(withGitProfile(root, async () => { throw new Error(profile.secret); }))
    .rejects.not.toThrow(profile.secret);
  let helper = '';
  await withGitProfile(root, async (context) => { helper = context.env!.GIT_ASKPASS!; });
  await expect(access(helper)).rejects.toMatchObject({ code: 'ENOENT' });
  await chmod(file, 0o644);
  await expect(withGitProfile(root, async () => undefined)).rejects.toThrow('Invalid or unavailable');
  await chmod(file, 0o600);
  const inside = path.join(root, 'profile.json');
  await writeFile(inside, JSON.stringify(profile), { mode: 0o600 });
  vi.stubEnv('KIMONO_GIT_PROFILE_FILE', inside);
  await expect(withGitProfile(root, async () => undefined)).rejects.toThrow('Invalid or unavailable');
});

it('uses strict SSH key/known_hosts options for real Git clone, push and fetch with rotated profiles', async () => {
  const { parent, root, file, profile } = await fixture();
  const key = path.join(parent, 'test-key');
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = (await readFile(`${key}.pub`, 'utf8')).split(' ').slice(0, 2).join(' ');
  const sshProfile = { ...profile, transport: 'ssh', username: 'git',
    secret: await readFile(key, 'utf8'), knownHosts: `${profile.host} ${publicKey}` };
  await writeFile(file, JSON.stringify(sshProfile));
  const remote = path.join(parent, 'remote.git');
  await execute('git', ['init', '--bare', '-b', 'main', remote]);
  const bin = path.join(parent, 'bin');
  await mkdir(bin);
  // Substitute only the SSH network boundary; Git pack protocols stay real.
  await writeFile(path.join(bin, 'ssh'), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(!args.includes('StrictHostKeyChecking=yes') || !args.includes('IdentityAgent=none') || !args.includes('-i')) process.exit(91);
const command=args.at(-1);
if(!/^(git-upload-pack|git-receive-pack) /.test(command)) process.exit(92);
const operation=command.split(' ')[0];
const result=spawnSync(operation, [${JSON.stringify(remote)}], {stdio:'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  await execute('git', ['init', '-b', 'main'], { cwd: root });
  await writeFile(path.join(root, 'index.md'), '# AI-KIDO');
  const repository = new RepositoryAccess(root, true);
  await repository.git({ operation: 'add', paths: ['index.md'] });
  await repository.git({ operation: 'commit', message: 'ssh seed' });
  await repository.git({ operation: 'remote-add', name: 'origin', url: `git@${profile.host}:team/repo.git` });
  await repository.git({ operation: 'push', ref: 'main', confirm: true });
  const clone = path.join(parent, 'clone');
  await installAikido(clone, 'main', `git@${profile.host}:team/repo.git`);
  expect(await readFile(path.join(clone, 'index.md'), 'utf8')).toBe('# AI-KIDO');
  await writeFile(file, JSON.stringify({ ...sshProfile, authorName: 'Rotated Author' }));
  await repository.git({ operation: 'fetch' });
  await expect(withGitProfile(root, async (context) => {
    context.validateUrl(`git@${profile.host}:team/repo.git`);
    await runProcess('git', [...context.args, 'ls-remote', `git@${profile.host}:team/repo.git`], root, [0], 120_000, undefined, context.env);
  })).resolves.toBeUndefined();
}, 30_000);
