import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const run = promisify(execFile);
const script = (name: string) => path.resolve('scripts', name);
let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'erb-test-'));
  await mkdir(path.join(directory, 'docs/github'), { recursive: true });
  await mkdir(path.join(directory, 'docs/confluence'), { recursive: true });
  await writeFile(path.join(directory, 'docs/github/dsid_aa11__pr-limits.txt'), 'upload limits');
  await writeFile(path.join(directory, 'docs/confluence/dsid_bb22__failover.txt'), 'failover game day');
  const question = (id: string, type: string, sources: string[], expected: string[]) =>
    JSON.stringify({ question_id: id, question_type: type, question: `question ${id}`, source_types: sources, expected_doc_ids: expected });
  await writeFile(path.join(directory, 'questions.jsonl'), [
    question('q1', 'basic', ['github'], ['dsid_aa11']),
    question('q2', 'semantic', ['confluence'], ['dsid_bb22']),
    question('q3', 'high_level', ['github'], []),
    question('q4', 'basic', ['slack'], ['dsid_aa11']),
    question('q5', 'basic', ['github'], ['dsid_missing']),
  ].join('\n'));
});

afterAll(() => rm(directory, { recursive: true, force: true }));

it('converts questions into cases and skips those the corpus cannot answer', async () => {
  const out = path.join(directory, 'cases.json');
  const { stdout } = await run('node', [script('enterprise-rag-cases.mjs'), '--questions', path.join(directory, 'questions.jsonl'),
    '--corpus', path.join(directory, 'docs'), '--out', out]);
  expect(JSON.parse(stdout)).toMatchObject({ written: 2, skippedNoTruth: 1, skippedSource: 1, skippedMissing: 1 });
  const cases = JSON.parse(await readFile(out, 'utf8'));
  expect(cases).toEqual([
    { id: 'q1', category: 'basic', query: 'question q1', expected: ['github/dsid_aa11__pr-limits.txt'] },
    { id: 'q2', category: 'semantic', query: 'question q2', expected: ['confluence/dsid_bb22__failover.txt'] },
  ]);
});

it('honours --limit and --types without consuming the flag twice', async () => {
  const out = path.join(directory, 'limited.json');
  await run('node', [script('enterprise-rag-cases.mjs'), '--questions', path.join(directory, 'questions.jsonl'),
    '--corpus', path.join(directory, 'docs'), '--out', out, '--limit', '1', '--types', 'basic,semantic']);
  expect(JSON.parse(await readFile(out, 'utf8'))).toHaveLength(1);
});

it('reports hit rates per category by joining rows to cases on the query text', async () => {
  const cases = [
    { id: 'q1', category: 'basic', query: 'question q1', expected: ['a'] },
    { id: 'q2', category: 'basic', query: 'question q2', expected: ['b'] },
    { id: 'q3', category: 'semantic', query: 'question q3', expected: ['c'] },
  ];
  const rows = [
    { query: 'question q1', ok: true, firstRelevantRank: 1 },
    { query: 'question q2', ok: true, firstRelevantRank: null },
    { query: 'question q3', ok: false, firstRelevantRank: null },
  ];
  await writeFile(path.join(directory, 'report-cases.json'), JSON.stringify(cases));
  await writeFile(path.join(directory, 'report-results.json'), JSON.stringify({ limit: 10, results: [
    { policy: 'p', modes: { semantic: { rows } } }] }));
  const { stdout } = await run('node', [script('enterprise-rag-report.mjs'), '--results', path.join(directory, 'report-results.json'),
    '--cases', path.join(directory, 'report-cases.json')]);
  expect(stdout).toContain('| basic | 2 | 50 % | 50 % | 0.500 |');
  // A failed row counts as a miss for the hit rate but is left out of the MRR average.
  expect(stdout).toContain('| semantic | 1 | 0 % | 0 % | n/a |');
  expect(stdout).toContain('| TOTAL | 3 | 33 % | 33 % | 0.500 |');
});
