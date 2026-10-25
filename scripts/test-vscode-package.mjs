import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { register } from '../vscode/extension.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(root, '.local-runtime-vscode-'));
let transport;
try {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const target = `${process.platform}-${process.arch}`;
  const archive = path.join(root, 'vscode', `kimono-mcp-${pkg.version}-${target}.vsix`);
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
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
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
  await provider.resolveMcpServerDefinition(definition, { isCancellationRequested: false });
  transport = new StdioClientTransport({
    command: definition.command, args: definition.args, cwd: definition.cwd.fsPath,
    env: Object.fromEntries(Object.entries(definition.env).filter(([, value]) => value !== null)),
    stderr: 'inherit',
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
  console.log('Packaged VS Code provider: MCP handshake, tools, ROOT, native lexical search and ONNX embedding passed.');
} finally {
  if (transport) await transport.close();
  await rm(scratch, { recursive: true, force: true });
}
