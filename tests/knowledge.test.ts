import { corpusConfig } from '../src/corpus-config.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';

const temporaryDirectories: string[] = [];

async function makeKnowledgeBase(): Promise<AikidoKnowledgeBase> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-test-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'prompts', 'hard_points', 'commands'), { recursive: true });
  await mkdir(path.join(root, 'prompts', 'gen', 'concepts'), { recursive: true });
  await mkdir(path.join(root, 'prompts', 'spec', 'sources'), { recursive: true });
  await writeFile(path.join(root, 'prompts', 'index.md'), '# AI-KIDO\nEntry point.');
  await writeFile(path.join(root, 'prompts', 'hard_points', 'commands', 'check-truth.md'), '# Check truth\nValidate truth tables.');
  await writeFile(path.join(root, 'prompts', 'gen', 'concepts', 'architecture.md'), '# Architecture\nSystem design and boundaries.');
  await writeFile(path.join(root, 'prompts', 'spec', 'sources', 'ignored.md'), 'Must not be indexed.');
  return new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('AikidoKnowledgeBase', () => {
  it('discovers text knowledge, classifies commands, and omits personal specs', async () => {
    const knowledge = await makeKnowledgeBase();
    await knowledge.initialize();

    expect(knowledge.list('command').map((entry) => entry.path)).toEqual(['prompts/hard_points/commands/check-truth.md']);
    expect(knowledge.list().some((entry) => entry.path.includes('prompts/spec/'))).toBe(false);
  });

  it('reads discovered documents and rejects paths outside the knowledge base', async () => {
    const knowledge = await makeKnowledgeBase();
    await knowledge.initialize();

    await expect(knowledge.read('prompts/hard_points/commands/check-truth.md')).resolves.toMatchObject({ content: expect.stringContaining('Validate truth tables') });
    await expect(knowledge.read('../../etc/passwd')).rejects.toThrow('not found');
  });

  it('searches content and enforces a bounded result count', async () => {
    const knowledge = await makeKnowledgeBase();
    await knowledge.initialize();

    await expect(knowledge.search('truth tables')).resolves.toMatchObject([
      { path: 'prompts/hard_points/commands/check-truth.md', kind: 'command' },
    ]);
    await expect(knowledge.search('truth', undefined, 101)).rejects.toThrow('between 1 and 100');
  });

  it('requires an AI-KIDO entry point', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kimono-invalid-'));
    temporaryDirectories.push(root);
    await expect(new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' })).initialize()).rejects.toThrow('No AI-KIDO entry point found');
  });
});
