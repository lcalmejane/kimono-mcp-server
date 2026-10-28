import { corpusConfig } from '../src/corpus-config.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { parseGitStatus } from '../src/repository.js';
import { createAikidoMcpServer } from '../src/server.js';
import { RUNTIME_TOOLS } from '../src/runtime-tools.js';
import * as processes from '../src/process.js';

const temporaryDirectories: string[] = [];

async function makeKnowledgeBase(): Promise<AikidoKnowledgeBase> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-mcp-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'prompts', 'hard_points', 'commands'), { recursive: true });
  await writeFile(path.join(root, 'prompts', 'index.md'), '# AI-KIDO');
  await writeFile(path.join(root, 'prompts', 'hard_points', 'commands', 'check-truth.md'), '# Check truth\nCheck truth tables.');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await knowledge.initialize();
  return knowledge;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  const realRun = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
    if (!args[0].includes('fgr')) return realRun(...args);
    return args[1].includes('--format')
      ? { stdout: '{"files":[]}', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 };
  });
});

describe('AI-KIDO MCP surface', () => {
  it('exposes the dynamic knowledge base through tools, resources, and prompts', async () => {
    const server = createAikidoMcpServer(await makeKnowledgeBase());
    const client = new Client({ name: 'kimono-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      const serverInfo = { name: metadata.name, version: metadata.version };
      expect(client.getServerVersion()).toEqual(serverInfo);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['aikido', 'aikido_snapshot', 'aikido_embed', 'aikido_root', 'aikido_search', 'aikido_index', 'aikido_git', 'aikido_collaboration', 'aikido_file']);
      for (const name of ['aikido', 'aikido_search']) {
        expect(tools.tools.find(tool => tool.name === name)?.inputSchema.properties?.detail)
          .toMatchObject({ enum: ['compact', 'locations', 'excerpts'], default: 'compact' });
        expect(tools.tools.find(tool => tool.name === name)?.inputSchema.properties?.queries)
          .toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
      }
      const begun = await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'begin' } });
      const snapshotId = JSON.parse((begun.content as Array<{ text: string }>)[0].text).snapshotId;

      const listed = await client.callTool({ name: 'aikido', arguments: { operation: 'list', kind: 'command', snapshotId } });
      expect(JSON.stringify(listed)).toContain('prompts/hard_points/commands/check-truth.md');
      const activation = await client.callTool({ name: 'aikido', arguments: { operation: 'activate', id: 'prompts/hard_points/commands/check-truth.md', context: 'validate now', snapshotId } });
      expect(JSON.stringify(activation)).toContain('validate now');
      expect(JSON.stringify(activation)).toContain('does not execute model workflows');
      const execution = await client.callTool({ name: 'aikido', arguments: { operation: 'execute', id: 'prompts/hard_points/commands/check-truth.md', context: 'execute with client tools', snapshotId } });
      expect(JSON.stringify(execution)).toContain('execute with client tools');
      const search = await client.callTool({ name: 'aikido_search', arguments: { query: 'truth', kind: 'command', snapshotId } });
      expect(search.isError, JSON.stringify(search)).not.toBe(true);
      expect(search).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"results":') }] });
      const alias = await client.callTool({ name: 'aikido', arguments: { operation: 'search', query: 'truth', kind: 'command', detail: 'compact', snapshotId } });
      expect(alias.isError, JSON.stringify(alias)).not.toBe(true);
      expect(alias.content).toEqual(search.content);
      const batch = await client.callTool({ name: 'aikido_search', arguments: { queries: ['truth', 'absent'], snapshotId } });
      const aliasBatch = await client.callTool({ name: 'aikido', arguments: { operation: 'search', queries: ['truth', 'absent'], snapshotId } });
      expect(batch.isError).not.toBe(true);
      expect(aliasBatch.content).toEqual(batch.content);
      expect(JSON.parse((batch.content as Array<{ text: string }>)[0].text))
        .toEqual({ snapshotId, searches: [{ results: [] }, { results: [] }] });
      const malformedBatch = await client.callTool({ name: 'aikido_search', arguments: { queries: ['truth'], query: 'truth', snapshotId } });
      expect(malformedBatch.isError).toBe(true);
      const stats = await client.callTool({ name: 'aikido_index', arguments: { operation: 'status', mode: 'semantic' } });
      expect(stats.isError).not.toBe(true);
      const root = await client.callTool({ name: 'aikido_root', arguments: { operation: 'status' } });
      expect(root).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"initialized":true') }] });
      expect(root.isError).not.toBe(true);
      expect(JSON.parse((root.content as Array<{ text: string }>)[0].text).server).toEqual(serverInfo);
      const invalid = await client.callTool({ name: 'aikido_git', arguments: { operation: 'run', args: ['--version'] } });
      expect(invalid.isError).toBe(true);

      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(2);
      const commandResource = resources.resources.find((resource) => resource.name.endsWith('check-truth.md'));
      expect(commandResource).toBeDefined();
      const document = await client.readResource({ uri: commandResource!.uri });
      expect(JSON.stringify(document)).toContain('Check truth tables');

      const prompts = await client.listPrompts();
      const commandPrompt = prompts.prompts.find((prompt) => prompt.name.includes('check-truth.md'));
      expect(commandPrompt).toBeDefined();
      const prompt = await client.getPrompt({ name: commandPrompt!.name, arguments: { context: 'validate current docs' } });
      expect(JSON.stringify(prompt)).toContain('validate current docs');
      expect(JSON.stringify(prompt)).toContain('Check truth tables');
      await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId } });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reduces exposed retrieval definitions by at least 20% including the new batch API', () => {
    const bytes = (tools: typeof RUNTIME_TOOLS) => Buffer.byteLength(JSON.stringify(tools));
    const retrieval = RUNTIME_TOOLS.filter(tool => ['aikido_snapshot', 'aikido_search', 'aikido_file'].includes(tool.name));
    // Baseline measured from the pre-batch v0.6.0 catalog, including descriptions/annotations.
    expect(bytes(retrieval)).toBeLessThanOrEqual(Math.floor((918 + 2717 + 2199 + 4) * 0.8));
    expect(bytes(RUNTIME_TOOLS)).toBeLessThanOrEqual(Math.floor((12023 + 9) * 0.8));
  });

  it('publishes MCP-only immutable knowledge revisions and detects three-way conflicts', async () => {
    const knowledge = await makeKnowledgeBase();
    const server = createAikidoMcpServer(knowledge);
    const client = new Client({ name: 'collaboration-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (arguments_: Record<string, unknown>) => client.callTool({
      name: 'aikido_collaboration', arguments: arguments_,
    });
    const value = (result: Awaited<ReturnType<typeof call>>) => JSON.parse(
      (result.content as Array<{ text: string }>)[0].text,
    );

    try {
      const guidanceResult = await call({ operation: 'guidance' });
      const guidance = value(guidanceResult);
      expect(guidance.modes.sharedDirectory).toContain('aikido_index update');
      expect(guidance.modes.personalReplica).toContain('remote endpoint');

      const initial = value(await call({ operation: 'status' }));
      const file = 'prompts/index.md';
      const captured = value(await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'begin' } }));
      const firstContent = '# First remote edit';
      const firstHash = createHash('sha256').update(firstContent).digest('hex');
      const firstManifest = { ...initial.localManifest, [file]: firstHash };
      const published = value(await call({
        operation: 'publish',
        expectedSharedVersion: initial.sharedVersion,
        baseVersion: initial.sharedVersion,
        localManifest: firstManifest,
        changes: [{ path: file, content: firstContent }],
      }));
      expect(published).toMatchObject({ published: true, conflicts: [] });

      const pinned = value(await call({
        operation: 'read', sharedVersion: published.sharedVersion, paths: [file],
      }));
      expect(pinned.files[file]).toBe(firstContent);
      expect((await knowledge.read(file)).content).toBe(firstContent);
      const researchRead = await client.callTool({
        name: 'aikido_file',
        arguments: { operation: 'read', path: file, snapshotId: captured.snapshotId, full: true },
      });
      expect(JSON.stringify(researchRead)).toContain('# AI-KIDO');
      const refreshedSnapshot = value(await client.callTool({
        name: 'aikido_snapshot', arguments: { operation: 'begin' },
      }));
      expect(refreshedSnapshot.version).not.toBe(captured.version);
      const refreshedRead = await client.callTool({
        name: 'aikido_file',
        arguments: { operation: 'read', path: file, snapshotId: refreshedSnapshot.snapshotId, full: true },
      });
      expect(JSON.stringify(refreshedRead)).toContain(firstContent);
      const refreshedSearch = await client.callTool({
        name: 'aikido_search', arguments: { query: 'First remote edit', snapshotId: refreshedSnapshot.snapshotId },
      });
      expect(refreshedSearch.isError).not.toBe(true);
      await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId: refreshedSnapshot.snapshotId } });

      const competingContent = '# Competing remote edit';
      const competingHash = createHash('sha256').update(competingContent).digest('hex');
      const competingManifest = { ...initial.localManifest, [file]: competingHash };
      const comparison = value(await call({
        operation: 'compare', baseVersion: initial.sharedVersion, localManifest: competingManifest,
      }));
      expect(comparison.conflicts).toMatchObject([{
        path: file, baseHash: initial.localManifest[file], localHash: competingHash, sharedHash: firstHash,
      }]);

      const unresolved = value(await call({
        operation: 'publish',
        expectedSharedVersion: published.sharedVersion,
        baseVersion: initial.sharedVersion,
        localManifest: competingManifest,
        changes: [{ path: file, content: competingContent }],
      }));
      expect(unresolved).toMatchObject({ published: false, conflicts: [{ path: file }] });

      const resolved = value(await call({
        operation: 'publish',
        expectedSharedVersion: published.sharedVersion,
        baseVersion: initial.sharedVersion,
        localManifest: competingManifest,
        changes: [{ path: file, content: competingContent }],
        resolutions: { [file]: 'shared' },
      }));
      expect(resolved).toMatchObject({ published: true, sharedVersion: published.sharedVersion });

      const stale = await call({
        operation: 'publish',
        expectedSharedVersion: initial.sharedVersion,
        baseVersion: initial.sharedVersion,
        localManifest: firstManifest,
        changes: [{ path: file, content: firstContent }],
      });
      expect(stale.isError).toBe(true);

      const deletionManifest = { ...initial.localManifest };
      delete deletionManifest['prompts/hard_points/commands/check-truth.md'];
      const deletion = value(await call({
        operation: 'compare', baseVersion: initial.sharedVersion, localManifest: deletionManifest,
      }));
      expect(deletion.localChanges).toMatchObject([{ path: 'prompts/hard_points/commands/check-truth.md', kind: 'deletion' }]);
      expect(deletion.deletions).toEqual([]);

      const pinnedBase = value(await call({ operation: 'status', sharedVersion: initial.sharedVersion }));
      expect(pinnedBase.requestedRevision).toMatchObject({
        version: initial.sharedVersion, manifest: initial.sharedManifest,
      });
      expect(pinnedBase.sharedVersion).toBe(resolved.sharedVersion);

      await writeFile(path.join(knowledge.root, file), '# Direct shared ROOT edit');
      const staleAfterRootEdit = await call({
        operation: 'publish',
        expectedSharedVersion: resolved.sharedVersion,
        baseVersion: initial.sharedVersion,
        localManifest: firstManifest,
        changes: [{ path: file, content: firstContent }],
      });
      expect(staleAfterRootEdit.isError).toBe(true);
      const rootRefreshed = value(await call({ operation: 'status' }));
      expect(rootRefreshed.sharedVersion).not.toBe(resolved.sharedVersion);
      expect(rootRefreshed.sharedManifest[file]).toBe(createHash('sha256').update('# Direct shared ROOT edit').digest('hex'));
      expect(rootRefreshed.rootConflicts).toEqual([]);

      const invalid = await call({ operation: 'compare', localManifest: { '../secrets.md': firstHash } });
      expect(invalid.isError).toBe(true);
      await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId: captured.snapshotId } });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('Git status parsing', () => {
  it('preserves NUL-delimited names, states, and rename source paths', () => {
    expect(parseGitStatus(' M prompts/a name.md\0?? new.md\0R  renamed.md\0old name.md\0D  gone.md\0'))
      .toEqual([
        { path: 'gone.md', status: 'D ' },
        { path: 'new.md', status: '??' },
        { path: 'prompts/a name.md', status: ' M' },
        { path: 'renamed.md', status: 'R ', oldPath: 'old name.md' },
      ]);
  });
});
