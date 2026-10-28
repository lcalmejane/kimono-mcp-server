import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { startHttpServer } from '../src/server.js';

it('separates public liveness from authenticated readiness/status and rechecks missing ROOT', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-readiness-'));
  const knowledge = new AikidoKnowledgeBase(path.join(parent, 'root'), false, corpusConfig({ mode: 'aikido' }));
  const instance = await startHttpServer(knowledge, { host: '127.0.0.1', port: 0, authToken: 'test-secret' });
  const url = `http://127.0.0.1:${instance.port}`;
  const headers = { authorization: 'Bearer test-secret' };
  try {
    const live = await fetch(`${url}/healthz`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect((await fetch(`${url}/statusz`)).status).toBe(401);
    expect((await fetch(`${url}/readyz`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${url}/readyz`, { headers })).status).toBe(503);
    await mkdir(knowledge.root);
    await writeFile(path.join(knowledge.root, 'index.md'), '# AI-KIDO');
    await knowledge.initialize();
    const ready = await fetch(`${url}/readyz`, { headers });
    expect(ready.status).toBe(200);
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const serverInfo = { name: metadata.name, version: metadata.version };
    expect(await ready.json()).toMatchObject({ ready: true, stopping: false, mode: 'aikido',
      server: serverInfo,
      root: { initialized: true, available: true }, semantic: { phase: 'unknown' } });
    expect(await (await fetch(`${url}/statusz`, { headers })).json()).toMatchObject({ server: serverInfo });
    expect((await fetch(`${url}/statusz`, { headers, method: 'POST' })).status).toBe(405);
    await rm(path.join(knowledge.root, 'index.md'));
    expect((await fetch(`${url}/readyz`, { headers })).status).toBe(503);
    expect((await fetch(`${url}/statusz`, { headers })).status).toBe(200);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  } finally {
    await instance.close();
    await knowledge.semanticIndex.idle();
    await rm(knowledge.searchIndex.directory, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

it('standard RAG mode is ready on any readable ROOT without an AI-KIDO entry point', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-rag-ready-'));
  await writeFile(path.join(parent, 'main.ts'), 'export const value = 1;\n');
  await writeFile(path.join(parent, 'prompts'), 'Not an AI-KIDO directory');
  const knowledge = new AikidoKnowledgeBase(parent, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  const instance = await startHttpServer(knowledge, { host: '127.0.0.1', port: 0, authToken: 'rag-secret' });
  try {
    const ready = await fetch(`http://127.0.0.1:${instance.port}/readyz`, { headers: { authorization: 'Bearer rag-secret' } });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ready: true, mode: 'rag', root: { available: true } });
  } finally {
    await instance.close();
    await knowledge.semanticIndex.idle();
    await rm(knowledge.searchIndex.directory, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

it('keeps accepted HTTP tool work while draining, exposes not-ready and refuses new sessions', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-drain-'));
  await writeFile(path.join(parent, 'index.md'), '# AI-KIDO');
  const knowledge = new AikidoKnowledgeBase(parent, false, corpusConfig({ mode: 'aikido' }));
  const instance = await startHttpServer(knowledge, { host: '127.0.0.1', port: 0, authToken: 'drain-secret' });
  const base = `http://127.0.0.1:${instance.port}`;
  const headers = { authorization: 'Bearer drain-secret' };
  const client = new Client({ name: 'drain-test', version: '1.0.0' });
  let finish!: () => void;
  const entered = vi.fn();
  vi.spyOn(knowledge.semanticIndex, 'run').mockImplementation(async () => {
    entered();
    await new Promise<void>((resolve) => { finish = resolve; });
    return { engine: 'embsearch-core', model: 'test-model', version: '0.3.4',
      chunks: 0, embedded: 0, count: 0, results: [] };
  });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const result = client.callTool({ name: 'aikido_index', arguments: { operation: 'update', mode: 'semantic' } });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const closing = instance.close();
    expect((await fetch(`${base}/readyz`, { headers })).status).toBe(503);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { headers, method: 'POST', body: '{}' })).status).toBe(503);
    finish();
    expect((await result).isError).not.toBe(true);
    await closing;
  } finally {
    finish?.();
    await client.close();
    await instance.close();
    await knowledge.semanticIndex.idle();
    await rm(knowledge.searchIndex.directory, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
