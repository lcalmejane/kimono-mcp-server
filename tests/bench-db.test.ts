import { expect, it } from 'vitest';
import { buildEmbeddingRecord, buildHarnessRecord, buildIndex, checkRecord, loadRecords, validateAll } from '../scripts/bench-db.js';

const usage = (input: number, output = 100, uncached = input / 2) => ({ models: ['model-x'], inputTokens: input, outputTokens: output,
  cacheReadTokens: input - uncached, cacheWriteTokens: 0, reasoningTokens: 0, uncachedInputTokens: uncached, apiMs: 1000 });
const row = (variant: string, input: number, wallMs: number, extra: Record<string, unknown> = {}) => ({
  task: 'find-ignore-policy', kind: 'research', repetition: 1, variant, status: 'ok', wallMs, exitCode: 0, failure: null,
  corpusUnchanged: true, mcpUsed: variant === 'with', usage: usage(input),
  tools: [{ toolName: 'grep' }, { toolName: 'grep' }, { toolName: 'view' }],
  quality: { formatValid: true, evidenceValid: true, expectedPathCoverage: 1, humanReview: 'pending' }, ...extra });
const run = (label = 'run-a') => ({ label, run: {
  startedAt: '2026-11-01T10:00:00.000Z', commit: '2696ecfed4f6a17c7f89f91a47f05bd068d93109', dirty: false, os: 'linux', arch: 'x64', node: 'v24.1.0',
  corpusSha256: 'a'.repeat(64), files: [{ path: 'a.ts', bytes: 10 }, { path: 'b.ts', bytes: 20 }],
  config: { repetitions: 1, timeoutMs: 600000, harness: { kind: 'external' }, mcp: { indexMode: 'all', searchDetail: 'compact',
    tools: ['aikido_search'], args: ['run', '-e', 'KIMONO_EMBEDDING_POLICY=auto-speed', 'my-image', '/app/dist/index.js'].map((arg, i, all) => arg === 'my-image' ? all[i] : arg) },
    tasks: [{ id: 'find-ignore-policy', kind: 'research', expectedPaths: ['a.ts'] }] },
  treatment: 'native tools in both arms' },
rows: [row('without', 1000, 20000), row('with', 600, 15000)] });
const meta = { id: 'external-test-20261101', contributor: 'Someone', harness: 'Claude Code', model: 'model-x', limitations: ['Local test run.'] };

it('builds a valid harness record from a bench-harness run', async () => {
  const record = buildHarnessRecord([run()], meta) as Record<string, any>;
  expect(await checkRecord(record)).toEqual([]);
  expect(record).toMatchObject({ kind: 'harness', status: 'exploratory', llm: { harness: 'Claude Code', model: 'model-x' },
    kimono: { embeddingPolicy: 'auto-speed', indexMode: 'all' }, corpus: { fileCount: 2, bytes: 30 } });
  expect(record.cells[0].toolCalls).toEqual({ grep: 2, view: 1 });
  expect(record.pairs[0]).toMatchObject({ inputChangePercent: -40, wallChangePercent: -25, eligibleForClaim: false });
});

it('keeps a run label per cell only when several runs are gathered', () => {
  expect((buildHarnessRecord([run()], meta) as any).cells[0].run).toBeUndefined();
  const merged = buildHarnessRecord([run('first'), run('second')], meta) as any;
  expect(merged.cells.map((cell: any) => cell.run)).toEqual(['first', 'first', 'second', 'second']);
  expect(merged.pairs.map((pair: any) => pair.run)).toEqual(['first', 'second']);
});

it('rejects machine-specific paths, secrets and inconsistent figures', async () => {
  const base = buildHarnessRecord([run()], meta) as Record<string, any>;
  expect((await checkRecord({ ...base, llm: { ...base.llm, notes: 'ran in /Users/me/work' } })).join()).toMatch(/local filesystem path/);
  expect((await checkRecord({ ...base, limitations: ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789'] })).join()).toMatch(/secret-like/);
  const forged = { ...base, pairs: [{ ...base.pairs[0], inputChangePercent: -90 }] };
  expect((await checkRecord(forged)).join()).toMatch(/does not match the cells/);
  const claim = { ...base, pairs: [{ ...base.pairs[0], eligibleForClaim: true }] };
  expect((await checkRecord(claim)).join()).toMatch(/eligibleForClaim requires no reasons/);
  expect((await checkRecord({ ...base, status: 'reviewed' })).join()).toMatch(/humanReview "passed"/);
  expect((await checkRecord({ ...base, id: 'Bad Id' })).join()).toMatch(/schema/);
  expect((await checkRecord({ ...base, id: 'other-id' }, '/x/external-test-20261101.json')).join()).toMatch(/must match the file name/);
});

it('requires harness records to carry the model and the two arms', async () => {
  const { llm: _llm, ...withoutLlm } = buildHarnessRecord([run()], meta) as Record<string, any>;
  expect((await checkRecord(withoutLlm)).join()).toMatch(/llm/);
});

it('builds an embedding record and an index grouped by client and model', async () => {
  const embedding = buildEmbeddingRecord({ image: 'img', cases: 16, results: [
    { policy: 'e5', startupMs: 700, lexicalIndexMs: 170, semanticIndexMs: 18000, stderr: 'noise',
      modes: { hybrid: { firstCallMs: 18, medianMs: 21, hitAt10: 12, mrr: 0.5 } } },
    { policy: 'auto-speed', startupMs: 520, lexicalIndexMs: 165, semanticIndexMs: 2400, modes: {} }] },
  { id: 'embedding-test', contributor: 'Someone', limitations: [] }) as Record<string, any>;
  expect(await checkRecord(embedding)).toEqual([]);
  expect(JSON.stringify(embedding)).not.toContain('noise');
  const harness = buildHarnessRecord([run()], meta);
  const index = buildIndex([harness, embedding]) as Record<string, any>;
  expect(index.records.map((entry: any) => entry.kind)).toEqual(expect.arrayContaining(['harness', 'embedding']));
  expect(index.byLlm).toEqual([expect.objectContaining({ harness: 'Claude Code', model: 'model-x', pairs: 1, medianInputChangePercent: -40 })]);
});

it('keeps the committed database valid and its index current', async () => {
  expect(await validateAll(true)).toEqual([]);
  expect((await loadRecords()).length).toBeGreaterThan(0);
});
