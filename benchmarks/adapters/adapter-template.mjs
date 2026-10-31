#!/usr/bin/env node
// Adapter template for `harness.kind: "external"` (see docs/harness-benchmark.md and docs/benchmark-database.md).
//
// bench-harness.ts runs this program once per cell (task x variant), from a read-only copy of the corpus.
//   node adapter-template.mjs --request <request.json> --response <response.json>
//
// request.json: { schemaVersion, variant: "without" | "with", model, corpus, prompt, mcp, output }
//   - corpus: absolute path of the read-only corpus copy (also the working directory)
//   - prompt: the task prompt; send it to your client as-is
//   - mcp:    null for "without"; for "with" a { command, args, env } stdio MCP server to register in the client
//
// Your job, in runClient():
//   1. Start a FRESH session of your client with `request.model` (no history, no memory, no custom instructions).
//   2. Allow only read/search tools: your client's native grep/glob/read, plus the Kimono MCP in the "with" variant.
//      Disable writes, shell, network, sub-agents and every other MCP server.
//   3. Send `request.prompt`, wait for the final answer (the JSON object the prompt asks for).
//   4. Report what happened, never what you expect:
//        answer   the final answer text
//        mcpUsed  true only if the client actually CALLED a Kimono tool (observed), false otherwise
//        usage    only the counters your client really exposes (omit the others)
//
// Environment: the harness passes only PATH, HOME (isolated), TMPDIR and the `harness.env` of the config.
// Put API keys or client settings there, never in the repository.
import { readFile, writeFile } from 'node:fs/promises';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

async function runClient(request) {
  // Replace this body. Example shape of the value to return:
  //   return {
  //     answer: '{"summary":"...","evidence":[{"path":"src/a.ts","startLine":1,"endLine":9,"reason":"..."}],"plan":[],"tests":[],"risks":[]}',
  //     mcpUsed: false,
  //     usage: { modelMetrics: { 'actual-model-id': { usage: {
  //       inputTokens: 123, outputTokens: 45, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } },
  //       totalApiDurationMs: 1000 },
  //   };
  // `inputTokens` semantics differ between providers (cache included or not): state yours in the record notes.
  throw new Error(`Adapter not implemented: wire your client in runClient() (variant "${request.variant}", model "${request.model}")`);
}

if (process.argv.includes('--version')) {
  console.log('adapter-template 1');
} else {
  const request = JSON.parse(await readFile(option('request'), 'utf8'));
  const response = await runClient(request);
  if (typeof response?.answer !== 'string' || typeof response.mcpUsed !== 'boolean') {
    throw new Error('runClient must return { answer: string, mcpUsed: boolean, usage?: object }');
  }
  await writeFile(option('response'), `${JSON.stringify(response, null, 2)}\n`);
}
