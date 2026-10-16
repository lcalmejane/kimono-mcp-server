import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runProcess } from './process.js';

const execute = promisify(execFile);
export const AIKIDO_REPOSITORY = 'https://github.com/lcalmejane/aikido.git';

export function isOfficialRepository(url: string): boolean {
  const normalized = url.trim().replace(/^git@([^:]+):/, 'ssh://git@$1/');
  if (!/^[a-z]+:\/\//i.test(normalized)) return false;
  const parsed = new URL(normalized);
  const repository = decodeURIComponent(parsed.pathname).toLowerCase().replace(/\/$/, '').replace(/\.git$/, '');
  return ['github.com', 'ssh.github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())
    && repository === '/lcalmejane/aikido';
}

export function validateRepository(url: string): void {
  if (!/^(https:\/\/[^ ]+|ssh:\/\/[^ ]+|git@[^ :]+:[^ ]+|\/[^ ]+)$/.test(url) || /[\0\r\n]/.test(url)) {
    throw new Error('Repository must be an HTTPS/SSH Git URL or an absolute local repository path');
  }
}

export async function installAikido(targetPath: string, ref = 'main', repository = AIKIDO_REPOSITORY): Promise<void> {
  if (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new Error('Git ref must contain only letters, numbers, dots, underscores, slashes, or hyphens and may not start with a hyphen.');
  }
  validateRepository(repository);
  const target = path.resolve(targetPath);
  if (target === path.parse(target).root || target === homedir()) throw new Error(`Refusing to install at a filesystem or home root: ${target}`);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  let existingEmptyDirectory = false;
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Install target must be a new or empty directory: ${target}`);
    if ((await readdir(target)).length) throw new Error(`Install target is not empty; refusing to overwrite it: ${target}`);
    existingEmptyDirectory = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const temporary = await mkdtemp(path.join(parent, '.kimono-aikido-install-'));
  const checkout = path.join(temporary, 'checkout');
  try {
    // Keep full history: the project checkout also supports normal Git workflows.
    await execute('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--branch', ref, '--', repository, checkout],
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const entryPoints = await Promise.all(['prompts/index.md', 'index.md'].map(async (file) => {
      try { return (await lstat(path.join(checkout, file))).isFile(); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      }
    }));
    if (!entryPoints.some(Boolean)) throw new Error('Cloned repository has no AI-KIDO entry point');
    if (existingEmptyDirectory) await rmdir(target);
    await rename(checkout, target);
  } catch (error) {
    throw new Error(`Unable to install AI-KIDO from ${repository} at ref ${ref}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const GIT_OPTIONS = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat',
  '-c', 'diff.external=', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
  '-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never',
];

export class RepositoryAccess {
  constructor(readonly root: string, readonly writable = process.env.AIKIDO_WRITABLE === 'true') {}

  async status(): Promise<{ root: string; writable: boolean; official: boolean }> {
    const origin = await this.gitProcess(['config', '--get', 'remote.origin.url'], [0, 1]);
    let official = isOfficialRepository(origin.stdout);
    if (origin.stdout.trim()) {
      for (const push of [false, true]) {
        const effective = await this.gitProcess(['remote', 'get-url', '--all', ...(push ? ['--push'] : []), 'origin']);
        official ||= effective.stdout.trim().split('\n').some(isOfficialRepository);
      }
    }
    return { root: this.root, official, writable: this.writable && !official };
  }

  async requireWritable(): Promise<void> {
    const state = await this.status();
    if (state.official) throw new Error('The official AI-KIDO base is read-only. Use a separate project/fork repository.');
    if (!state.writable) throw new Error('Repository writes require AIKIDO_WRITABLE=true on a project/fork ROOT');
    const actual = (await this.gitProcess(['rev-parse', '--show-toplevel'])).stdout.trim();
    if (await realpath(actual) !== await realpath(this.root)) throw new Error('Git repository must be rooted exactly at AIKIDO_ROOT');
  }

  async git(input: GitInput) {
    const { operation } = input;
    const readOnly = ['status', 'log', 'diff', 'show', 'blame', 'ls-files', 'reflog', 'remote'];
    if (!readOnly.includes(operation)) await this.requireWritable();
    const args = this.arguments(input);
    return this.gitProcess(args);
  }

  private arguments(input: GitInput): string[] {
    const { operation, message, ref, remote = 'origin', name, url, paths = [], confirm = false } = input;
    for (const value of [ref, remote, name].filter((item) => item !== undefined)) {
      if (!value || value.startsWith('-') || /[\0\r\n]/.test(value)) throw new Error('Invalid Git reference/remote/name');
    }
    for (const file of paths) validateRelativePath(file);
    switch (operation) {
      case 'status': return ['status', '--short', '--branch'];
      case 'log': return ['log', '-30', '--format=medium', '--no-decorate'];
      case 'reflog': return ['reflog', '-30'];
      case 'ls-files': return ['ls-files', '--', ...paths];
      case 'diff': return ['diff', '--no-ext-diff', '--no-textconv', ...(ref ? [ref] : []), '--', ...paths];
      case 'show': return ['show', '--no-ext-diff', '--no-textconv', ref ?? 'HEAD', '--', ...paths];
      case 'blame':
        if (paths.length !== 1) throw new Error('blame requires exactly one path');
        return ['blame', '--', paths[0]];
      case 'add':
      case 'restore':
      case 'rm':
        if (!paths.length) throw new Error(`${operation} requires paths`);
        return [operation, '--', ...paths];
      case 'commit':
        if (!message?.trim()) throw new Error('commit requires a message');
        return ['commit', '--no-verify', '-m', message];
      case 'fetch':
      case 'pull':
      case 'push':
        if (operation === 'push' && !confirm) throw new Error('push requires confirm=true after client approval');
        return [operation, ...(operation === 'pull' ? ['--ff-only'] : []), remote, ...(ref ? [ref] : [])];
      case 'switch': return ['switch', required(ref, 'ref')];
      case 'checkout': return ['checkout', required(ref, 'ref'), '--', ...paths];
      case 'branch': return ['branch', required(name, 'name'), ...(ref ? [ref] : [])];
      case 'tag': return ['tag', required(name, 'name'), ...(ref ? [ref] : [])];
      case 'merge': return ['merge', '--no-edit', required(ref, 'ref')];
      case 'rebase': return ['rebase', required(ref, 'ref')];
      case 'rebase-abort': return ['rebase', '--abort'];
      case 'rebase-continue': return ['rebase', '--continue'];
      case 'cherry-pick': return ['cherry-pick', required(ref, 'ref')];
      case 'revert': return ['revert', '--no-edit', required(ref, 'ref')];
      case 'reset':
        if (!confirm) throw new Error('reset requires confirm=true after client approval');
        return ['reset', '--mixed', required(ref, 'ref')];
      case 'stash': return ['stash', 'push', '-m', message ?? 'Kimono MCP'];
      case 'stash-pop': return ['stash', 'pop'];
      case 'remote': return ['remote', '-v'];
      case 'remote-add':
        validateRepository(required(url, 'url'));
        if (isOfficialRepository(url!)) throw new Error('The official AI-KIDO remote cannot be added to a writable project');
        return ['remote', 'add', required(name, 'name'), url!];
      default: throw new Error(`Unsupported Git operation: ${operation}`);
    }
  }

  private async gitProcess(args: string[], allowedExitCodes = [0]) {
    // Only named remotes are accepted by network operations. Check every effective
    // fetch/push URL, including url.*.insteadOf expansion, before starting Git.
    let localRemote = false;
    if (['fetch', 'pull', 'push'].includes(args[0])) {
      const remote = args[args[0] === 'pull' ? 2 : 1];
      if (!/^[A-Za-z0-9_.-]+$/.test(remote)) throw new Error('Network operations require a configured remote name, not a URL');
      for (const push of [false, true]) {
        const result = await runProcess('git', [...GIT_OPTIONS, 'remote', 'get-url', '--all', ...(push ? ['--push'] : []), remote], this.root);
        for (const url of result.stdout.trim().split('\n')) {
          if (isOfficialRepository(url)) throw new Error('Network writes/fetches against the official AI-KIDO base are disabled');
          validateRepository(url);
          if (path.isAbsolute(url)) {
            const source = await runProcess('git', [...GIT_OPTIONS, 'config', '--get', 'remote.origin.url'], url, [0, 1]);
            if (isOfficialRepository(source.stdout)) throw new Error('The local remote is an official AI-KIDO base and is protected');
          }
          localRemote ||= path.isAbsolute(url);
        }
      }
    }
    return runProcess('git', [...GIT_OPTIONS, ...(localRemote ? ['-c', 'protocol.file.allow=always'] : []), ...args], this.root, allowedExitCodes);
  }
}

export interface GitInput {
  operation: string;
  message?: string;
  ref?: string;
  remote?: string;
  name?: string;
  url?: string;
  paths?: string[];
  confirm?: boolean;
}

export function validateRelativePath(file: string): void {
  if (!file || path.isAbsolute(file) || file.includes('\\') || file.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
    || /[\0\r\n]/.test(file) || file.startsWith(':')) throw new Error(`Path must stay inside AIKIDO_ROOT and outside .git: ${file}`);
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
