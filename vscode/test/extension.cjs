"use strict";

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { register, remoteUrl, providerId, tokenKey } = require("../extension.cjs");

afterEach(async () => {
  await fs.rm(path.join(process.cwd(), ".local-runtime-vscode-test"), { recursive: true, force: true });
});

function fixture(options = {}) {
  const state = {
    settings: { mode: "embedded", ...options }, trusted: true, definitions: undefined,
    commands: new Map(), secrets: new Map(), callbacks: {}, errors: [], events: 0, disposed: 0,
  };
  const disposable = () => ({ dispose() { state.disposed++; } });
  const listen = name => callback => { state.callbacks[name] = callback; return disposable(); };
  const uri = filename => ({ scheme: "file", fsPath: filename });
  class Stdio {
    constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
  }
  const vscode = {
    EventEmitter: class { event = () => {}; fire() { state.events++; } dispose() {} },
    Uri: { file: uri, parse: value => ({ value }) },
    McpStdioServerDefinition: Stdio,
    McpHttpServerDefinition: class {
      constructor(label, url, headers, version) { Object.assign(this, { label, url, headers, version }); }
    },
    workspace: {
      get isTrusted() { return state.trusted; },
      workspaceFolders: [{ name: "Knowledge", uri: uri(process.cwd()) }],
      getConfiguration: (_name, folder) => ({
        get: (key, fallback) => folder && state.folderSettings?.[folder.fsPath]?.[key] !== undefined
          ? state.folderSettings[folder.fsPath][key] : state.settings[key] ?? fallback,
      }),
      onDidChangeConfiguration: listen("config"), onDidChangeWorkspaceFolders: listen("folders"),
      onDidGrantWorkspaceTrust: listen("trust"),
    },
    lm: { registerMcpServerDefinitionProvider: (id, value) => {
      assert.equal(id, providerId); state.provider = value; return disposable();
    } },
    commands: {
      registerCommand: (id, action) => { state.commands.set(id, action); return disposable(); },
      executeCommand: async (...args) => { state.commandArgs = args; },
    },
    window: {
      showInputBox: async () => state.input,
      showErrorMessage: message => state.errors.push(message),
    },
  };
  const context = {
    extensionPath: path.join(process.cwd(), "vscode"), extension: {
      id: "ai-kido.kimono-rag-mcp", packageJSON: { version: "0.6.3" },
    },
    globalStorageUri: uri(path.join(process.cwd(), ".local-runtime-vscode-test")),
    secrets: {
      get: async key => state.secrets.get(key),
      store: async (key, value) => state.secrets.set(key, value),
      delete: async key => state.secrets.delete(key),
      onDidChange: listen("secret"),
    },
  };
  const disposables = register(vscode, context, async () => ({ FGR_BIN: "/native/fgr", PATH: "/native/bin" }));
  return { state, vscode, context, disposables };
}

test("provider uses per-folder roots, bundled Node, and extension-owned registration", async () => {
  const { state, vscode, disposables } = fixture();
  vscode.workspace.workspaceFolders.push({ name: "Other", uri: { scheme: "file", fsPath: path.join(process.cwd(), "src") } });
  vscode.workspace.workspaceFolders.push({ name: "Virtual", uri: { scheme: "virtual", fsPath: "/virtual" } });
  state.folderSettings = { [path.join(process.cwd(), "src")]: { root: "../tests" } };
  const servers = await state.provider.provideMcpServerDefinitions();
  assert.equal(servers.length, 2);
  assert.ok(servers[0].command.endsWith(process.platform === "win32" ? "node.exe" : "node"));
  assert.ok(servers[0].command.includes("runtime"));
  assert.equal(servers[1].args.at(-1), path.join(process.cwd(), "tests"));
  assert.notEqual(servers[0].label, servers[1].label);
  assert.equal(servers[0].env.FGR_BIN, "/native/fgr");
  assert.equal(servers[0].env.KIMONO_CORPUS_MODE, "rag");
  assert.equal(servers[0].env.MCP_TRANSPORT, "stdio");
  assert.equal(servers[0].cwd.fsPath, process.cwd());
  assert.equal(servers[1].env.AIKIDO_ROOT, path.join(process.cwd(), "tests"));
  for (const disposable of disposables) disposable.dispose();
  assert.ok(state.disposed >= 8);
});

test("settings command targets the installed extension identity", async () => {
  const { state, context } = fixture();
  context.extension.id = "another-publisher.kimono-mcp";
  await state.commands.get("kimono.configure")();
  assert.deepEqual(state.commandArgs, ["workbench.action.openSettings", "@ext:another-publisher.kimono-mcp"]);
});

test("embedded resolve isolates environment, cache and Git profile; configuration invalidates old definitions", async () => {
  const { state, context } = fixture({ gitProfileFile: path.join(process.cwd(), ".private-profile.json") });
  const [server] = await state.provider.provideMcpServerDefinitions();
  try {
    const resolved = await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: false });
    assert.equal(resolved.env.MCP_TRANSPORT, "stdio");
    assert.equal(resolved.env.KIMONO_CORPUS_MODE, "rag");
    assert.equal(resolved.env.FGR_BIN, "/native/fgr");
    assert.equal(resolved.env.KIMONO_GIT_PROFILE_FILE, state.settings.gitProfileFile);
    assert.ok(resolved.env.KIMONO_CACHE_DIR.startsWith(context.globalStorageUri.fsPath));
    for (const key of Object.keys(process.env)) {
      if (!["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "MCP_TRANSPORT",
        "AIKIDO_ROOT", "KIMONO_CORPUS_MODE", "KIMONO_CACHE_DIR", "FGR_BIN", "KIMONO_GIT_PROFILE_FILE"].includes(key)) {
        assert.equal(resolved.env[key], null);
      }
    }
    state.callbacks.config({ affectsConfiguration: name => name === "kimono" });
    assert.equal(state.events, 1);
    assert.equal(await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: false }), undefined);
  } finally {
    await fs.rm(context.globalStorageUri.fsPath, { recursive: true, force: true });
  }
});

test("restricted, disabled and cancelled providers cannot launch servers", async () => {
  const { state } = fixture();
  const [server] = await state.provider.provideMcpServerDefinitions();
  assert.equal(await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: true }), undefined);
  state.trusted = false;
  assert.equal(await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: false }), undefined);
  assert.deepEqual(await state.provider.provideMcpServerDefinitions(), []);
  state.trusted = true;
  state.settings.mode = "disabled";
  assert.deepEqual(await state.provider.provideMcpServerDefinitions(), []);
});

test("remote secrets resolve late and stay bound to their endpoint", async () => {
  const { state } = fixture({ mode: "remote", url: "https://knowledge.example/mcp" });
  state.input = "private-token";
  await state.commands.get("kimono.setToken")();
  assert.ok(state.secrets.has(tokenKey));
  const [server] = await state.provider.provideMcpServerDefinitions();
  assert.deepEqual(server.headers, {});
  await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: false });
  assert.deepEqual(server.headers, { Authorization: "Bearer private-token" });
  state.settings.url = "https://another.example/mcp";
  const [other] = await state.provider.provideMcpServerDefinitions();
  await assert.rejects(() => state.provider.resolveMcpServerDefinition(other, { isCancellationRequested: false }), /endpoint changed/);
  assert.deepEqual(other.headers, {});
  assert.match(state.errors[0], /endpoint changed/);
  await state.commands.get("kimono.clearToken")();
  await state.provider.resolveMcpServerDefinition(other, { isCancellationRequested: false });
  assert.deepEqual(other.headers, {});
});

test("remote URL validation rejects plaintext non-loopback and credential-bearing URLs", () => {
  for (const url of ["http://example.com/mcp", "https://u:password@example.com", "https://example.com?token=x",
    "https://example.com/#secret", "file:///tmp/server"]) {
    assert.throws(() => remoteUrl(url));
  }
  for (const url of ["https://example.com/mcp", "http://localhost:3000/mcp", "http://127.0.0.1:3000/mcp", "http://[::1]:3000/mcp"]) {
    assert.equal(remoteUrl(url), url);
  }
});

test("cancelled and invalid token input never stores a credential", async () => {
  const { state } = fixture({ mode: "remote", url: "https://knowledge.example/mcp" });
  await state.commands.get("kimono.setToken")();
  assert.equal(state.secrets.size, 0);
  state.input = "invalid\nvalue";
  await assert.rejects(state.commands.get("kimono.setToken"), /without newlines/);
  assert.equal(state.secrets.size, 0);
});

test("embedded provider can explicitly select AI-KIDO instead of default RAG", async () => {
  const { state, context } = fixture({ corpusMode: "aikido", configFile: path.join(process.cwd(), "corpus.json") });
  const [server] = await state.provider.provideMcpServerDefinitions();
  try {
    await state.provider.resolveMcpServerDefinition(server, { isCancellationRequested: false });
    assert.equal(server.env.KIMONO_CORPUS_MODE, "aikido");
    assert.equal(server.env.KIMONO_CONFIG_FILE, state.settings.configFile);
    state.settings.configFile = "relative.json";
    await assert.rejects(() => state.provider.provideMcpServerDefinitions(), /config path must be absolute/);
  } finally {
    await fs.rm(context.globalStorageUri.fsPath, { recursive: true, force: true });
  }
});

test("cancelled discovery does not expose an unresolved embedded launch", async () => {
  const { state } = fixture();
  assert.deepEqual(await state.provider.provideMcpServerDefinitions({ isCancellationRequested: true }), []);
});
