#!/usr/bin/env node
import { AikidoKnowledgeBase } from './knowledge.js';
import { startHttpServer, startStdioServer } from './server.js';
import { AIKIDO_REPOSITORY, installAikido } from './repository.js';
export { installAikido } from './repository.js';

interface ParsedArgs {
  command: string;
  options: Map<string, string>;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, options } = parseArgs(argv);
  if (options.has('repository')) process.env.AIKIDO_REPOSITORY = options.get('repository');
  if (options.has('ref')) process.env.AIKIDO_REF = options.get('ref');
  if (command === 'init') {
    const target = requiredOption(options, 'root');
    await installAikido(target, options.get('ref') ?? process.env.AIKIDO_REF ?? 'main',
      options.get('repository') ?? process.env.AIKIDO_REPOSITORY ?? AIKIDO_REPOSITORY);
    console.error(`AI-KIDO installed at ${target}. Set AIKIDO_ROOT=${target}.`);
    return;
  }
  if (command !== 'serve' && command !== 'index') {
    throw new Error(`Unknown command "${command}". Use serve, index, or init --root <path> [--repository <url>] [--ref <git-ref>].`);
  }

  const root = options.get('root') ?? process.env.AIKIDO_ROOT;
  if (!root) throw new Error('Set AIKIDO_ROOT or provide --root <path> to an AI-KIDO checkout.');
  const knowledge = new AikidoKnowledgeBase(root);
  if (command === 'index') {
    await knowledge.initialize();
    if (options.get('mode') === 'semantic') {
      console.error(JSON.stringify(await knowledge.semanticIndex.run('update')));
      return;
    }
    if (options.has('mode') && options.get('mode') !== 'literal') throw new Error('index --mode must be literal or semantic');
    console.error(await knowledge.searchIndex.maintain('update'));
    return;
  }
  const transport = process.env.MCP_TRANSPORT ?? 'stdio';
  if (transport === 'stdio') {
    await startStdioServer(knowledge);
    return;
  }
  if (transport === 'http') {
    const port = parsePort(process.env.MCP_PORT ?? '3000');
    const host = process.env.MCP_HOST ?? '127.0.0.1';
    await startHttpServer(knowledge, { host, port, authToken: process.env.MCP_AUTH_TOKEN ?? '' });
    return;
  }
  throw new Error(`Unsupported MCP_TRANSPORT "${transport}". Expected stdio or http.`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'serve', ...tokens] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf('=');
    const name = token.slice(2, separator < 0 ? undefined : separator);
    const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
    const value = inlineValue ?? tokens[++index];
    if (!value || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
    if (!['root', 'ref', 'repository', 'mode'].includes(name)) throw new Error(`Unknown option: --${name}`);
    if (options.has(name)) throw new Error(`Option --${name} was provided more than once`);
    options.set(name, value);
  }
  return { command, options };
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`Option --${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MCP_PORT must be an integer from 1 to 65535; received "${value}"`);
  return port;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('kimono-mcp-server:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}