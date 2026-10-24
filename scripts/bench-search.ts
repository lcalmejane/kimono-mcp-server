// Reproducible lexical search benchmark:
//   tsx scripts/bench-search.ts <AIKIDO_ROOT> [cases.json] [--runs N] [--mutable] [--json]
// Default: immutable corpus, as searched inside an aikido_snapshot session. --mutable measures direct ROOT search.
// Compares fast-grep literal phrase search, the planned text mode and an AI-KIDO search-plan style ripgrep baseline.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { plannedSearch } from '../src/planned-search.js';
import { terms } from '../src/query-plan.js';

type Case = { query: string; expected: string[] };
type Ranked = { documents: string[]; ms: number };

const exec = promisify(execFile);
const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; };
const option = (name: string) => args.includes(name) && Boolean(args.splice(args.indexOf(name), 1));
const json = option('--json');
const mutable = option('--mutable');
const runs = Number(flag('--runs') ?? 5);
const limit = 10;
const [root, casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench-cases.aikido.json')] = args;
if (!root || !Number.isInteger(runs) || runs < 1) {
  console.error('Usage: tsx scripts/bench-search.ts <AIKIDO_ROOT> [cases.json] [--runs N] [--mutable] [--json]');
  process.exit(2);
}
const cases: Case[] = JSON.parse(await readFile(casesFile, 'utf8'));
const unique = (paths: string[]) => [...new Set(paths)].slice(0, limit);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function time(task: () => Promise<string[]>): Promise<Ranked> {
  const samples: number[] = [];
  let documents: string[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    documents = await task();
    samples.push(performance.now() - started);
  }
  return { documents, ms: median(samples) };
}

// Mirrors the search plans: one ripgrep pass per query, whole words, case-insensitive, ranked by matched terms then hits.
async function ripgrep(query: string): Promise<string[]> {
  const words = terms(query);
  if (!words.length) return [];
  const { stdout } = await exec('rg', ['--json', '-i', '-w', '--glob', '*.{md,mdx,mdc,txt}', '-e', words.join('|'), '.'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 }).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? '' }));
  const score = new Map<string, { terms: Set<string>; hits: number }>();
  for (const line of stdout.split('\n')) {
    if (!line.includes('"type":"match"')) continue;
    const event = JSON.parse(line);
    const file = String(event.data.path.text).replace(/^\.\//, '');
    const entry = score.get(file) ?? { terms: new Set<string>(), hits: 0 };
    for (const match of event.data.submatches) entry.terms.add(String(match.match.text).toLowerCase());
    entry.hits++;
    score.set(file, entry);
  }
  return [...score].sort(([a, x], [b, y]) => y.terms.size - x.terms.size || y.hits - x.hits || a.localeCompare(b))
    .map(([file]) => file).slice(0, limit);
}

const started = performance.now();
process.env.KIMONO_CACHE_DIR ??= await mkdtemp(path.join(tmpdir(), 'kimono-bench-cache-'));
const knowledge = new AikidoKnowledgeBase(root, !mutable);
await knowledge.initialize();
const initializeMs = performance.now() - started;
const coldStarted = performance.now();
await plannedSearch(knowledge, await knowledge.vocabulary.plan(cases[0].query), 'text', undefined, () => true, limit);
const firstSearchMs = performance.now() - coldStarted;
const hasRipgrep = await exec('rg', ['--version']).then(() => true, () => false);

const engines: Record<string, (query: string) => Promise<string[]>> = {
  literal: async query => unique((await knowledge.search(query, undefined, 50)).map(hit => hit.path)),
  text: async query => unique((await plannedSearch(knowledge, await knowledge.vocabulary.plan(query), 'text',
    undefined, () => true, limit)).results.map(hit => hit.path)),
  ...(hasRipgrep ? { ripgrep } : {}),
};

const rows = [];
for (const item of cases) {
  const row: Record<string, unknown> = { query: item.query, expected: item.expected };
  for (const [name, engine] of Object.entries(engines)) {
    const { documents, ms } = await time(() => engine(item.query));
    const ranks = item.expected.map(target => documents.indexOf(target) + 1).filter(rank => rank > 0);
    row[name] = { ms: Number(ms.toFixed(1)), count: documents.length, rank: ranks.length ? Math.min(...ranks) : null,
      recall: item.expected.length ? ranks.length / item.expected.length : null, top: documents.slice(0, 3) };
  }
  rows.push(row);
}

const summary = Object.fromEntries(Object.keys(engines).map(name => {
  const scored = rows.filter(row => (row.expected as string[]).length).map(row => row[name] as { rank: number | null; recall: number; ms: number });
  const all = rows.map(row => (row[name] as { ms: number }).ms);
  return [name, {
    hitAt1: scored.filter(item => item.rank === 1).length, hitAt10: scored.filter(item => item.rank !== null).length,
    scored: scored.length, mrr: Number((scored.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / scored.length).toFixed(3)),
    medianMs: Number(median(all).toFixed(1)), maxMs: Number(Math.max(...all).toFixed(1)),
  }];
}));
const report = { root, corpus: mutable ? 'mutable ROOT' : 'immutable snapshot corpus', documents: knowledge.list().length, runs, initializeMs: Number(initializeMs.toFixed(1)),
  firstSearchMs: Number(firstSearchMs.toFixed(1)), vocabulary: knowledge.vocabulary.status(), summary, rows };

if (json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`corpus=${report.corpus} documents=${report.documents} init=${report.initializeMs}ms firstTextSearch=${report.firstSearchMs}ms runs=${runs} vocabularyConcepts=${report.vocabulary.concepts}`);
  for (const row of rows) {
    console.log(`\n${JSON.stringify(row.query)} -> ${(row.expected as string[]).join(', ') || '(no expected document)'}`);
    for (const name of Object.keys(engines)) {
      const value = row[name] as { ms: number; count: number; rank: number | null; top: string[] };
      console.log(`  ${name.padEnd(8)} ${String(value.ms).padStart(7)} ms  docs=${String(value.count).padStart(2)}  rank=${value.rank ?? '-'}  top=${value.top.join(' | ')}`);
    }
  }
  console.log('\nsummary', JSON.stringify(summary));
}
