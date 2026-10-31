import { corpusConfig } from '../src/corpus-config.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { createAikidoMcpServer } from '../src/server.js';
import * as processes from '../src/process.js';

const directories: string[] = [];
const header = '> **Version**: 1.0 | **Date**: 2026-10-31 | **Statut**: Active\n';
const dir = 'prompts/gen/concepts';

beforeEach(() => {
  const realRun = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
    if (!args[0].includes('fgr')) return realRun(...args);
    return args[1].includes('--format')
      ? { stdout: '{"files":[]}', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function connect() {
  const base = await mkdtemp(path.resolve('.delta-e2e-'));
  directories.push(base);
  const root = path.join(base, 'kimono-root');
  const workspaceA = path.join(base, 'alice-workspace');
  const workspaceB = path.join(base, 'bob-workspace');
  await mkdir(path.join(root, dir), { recursive: true });
  await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
  await writeFile(path.join(root, 'prompts/index.md'), '# Index\n');
  await writeFile(path.join(root, `${dir}/shared.md`), `${header}# Shared v1\n`);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(base, 'cache'));
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  const server = createAikidoMcpServer(knowledge);
  const client = new Client({ name: 'delta-e2e', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  return { root, workspaceA, workspaceB, call, close: async () => { await client.close(); await server.close(); } };
}

describe('user delta synchronization through the MCP surface', () => {
  it('advertises the new operations and accepts them through schema validation', async () => {
    const { call, root, workspaceA, close } = await connect();
    try {
      const guidance = await call('aikido_collaboration', { operation: 'guidance' });
      expect(guidance.isError, guidance.text).toBe(false);
      expect(guidance.text).toContain('stage');
      expect((await call('aikido_collaboration', { operation: 'mode', clientRoot: root })).json())
        .toMatchObject({ mode: 'same-root', verified: true });
      expect((await call('aikido_collaboration', { operation: 'mode', clientRoot: workspaceA })).json())
        .toMatchObject({ mode: 'replica', verified: true });
      const invalid = await call('aikido_collaboration', { operation: 'sync', bogus: true });
      expect(invalid.isError).toBe(true);
    } finally { await close(); }
  });

  it('lets two replica users stage, see their own overlay in a snapshot, sync in parallel and reconcile', async () => {
    const { call, root, workspaceA, workspaceB, close } = await connect();
    try {
      const alice = (input: Record<string, unknown>) => call('aikido_collaboration', { owner: 'alice', clientRoot: workspaceA, ...input });
      const bob = (input: Record<string, unknown>) => call('aikido_collaboration', { owner: 'bob', clientRoot: workspaceB, ...input });

      const staged = await alice({ operation: 'stage', changes: [
        { path: `${dir}/alice-note.md`, content: `${header}# Alice note\n` },
        { path: `${dir}/shared.md`, content: `${header}# Shared v2 by alice\n` },
      ] });
      expect(staged.isError, staged.text).toBe(false);
      expect(staged.json().items).toHaveLength(2);

      const mine = (await call('aikido_snapshot', { operation: 'begin', owner: 'alice' })).json();
      const theirs = (await call('aikido_snapshot', { operation: 'begin', owner: 'bob' })).json();
      try {
        expect(mine.provenance.overlay).toEqual({ owner: 'alice', files: 2 });
        expect(theirs.provenance.overlay).toBeUndefined();
        const aliceRead = (await call('aikido_file', { operation: 'read', path: `${dir}/shared.md`, full: true, snapshotId: mine.snapshotId })).json();
        expect(aliceRead.content).toContain('Shared v2 by alice');
        const bobRead = (await call('aikido_file', { operation: 'read', path: `${dir}/shared.md`, full: true, snapshotId: theirs.snapshotId })).json();
        expect(bobRead.content).toContain('Shared v1');
      } finally {
        await call('aikido_snapshot', { operation: 'end', snapshotId: mine.snapshotId });
        await call('aikido_snapshot', { operation: 'end', snapshotId: theirs.snapshotId });
      }

      // Bob edits the same shared file (while it is still v1) and a new one. Staging at edit time records the revision
      // each change started from; that is what makes the concurrent sync below detectable as a conflict.
      expect((await bob({ operation: 'stage', changes: [
        { path: `${dir}/bob-note.md`, content: `${header}# Bob note\n` },
        { path: `${dir}/shared.md`, content: `${header}# Shared v2 by bob\n` },
      ] })).isError).toBe(false);
      const [aliceSync, bobSync] = await Promise.all([alice({ operation: 'sync' }), bob({ operation: 'sync' })]);
      expect(aliceSync.isError, aliceSync.text).toBe(false);
      expect(bobSync.isError, bobSync.text).toBe(false);
      const a = aliceSync.json();
      const b = bobSync.json();

      // The two edits of shared.md cannot both win: exactly one publishes, the other gets an explicit conflict.
      const winners = [a, b].filter(result => result.published.includes(`${dir}/shared.md`));
      const losers = [a, b].filter(result => result.conflicts.some((item: { path: string }) => item.path === `${dir}/shared.md`));
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(a.published).toContain(`${dir}/alice-note.md`);
      expect(b.published).toContain(`${dir}/bob-note.md`);
      expect(await readFile(path.join(root, `${dir}/alice-note.md`), 'utf8')).toContain('Alice note');
      expect(await readFile(path.join(root, `${dir}/bob-note.md`), 'utf8')).toContain('Bob note');

      // The loser keeps the conflict in the overlay until an explicit choice is made.
      const loserCall = losers[0] === a ? alice : bob;
      const remaining = (await loserCall({ operation: 'overlay' })).json().items;
      expect(remaining).toEqual([expect.objectContaining({ path: `${dir}/shared.md`, status: 'conflict' })]);
      const resolved = (await loserCall({ operation: 'sync', resolutions: { [`${dir}/shared.md`]: 'shared' } })).json();
      expect(resolved).toMatchObject({ discarded: [`${dir}/shared.md`], conflicts: [], remaining: [] });
      expect((await loserCall({ operation: 'overlay' })).json().items).toEqual([]);
    } finally { await close(); }
  });

  it('is a no-op for a client that edits the ROOT itself (same-root)', async () => {
    const { call, root, close } = await connect();
    try {
      const before = await readFile(path.join(root, `${dir}/shared.md`), 'utf8');
      const result = await call('aikido_collaboration', { operation: 'sync', owner: 'alice', clientRoot: root,
        changes: [{ path: `${dir}/ghost.md`, content: `${header}# Ghost\n` }] });
      expect(result.isError, result.text).toBe(false);
      expect(result.json()).toMatchObject({ mode: 'same-root', skipped: true });
      await expect(readFile(path.join(root, `${dir}/ghost.md`))).rejects.toThrow();
      expect(await readFile(path.join(root, `${dir}/shared.md`), 'utf8')).toBe(before);
    } finally { await close(); }
  });
});
