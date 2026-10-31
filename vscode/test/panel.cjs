"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { registerManagement } = require("../panel.cjs");
const { lines, overall, readIndexStatus, summarize } = require("../status.cjs");

const extensionPath = path.join(__dirname, "..");

test("shared status distinguishes completed partial indexes from fully indexed content in both languages", () => {
  const partial = { phase: "ready", chunks: 10, skippedChunks: 2 };
  assert.equal(summarize(partial, "en"), "Partially indexed");
  assert.equal(summarize(partial, "fr"), "Indexation partielle");
  assert.ok(lines(partial, "en").some(row => row.label === "Skipped chunks" && row.value === "2"));
  assert.ok(lines(partial, "fr").some(row => row.label === "Passages non vectorisés" && row.value === "2"));
  assert.equal(summarize({ ...partial, skippedChunks: 0 }, "en"), "Indexed");
});

test("shared status exposes measured provider choice without claiming GPU execution", () => {
  const status = { phase: "running", batchMs: 40, runtime: { executionProvider: "cpu", gpuExecutionVerified: false,
    benchmarks: [{ executionProvider: "cpu", medianMs: 70 }, { executionProvider: "coreml", medianMs: 900 }] } };
  assert.ok(lines(status, "en").some(row => row.label === "Execution provider" && row.value === "CPU"));
  assert.ok(lines(status, "fr").some(row => row.label === "Mesure au démarrage" && row.value === "CPU: 70 ms · COREML: 900 ms"));
  assert.ok(lines(status, "en").some(row => row.label === "Last batch" && row.value === "40 ms"));
});

test("shared status exposes worker lifecycle, model and measured resource estimates in both languages", () => {
  const status = {
    phase: "ready", model: "multilingual-model", worker: { phase: "ready", pid: process.pid },
    hotIndexes: 2, hotIndexEstimatedBytes: 16 * 1024 ** 2,
    runtime: {
      executionProvider: "cpu", gpuExecutionVerified: false, workers: 2, threads: 2, batch: 16, benchmarks: [],
      resources: {
        availableCpus: 8, cpuPercent: 80, cpuBudget: 6, availableMemoryBytes: 4 * 1024 ** 3,
        memoryPercent: 75, memoryBudgetBytes: 3 * 1024 ** 3, estimatedMemoryBytes: 1024 ** 3,
      },
    },
  };
  const english = lines(status, "en");
  const french = lines(status, "fr");
  assert.ok(english.some(row => row.label === "Persistent worker" && row.value === "Ready · model warm"));
  assert.ok(english.some(row => row.label === "Warm indexes" && row.value === "2"));
  assert.ok(english.some(row => row.label === "Warm index estimate" && row.value === "16.0 MiB"));
  assert.ok(english.some(row => row.label === "Embedding model" && row.value === "multilingual-model"));
  assert.ok(english.some(row => row.label === "CPU budget" && row.value === "6 / 8 CPUs (80%)"));
  assert.ok(english.some(row => row.label === "Estimated memory" && row.value === "1.0 GiB / 3.0 GiB (75%)"));
  assert.ok(french.some(row => row.label === "Worker persistant" && row.value === "Prêt · modèle chargé"));
  assert.ok(french.some(row => row.label === "Index gardés en mémoire" && row.value === "2"));
  assert.ok(french.some(row => row.label === "Modèle d'embedding" && row.value === "multilingual-model"));
  assert.ok(french.some(row => row.label === "Budget CPU" && row.value === "6 / 8 cœurs CPU (80%)"));
  assert.ok(french.some(row => row.label === "Mémoire estimée" && row.value === "1.0 GiB / 3.0 GiB (75%)"));
  assert.ok(lines({ worker: { phase: "error", error: "worker exited" } }, "en")
    .some(row => row.label === "Worker detail" && row.value === "worker exited"));
});

test("index status reports live counters, ETA and interrupted indexers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kimono-status-"));
  const file = path.join(directory, "semantic-status.json");
  assert.deepEqual(await readIndexStatus(file), { phase: "not-indexed" });
  const running = { phase: "running", stage: "document_embedding", pid: process.pid, host: os.hostname(),
    files: { completed: 40, total: 40 }, estimatedTokens: { completed: 120000, total: 120000 },
    embedded: { completed: 50, total: 100 }, chunksPerSecond: 25, etaSeconds: 2 };
  await fs.writeFile(file, JSON.stringify(running));
  const status = await readIndexStatus(file);
  assert.equal(status.pid, undefined);
  assert.equal(overall(status), 0.55);
  assert.equal(summarize(status), "Indexing · 55% · embedding chunks · ETA 2s");
  assert.deepEqual(lines(status).map(line => `${line.label}=${line.value}`),
    ["Files=40 / 40", "Tokens (est.)=120k / 120k", "Chunks=50 / 100", "Rate=25 chunks/s", "ETA=2s"]);
  await fs.writeFile(file, JSON.stringify({ ...running, host: "another-host" }));
  assert.equal((await readIndexStatus(file)).phase, "interrupted");
  await fs.writeFile(file, JSON.stringify({ phase: "ready", chunks: 300, files: { completed: 40, total: 40 }, indexedAt: "2026-10-25T10:00:00Z" }));
  const ready = await readIndexStatus(file);
  assert.equal(overall(ready), 1);
  assert.match(lines(ready).map(line => `${line.label}=${line.value}`).join(","), /Files=40 \/ 40,Chunks=300,Last indexed=/);
  await fs.writeFile(file, JSON.stringify({
    phase: "ready", pid: process.pid, host: os.hostname(), worker: { phase: "ready", pid: Number.MAX_SAFE_INTEGER },
  }));
  assert.deepEqual((await readIndexStatus(file)).worker, { phase: "stopped" });
  await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(settings = {}, language = "en") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kimono-panel-"));
  const state = { settings: { mode: "embedded", corpusMode: "rag", ...settings }, updates: [], commands: new Map(), messages: [], errors: [] };
  const uri = fsPath => ({ scheme: "file", fsPath, toString: () => `file://${fsPath}` });
  const folder = { mode: "embedded", name: "Docs", uri: uri(directory), root: directory, identity: "docs", statusFile: path.join(directory, "status.json") };
  const disposable = { dispose() {} };
  const vscode = {
    EventEmitter: class { event = () => disposable; fire() { state.fired = (state.fired ?? 0) + 1; } dispose() {} },
    TreeItem: class { constructor(label, collapsibleState) { Object.assign(this, { label, collapsibleState }); } },
    TreeItemCollapsibleState: { None: 0, Expanded: 2 },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1 },
    Uri: { file: uri, parse: value => ({ value }) },
    env: { language, openExternal: async value => { state.opened = value; } },
    workspace: {
      isTrusted: true,
      getConfiguration: () => ({
        get: (key, fallback) => state.settings[key] ?? fallback,
        update: async (key, value, target) => { state.updates.push({ key, value, target }); },
      }),
      onDidChangeConfiguration: () => disposable, onDidChangeWorkspaceFolders: () => disposable,
    },
    commands: {
      registerCommand: (id, action) => { state.commands.set(id, action); return disposable; },
      executeCommand: async (...args) => { state.executed = args; },
      getCommands: async () => ["workbench.mcp.listServer", "workbench.action.openSettings"],
    },
    window: {
      createTreeView: (_id, options) => {
        state.tree = options.treeDataProvider;
        return { visible: false, onDidChangeVisibility: callback => { state.visibility = callback; return disposable; }, dispose() {} };
      },
      createStatusBarItem: () => (state.bar = { show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }),
      createWebviewPanel: (id, title) => {
        let receive, dispose;
        state.panel = { id, title, reveal() {}, onDidDispose: callback => { dispose = callback; return disposable; },
          close: () => dispose(), dispose: () => dispose(),
          webview: {
            cspSource: "vscode-resource:", asWebviewUri: value => `webview:${value.fsPath}`,
            postMessage: async message => { state.messages.push(message); },
            onDidReceiveMessage: callback => { receive = callback; return disposable; },
          } };
        state.receive = message => receive(message);
        return state.panel;
      },
      showErrorMessage: message => state.errors.push(message),
      showWarningMessage: async (...args) => { state.warning = args; return state.confirmation; },
    },
  };
  const context = { extensionPath, secrets: { get: async () => state.secret, onDidChange: () => disposable } };
  const disposables = registerManagement(vscode, context, {
    config: () => vscode.workspace.getConfiguration("kimono"), embeddedFolders: () => [folder],
    embeddedLaunch: async () => { if (state.launch) return state.launch; throw new Error("not started in tests"); }, remoteUrl: value => value.startsWith("https://") ? value : undefined,
    tokenKey: "kimono.token", version: "0.6.2",
  });
  return { state, folder, directory, dispose: async () => {
    for (const value of disposables) value.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  } };
}

test("management exposes live status in the status bar and central webview, not an intermediate tree", async () => {
  const { state, folder, dispose } = await fixture();
  await fs.writeFile(folder.statusFile, JSON.stringify({ phase: "running", stage: "reading_documents", pid: process.pid, host: os.hostname(),
    files: { completed: 3, total: 10 }, estimatedTokens: { completed: 900, total: 3000 } }));
  for (const id of ["kimono.openPanel", "kimono.testSearch", "kimono.startIndex"]) assert.ok(state.commands.has(id), id);
  await state.commands.get("kimono.openPanel")();
  assert.equal(state.panel.title, "Kimono MCP");
  assert.match(state.panel.webview.html, /webview:.*management\/kimono\.js/);
  assert.doesNotMatch(state.panel.webview.html, /{{/);
  await state.receive({ action: "refresh" });
  const view = state.messages.find(message => message.type === "state").value;
  assert.equal(view.language, "en");
  assert.equal(view.folders[0].status.phase, "running");
  assert.match(state.panel.webview.html, /<html lang="en">/);
  for (const asset of ["status-format.js", "kimono-view.js", "kimono-view.css"]) assert.match(state.panel.webview.html, new RegExp(`management/${asset.replace(".", "\\.")}`));
  assert.equal(state.bar.text, "Kimono: Indexing · 3% · reading files");
  assert.ok(state.bar.shown);
  assert.deepEqual(state.tree.getChildren(), []);
  state.panel.close();
  await dispose();
});

test("management follows the VS Code display language", async () => {
  const { state, folder, dispose } = await fixture({}, "fr-FR");
  await fs.writeFile(folder.statusFile, JSON.stringify({ phase: "running", stage: "reading_documents", pid: process.pid, host: os.hostname(),
    files: { completed: 3, total: 10 }, estimatedTokens: { completed: 900, total: 3000 } }));
  await state.commands.get("kimono.openPanel")();
  assert.match(state.panel.webview.html, /<html lang="fr">/);
  await state.receive({ action: "refresh" });
  assert.equal(state.messages.find(message => message.type === "state").value.language, "fr");
  assert.equal(state.bar.text, "Kimono: Indexation · 3% · lecture des fichiers");
  assert.deepEqual(state.tree.getChildren(), []);
  state.panel.close();
  await dispose();
});

test("clicking the Kimono activity-bar icon closes the sidebar and opens the central panel directly", async () => {
  const { state, dispose } = await fixture();
  try {
    state.visibility({ visible: false });
    assert.equal(state.panel, undefined);
    state.visibility({ visible: true });
    for (let attempt = 0; !state.panel && attempt < 50; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(state.executed, ["workbench.action.closeSidebar"]);
    assert.equal(state.panel.id, "kimono.management");
    assert.deepEqual(state.tree.getChildren(), []);
  } finally { await dispose(); }
});

test("shared panel view and formatter load as modules with both languages", () => {
  const view = require("../management/kimono-view.js");
  const format = require("../management/status-format.js");
  assert.equal(typeof view.create, "function");
  assert.equal(view.language("fr-CA"), "fr");
  assert.equal(view.language("de"), "en");
  assert.deepEqual(Object.keys(view.strings.fr).sort(), Object.keys(view.strings.en).sort());
  assert.equal(view.translator("en")("snapshot", { version: 3, documents: 7 }), "Snapshot 3 · 7 documents");
  const ready = format.view({ phase: "ready", files: { completed: 4, total: 4 }, chunks: 12 }, "fr");
  assert.equal(ready.progress, 1);
  assert.deepEqual(ready.lines.map(line => line.label), ["Fichiers", "Passages"]);
  assert.equal(format.view({ phase: "waiting" }).progress, null);
});

test("status formatter shows mixed embedding profiles and model downloads", () => {
  const format = require("../management/status-format.js");
  const mixed = format.view({ phase: "running", stage: "document_embedding", files: { completed: 10, total: 10 }, embedded: { completed: 40, total: 100 },
    embedding: { policy: "auto-balanced", mixed: true, current: "code", profiles: [
      { id: "multilingual", model: "multilingual-fast", scope: "documents", state: "done", chunks: 300, embedded: { completed: 300, total: 300 } },
      { id: "code", model: "code", scope: "code", state: "running" }] } }, "en");
  const lines = Object.fromEntries(mixed.lines.map(line => [line.label, line.value]));
  assert.match(lines["Embedding mode"], /Automatic · balanced · Mixed/);
  assert.match(lines["Documents profile"], /multilingual-fast · Done · 300 \/ 300/);
  assert.match(lines["Code profile"], /code · Embedding · 40 \/ 100/);
  assert.match(mixed.summary, /Code profile 2\/2/);
  const download = { model: "multilingual-fast", state: "downloading", file: "model.safetensors", fileIndex: 1, fileCount: 4, bytes: 262144000, totalBytes: 524288000 };
  const idle = format.view({ phase: "ready", chunks: 5, downloads: [download] }, "fr");
  assert.equal(idle.active, true, "a download keeps the fast refresh loop");
  assert.equal(idle.progress, 0.5);
  assert.match(idle.lines.at(-1).value, /Téléchargement · 50% · 250.0 MiB \/ 500.0 MiB · model.safetensors \(1\/4\)/);
  assert.equal(format.view({ phase: "ready", chunks: 5, downloads: [{ ...download, state: "done" }] }, "fr").active, false);
  assert.equal(format.view({ phase: "ready", downloads: [{ model: "x", state: "hacked" }, null] }, "en").lines.length, 0, "unknown download states are ignored");
});

test("management validates settings and keeps indexing to embedded mode", async () => {
  const { state, folder, dispose } = await fixture({ mode: "remote" });
  await state.commands.get("kimono.openPanel")();
  await state.receive({ action: "setting", key: "corpusMode", value: "aikido" });
  await state.receive({ action: "setting", key: "root", folder: folder.uri.toString(), value: "docs" });
  await state.receive({ action: "setting", key: "url", value: "http://example.com/mcp" });
  await state.receive({ action: "setting", key: "__proto__", value: "x" });
  await state.receive({ action: "indexStart", folder: folder.uri.toString() });
  await state.receive({ action: "runCommand" });
  assert.deepEqual(state.updates, [{ key: "corpusMode", value: "aikido", target: 1 }, { key: "root", value: "docs", target: 3 }]);
  const errors = state.messages.filter(message => message.type === "error").map(message => message.message);
  assert.equal(errors.length, 4);
  assert.match(errors[2], /Switch Mode to Embedded/);
  assert.match(errors[3], /not allowed/);
  await state.receive({ action: "website" });
  assert.equal(state.opened.value, "https://ai-kido.fr");
  state.panel.close();
  await dispose();
});

test("manifest contributes the Kimono view, commands and packaged assets", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "package.json"), "utf8"));
  assert.equal(manifest.icon, "media/icon.png");
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].icon, "media/kimono.svg");
  assert.equal(manifest.contributes.views.kimono[0].id, "kimono.status");
  const commands = manifest.contributes.commands.map(command => command.command);
  for (const id of ["kimono.openPanel", "kimono.testSearch", "kimono.startIndex"]) assert.ok(commands.includes(id), id);
  for (const file of ["panel.cjs", "mcp-client.cjs", "search.cjs", "status.cjs", "management/kimono.html", "management/kimono.js", "management/kimono-view.js", "management/kimono-view.css", "management/status-format.js", "media/kimono.svg", "media/icon.png"]) {
    await fs.access(path.join(extensionPath, file));
  }
  assert.ok(manifest.files.includes("management/**") && manifest.files.includes("media/**"));
});

test("full rebuild needs native confirmation and routes only a background semantic rebuild", async () => {
  const { state, directory, folder, dispose } = await fixture();
  try {
    await state.commands.get("kimono.openPanel")();
    await state.receive({ action: "indexRebuild", folder: folder.uri.toString() });
    assert.match(state.warning[0], /Sources and snapshots are unchanged/);
    assert.deepEqual(state.warning[1], { modal: true });
    assert.match(state.messages.at(-1).message, /cancelled/);
    const requestFile = path.join(directory, "requests.json");
    state.launch = { command: process.execPath, cwd: directory, env: process.env, args: ["-e", `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "tools/call") fs.writeFileSync(${JSON.stringify(requestFile)}, JSON.stringify(request.params));
        process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id:request.id,
          result: request.method === "tools/call" ? { content:[{type:"text",text:'{"phase":"running"}'}] } : {} }) + "\\n");
      });

    `] };
    state.confirmation = "Rebuild";
    await state.receive({ action: "indexRebuild", folder: folder.uri.toString() });
    assert.deepEqual(JSON.parse(await fs.readFile(requestFile, "utf8")), {
      name: "aikido_index", arguments: { operation: "rebuild", mode: "semantic", background: true },
    });
    assert.match(state.messages.at(-1).message, /Rebuild started/);
    state.settings.mode = "remote";
    await state.receive({ action: "indexRebuild", folder: folder.uri.toString() });
    assert.match(state.messages.at(-1).message, /Switch Mode to Embedded/);
  } finally { await dispose(); }
});

test("stop sends an immediate cancel and deleting the index needs native confirmation", async () => {
  const { state, directory, folder, dispose } = await fixture();
  try {
    await state.commands.get("kimono.openPanel")();
    const requestFile = path.join(directory, "control-requests.jsonl");
    state.launch = { command: process.execPath, cwd: directory, env: process.env, args: ["-e", `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "tools/call") fs.appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify(request.params) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id:request.id,
          result: request.method === "tools/call" ? { content:[{type:"text",text:'{"phase":"unknown"}'}] } : {} }) + "\\n");
      });
    `] };
    const sent = async () => (await fs.readFile(requestFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));

    // Stopping is not destructive: no confirmation, and no background flag since the answer is immediate.
    await state.receive({ action: "indexStop", folder: folder.uri.toString() });
    assert.deepEqual((await sent()).filter(call => call.arguments.operation === "cancel"),
      [{ name: "aikido_index", arguments: { operation: "cancel", mode: "semantic" } }]);
    assert.match(state.messages.at(-1).message, /stopped/);

    // Deleting asks first; a refusal sends nothing.
    await state.receive({ action: "indexReset", folder: folder.uri.toString() });
    assert.match(state.warning[0], /Sources, snapshots, text search and the embedding policy are kept/);
    assert.deepEqual(state.warning[1], { modal: true });
    assert.match(state.messages.at(-1).message, /cancelled/);
    assert.equal((await sent()).some(call => call.arguments.operation === "reset"), false);

    state.confirmation = "Delete";
    await state.receive({ action: "indexReset", folder: folder.uri.toString() });
    assert.deepEqual((await sent()).filter(call => call.arguments.operation === "reset"),
      [{ name: "aikido_index", arguments: { operation: "reset", mode: "semantic" } }]);
    assert.match(state.messages.at(-1).message, /deleted/);
  } finally { await dispose(); }
});

test("model management is lazy and native consent is separate for download and rebuild", async () => {
  const { state, directory, folder, dispose } = await fixture();
  try {
    const requestFile = path.join(directory, "model-requests.jsonl");
    const status = { requestedPolicy: "auto-speed", activePolicy: "e5", reason: "retained", models: [
      { id: "code", repository: "approved/source", revision: "pinned-sha", license: "Apache-2.0", downloadBytes: 12345 },
    ] };
    state.launch = { command: process.execPath, cwd: directory, env: process.env, args: ["-e", `
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "tools/call") fs.appendFileSync(${JSON.stringify(requestFile)}, JSON.stringify(request.params) + "\\n");
        process.stdout.write(JSON.stringify({ jsonrpc:"2.0", id:request.id,
          result: request.method === "tools/call" ? { content:[{type:"text",text:${JSON.stringify(JSON.stringify(status))}}] } : {} }) + "\\n");
      });
    `] };
    await state.commands.get("kimono.openPanel")();
    await state.receive({ action: "refresh" });
    await assert.rejects(fs.stat(requestFile), { code: "ENOENT" });
    const send = input => state.receive({ action: "models", input, folder: folder.uri.toString() });
    const requests = async () => (await fs.readFile(requestFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    await send({ operation: "status" });
    assert.deepEqual((await requests())[0], { name: "aikido_models", arguments: { operation: "status" } });
    await send({ operation: "install", model: "code" });
    assert.equal((await requests()).filter(call => call.arguments.operation === "install").length, 0);
    state.confirmation = "Confirm";
    await send({ operation: "install", model: "code" });
    assert.deepEqual(state.warning[1], { modal: true });
    for (const text of ["approved/source", "pinned-sha", "Apache-2.0", "12345"]) assert.ok(state.warning[0].includes(text));
    assert.deepEqual((await requests()).find(call => call.arguments.operation === "install").arguments,
      { operation: "install", model: "code", confirmed: true });
    await send({ operation: "configure", policy: "auto-speed" });
    assert.deepEqual((await requests()).find(call => call.arguments.operation === "configure").arguments,
      { operation: "configure", policy: "auto-speed", confirmed: true });
    await send({ operation: "install", model: "../../bad" });
    assert.equal(state.messages.at(-1).type, "error");
  } finally { await dispose(); }
});

test("remote model panel honors endpoint-bound SecretStorage without local launch", async () => {
  const { state, dispose } = await fixture({ mode: "remote", url: "https://configured.example/mcp" });
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(options.body);
    if (!request.id) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
      ? { protocolVersion: "2025-03-26" }
      : { content: [{ type: "text", text: JSON.stringify({ requestedPolicy: "code", activePolicy: null,
        reason: "remote status", phase: "download-required", models: [] }) }] } });
  };
  try {
    state.secret = JSON.stringify({ url: "https://different.example/mcp", token: "never-forward" });
    await state.commands.get("kimono.openPanel")();
    await state.receive({ action: "models", input: { operation: "status" } });
    assert.equal(calls.length, 0);
    assert.match(state.messages.at(-1).message, /endpoint changed/);
    state.secret = JSON.stringify({ url: "https://configured.example/mcp", token: "bound-token" });
    await state.receive({ action: "models", input: { operation: "status" } });
    assert.equal(state.messages.at(-1).type, "models");
    assert.equal(state.messages.at(-1).value.activePolicy, null);
    assert.ok(calls.every(call => call.url === "https://configured.example/mcp"));
    assert.ok(calls.every(call => call.options.headers.authorization === "Bearer bound-token"));
    assert.deepEqual(JSON.parse(calls.at(-1).options.body).params,
      { name: "aikido_models", arguments: { operation: "status" } });
  } finally { global.fetch = originalFetch; await dispose(); }
});
