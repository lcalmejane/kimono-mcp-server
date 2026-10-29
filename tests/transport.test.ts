import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('serves snapshot-pinned knowledge over stdio and rejects legacy mutations', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-stdio-'));
  const root = path.join(parent, 'project');
  await mkdir(path.join(root, 'prompts'), { recursive: true });
  await writeFile(path.join(root, 'prompts/index.md'), '# AI-KIDO\nStandard entry');
  const client = new Client({ name: 'stdio-integration', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', AIKIDO_ROOT: root, KIMONO_CORPUS_MODE: 'aikido',
      AIKIDO_WRITABLE: 'true', KIMONO_CACHE_DIR: path.join(parent, 'cache'),
      FGR_BIN: process.env.FGR_BIN ?? 'fgr',
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
      'aikido', 'aikido_models', 'aikido_snapshot', 'aikido_embed', 'aikido_root', 'aikido_search',
      'aikido_index', 'aikido_git', 'aikido_collaboration', 'aikido_file',
    ]);
    const begun = await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'begin' } });
    expect(begun.isError).not.toBe(true);
    const snapshotId = JSON.parse((begun.content as Array<{ text: string }>)[0].text).snapshotId;
    await writeFile(path.join(root, 'prompts/index.md'), '# New knowledge');
    const pinned = await client.callTool({
      name: 'aikido_file', arguments: { operation: 'read', path: 'prompts/index.md', snapshotId },
    });
    expect(pinned.isError).not.toBe(true);
    expect(JSON.stringify(pinned)).toContain('Standard entry');
    for (const operation of ['add', 'commit', 'push', 'merge', 'branch', 'checkout', 'pull', 'fetch']) {
      const denied = await client.callTool({ name: 'aikido_git', arguments: { operation, confirm: true } });
      expect(denied.isError).toBe(true);
    }
    const deniedWrite = await client.callTool({
      name: 'aikido_file', arguments: { operation: 'write', path: 'prompts/index.md', content: 'forbidden', snapshotId },
    });
    expect(deniedWrite.isError).toBe(true);
    expect(await readFile(path.join(root, 'prompts/index.md'), 'utf8')).toBe('# New knowledge');
    await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId } });
  } finally {
    await client.close();
    await transport.close();
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);
