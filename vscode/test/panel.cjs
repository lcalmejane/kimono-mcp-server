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
    },
  };
  const context = { extensionPath, secrets: { get: async () => undefined, onDidChange: () => disposable } };
  const disposables = registerManagement(vscode, context, {
    config: () => vscode.workspace.getConfiguration("kimono"), embeddedFolders: () => [folder],
    embeddedLaunch: async () => { throw new Error("not started in tests"); }, remoteUrl: value => value.startsWith("https://") ? value : undefined,
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
