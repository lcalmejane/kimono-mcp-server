// Kimono benchmark database: JSON records contributed from any LLM/client, validated against
// benchmarks/db/record.schema.json and listed in benchmarks/db/index.json.
//
//   tsx scripts/bench-db.ts validate [--check-index]
//   tsx scripts/bench-db.ts index
//   tsx scripts/bench-db.ts import-harness <run-dir>... --id ID --contributor NAME --harness NAME --model MODEL [options]
//   tsx scripts/bench-db.ts import-embedding <results.json> --id ID --contributor NAME [options]
//
// No LLM is called. Records are derived from the evidence produced by bench-harness.ts / bench-embedding.mjs.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { paired } from './bench-harness.js';

type Json = Record<string, unknown>;
const here = path.dirname(fileURLToPath(import.meta.url));
export const dbDirectory = path.resolve(here, '../benchmarks/db');
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown): string | null => typeof value === 'string' && value ? value : null;

export async function loadSchema(): Promise<Json> {
  return JSON.parse(await readFile(path.join(dbDirectory, 'record.schema.json'), 'utf8')) as Json;
}

const LOCAL_PATH = /\/Users\/|\/home\/[a-z]|\/private\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\+Users/;
const SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[abp]-[A-Za-z0-9-]{10,})\b|Bearer\s+[A-Za-z0-9._-]{20,}/;

function strings(value: unknown, trail: string, out: Array<[string, string]>) {
  if (typeof value === 'string') out.push([trail, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${trail}[${index}]`, out));
  else if (object(value)) for (const [key, item] of Object.entries(value)) strings(item, `${trail}.${key}`, out);
}

const round1 = (value: number) => Math.round(value * 10) / 10;
function change(without: unknown, treatment: unknown): number | null {
  return finite(without) && finite(treatment) && without > 0 ? round1(100 * (treatment / without - 1)) : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Schema + integrity + privacy checks. Returns human-readable errors; empty means valid. */
export async function checkRecord(record: unknown, file?: string): Promise<string[]> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(await loadSchema());
  if (!validate(record)) {
    return (validate.errors ?? []).map(error => `schema: ${error.instancePath || '/'} ${error.message}`);
  }
  const errors: string[] = [];
  const data = record as Json;
  const id = String(data.id);
  if (file && path.basename(file) !== `${id}.json`) errors.push(`id "${id}" must match the file name (${path.basename(file)})`);
  const found: Array<[string, string]> = [];
  strings(data, '', found);
  for (const [trail, value] of found) {
    if (trail === '.contributor.contact') { if (SECRET.test(value)) errors.push(`secret-like value at ${trail}`); continue; }
    if (LOCAL_PATH.test(value)) errors.push(`local filesystem path at ${trail}: remove machine-specific paths`);
    if (SECRET.test(value)) errors.push(`secret-like value at ${trail}`);
  }
  if (data.kind === 'harness') {
    const cells = (data.cells ?? []) as Json[];
    const key = (cell: Json) => `${cell.run ?? ''}|${cell.task}|${cell.repetition}|${cell.variant}`;
    const byKey = new Map<string, Json>();
    for (const cell of cells) {
      if (byKey.has(key(cell))) errors.push(`duplicate cell ${key(cell)}`);
      byKey.set(key(cell), cell);
    }
    for (const pair of (data.pairs ?? []) as Json[]) {
      const base = `${pair.run ?? ''}|${pair.task}|${pair.repetition}`;
      const a = byKey.get(`${base}|without`), b = byKey.get(`${base}|with`);
      if (!a || !b) { errors.push(`pair ${base} references a missing cell`); continue; }
      const stored = (field: string, a1: unknown, b1: unknown) => {
        if (typeof pair[field] !== 'number') return;
        const expected = change(a1, b1);
        if (expected === null || Math.abs(expected - (pair[field] as number)) > 0.11) {
          errors.push(`pair ${base}: ${field} ${String(pair[field])} does not match the cells (${String(expected)})`);
        }
      };
      const ua = a.usage as Json, ub = b.usage as Json;
      stored('inputChangePercent', ua.inputTokens, ub.inputTokens);
      stored('uncachedInputChangePercent', ua.uncachedInputTokens, ub.uncachedInputTokens);
      stored('outputChangePercent', ua.outputTokens, ub.outputTokens);
      stored('wallChangePercent', a.wallMs, b.wallMs);
      if (pair.eligibleForClaim === true && ((pair.reasons as unknown[]).length || a.status !== 'ok' || b.status !== 'ok')) {
        errors.push(`pair ${base}: eligibleForClaim requires no reasons and two ok cells`);
      }
    }
    if (data.status === 'reviewed' && cells.some(cell => cell.status === 'ok'
      && (!object(cell.quality) || cell.quality.humanReview !== 'passed'))) {
      errors.push('status "reviewed" requires humanReview "passed" on every ok cell');
    }
  } else if (data.kind === 'embedding') {
    const names = ((data.policies ?? []) as Json[]).map(policy => String(policy.policy));
    if (new Set(names).size !== names.length) errors.push('duplicate embedding policy names');
  }
  return errors;
}

export interface HarnessMeta {
  id: string; contributor: string; contact?: string; harness: string; harnessVersion?: string; model: string;
  provider?: string; armWithout?: string; armWith?: string; kimonoVersion?: string; notes?: string;
  limitations: string[]; createdAt?: string;
}
export interface RunInput { label: string; run: Json; rows: Json[]; harnessVersion?: string }

const DEFAULT_LIMITATIONS = [
  'Human quality review pending unless status is "reviewed"; automatic checks validate format, path bounds and coverage only.',
  'Provider/OS caches and model variability are uncontrolled; input tokens may include cached input and are not a bill.',
];

function toCell(row: Json, label: string | undefined): Json {
  const usage = object(row.usage) ? row.usage : {};
  const num = (value: unknown) => finite(value) ? value : null;
  const toolCalls: Record<string, number> = {};
  for (const tool of Array.isArray(row.tools) ? row.tools : []) {
    if (object(tool) && typeof tool.toolName === 'string') toolCalls[tool.toolName] = (toolCalls[tool.toolName] ?? 0) + 1;
  }
  const quality = object(row.quality) ? row.quality : null;
  const failure = text(row.failure) ?? text(row.error);
  return {
    ...label ? { run: label } : {},
    task: row.task, ...text(row.kind) ? { kind: row.kind } : {}, repetition: row.repetition, variant: row.variant,
    status: row.status === 'ok' ? 'ok' : 'failed', failure: failure ? failure.slice(0, 300) : null,
    wallMs: finite(row.wallMs) ? Math.round(row.wallMs) : null,
    mcpUsed: typeof row.mcpUsed === 'boolean' ? row.mcpUsed : null,
    isolationPassed: object(row.isolation) ? row.isolation.passed === true : null,
    usage: {
      models: Array.isArray(usage.models) ? usage.models.filter(item => typeof item === 'string') : [],
      inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens), cacheWriteTokens: num(usage.cacheWriteTokens),
      reasoningTokens: num(usage.reasoningTokens), uncachedInputTokens: num(usage.uncachedInputTokens), apiMs: num(usage.apiMs),
    },
    toolCalls,
    ...quality ? { quality: {
      ...typeof quality.formatValid === 'boolean' ? { formatValid: quality.formatValid } : {},
      ...typeof quality.evidenceValid === 'boolean' ? { evidenceValid: quality.evidenceValid } : {},
      ...finite(quality.expectedPathCoverage) ? { expectedPathCoverage: quality.expectedPathCoverage } : {},
      ...['pending', 'passed', 'failed'].includes(String(quality.humanReview)) ? { humanReview: quality.humanReview } : {},
    } } : {},
  };
}

export function buildHarnessRecord(runs: RunInput[], meta: HarnessMeta): Json {
  const first = runs[0].run;
  const config = (object(first.config) ? first.config : {}) as Json;
  const mcp = (object(config.mcp) ? config.mcp : {}) as Json;
  const harnessConfig = (object(config.harness) ? config.harness : {}) as Json;
  const args = Array.isArray(mcp.args) ? mcp.args.map(String) : [];
  const policyArg = args.find(arg => arg.startsWith('KIMONO_EMBEDDING_POLICY='));
  const entry = args.indexOf('/app/dist/index.js');
  const multi = runs.length > 1;
  const cells: Json[] = [];
  const pairs: Json[] = [];
  const observed = new Set<string>();
  for (const { label, rows } of runs) {
    const eligibility = new Map(paired(rows).map(item => [`${item.task}|${item.repetition}`, item as Json]));
    for (const row of rows) cells.push(toCell(row, multi ? label : undefined));
    for (const baseline of rows.filter(row => row.variant === 'without')) {
      const treatment = rows.find(row => row.task === baseline.task && row.repetition === baseline.repetition && row.variant === 'with');
      const info = eligibility.get(`${baseline.task}|${baseline.repetition}`);
      if (!treatment || !info) continue;
      const ok = baseline.status === 'ok' && treatment.status === 'ok';
      const ua = (object(baseline.usage) ? baseline.usage : {}) as Json, ub = (object(treatment.usage) ? treatment.usage : {}) as Json;
      pairs.push({
        ...multi ? { run: label } : {}, task: baseline.task, repetition: baseline.repetition,
        eligibleForClaim: info.eligibleForClaim === true, reasons: (info.reasons as string[] | undefined) ?? [],
        inputChangePercent: ok ? change(ua.inputTokens, ub.inputTokens) : null,
        uncachedInputChangePercent: ok ? change(ua.uncachedInputTokens, ub.uncachedInputTokens) : null,
        outputChangePercent: ok ? change(ua.outputTokens, ub.outputTokens) : null,
        wallChangePercent: ok ? change(baseline.wallMs, treatment.wallMs) : null,
      });
    }
    for (const row of rows) for (const model of object(row.usage) && Array.isArray(row.usage.models) ? row.usage.models : []) observed.add(String(model));
  }
  const files = Array.isArray(first.files) ? first.files as Json[] : [];
  const okCells = cells.filter(cell => cell.status === 'ok');
  const reviewed = okCells.length > 0 && okCells.every(cell => object(cell.quality) && cell.quality.humanReview === 'passed');
  const tasks = (Array.isArray(config.tasks) ? config.tasks as Json[] : []).map(task => ({
    id: task.id, ...text(task.kind) ? { kind: task.kind } : {},
    ...Array.isArray(task.expectedPaths) ? { expectedPaths: task.expectedPaths } : {} }));
  const note = [meta.notes, observed.size && !(observed.size === 1 && observed.has(meta.model)) ? `Observed models: ${[...observed].sort().join(', ')}.` : null]
    .filter(Boolean).join(' ');
  const harnessVersion = meta.harnessVersion ?? runs.find(run => run.harnessVersion)?.harnessVersion;
  return {
    schemaVersion: 1, id: meta.id, kind: 'harness',
    createdAt: meta.createdAt ?? text(first.startedAt) ?? new Date().toISOString(),
    contributor: { name: meta.contributor, ...meta.contact ? { contact: meta.contact } : {} },
    llm: { harness: meta.harness, ...harnessVersion ? { harnessVersion } : {}, model: meta.model,
      ...meta.provider ? { provider: meta.provider } : {}, ...note ? { notes: note } : {} },
    arms: { without: meta.armWithout ?? `${meta.harness} native read/search tools only`,
      with: meta.armWith ?? `${meta.harness} native tools plus Kimono MCP (${Array.isArray(mcp.tools) ? mcp.tools.join(', ') : 'tools'})` },
    environment: { os: text(first.os) ?? os.platform(), arch: text(first.arch) ?? os.arch(), ...text(first.node) ? { node: first.node } : {} },
    kimono: {
      ...meta.kimonoVersion ? { version: meta.kimonoVersion } : {},
      ...typeof first.commit === 'string' && /^[0-9a-f]{7,40}$/.test(first.commit) ? { commit: first.commit } : {},
      ...typeof first.dirty === 'boolean' ? { dirty: first.dirty } : {},
      ...typeof first.runtimeSha256 === 'string' ? { runtimeSha256: first.runtimeSha256 } : {},
      ...entry > 0 && !args[entry - 1].startsWith('-') ? { image: args[entry - 1] } : {},
      ...policyArg ? { embeddingPolicy: policyArg.split('=')[1] } : {},
      ...text(mcp.indexMode) ? { indexMode: mcp.indexMode } : {}, ...text(mcp.searchDetail) ? { searchDetail: mcp.searchDetail } : {},
    },
    corpus: { sha256: first.corpusSha256, fileCount: files.length,
      bytes: files.reduce((sum, file) => sum + (finite(file.bytes) ? file.bytes : 0), 0) },
    protocol: { repetitions: config.repetitions, timeoutMs: config.timeoutMs, tasks,
      notes: [text(first.treatment), text(first.cachePolicy), harnessConfig.kind === 'external' ? 'Custom adapter (harness.kind "external").' : null].filter(Boolean).join(' ') },
    status: reviewed ? 'reviewed' : 'exploratory', cells, pairs,
    limitations: [...DEFAULT_LIMITATIONS, ...meta.limitations],
  };
}

export interface EmbeddingMeta {
  id: string; contributor: string; contact?: string; corpusDescription?: string; image?: string; os?: string; arch?: string;
  limitations: string[]; createdAt?: string;
}
export function buildEmbeddingRecord(data: Json, meta: EmbeddingMeta): Json {
  const results = Array.isArray(data.results) ? data.results as Json[] : [];
  const policies = results.map(result => {
    const modes: Json = {};
    for (const [mode, values] of Object.entries(object(result.modes) ? result.modes : {})) {
      modes[mode] = Object.fromEntries(Object.entries(object(values) ? values : {}).filter(([, item]) => finite(item)));
    }
    return { policy: result.policy, error: text(result.error), startupMs: finite(result.startupMs) ? result.startupMs : null,
      lexicalIndexMs: finite(result.lexicalIndexMs) ? result.lexicalIndexMs : null,
      semanticIndexMs: finite(result.semanticIndexMs) ? result.semanticIndexMs : null, modes };
  });
  return {
    schemaVersion: 1, id: meta.id, kind: 'embedding', createdAt: meta.createdAt ?? new Date().toISOString(),
    contributor: { name: meta.contributor, ...meta.contact ? { contact: meta.contact } : {} },
    environment: { os: meta.os ?? os.platform(), arch: meta.arch ?? os.arch() },
    kimono: { ...meta.image ?? text(data.image) ? { image: meta.image ?? data.image } : {} },
    corpus: meta.corpusDescription ? { description: meta.corpusDescription } : {},
    status: 'exploratory', queries: typeof data.cases === 'number' ? data.cases : Array.isArray(data.cases) ? data.cases.length : 1,
    policies, limitations: [
      'Hand-written queries with author-chosen expected files; indicative only.',
      'One cold run per policy for indexing; no confidence interval.',
      ...meta.limitations],
  };
}

export async function loadRecords(directory = path.join(dbDirectory, 'records')): Promise<Array<{ file: string; record: Json }>> {
  const names = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => ({ file: path.join(directory, name),
    record: JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Json })));
}

export function buildIndex(records: Json[]): Json {
  const sorted = [...records].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  const entries = sorted.map(record => {
    const base = { id: record.id, kind: record.kind, createdAt: record.createdAt, status: record.status,
      contributor: (record.contributor as Json).name, path: `records/${String(record.id)}.json` };
    if (record.kind === 'embedding') return { ...base, policies: ((record.policies ?? []) as Json[]).map(policy => policy.policy) };
    const pairs = (record.pairs ?? []) as Json[];
    const numbers = (field: string) => pairs.map(pair => pair[field]).filter((value): value is number => typeof value === 'number');
    const llm = record.llm as Json;
    return { ...base, llm: { harness: llm.harness, model: llm.model }, cells: ((record.cells ?? []) as Json[]).length,
      pairs: pairs.length, eligiblePairs: pairs.filter(pair => pair.eligibleForClaim === true).length,
      medianInputChangePercent: median(numbers('inputChangePercent')), medianWallChangePercent: median(numbers('wallChangePercent')) };
  });
  const groups = new Map<string, Json[]>();
  for (const record of sorted.filter(item => item.kind === 'harness')) {
    const llm = record.llm as Json, key = `${String(llm.harness)}|${String(llm.model)}`;
    groups.set(key, [...groups.get(key) ?? [], record]);
  }
  const byLlm = [...groups].map(([key, items]) => {
    const [harness, model] = key.split('|');
    const pairs = items.flatMap(item => (item.pairs ?? []) as Json[]);
    const numbers = (field: string) => pairs.map(pair => pair[field]).filter((value): value is number => typeof value === 'number');
    return { harness, model, records: items.length, pairs: pairs.length,
      medianInputChangePercent: median(numbers('inputChangePercent')), medianWallChangePercent: median(numbers('wallChangePercent')) };
  });
  return { schemaVersion: 1,
    note: 'Generated by scripts/bench-db.ts index. Negative percentages mean the Kimono arm used less. Exploratory unless a record is eligible for claim.',
    records: entries, byLlm };
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export async function validateAll(checkIndex: boolean): Promise<string[]> {
  const loaded = await loadRecords();
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const { file, record } of loaded) {
    for (const error of await checkRecord(record, file)) errors.push(`${path.basename(file)}: ${error}`);
    if (ids.has(String(record.id))) errors.push(`${path.basename(file)}: duplicate id`);
    ids.add(String(record.id));
  }
  if (checkIndex) {
    const current = await readFile(path.join(dbDirectory, 'index.json'), 'utf8').catch(() => '');
    if (current !== serialize(buildIndex(loaded.map(item => item.record)))) errors.push('index.json is out of date: run "tsx scripts/bench-db.ts index"');
  }
  return errors;
}

export async function writeIndex(): Promise<void> {
  const loaded = await loadRecords();
  await writeFile(path.join(dbDirectory, 'index.json'), serialize(buildIndex(loaded.map(item => item.record))));
}

function parseOptions(argv: string[]) {
  const positional: string[] = [], options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) options.set(name, [...options.get(name) ?? [], 'true']);
    else { options.set(name, [...options.get(name) ?? [], next]); i++; }
  }
  const one = (name: string) => options.get(name)?.at(-1);
  return { positional, options, one,
    require: (name: string) => { const value = one(name); if (!value) throw new Error(`Missing --${name}`); return value; } };
}

async function persist(record: Json, force: boolean) {
  const errors = await checkRecord(record);
  if (errors.length) throw new Error(`Record is not valid:\n- ${errors.join('\n- ')}`);
  const file = path.join(dbDirectory, 'records', `${String(record.id)}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  if (!force && await readFile(file).then(() => true, () => false)) throw new Error(`${path.basename(file)} exists; choose another --id or pass --force`);
  await writeFile(file, serialize(record));
  await writeIndex();
  console.log(file);
}

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const args = parseOptions(rest);
  if (command === 'validate') {
    const errors = await validateAll(args.one('check-index') === 'true');
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log('Benchmark database is valid.');
  } else if (command === 'index') {
    await writeIndex(); console.log(path.join(dbDirectory, 'index.json'));
  } else if (command === 'import-harness') {
    if (!args.positional.length) throw new Error('Pass at least one run directory (output of bench-harness.ts)');
    const runs: RunInput[] = [];
    for (const directory of args.positional) {
      const base = path.resolve(directory);
      const summary = await readFile(path.join(base, 'summary.json'), 'utf8').then(raw => JSON.parse(raw) as Json, () => null);
      const rows = summary && Array.isArray(summary.results) ? summary.results as Json[]
        : JSON.parse(await readFile(path.join(base, 'results.json'), 'utf8')) as Json[];
      const version = (await readFile(path.join(base, 'harness-version.txt'), 'utf8').catch(() => '')).split('\n')[0].trim().replace(/\.$/, '');
      runs.push({ label: path.basename(base), run: JSON.parse(await readFile(path.join(base, 'run.json'), 'utf8')) as Json, rows,
        ...version ? { harnessVersion: version } : {} });
    }
    const labels = runs.map(run => run.label);
    if (new Set(labels).size !== labels.length) throw new Error('Run directories must have distinct names');
    await persist(buildHarnessRecord(runs, {
      id: args.require('id'), contributor: args.require('contributor'), contact: args.one('contact'), harness: args.require('harness'),
      harnessVersion: args.one('harness-version'), model: args.require('model'), provider: args.one('provider'),
      armWithout: args.one('arm-without'), armWith: args.one('arm-with'), kimonoVersion: args.one('kimono-version'),
      notes: args.one('note'), limitations: args.options.get('limitation') ?? [], createdAt: args.one('created-at'),
    }), args.one('force') === 'true');
  } else if (command === 'import-embedding') {
    if (args.positional.length !== 1) throw new Error('Pass the results.json written by bench-embedding.mjs');
    const data = JSON.parse(await readFile(path.resolve(args.positional[0]), 'utf8')) as Json;
    await persist(buildEmbeddingRecord(data, {
      id: args.require('id'), contributor: args.require('contributor'), contact: args.one('contact'),
      corpusDescription: args.one('corpus-description'), image: args.one('image'), os: args.one('os'), arch: args.one('arch'),
      limitations: args.options.get('limitation') ?? [], createdAt: args.one('created-at'),
    }), args.one('force') === 'true');
  } else {
    throw new Error('Usage: bench-db.ts validate [--check-index] | index | import-harness <run-dir>... --id ID --contributor NAME --harness NAME --model MODEL | import-embedding <results.json> --id ID --contributor NAME');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
