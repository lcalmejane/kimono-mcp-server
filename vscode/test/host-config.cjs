"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverRepositories, mergeRepositories, installLauncher, syncMcpJson } = require("../host-config.cjs");

async function tree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kimono-host-"));
  for (const dir of ["a/.git", "b/inner/.git", "node_modules/x/.git", ".hidden/.git", "c"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, "c/.git"), "gitdir: ../.git/modules/c\n");
  return root;
}

test("discovers nested clones and submodules, skipping node_modules and hidden folders", async () => {
  const root = await tree();
  assert.deepEqual(await discoverRepositories(root), [{ path: "a" }, { path: "b/inner" }, { path: "c" }]);
  assert.deepEqual(mergeRepositories([{ path: "a", name: "alpha" }], [{ path: "a" }, { path: "c" }]),
    [{ path: "a", name: "alpha" }, { path: "c" }]);
});

test("launcher path is version-free and re-pointed at the running extension", async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "kimono-storage-"));
  const first = await installLauncher("/ext/kimono-rag-mcp-0.9.7-darwin-arm64", storage);
  const second = await installLauncher("/ext/kimono-rag-mcp-0.9.8-darwin-arm64", storage);
  assert.equal(first, second);
  assert.doesNotMatch(second, /\d+\.\d+\.\d+/);
  const body = await fs.readFile(second, "utf8");
  assert.match(body, /0\.9\.8/);
  assert.doesNotMatch(body, /0\.9\.7/);
});

test(".mcp.json Kimono entries migrate to the launcher; other servers untouched; no file created unasked", async () => {
  const root = await tree();
  assert.equal((await syncMcpJson(root, "/s/bin/kimono-mcp", [])).changed, false);
  await assert.rejects(fs.access(path.join(root, ".mcp.json")));
  const old = "/x/ai-kido.kimono-rag-mcp-0.9.7-darwin-arm64";
  await fs.writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: {
    kimono: { type: "stdio", command: `${old}/runtime/node`, args: [`${old}/stdio.cjs`, "serve", "--root", "/r"], env: { AIKIDO_ROOT: "/r" } },
    other: { command: "other-server" },
  } }));
  const repositories = [{ path: "a" }];
  const result = await syncMcpJson(root, "/s/bin/kimono-mcp", repositories);
  assert.equal(result.changed, true);
  const document = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(document.mcpServers.kimono.command, "/s/bin/kimono-mcp");
  assert.deepEqual(document.mcpServers.kimono.args, ["serve", "--root", "/r"]);
  assert.equal(document.mcpServers.kimono.env.KIMONO_REPOSITORIES, JSON.stringify(repositories));
  assert.deepEqual(document.mcpServers.other, { command: "other-server" });
  assert.equal((await syncMcpJson(root, "/s/bin/kimono-mcp", repositories)).changed, false);
});

test("explicit write creates a Kimono entry", async () => {
  const root = await tree();
  const result = await syncMcpJson(root, "/s/bin/kimono-mcp", [{ path: "a" }], { create: true });
  assert.equal(result.changed, true);
  const entry = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).mcpServers.kimono;
  assert.deepEqual(entry.args, ["serve", "--root", root]);
});

test("concurrent launcher installs (activation + Autoconfig) never race on a shared temporary file", async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "kimono-storage-"));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    installLauncher(`/ext/kimono-rag-mcp-0.9.${index % 2 ? 9 : 8}-darwin-arm64`, storage)));
  assert.equal(new Set(results).size, 1);
  assert.deepEqual((await fs.readdir(path.join(storage, "bin"))).filter(name => name.endsWith(".tmp")), []);
});
