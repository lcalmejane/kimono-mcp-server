import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { register } from '../vscode/extension.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(root, '.local-runtime-vscode-'));
let transport;
let diagnostics = '';
const createTransport = options => {
  const channel = new StdioClientTransport({ ...options, stderr: 'pipe' });
  channel.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  return channel;
};
try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  const archive = path.join(root, 'vscode', `kimono-rag-mcp-${pkg.version}-${target}.vsix`);
  const extracted = path.join(scratch, 'unpacked');
  await mkdir(extracted);
  // Test the installed archive, including ZIP permissions, not the build staging tree.
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xf', archive, '-C', extracted]);
  } else {
    execFileSync('unzip', ['-q', archive, '-d', extracted]);
  }
  const stage = path.join(extracted, 'extension');
  const knowledge = path.join(scratch, 'knowledge');
  await mkdir(path.join(knowledge, 'prompts'), { recursive: true });
  await writeFile(path.join(knowledge, 'prompts/index.md'), '# Knowledge\n\nKimono integration distribution evidence.\n');
  let provider;
  const settings = { corpusMode: 'aikido' };
  const noop = () => ({ dispose() {} });
  const uri = file => ({ scheme: 'file', fsPath: file });
  const vscode = {
    EventEmitter: class { event = noop; fire() {} dispose() {} },
    Uri: { file: uri },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ name: 'Fixture', uri: uri(knowledge) }],
      getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
      onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop, onDidGrantWorkspaceTrust: noop,
    },
    lm: { registerMcpServerDefinitionProvider: (_id, value) => { provider = value; return noop(); } },
    commands: { registerCommand: noop },
    window: { showErrorMessage: message => { throw new Error(message); } },
  };
  register(vscode, {
    extensionPath: stage, extension: { packageJSON: { version: 'test' } },
    globalStorageUri: uri(path.join(scratch, 'storage')),
    secrets: { onDidChange: noop, get: async () => undefined },
  });
  const [definition] = await provider.provideMcpServerDefinitions();
  assert.ok(path.isAbsolute(definition.env.FGR_BIN));
  assert.equal(definition.env.MCP_TRANSPORT, 'stdio');
  transport = createTransport({
    command: definition.command, args: definition.args, cwd: definition.cwd.fsPath,
    env: Object.fromEntries(Object.entries(definition.env).filter(([, value]) => value !== null)),
  });
  const client = new Client({ name: 'kimono-vsix-smoke', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  for (const name of ['aikido', 'aikido_snapshot', 'aikido_search', 'aikido_embed', 'aikido_collaboration']) {
    assert.ok(tools.tools.some(tool => tool.name === name), `Missing tool ${name}`);
  }
  const status = await client.callTool({ name: 'aikido_root', arguments: { operation: 'status' } });
  assert.ok(!status.isError, JSON.stringify(status));
  const embedding = await client.callTool({ name: 'aikido_embed', arguments: { text: 'Kimono distribution', usage: 'query' } });
  assert.ok(!embedding.isError, JSON.stringify(embedding));
  const embeddingData = JSON.parse(embedding.content.find(item => item.type === 'text').text);
  assert.equal(embeddingData.dimensions, 384);
  assert.equal(embeddingData.vector.length, 384);
  assert.ok(embeddingData.vector.every(Number.isFinite));
  const snapshot = await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'begin' } });
  assert.ok(!snapshot.isError, JSON.stringify(snapshot));
  const snapshotData = JSON.parse(snapshot.content.find(item => item.type === 'text').text);
  const search = await client.callTool({ name: 'aikido_search', arguments: {
    snapshotId: snapshotData.snapshotId, query: 'distribution', mode: 'literal',
  } });
  assert.ok(!search.isError, JSON.stringify(search));
  assert.match(JSON.stringify(search), /prompts\/index.md/);
  const ended = await client.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId: snapshotData.snapshotId } });
  assert.ok(!ended.isError, JSON.stringify(ended));
  await client.close();
  await rm(path.join(knowledge, 'prompts/index.md'));
  await mkdir(path.join(knowledge, 'src'));
  await writeFile(path.join(knowledge, 'src/main.rs'), '// Local RAG source retrieval\nfn authenticate() {}\n');
  delete settings.corpusMode;
  const [ragDefinition] = await provider.provideMcpServerDefinitions();
  assert.equal(ragDefinition.env.KIMONO_CORPUS_MODE, 'rag');
  transport = createTransport({
    command: ragDefinition.command, args: ragDefinition.args, cwd: ragDefinition.cwd.fsPath,
    env: Object.fromEntries(Object.entries(ragDefinition.env).filter(([, value]) => value !== null)),
  });
  const ragClient = new Client({ name: 'kimono-vsix-rag-smoke', version: '1.0.0' });
  await ragClient.connect(transport);
  const ragStatus = await ragClient.callTool({ name: 'aikido_root', arguments: { operation: 'status' } });
  assert.ok(!ragStatus.isError, JSON.stringify(ragStatus));
  const ragData = JSON.parse(ragStatus.content.find(item => item.type === 'text').text);
  assert.equal(ragData.corpus.mode, 'rag');
  const captured = await ragClient.callTool({ name: 'aikido_snapshot', arguments: { operation: 'begin', paths: ['src'] } });
  assert.ok(!captured.isError, JSON.stringify(captured));
  const ragId = JSON.parse(captured.content.find(item => item.type === 'text').text).snapshotId;
  for (const mode of ['text', 'semantic']) {
    const result = await ragClient.callTool({ name: 'aikido_search', arguments: { snapshotId: ragId, query: 'authenticate', mode } });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result), /src\/main.rs/);
  }
  await ragClient.callTool({ name: 'aikido_snapshot', arguments: { operation: 'end', snapshotId: ragId } });
  await ragClient.close();
  // The management panel's private MCP client and live status file, as packaged.
  const statusFile = ragDefinition.env.KIMONO_STATUS_FILE;
  assert.ok(statusFile, 'embedded definitions publish a live index status file');
  const { startMcpClient } = createRequire(import.meta.url)(path.join(stage, 'mcp-client.cjs'));
  const { readIndexStatus } = createRequire(import.meta.url)(path.join(stage, 'status.cjs'));
  const panelClient = startMcpClient({ command: ragDefinition.command, args: ragDefinition.args, cwd: ragDefinition.cwd.fsPath,
    env: Object.fromEntries(Object.entries(ragDefinition.env).filter(([, value]) => value !== null)) }, { version: pkg.version });
  try {
    await panelClient.call('aikido_index', { operation: 'update', mode: 'semantic' });
    const live = await readIndexStatus(statusFile);
    assert.equal(live.phase, 'ready', JSON.stringify(live));
    assert.ok(live.files.total > 0 && live.files.completed === live.files.total, JSON.stringify(live));
    assert.ok(live.estimatedTokens.total > 0 && live.chunks > 0, JSON.stringify(live));
    // The panel's "Test a search" must find real hits in every mode.
    const { runSearchBench } = createRequire(import.meta.url)(path.join(stage, 'search.cjs'));
    const bench = await runSearchBench((name, args) => {
      assert.notEqual(name, 'aikido_file', 'search tests must not fetch code automatically');
      if (name === 'aikido_search') assert.equal(args.detail, 'compact');
      return panelClient.call(name, args);
    },
      { query: 'authenticate', modes: ['literal', 'text', 'semantic', 'hybrid'], limit: 5 });
    for (const run of bench.runs) {
      assert.ok(run.ok && run.count > 0 && run.documents.includes('src/main.rs'), JSON.stringify(run));
      assert.doesNotMatch(JSON.stringify(run), /"excerpt"|"content"|"passages"/);
      assert.ok(run.payload.results.every(file => Object.keys(file).sort().join(',') === 'path,ranges'));
      assert.equal(run.bytes, Buffer.byteLength(JSON.stringify(run.payload)));
    }
  } finally { panelClient.close(); }
  // The same bundle is usable outside VS Code, with the generic stdio launcher.
  transport = createTransport({
    command: ragDefinition.command,
    args: [path.join(stage, 'stdio.cjs'), 'serve', '--root', knowledge],
    env: { PATH: process.env.PATH ?? '', KIMONO_CACHE_DIR: path.join(scratch, 'external-cache') },
  });
  const externalClient = new Client({ name: 'generic-mcp-host', version: '1.0.0' });
  await externalClient.connect(transport);
  const externalStatus = await externalClient.callTool({ name: 'aikido_root', arguments: { operation: 'status' } });
  assert.ok(!externalStatus.isError, JSON.stringify(externalStatus));
  assert.equal(JSON.parse(externalStatus.content.find(item => item.type === 'text').text).corpus.mode, 'rag');
  await externalClient.close();
  assert.equal((diagnostics.match(/ready on stdio/g) ?? []).length, 3, diagnostics);
  assert.doesNotMatch(diagnostics, /locked by another writer|Semantic index preparation failed/, diagnostics);
  console.log('Packaged VSIX passed: AI-KIDO tools/ROOT/384D embedding and generic RAG without entry point, scoped snapshot, lexical and semantic code retrieval.');
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  if (transport) await transport.close();
  await rm(scratch, { recursive: true, force: true });
}
