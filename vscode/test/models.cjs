"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parse, confirmation } = require("../management/model-actions.js");
const { startRemoteMcpClient } = require("../mcp-client.cjs");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

test("all three HTML entries load the model helper before their callbacks", async () => {
  const workspace = path.resolve(__dirname, "../../..");
  for (const relative of ["kimono-mcp-server/vscode/management/kimono.html", "tatami-agent/vscode/management/kimono.html"]) {
    const html = await readFile(path.join(workspace, relative), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)src="([^"]+)"[^>]*>/g)];
    assert.deepEqual(scripts.map(item => path.basename(item[2])), ["status-format.js", "kimono-view.js", "model-actions.js", "kimono.js"]);
    assert.ok(scripts.every(item => item[1].includes('nonce="{{nonce}}"')));
    assert.match(html, /script-src 'nonce-\{\{nonce\}\}'/);
  }
  const core = await readFile(path.join(workspace, "tatami-core/public/index.html"), "utf8");
  assert.match(core, /<script src="\/kimono\/model-actions.js" defer><\/script>/);
  assert.ok(core.indexOf("/kimono/model-actions.js") < core.indexOf('src="/app.js"'));
});

const status = { models: [{ id: "multilingual-fast", repository: "approved/source", revision: "pinned-sha",
  license: "Apache-2.0", downloadBytes: 512000000 }] };

test("remote management uses configured authenticated MCP, not embedded launch settings", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push({ ...request, authorization: req.headers.authorization, session: req.headers["mcp-session-id"] });
    if (!request.id) { res.writeHead(202); res.end(); return; }
    const result = request.method === "initialize" ? { protocolVersion: "2025-03-26" }
      : { content: [{ type: "text", text: JSON.stringify(status) }] };
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "models-session" });
    res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = startRemoteMcpClient(`http://127.0.0.1:${server.address().port}/mcp`, "private-token");
  try {
    assert.deepEqual(await client.call("aikido_models", { operation: "status" }), status);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => request.authorization === "Bearer private-token"));
    assert.equal(requests.at(-1).session, "models-session");
    assert.deepEqual(requests.at(-1).params, { name: "aikido_models", arguments: { operation: "status" } });
  } finally { client.close(); await new Promise(resolve => server.close(resolve)); }
});

test("model consent is explicit, metadata-backed, and cannot introduce paths or URLs", () => {
  assert.deepEqual(parse({ operation: "status" }, true), { operation: "status" });
  assert.throws(() => parse({ operation: "install", model: "code" }, true));
  assert.throws(() => parse({ operation: "install", model: "e5", confirmed: true }, true));
  assert.throws(() => parse({ operation: "configure", policy: "auto-speed", confirmed: "yes" }, true));
  assert.throws(() => parse({ operation: "install", model: "code", confirmed: true, url: "https://example.test" }, true));
  assert.deepEqual(parse({ operation: "configure", policy: "e5", confirmed: true }, true),
    { operation: "configure", policy: "e5", confirmed: true });
  for (const language of ["en", "fr"]) {
    const text = confirmation({ operation: "install", model: "multilingual-fast" }, status, language);
    for (const expected of ["approved/source", "pinned-sha", "Apache-2.0", "512000000"]) assert.ok(text.includes(expected));
  }
  assert.throws(() => confirmation({ operation: "install", model: "code" }, status));
  assert.match(confirmation({ operation: "configure", policy: "auto-balanced" }, status), /previous generation remains active/);
});

test("shared model UI is lazy, shows actual server policy and emits only explicit actions", () => {
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; this.classList = { add() {} };
      this.textContent = ""; this.value = "";
    }
    append(...children) { for (const child of children) { this.children.push(child); if (typeof child === "object") child.parentElement = this; } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute() {}
    removeAttribute() {}
    addEventListener(name, callback) { this.events[name] = callback; }
    querySelectorAll() { return []; }
  }
  const previous = global.document;
  global.document = { createElement: tag => new Element(tag), documentElement: { lang: "en" } };
  try {
    const calls = [];
    const root = new Element("main");
    const view = require("../management/kimono-view.js").create(root, {
      language: "en", onModelsRequest: (input, folder) => calls.push({ input, folder }),
    });
    const descendants = element => [element, ...element.children.filter(child => typeof child === "object").flatMap(descendants)];
    const allText = () => descendants(root).map(item => item.textContent).join("\n");
    view.configureModels({ folders: [{ id: "folder-one", name: "One" }] });
    assert.equal(calls.length, 0, "Opening the management panel alone must not request model status");
    const card = descendants(root).find(item => item.tag === "details" && item.children[0]?.textContent === "Embedding models");
    card.open = true; card.events.toggle();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input, { operation: "status" });
    view.showModels({
      requestedPolicy: "auto-speed", activePolicy: "e5", reason: "previous generation retained", phase: "download-required",
      corpus: { codeFiles: 42, documentFiles: 7, bytes: 1048576 }, requiredModels: ["multilingual-fast"],
      missingModels: ["multilingual-fast"], reconstructionRequired: true, profiles: [{ id: "code", model: "e5", files: 42 }],
      models: [{ ...status.models[0], installed: false, estimatedMemoryBytes: 1024000000,
        backend: "static", dimensions: 256, chunkChars: 2000 }],
    });
    for (const text of ["auto-speed", "e5", "previous generation retained", "download-required", "multilingual-fast", "42 code", "489 MiB"]) {
      assert.ok(allText().includes(text), text);
    }
    assert.equal(calls.length, 1, "Rendering status must not trigger installation or configuration");
    descendants(root).find(item => item.tag === "button" && item.textContent === "Download only…").events.click();
    assert.deepEqual(calls.at(-1).input, { operation: "install", model: "multilingual-fast" });
    assert.equal(calls.at(-1).input.confirmed, undefined, "Consent belongs to the host dialog");
    const policy = descendants(root).find(item => item.id === "kimono-policy");
    policy.value = "code";
    descendants(root).find(item => item.tag === "button" && item.textContent === "Switch policy / rebuild…").events.click();
    assert.deepEqual(calls.at(-1).input, { operation: "configure", policy: "code" });
    view.showModels({ requestedPolicy: "e5", activePolicy: null, reason: "not initialized", phase: "download-required",
      missingModels: ["e5"], requiredModels: ["e5"], corpus: {},
      models: [{ id: "e5", installed: false, repository: "host/bundle", revision: "pinned", license: "MIT", downloadBytes: 0 }] });
    assert.ok(allText().includes("Not active yet"));
    assert.ok(allText().includes("cannot be downloaded here"));
    assert.ok(!descendants(root).some(item => item.tag === "button" && item.textContent === "Download only…"));
    view.dispose();
  } finally { global.document = previous; }
});
