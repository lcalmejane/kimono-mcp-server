import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { answerFrom, benchmark, isolationAudit, paired, qualityCheck, readEvents, summarize, usageMetrics } from '../scripts/bench-harness.js';

it('uses per-model totals exactly once and leaves missing counters unknown', () => {
  expect(usageMetrics({ modelMetrics: { a: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 30 } },
    b: { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 20 } } },
  agentMetrics: { duplicated: { inputTokens: 150 } } })).toMatchObject({
    models: ['a', 'b'], inputTokens: 150, outputTokens: 15, cacheReadTokens: 50,
    cacheWriteTokens: null, reasoningTokens: null,
  });
  expect(usageMetrics({})).toMatchObject({ models: [], inputTokens: null });
  expect(usageMetrics({ tokenDetails: { input: { tokenCount: 42 } } }).uncachedInputTokens).toBe(42);
});

it('extracts the final answer, not a tool request or partial output', () => {
  const events = readEvents('{"type":"assistant.message","data":{"content":"searching","toolRequests":[{}]}}\n'
    + '{"type":"assistant.message","data":{"content":"answer","toolRequests":[]}}\n{"type":"result"}\n');
  expect(answerFrom(events)).toBe('answer');
  expect(() => readEvents('not json')).toThrow();
});

it('rejects AI-KIDO/custom native tools and any active MCP in the native baseline', () => {
  const inventory = { type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'github-mcp-server', status: 'disabled' }] } };
  const call = (toolName: string) => ({ type: 'tool.execution_start', data: { toolName } });
  expect(isolationAudit([inventory, call('grep'), call('glob'), call('view')], 'without', ['aikido_search']))
    .toMatchObject({ passed: true, observedTools: ['glob', 'grep', 'view'] });
  for (const name of ['aikido_search', 'task', 'skill', 'shell', 'kimono-aikido_search']) {
    expect(isolationAudit([inventory, call(name)], 'without', ['aikido_search']).passed).toBe(false);
  }
  const connected = { type: 'session.mcp_server_status_changed', data: { serverName: 'kimono', status: 'connected' } };
  expect(isolationAudit([inventory, connected], 'without', ['aikido_search']).passed).toBe(false);
  expect(isolationAudit([inventory, connected, call('kimono-aikido_search')], 'with', ['aikido_search']).passed).toBe(true);
  expect(isolationAudit([inventory, call('kimono-aikido_git')], 'with', ['aikido_search']).passed).toBe(false);
  expect(isolationAudit([call('grep')], 'without', []).passed).toBe(false);
});

it('accepts the CLI `rg` alias of grep but still rejects other unlisted tools', () => {
  const inventory = { type: 'session.mcp_servers_loaded', data: { servers: [{ name: 'github-mcp-server', status: 'disabled' }] } };
  const call = (toolName: string) => ({ type: 'tool.execution_start', data: { toolName } });
  expect(isolationAudit([inventory, call('rg'), call('glob'), call('view')], 'without', ['aikido_search']))
    .toMatchObject({ passed: true, observedTools: ['glob', 'rg', 'view'], aliasedTools: ['rg'], unexpectedTools: [] });
  expect(isolationAudit([inventory, call('grep')], 'without', ['aikido_search']).aliasedTools).toEqual([]);
  for (const name of ['ripgrep', 'bash', 'rg2']) {
    expect(isolationAudit([inventory, call('rg'), call(name)], 'without', ['aikido_search']))
      .toMatchObject({ passed: false, unexpectedTools: [name] });
  }
});

it('checks real citations and gold-path coverage without pretending to grade correctness', () => {
  const task = { id: 'task', kind: 'research', prompt: 'task', expectedPaths: ['a.ts'], rubric: ['correctness'] };
  const answer = { summary: 'summary', evidence: [{ path: 'a.ts', startLine: 1, endLine: 2 }], plan: [], risks: [], tests: [] };
  const files = new Map([['a.ts', 'one\ntwo']]);
  expect(qualityCheck(JSON.stringify(answer), task, files)).toEqual({
    formatValid: true, evidenceValid: true, expectedPathCoverage: 1, humanReview: 'pending',
  });
  answer.evidence[0].endLine = 3;
  expect(qualityCheck(JSON.stringify(answer), task, files).evidenceValid).toBe(false);
  expect(qualityCheck('not json', task, files).formatValid).toBe(false);
});

it('keeps negative savings visible and rejects claims with routing/quality/MCP confounds', () => {
  const baseline = { task: 'task', repetition: 1, variant: 'without', status: 'ok', wallMs: 100,
    usage: { models: ['a'], inputTokens: 100 }, quality: { humanReview: 'pending' } };
  const treatment = { ...baseline, variant: 'with', mcpUsed: true, wallMs: 120,
    usage: { models: ['b'], inputTokens: 150 } };
  const [pair] = paired([baseline, treatment]);
  expect(pair).toMatchObject({ eligibleForClaim: false, exploratoryInputReductionPercent: -50,
    exploratoryWallReductionPercent: -20 });
  expect(pair.reasons).toContain('different observed model sets');
  expect(pair.reasons).toContain('without: isolation not verified');
  expect(paired([baseline, { ...treatment, mcpUsed: false }])[0].reasons).toContain('Kimono not actually called');
  expect(paired([baseline])[0].reasons).toContain('missing treatment');
  expect(paired([{ ...baseline, status: 'failed', failure: 'timeout' }, treatment])[0])
    .toMatchObject({ eligibleForClaim: false, exploratoryInputReductionPercent: null, exploratoryWallReductionPercent: null });
});

it('prepares a hashed dry run without starting the deliberately unavailable harness or MCP', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimono-bench-test-'));
  try {
    const configFile = path.join(directory, 'config.json');
    const output = path.join(directory, 'output');
    const corpus = path.join(directory, 'source');
    await mkdir(corpus);
    await writeFile(path.join(corpus, 'a.ts'), 'export const fixture = true;\n');
    const git = promisify(execFile);
    await git('git', ['init', '--quiet', corpus]);
    await git('git', ['-c', 'user.name=Benchmark Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'Initialize benchmark fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'], { cwd: corpus });
    await writeFile(configFile, JSON.stringify({
      corpus, policy: { include: ['a.ts'] }, model: 'auto', repetitions: 1, timeoutMs: 1000,
      harness: { kind: 'copilot', command: 'unavailable-benchmark-harness', args: [], versionArgs: ['--version'] },
      mcp: { command: 'unavailable-benchmark-mcp', args: [], indexMode: 'literal', tools: ['aikido_search'] },
      tasks: [{ id: 'config', kind: 'research', prompt: 'Explain config', expectedPaths: ['a.ts'], rubric: ['accurate'] }],
    }));
    await benchmark(configFile, output, true);
    const run = JSON.parse(await readFile(path.join(output, 'run.json'), 'utf8'));
    expect(run.dryRun).toBe(true);
    expect(run.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.files).toHaveLength(1);
    expect(await readFile(path.join(output, 'corpus/a.ts'), 'utf8')).toContain('fixture');
    expect((await summarize(output)).pairs).toEqual([]);
    await expect(benchmark(configFile, output, true)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
