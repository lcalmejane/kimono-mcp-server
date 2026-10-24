import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { currentGitProfileContext } from '../src/git-profile.js';
import { runtimeFor } from '../src/runtime-tools.js';
import { startHttpServer } from '../src/server.js';

it.each([false, true])('isolates authenticated HTTP credential contexts (trusted proxy: %s)', async trusted => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-http-profile-'));
  const root = path.join(parent, 'knowledge');
  await mkdir(root);
  await writeFile(path.join(root, 'index.md'), '# Shared knowledge');
  const knowledge = new AikidoKnowledgeBase(root);
  await knowledge.initialize();
  const observed: Array<{ name: string; secret: string | null | undefined }> = [];
  const spy = vi.spyOn(runtimeFor(knowledge), 'call').mockImplementation(async (_name, input, context) => {
    await new Promise(resolve => setTimeout(resolve, input.connectionId === 'alice' ? 15 : 1));
    expect(currentGitProfileContext()).toEqual(context?.gitProfile);
    observed.push({ name: String(input.connectionId), secret: context?.gitProfile?.secret });
    return '{"operation":"sync"}';
  });
  const instance = await startHttpServer(knowledge, {
    host: '127.0.0.1', port: 0, authToken: 'http-profile-test',
    trustedGitProfileHeader: trusted, allowLocalGitProfile: false,
  });
  const url = new URL(`http://127.0.0.1:${instance.port}/mcp`);
  const clients: Client[] = [];
  const profile = (name: string) => Buffer.from(JSON.stringify({
    host: 'git.example.invalid', transport: 'https', username: name, secret: `${name}-test-token`,
  })).toString('base64');
  try {
    const transports = await Promise.all(['alice', 'bob', 'public'].map(async name => {
      const client = new Client({ name, version: '1.0.0' });
      clients.push(client);
      const headers: Record<string, string> = { authorization: 'Bearer http-profile-test' };
      if (name !== 'public') headers['x-kimono-git-profile'] = profile(name);
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      await client.connect(transport);
      return transport;
    }));
    await Promise.all(clients.map((client, index) => client.callTool({
      name: 'aikido_git', arguments: { operation: 'sync', connectionId: ['alice', 'bob', 'public'][index] },
    })));
    expect(observed).toEqual(expect.arrayContaining([
      { name: 'alice', secret: trusted ? 'alice-test-token' : undefined },
      { name: 'bob', secret: trusted ? 'bob-test-token' : undefined },
      { name: 'public', secret: undefined },
    ]));
    expect(observed).toHaveLength(3);
    const headers = {
      authorization: 'Bearer http-profile-test',
      'mcp-session-id': transports[0].sessionId!,
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    };
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'tools/call',
      params: { name: 'aikido_git', arguments: { operation: 'sync', connectionId: 'next-public' } },
    });
    const noProfile = await fetch(url, { method: 'POST', headers, body });
    expect(noProfile.status).toBe(200);
    await noProfile.text();
    expect(observed.at(-1)).toEqual({ name: 'next-public', secret: undefined });
    if (trusted) {
      const invalid = await fetch(url, {
        method: 'POST', headers: { ...headers, 'x-kimono-git-profile': 'invalid-json' }, body,
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toBe('Invalid trusted Git profile');
      expect(observed).toHaveLength(4);
    }
    const unauthorized = await fetch(url, {
      method: 'POST', headers: { ...headers, authorization: 'Bearer wrong', 'x-kimono-git-profile': profile('alice') }, body,
    });
    expect(unauthorized.status).toBe(401);
    expect(observed).toHaveLength(4);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await instance.close();
    spy.mockRestore();
    await rm(knowledge.searchIndex.directory, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
