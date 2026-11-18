"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collaborationBaseKey, decodeToolResult, manifestHash, scanReplica, validKnowledgePath,
} = require("../collaboration.cjs");

test("replica file paths reject traversal, symlinks targets, secrets and private specs", () => {
  for (const path of ["../README.md", "/etc/passwd", "prompts/../README.md", ".git/config",
    "prompts/spec/private.md", "credentials/token.txt", ".env", "keys/server.pem", "a\\b.md", "web/index.html"]) {
    assert.equal(validKnowledgePath(path), false, path);
  }
  for (const path of ["README.md", "prompts/index.md", "prompts/gen/README.md"]) {
    assert.equal(validKnowledgePath(path), true, path);
  }
});

test("replica baseline is scoped to both canonical workspace and remote target", () => {
  assert.notEqual(collaborationBaseKey("/workspace/a", "https://mcp.example"), collaborationBaseKey("/workspace/b", "https://mcp.example"));
  assert.notEqual(collaborationBaseKey("/workspace/a", "https://mcp.example"), collaborationBaseKey("/workspace/a", "https://other.example"));
  assert.match(manifestHash(Buffer.from("fixture")), /^[a-f0-9]{64}$/);
});

test("standalone manifest scanner respects file/path eligibility and bounded content", async t => {
  const fs = require("node:fs/promises"), path = require("node:path");
  const root = await fs.mkdtemp(path.join(__dirname, "../.local-runtime-replica-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  require("node:child_process").execFileSync("git", ["init", "--quiet", root]);
  await fs.writeFile(path.join(root, "README.md"), "# Knowledge\n");
  await fs.writeFile(path.join(root, ".gitignore"), "generated/\n");
  await fs.mkdir(path.join(root, "generated"));
  await fs.writeFile(path.join(root, "generated/large.cjs"), "x".repeat(256 * 1024 + 1));
  const result = await scanReplica(root);
  assert.ok(result.manifest["README.md"]);
  assert.ok(Object.keys(result.manifest).every(validKnowledgePath));
  assert.equal(Object.keys(result.manifest).some(path => path.startsWith(".git/")), false);
  assert.equal(Object.hasOwn(result.manifest, "generated/large.cjs"), false);
  assert.ok(result.totalBytes <= 8 * 1024 * 1024);
  await fs.writeFile(path.join(root, "large.md"), "x".repeat(256 * 1024 + 1));
  await assert.rejects(scanReplica(root), /256 KiB/);
});

test("MCP tool responses are decoded without trusting error or non-JSON content", () => {
  const encoded = JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ sharedVersion: "v1" }) }] });
  assert.deepEqual(decodeToolResult(encoded), { sharedVersion: "v1" });
  assert.deepEqual(decodeToolResult(JSON.stringify({ content: [{ type: "text", text: "Index updated." }] }), false),
    { message: "Index updated." });
  assert.throws(() => decodeToolResult(JSON.stringify({ isError: true, content: [] })), /tool error/);
  assert.throws(() => decodeToolResult(JSON.stringify({ content: [{ type: "text", text: "not json" }] })), /invalid JSON/);
});

test("Kimono pairs with Tatami Core by itself: project-scoped token, verified account, same-origin approval page", async () => {
  const { pairWithTatami } = require("../collaboration.cjs");
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  let polls = 0;
  const fetcher = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    const route = new URL(url).pathname;
    if (route === "/extension-auth/pairings") return reply(201, { pairingId: "p1", pairingUrl: "https://tatami.example/extension-auth/approve?p=p1", expiresAt: Date.now() + 60_000 });
    if (route === "/extension-auth/pairings/poll") return reply(200, ++polls < 2 ? { status: "pending" } : { status: "approved", accessToken: "tok", projectId: "kb", expiresAt: Date.now() + 3_600_000 });
    if (route === "/api/me") { assert.equal(init.headers.Authorization, "Bearer tok"); return reply(200, { user: { id: "u1", name: "Ana" } }); }
    return reply(404, {});
  };
  const opened = [];
  const savedFetch = global.fetch; global.fetch = fetcher;
  try {
    const connection = await pairWithTatami("https://tatami.example", { openExternal: async url => opened.push(url), fetcher, intervalMs: 1 });
    assert.deepEqual({ origin: connection.origin, token: connection.token, projectId: connection.projectId, userName: connection.userName },
      { origin: "https://tatami.example", token: "tok", projectId: "kb", userName: "Ana" });
    assert.deepEqual(opened, ["https://tatami.example/extension-auth/approve?p=p1"]);
    assert.deepEqual(calls, ["POST /extension-auth/pairings", "POST /extension-auth/pairings/poll", "POST /extension-auth/pairings/poll", "GET /api/me"]);
    await assert.rejects(() => pairWithTatami("http://tatami.example", { openExternal: async () => {}, fetcher }), /HTTPS/);
    const foreign = async (url, init) => new URL(url).pathname === "/extension-auth/pairings"
      ? reply(201, { pairingId: "p", pairingUrl: "https://evil.example/x" }) : fetcher(url, init);
    await assert.rejects(() => pairWithTatami("https://tatami.example", { openExternal: async () => {}, fetcher: foreign }), /Unexpected/);
  } finally { global.fetch = savedFetch; }
});
