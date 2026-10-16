import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

it('initializes an absent ROOT and edits/commits/pushes a project over real stdio MCP', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-stdio-'));
  const source = path.join(parent, 'template');
  const remote = path.join(parent, 'remote.git');
  await mkdir(path.join(source, 'prompts'), { recursive: true });
  await writeFile(path.join(source, 'prompts/index.md'), '# AI-KIDO\nStandard entry');
  const git = (...args: string[]) => exec('git', args, { cwd: source });
  await git('init', '-b', 'main');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.');
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'template');
  await git('clone', '--bare', source, remote);
  const client = new Client({ name: 'stdio-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      AIKIDO_ROOT: path.join(parent, 'project'),
      AIKIDO_WRITABLE: 'true',
      KIMONO_CACHE_DIR: path.join(parent, 'cache'),
      FGR_BIN: process.env.FGR_BIN ?? 'fgr',
      GIT_AUTHOR_NAME: 'MCP Client', GIT_AUTHOR_EMAIL: 'client@example.invalid',
      GIT_COMMITTER_NAME: 'MCP Client', GIT_COMMITTER_EMAIL: 'client@example.invalid',
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    expect((await client.listResources()).resources).toEqual([]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return response;
    };
    await call('aikido_root', { operation: 'init', repository: remote });
    await call('aikido_file', { operation: 'write', path: 'prompts/client.md', content: '# Stdio MCP live index' });
    const search = await call('aikido_search', { query: 'Stdio MCP' });
    expect(JSON.stringify(search)).toContain('prompts/client.md');
    await call('aikido_git', { operation: 'add', paths: ['prompts/client.md'] });
    await call('aikido_git', { operation: 'commit', message: 'docs: update through MCP' });
    await call('aikido_git', { operation: 'push', ref: 'main', confirm: true });
    const result = await exec('git', ['log', '-1', '--format=%s'], { cwd: remote });
    expect(result.stdout.trim()).toBe('docs: update through MCP');
  } finally {
    await client.close();
    await transport.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);
