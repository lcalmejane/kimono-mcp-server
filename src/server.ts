import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AikidoKnowledgeBase, type KnowledgeEntry, type KnowledgeKind } from './knowledge.js';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { RUNTIME_TOOLS, runtimeFor } from './runtime-tools.js';
import { Lifecycle, shutdownSignals } from './lifecycle.js';
import { Retrieval, RETRIEVAL_PROPERTIES, READ_PROPERTIES } from './retrieval.js';

const SERVER_NAME = 'kimono-mcp-server';
const SERVER_VERSION = '0.2.0';
const MCP_TOOL: Tool = {
  name: 'aikido',
  description: 'Discover AI-KIDO progressively: list returns paginated metadata and headers (25 entries, 16 KiB by default); search delegates to aikido_search. Prefer aikido_file metadata/outline/read for bounded JSON passages. Legacy read without selectors and activate/execute return complete instructions, explicitly requested only. Activation does not execute an LLM.',
  inputSchema: {
    type: 'object',
    allOf: [{
      if: { properties: { operation: { enum: ['list', 'search'] } }, required: ['operation'] },
      then: { properties: { maxBytes: RETRIEVAL_PROPERTIES.maxBytes } },
    }],
    properties: {
      ...RETRIEVAL_PROPERTIES,
      ...READ_PROPERTIES,
      offset: { type: 'integer', minimum: 0, default: 0 },
      contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 2 },
      operation: { type: 'string', enum: ['list', 'search', 'read', 'activate', 'execute', 'refresh'] },
      kind: { type: 'string', enum: ['command', 'agent', 'skill', 'workflow', 'knowledge'] },
      query: { type: 'string', description: 'Filter or full-text search query.' },
      vector: { type: 'array', minItems: 1, maxItems: 16384, items: { type: 'number' }, description: 'Search only: alternative to query, requires mode=semantic and embeddingModel.' },
      embeddingModel: { type: 'string', description: 'Exact model identifier from aikido_embed; vectors must use matching weights and preprocessing.' },
      mode: { type: 'string', enum: ['literal', 'regex', 'semantic'], default: 'literal' },
      id: { type: 'string', description: 'Knowledge-base relative path or V3.1 SHA-256(path)[:12] file_id.' },
      context: { type: 'string', description: 'Optional user request to include when activating a command, agent, or skill.' },
      limit: { type: 'number', description: 'Maximum search results (1-100).', minimum: 1, maximum: 100 },
    },
    required: ['operation'],
  },
};

export function createAikidoMcpServer(knowledge: AikidoKnowledgeBase, lifecycle = new Lifecycle()): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {}, resources: { subscribe: false, listChanged: false }, prompts: {}, completions: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [MCP_TOOL, ...RUNTIME_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await lifecycle.run(async () => {
        if (request.params.name !== 'aikido') {
          return toolResult(await runtimeFor(knowledge).call(request.params.name, request.params.arguments ?? {}));
        }
        return callAikidoTool(knowledge, request.params.arguments ?? {});
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async request => {
    const entries = knowledge.isInitialized ? knowledge.list() : [];
    const page = cataloguePage(entries, request.params?.cursor);
    return {
      resources: page.entries.map((entry) => ({
        uri: resourceUri(entry.path),
        name: entry.path,
        description: `${entry.kind}: ${entry.title}`,
        mimeType: mimeType(entry.path),
      })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: 'aikido://{path}',
      name: 'AI-KIDO knowledge document',
      description: 'Read a text document from the configured AIKIDO_ROOT.',
      mimeType: 'text/markdown',
    }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const filePath = pathFromResourceUri(request.params.uri);
    await knowledge.refresh();
    const { content } = await knowledge.read(filePath);
    return { contents: [{ uri: request.params.uri, mimeType: mimeType(filePath), text: content }] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async request => {
    const entries = knowledge.isInitialized ? knowledge.list() : [];
    const page = cataloguePage(entries, request.params?.cursor);
    return {
      prompts: page.entries.map((entry) => ({
        name: promptName(entry),
        description: `Load AI-KIDO ${entry.kind} instructions: ${entry.path}`,
        arguments: [{ name: 'context', description: 'Optional user request/context for the AI-KIDO instructions.', required: false }],
      })), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    await knowledge.refresh();
    const entry = knowledge.list().find((item) => promptName(item) === request.params.name);
    if (!entry) throw new Error(`AI-KIDO prompt not found: ${request.params.name}`);
    const { content } = await knowledge.read(entry.id);
    const context = request.params.arguments?.context;
    const message = typeof context === 'string' && context.trim()
      ? `User context:\n${context.trim()}\n\nAI-KIDO instructions (${entry.path}):\n\n${content}`
      : `AI-KIDO instructions (${entry.path}):\n\n${content}`;
    return { description: `AI-KIDO ${entry.kind}: ${entry.title}`, messages: [{ role: 'user', content: { type: 'text', text: message } }] };
  });
  server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { argument, ref } = request.params;
    const value = argument.value.toLocaleLowerCase();
    const candidates = !knowledge.isInitialized ? [] : ref.type === 'ref/prompt'
      ? knowledge.list().map(promptName)
      : ref.type === 'ref/resource'
        ? knowledge.list().map((entry) => resourceUri(entry.path))
        : [];
    const filtered = candidates.filter((candidate) => candidate.toLocaleLowerCase().includes(value));
    const values = filtered.slice(0, 100);
    return { completion: { values, total: filtered.length, hasMore: filtered.length > values.length } };
  });
  return server;
}

async function callAikidoTool(knowledge: AikidoKnowledgeBase, raw: Record<string, unknown>) {
  const operation = raw.operation;
  const kind = parseKind(raw.kind);
  if (operation === 'refresh') {
    const count = await knowledge.refresh();
    await knowledge.searchIndex.synchronize();
    return toolResult(`AI-KIDO index refreshed: ${count} text files discovered.`);
  }
  if (operation === 'list') {
    return toolResult(await new Retrieval(knowledge).list(raw, kind));
  }
  if (operation === 'search') {
    return toolResult(await runtimeFor(knowledge).call('aikido_search', raw));
  }
  if (operation === 'read' || operation === 'activate' || operation === 'execute') {
    const id = stringArg(raw.id, 'id', true)!;
    if (operation === 'read' && ['startLine', 'endLine', 'section', 'full', 'maxBytes'].some(key => raw[key] !== undefined)) {
      return toolResult(await new Retrieval(knowledge).read(raw, id));
    }
    await knowledge.refresh();
    const { entry, content } = await knowledge.read(id);
    if (operation === 'read') return toolResult(content);
    if (!['command', 'agent', 'skill', 'workflow'].includes(entry.kind)) {
      throw new Error(`Only commands, agents, skills and workflows can be activated; ${entry.path} is ${entry.kind}`);
    }
    const context = stringArg(raw.context, 'context', false);
    return toolResult([
      `AI-KIDO ${entry.kind} instructions loaded from ${entry.path}.`,
      'Follow these instructions as the connected AI assistant; the MCP server does not execute model workflows. Use aikido_file and aikido_git for approved project actions; the standard base is protected.',
      context ? `\nUser context:\n${context}` : '',
      `\n---\n${content}`,
    ].filter(Boolean).join('\n'));
  }
  throw new Error(`Unknown operation: ${String(operation)}. Use list, search, read, activate, execute, or refresh.`);
}

function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function parseKind(value: unknown): KnowledgeKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'command' || value === 'agent' || value === 'skill' || value === 'workflow' || value === 'knowledge') return value;
  throw new Error('kind must be command, agent, skill, workflow or knowledge');
}

function stringArg(value: unknown, name: string, required: true): string;
function stringArg(value: unknown, name: string, required: false): string | undefined;
function stringArg(value: unknown, name: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function promptName(entry: KnowledgeEntry): string {
  return `aikido.${entry.kind}.${encodeURIComponent(entry.path)}`;
}

function cataloguePage(entries: KnowledgeEntry[], cursor?: string) {
  if (cursor !== undefined && (!/^(0|[1-9]\d*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
    throw new Error('Invalid catalogue cursor');
  }
  const start = Number(cursor ?? 0);
  const selected = entries.slice(start, start + 25);
  return { entries: selected, nextCursor: start + selected.length < entries.length ? String(start + selected.length) : undefined };
}

function resourceUri(filePath: string): string {
  return `aikido://${encodeURIComponent(filePath)}`;
}

function pathFromResourceUri(uri: string): string {
  const prefix = 'aikido://';
  if (!uri.startsWith(prefix)) throw new Error(`Unsupported AI-KIDO resource URI: ${uri}`);
  try {
    return decodeURIComponent(uri.slice(prefix.length));
  } catch (error) {
    throw new Error(`Malformed AI-KIDO resource URI: ${uri}`, { cause: error });
  }
}

function mimeType(filePath: string): string {
  if (/\.(md|mdc|mdx)$/.test(filePath)) return 'text/markdown';
  if (filePath.endsWith('.json')) return 'application/json';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'application/yaml';
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return 'text/javascript';
  if (filePath.endsWith('.sh')) return 'text/x-shellscript';
  if (filePath.endsWith('.xml')) return 'application/xml';
  return 'text/plain';
}

export async function startStdioServer(knowledge: AikidoKnowledgeBase): Promise<void> {
  await prepareKnowledge(knowledge);
  const lifecycle = new Lifecycle();
  const server = createAikidoMcpServer(knowledge, lifecycle);
  await server.connect(new StdioServerTransport());
  const removeSignals = shutdownSignals(() => lifecycle.close(async () => {
    // Let the SDK emit the response for the last completed tool call.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.close();
    removeSignals();
  }, () => undefined));
  console.error(`${SERVER_NAME} ready on stdio (${knowledge.isInitialized ? knowledge.list().length : 0} documents)`);
}

export async function startHttpServer(knowledge: AikidoKnowledgeBase, options: { host: string; port: number; authToken: string }) {
  if (!options.authToken.trim()) throw new Error('MCP_AUTH_TOKEN is required for the HTTP transport');
  await prepareKnowledge(knowledge);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const lifecycle = new Lifecycle();

  const httpServer = createHttpServer((request, response) => {
    const handle = () => handleHttpRequest(request, response, knowledge, options.authToken, transports, lifecycle);
    const handling = request.method === 'POST' && !lifecycle.stopping ? lifecycle.run(async () => {
      const sent = new Promise<void>((resolve) => {
        response.once('finish', resolve);
        response.once('close', resolve);
      });
      await handle();
      await sent;
    }) : handle();
    void handling.catch((error: unknown) => {
      console.error('MCP HTTP handler failed:', error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500).end('MCP request failed');
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, resolve);
  });
  const close = () => lifecycle.close(async () => {
    await Promise.all([...transports.values()].map((transport) => transport.close()));
    const closed = new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    httpServer.closeAllConnections();
    await closed;
    removeSignals();
  }, () => httpServer.closeAllConnections());
  const removeSignals = shutdownSignals(close);
  console.error(`${SERVER_NAME} listening on http://${options.host}:${options.port}/mcp`);
  const address = httpServer.address();
  return { port: typeof address === 'object' && address ? address.port : options.port, close };
}

async function prepareKnowledge(knowledge: AikidoKnowledgeBase): Promise<void> {
  try {
    const info = await lstat(knowledge.root);
    if (info.isDirectory() && (await readdir(knowledge.root)).length === 0) return;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  await knowledge.initialize();
  await knowledge.searchIndex.synchronize();
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse<IncomingMessage>,
  knowledge: AikidoKnowledgeBase,
  authToken: string,
  transports: Map<string, StreamableHTTPServerTransport>,
  lifecycle: Lifecycle,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/healthz' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  if (!['/mcp', '/readyz', '/statusz'].includes(pathname)) {
    response.writeHead(404).end('Not found');
    return;
  }
  if (!authorized(request, authToken)) {
    response.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
    return;
  }
  if (pathname === '/readyz' || pathname === '/statusz') {
    if (request.method !== 'GET') { response.writeHead(405).end('Method not allowed'); return; }
    let rootAvailable = false;
    let rootError: string | undefined;
    try {
      const root = await stat(knowledge.root);
      if (!root.isDirectory()) throw new Error('ROOT is not a directory');
      const candidates = await Promise.all(['prompts/index.md', 'index.md'].map(async (file) => {
        try {
          const target = `${knowledge.root}/${file}`;
          if (!(await stat(target)).isFile()) return false;
          await access(target, constants.R_OK);
          return true;
        }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
          throw error;
        }
      }));
      rootAvailable = candidates.some(Boolean);
    } catch (error) {
      rootError = error instanceof Error ? error.message : String(error);
    }
    const ready = !lifecycle.stopping && knowledge.isInitialized && rootAvailable;
    response.writeHead(pathname === '/readyz' && !ready ? 503 : 200,
      { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
      ready, stopping: lifecycle.stopping,
      root: { initialized: knowledge.isInitialized, available: rootAvailable, error: rootError },
      semantic: knowledge.semanticIndex.status(),
    }));
    return;
  }
  if (lifecycle.stopping) {
    response.writeHead(503, { 'retry-after': '5' }).end('Kimono is shutting down');
    return;
  }

  const sessionId = request.headers['mcp-session-id'];
  let transport: StreamableHTTPServerTransport | undefined;
  if (typeof sessionId === 'string') {
    transport = transports.get(sessionId);
    if (!transport) {
      response.writeHead(404).end('Unknown MCP session');
      return;
    }
  } else if (request.method === 'POST') {
    let initializedSessionId: string | undefined;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        initializedSessionId = id;
        transports.set(id, transport!);
      },
      onsessionclosed: (id) => {
        transports.delete(id);
      },
    });
    const mcpServer = createAikidoMcpServer(knowledge, lifecycle);
    await mcpServer.connect(transport);
    transport.onclose = () => {
      if (initializedSessionId) transports.delete(initializedSessionId);
      void mcpServer.close().catch((error: unknown) => {
        console.error('Unable to close MCP session:', error instanceof Error ? error.message : String(error));
      });
    };
  } else {
    response.writeHead(400).end('MCP session ID required');
    return;
  }

  try {
    await transport.handleRequest(request, response);
  } catch (error) {
    console.error('MCP HTTP request failed:', error instanceof Error ? error.message : String(error));
    if (!response.headersSent) response.writeHead(500).end('MCP request failed');
    else response.end();
  }
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}