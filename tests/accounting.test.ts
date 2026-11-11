import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args]);

it('accounts every Git file as indexed or outside with a reason, and honours .git/info/exclude', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-accounting-'));
  directories.push(root);
  git(root, 'init', '-q');
  await mkdir(path.join(root, 'vendor/lib'), { recursive: true });
  await mkdir(path.join(root, '.local-plans'), { recursive: true });
  await writeFile(path.join(root, 'app.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'vendor/lib/x.js'), 'module.exports = 1;\n');
  await writeFile(path.join(root, 'tracked.json'), '{}\n');
  await writeFile(path.join(root, '.local-plans/PLAN.md'), '# draft\n');
  await writeFile(path.join(root, '.env.example'), 'TOKEN=changeme\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=real-secret\n');
  git(root, 'add', 'app.ts', 'vendor/lib/x.js', 'tracked.json', '.env.example', '.env');
  git(root, 'commit', '-qm', 'init');
  await writeFile(path.join(root, '.gitignore'), 'tracked.json\n');
  await writeFile(path.join(root, '.git/info/exclude'), '.local-plans/\n');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  const entries = new Map(knowledge.list().map(entry => [entry.path, entry]));
  // .git/info/exclude is honoured like Git.
  expect(entries.has('.local-plans/PLAN.md')).toBe(false);
  // Every file Git keeps is indexed: vendor/ and env templates as metadata only, tracked-but-ignored with content.
  expect(entries.get('vendor/lib/x.js')?.metadata?.reason).toBe('excluded directory vendor/');
  expect(entries.get('.env.example')?.metadata?.contentStatus).toBe('metadata-only');
  expect(entries.get('tracked.json')?.metadata).toBeUndefined();
  expect((await knowledge.read('.env.example')).content).not.toContain('changeme');
  // Real secrets stay outside, counted with their reason.
  expect(entries.has('.env')).toBe(false);
  const [repository] = knowledge.accounting;
  expect(repository).toMatchObject({ path: '', extra: 0, metadataOnly: 3, outside: { sensitive: 1 } }); // vendor file, .env.example, .gitignore
  const outside = Object.values(repository.outside).reduce((sum, count) => sum + count, 0);
  expect(repository.indexedGitFiles! + outside).toBe(repository.gitFiles);
});

it('reports no Git view outside a Git repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-accounting-nogit-'));
  directories.push(root);
  await writeFile(path.join(root, 'a.md'), '# a\n');
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'rag' }));
  await knowledge.initialize();
  expect(knowledge.accounting[0]).toMatchObject({ files: 1, gitFiles: null });
});
