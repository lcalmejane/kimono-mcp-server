import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { createAikidoMcpServer } from '../src/server.js';

const temporaryDirectories: string[] = [];

async function makeKnowledgeBase(): Promise<AikidoKnowledgeBase> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-mcp-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'prompts', 'hard_points', 'commands'), { recursive: true });
  await writeFile(path.join(root, 'prompts', 'index.md'), '# AI-KIDO');
  await writeFile(path.join(root, 'prompts', 'hard_points', 'commands', 'check-truth.md'), '# Check truth\nCheck truth tables.');
  const knowledge = new AikidoKnowledgeBase(root);
  await knowledge.initialize();
  return knowledge;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('AI-KIDO MCP surface', () => {
  it('exposes the dynamic knowledge base through tools, resources, and prompts', async () => {
    const server = createAikidoMcpServer(await makeKnowledgeBase());
    const client = new Client({ name: 'kimono-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['aikido', 'aikido_embed', 'aikido_root', 'aikido_search', 'aikido_index', 'aikido_git', 'aikido_file']);

      const listed = await client.callTool({ name: 'aikido', arguments: { operation: 'list', kind: 'command' } });
      expect(JSON.stringify(listed)).toContain('prompts/hard_points/commands/check-truth.md');
      const activation = await client.callTool({ name: 'aikido', arguments: { operation: 'activate', id: 'prompts/hard_points/commands/check-truth.md', context: 'validate now' } });
      expect(JSON.stringify(activation)).toContain('validate now');
      expect(JSON.stringify(activation)).toContain('does not execute model workflows');
      const execution = await client.callTool({ name: 'aikido', arguments: { operation: 'execute', id: 'prompts/hard_points/commands/check-truth.md', context: 'execute with client tools' } });
      expect(JSON.stringify(execution)).toContain('execute with client tools');
      const search = await client.callTool({ name: 'aikido_search', arguments: { query: 'truth', kind: 'command' } });
      expect(search.isError).not.toBe(true);
      expect(search).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"engine":"fast-grep"') }] });
      const stats = await client.callTool({ name: 'aikido_index', arguments: { operation: 'stats' } });
      expect(stats.isError).not.toBe(true);
      const root = await client.callTool({ name: 'aikido_root', arguments: { operation: 'status' } });
      expect(root).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('"initialized":true') }] });
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
    } finally {
      await client.close();
      await server.close();
    }
  });
});
