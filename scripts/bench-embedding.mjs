// Embedding policy benchmark (no LLM, no credits): cold indexing time, search latency, relevance and payload size.
//   node scripts/bench-embedding.mjs --corpus DIR --models DIR --out DIR [--image IMAGE] [--policies e5,auto-balanced,auto-speed]
//                                    [--runs N] [--limit N] [--cases FILE] [--keep-cache]
// Each policy runs in a throw-away container with an empty cache, so indexing is measured cold. Models of the
// non-bundled policies are read from --models (same layout as KIMONO_MODELS_DIR); nothing is downloaded.
// Payload bytes are the exact MCP search responses; tokens are estimated as bytes / 4 (a proxy, not a tokenizer).
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; };
const option = name => args.includes(name) && Boolean(args.splice(args.indexOf(name), 1));
const keepCache = option('--keep-cache');
const corpus = flag('--corpus'), models = flag('--models'), out = flag('--out');
const image = flag('--image') ?? 'tatami-core-kimono';
const policies = (flag('--policies') ?? 'e5,auto-balanced,auto-speed').split(',');
const runs = Number(flag('--runs') ?? 5), limit = Number(flag('--limit') ?? 10);
const casesFile = flag('--cases');
const workers = flag('--workers');
const modesFlag = flag('--modes');
if (!corpus || !models || !out || !Number.isInteger(runs) || runs < 1) {
  console.error('Usage: node scripts/bench-embedding.mjs --corpus DIR --models DIR --out DIR [--image IMAGE] [--policies a,b] [--runs N] [--limit N] [--cases FILE] [--workers N] [--modes text,semantic,hybrid]');
  process.exit(2);
}

const defaultCases = [
  { query: 'how are embedding models downloaded and verified', expected: ['src/embedding-models.ts'] },
  { query: 'cancel a running semantic indexing', expected: ['src/semantic.ts', 'tests/index-control.test.ts'] },
  { query: 'which files are eligible for indexing and gitignore rules', expected: ['src/corpus-config.ts', 'src/knowledge.ts', 'tests/corpus.test.ts'] },
  { query: 'immutable snapshot of the corpus for consistent reads', expected: ['src/snapshots.ts', 'tests/snapshots.test.ts'] },
  { query: 'user overlay conflict resolution without last write wins', expected: ['src/overlay.ts', 'src/collaboration.ts', 'tests/overlay.test.ts'] },
  { query: 'synchroniser les modifications d\'un utilisateur vers le serveur partagé', expected: ['src/synchronization.ts', 'src/remote-sync.ts', 'src/collaboration.ts', 'tests/synchronization.test.ts'] },
  { query: 'persistent worker that keeps the embedding model warm', expected: ['src/semantic-worker.ts', 'tests/semantic-worker.test.ts'] },
  { query: 'split a question into search terms and plan the query', expected: ['src/query-plan.ts', 'src/planned-search.ts', 'tests/query-plan.test.ts'] },
  { query: 'git authentication over http for the shared remote', expected: ['tests/http-git-auth.test.ts', 'src/git-profile.ts', 'src/remote-sync.ts'] },
  { query: 'merge lexical and semantic rankings with reciprocal rank fusion', expected: ['src/search.ts', 'src/retrieval.ts', 'src/planned-search.ts'] },
  { query: 'extraire le texte des PDF et des documents bureautiques', expected: ['src/documents.ts', 'tests/documents.test.ts'] },
  { query: 'arrêt propre du serveur à la réception d\'un signal', expected: ['src/lifecycle.ts', 'tests/shutdown.test.ts'] },
  { query: 'choix du modèle d\'embedding selon le type de contenu code ou documents', expected: ['src/embedding-models.ts', 'docs/local-rag.fr.md', 'docs/local-rag.md', 'tests/embedding-models.test.ts'] },
  { query: 'which execution provider CPU CUDA CoreML is fastest', expected: ['src/semantic.ts', 'src/semantic-worker.ts', 'docs/local-rag.md'] },
  { query: 'same root or replica synchronization mode detection', expected: ['src/sync-mode.ts', 'tests/sync-mode.test.ts'] },
  { query: 'cache of search results invalidated after a change', expected: ['src/search-cache.ts', 'tests/search-cache.test.ts'] },
];
const cases = casesFile ? JSON.parse(await readFile(casesFile, 'utf8')) : defaultCases;
const modes = (modesFlag ?? 'text,semantic,hybrid').split(',');
if (modes.some(mode => !['text', 'semantic', 'hybrid'].includes(mode))) { console.error('--modes accepts text, semantic, hybrid'); process.exit(2); }
// Snapshots expire after 15 minutes by default and a text pass over a large corpus can outlast that: renew them early.
const snapshotRenewMs = 10 * 60_000;
const describeError = result => {
  const text = JSON.stringify(payloadOf(result));
  return text.length > 900 ? `${text.slice(0, 300)} … ${text.slice(-600)}` : text;
};

const median = values => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round = (value, digits = 1) => value === null ? null : Number(value.toFixed(digits));
const matches = (file, expected) => expected.some(item => item.endsWith('/') ? file.startsWith(item) : file === item);
const payloadOf = result => {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).find(item => item.type === 'text')?.text;
  try { return text ? JSON.parse(text) : { raw: text }; } catch { return { raw: text }; }
};
const documentsOf = value => [...new Set((value.results ?? []).filter(item => item && typeof item.path === 'string').map(item => item.path))];

async function runPolicy(policy) {
  const cache = await mkdtemp(path.join(tmpdir(), `kimono-bench-${policy}-`));
  const command = {
    command: 'docker',
    args: ['run', '--rm', '--user', 'root', '-i',
      '-v', `${path.resolve(corpus)}:/corpus:ro`, '-v', `${path.resolve(models)}:/models:ro`, '-v', `${cache}:/cache`,
      '-e', 'AIKIDO_ROOT=/corpus', '-e', 'KIMONO_CORPUS_MODE=rag', '-e', 'KIMONO_CACHE_DIR=/cache',
      '-e', 'KIMONO_MODELS_DIR=/models', '-e', `KIMONO_EMBEDDING_POLICY=${policy}`,
      ...(workers ? ['-e', `KIMONO_SEMANTIC_WORKERS=${workers}`] : []),
      '-e', 'MCP_TRANSPORT=stdio', '--entrypoint', 'node', image, '/app/dist/index.js'],
  };
  const client = new Client({ name: 'kimono-embedding-benchmark', version: '1.0.0' });
  const transport = new StdioClientTransport({ ...command, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
  const call = (name, input, timeout = 60_000) => client.callTool({ name, arguments: input }, undefined, { timeout });
  const report = { policy, error: null };
  const started = performance.now();
  try {
    await client.connect(transport);
    await client.listTools();
    report.startupMs = performance.now() - started;

    let began = performance.now();
    const lexical = await call('aikido_index', { operation: 'update', mode: 'literal' }, 600_000);
    report.lexicalIndexMs = performance.now() - began;
    if (lexical.isError) throw new Error(`lexical index failed: ${JSON.stringify(payloadOf(lexical)).slice(0, 400)}`);

    began = performance.now();
    const semantic = await call('aikido_index', { operation: 'update', mode: 'semantic' }, 1_800_000);
    report.semanticIndexMs = performance.now() - began;
    report.indexResult = payloadOf(semantic);
    if (semantic.isError) throw new Error(`semantic index failed: ${JSON.stringify(report.indexResult).slice(0, 600)}`);
    report.status = payloadOf(await call('aikido_index', { operation: 'status', mode: 'semantic' }));

    let snapshot = null, snapshotAt = 0;
    const freshSnapshot = async () => {
      if (snapshot && performance.now() - snapshotAt < snapshotRenewMs) return snapshot.snapshotId;
      if (snapshot) await call('aikido_snapshot', { operation: 'end', snapshotId: snapshot.snapshotId }).catch(() => undefined);
      snapshot = payloadOf(await call('aikido_snapshot', { operation: 'begin' }));
      if (!snapshot.snapshotId) throw new Error(`snapshot failed: ${JSON.stringify(snapshot).slice(0, 300)}`);
      snapshotAt = performance.now();
      return snapshot.snapshotId;
    };
    await freshSnapshot();
    report.modes = {};
    try {
      for (const mode of modes) {
        const rows = [];
        let firstMs = null;
        for (const item of cases) {
          // Run 1 is the real cost (query embedding + search); later runs hit the search cache and are reported separately.
          let value, coldMs = null;
          const warm = [];
          for (let run = 0; run < runs; run++) {
            const snapshotId = await freshSnapshot();
            const t = performance.now();
            const result = await call('aikido_search', { snapshotId, query: item.query, mode, detail: 'compact', limit, maxBytes: 131072 });
            const ms = performance.now() - t;
            if (result.isError) { value = { error: describeError(result) }; break; }
            if (run === 0) coldMs = ms; else warm.push(ms);
            value = payloadOf(result);
          }
          if (firstMs === null) firstMs = coldMs;
          const documents = value?.error ? [] : documentsOf(value);
          const rank = documents.findIndex(file => matches(file, item.expected));
          rows.push({ query: item.query, ok: !value?.error, error: value?.error ?? null, coldMs, warmMs: median(warm),
            bytes: value?.error ? 0 : Buffer.byteLength(JSON.stringify(value)), hits: documents.length,
            firstRelevantRank: rank < 0 ? null : rank + 1, top: documents.slice(0, 3) });
        }
        const good = rows.filter(row => row.ok);
        report.modes[mode] = {
          firstCallMs: firstMs, medianMs: median(good.map(row => row.coldMs)), meanMs: mean(good.map(row => row.coldMs)),
          warmMs: median(good.map(row => row.warmMs).filter(value => value !== null)),
          meanBytes: mean(good.map(row => row.bytes)), meanTokens: mean(good.map(row => row.bytes / 4)),
          hitAt1: good.filter(row => row.firstRelevantRank === 1).length, hitAt3: good.filter(row => row.firstRelevantRank && row.firstRelevantRank <= 3).length,
          hitAt10: good.filter(row => row.firstRelevantRank).length, failed: rows.length - good.length,
          mrr: mean(good.map(row => row.firstRelevantRank ? 1 / row.firstRelevantRank : 0)), rows,
        };
      }
    } finally {
      if (snapshot) await call('aikido_snapshot', { operation: 'end', snapshotId: snapshot.snapshotId }).catch(() => undefined);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    report.stderr = diagnostics.slice(-1500);
    if (!keepCache) await rm(cache, { recursive: true, force: true }).catch(() => undefined);
  }
  return report;
}

await mkdir(out, { recursive: true });
const results = [];
for (const policy of policies) {
  console.error(`== ${policy}`);
  const result = await runPolicy(policy);
  console.error(result.error ? `   FAILED: ${result.error}` : `   index ${Math.round(result.semanticIndexMs)} ms, semantic median ${round(result.modes.semantic.medianMs)} ms`);
  results.push(result);
  await writeFile(path.join(out, 'results.json'), JSON.stringify({ image, runs, limit, cases: cases.length, results }, null, 2));
}

const fmt = (value, digits = 1) => value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);
const base = results.find(item => item.policy === 'e5' && !item.error);
const delta = (value, reference) => base && value !== null && reference ? `${value / reference - 1 >= 0 ? '+' : ''}${fmt((value / reference - 1) * 100, 0)} %` : '';
const lines = ['# Embedding policy benchmark', '',
  `Image \`${image}\` · ${cases.length} requêtes · ${runs} répétitions (médiane) · limite ${limit} · corpus ${path.resolve(corpus)}`, '',
  '## Indexation à froid (cache vide)', '',
  '| Politique | Démarrage | Index lexical | Index sémantique | vs e5 |', '|---|---:|---:|---:|---:|'];
for (const item of results) {
  lines.push(item.error ? `| ${item.policy} | échec : ${item.error.replace(/\|/g, '/').slice(0, 120)} | | | |`
    : `| ${item.policy} | ${fmt(item.startupMs, 0)} ms | ${fmt(item.lexicalIndexMs, 0)} ms | ${fmt(item.semanticIndexMs, 0)} ms | ${item.policy === 'e5' ? 'réf.' : delta(item.semanticIndexMs, base?.semanticIndexMs)} |`);
}
for (const mode of modes) {
  lines.push('', `## Recherche \`${mode}\``, '',
    '| Politique | 1er appel | Médiane à froid | vs e5 | Répété (cache) | Octets/réponse | ≈ tokens/réponse | Hit@1 | Hit@3 | Hit@10 | MRR |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const item of results.filter(entry => !entry.error)) {
    const m = item.modes[mode];
    lines.push(`| ${item.policy} | ${fmt(m.firstCallMs, 0)} ms | ${fmt(m.medianMs)} ms | ${item.policy === 'e5' ? 'réf.' : delta(m.medianMs, base?.modes[mode].medianMs)} | ${fmt(m.warmMs, 2)} ms | ${fmt(m.meanBytes, 0)} | ${fmt(m.meanTokens, 0)} | ${m.hitAt1}/${cases.length} | ${m.hitAt3}/${cases.length} | ${m.hitAt10}/${cases.length} | ${fmt(m.mrr, 3)} |`);
  }
}
lines.push('', 'Tokens estimés = octets / 4 (proxy, pas un tokenizer). Hit@k = au moins un document attendu dans les k premiers fichiers.', '');
await writeFile(path.join(out, 'report.md'), lines.join('\n'));
console.log(path.join(out, 'report.md'));
