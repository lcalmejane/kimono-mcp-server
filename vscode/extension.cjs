"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { nativeEnvironment } = require("./native.cjs");
const { registerManagement } = require("./panel.cjs");
const { discoverRepositories, mergeRepositories, installLauncher, syncMcpJson } = require("./host-config.cjs");

const providerId = "kimono.mcp";
const tokenKey = "kimono.remoteBearer";

function remoteUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Kimono requires HTTPS (or loopback HTTP), without credentials, query or fragment.");
  }
  return url.href;
}

function register(vscode, context, native = nativeEnvironment) {
  if (!vscode.lm?.registerMcpServerDefinitionProvider) {
    throw new Error("Kimono MCP requires VS Code 1.106 or newer with MCP support.");
  }
  const changed = new vscode.EventEmitter();
  const version = context.extension.packageJSON.version;
  let definitions = new Map();
  let nativeAssets;
  const config = () => vscode.workspace.getConfiguration("kimono");
  const nodeExecutable = () => path.join(context.extensionPath, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const serverEntry = () => path.join(context.extensionPath, "server", "index.mjs");
  const storageFor = identity => path.join(context.globalStorageUri.fsPath, identity);
  const embeddedFolders = () => (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === "file").map(folder => {
    const configured = vscode.workspace.getConfiguration("kimono", folder.uri).get("root", "");
    const root = path.resolve(folder.uri.fsPath, configured);
    const identity = createHash("sha256").update(root).digest("hex").slice(0, 16);
    return { mode: "embedded", name: folder.name, uri: folder.uri, root, identity,
      statusFile: path.join(storageFor(identity), "semantic-status.json") };
  });
  // Declared repositories plus, unless disabled, the nested Git repositories found under ROOT.
  async function repositoriesFor(selected, root) {
    const folder = vscode.workspace.getConfiguration("kimono", selected.uri);
    const declared = folder.get("repositories", []);
    if (!Array.isArray(declared) || declared.length > 64 || !declared.every(item =>
      item && typeof item === "object" && !Array.isArray(item) && typeof item.path === "string")) {
      throw new Error("Kimono repositories must be an array of { path, name?, gitUrl?, branch? }.");
    }
    if (!folder.get("discoverRepositories", true)) return declared;
    return mergeRepositories(declared, await discoverRepositories(root));
  }
  // Repositories the server will index, each tagged "declared" (settings) or "discovered" (found under ROOT).
  async function indexedRepositories(selected) {
    const root = await fs.realpath(selected.root).catch(() => undefined);
    if (!root) return [];
    const declared = vscode.workspace.getConfiguration("kimono", selected.uri).get("repositories", []);
    const paths = new Set((Array.isArray(declared) ? declared : []).map(item => item.path));
    return (await repositoriesFor(selected, root).catch(() => []))
      .map(item => ({ path: item.path, source: paths.has(item.path) ? "declared" : "discovered" }));
  }
  // Points agent-host .mcp.json files at the version-free launcher (on activation, install and update).
  async function syncHosts(create = false) {
    if (!vscode.workspace.isTrusted || config().get("mode", "embedded") !== "embedded") return [];
    const launcher = await installLauncher(context.extensionPath, context.globalStorageUri.fsPath);
    if (!create && !config().get("syncMcpJson", true)) return [];
    const results = [];
    for (const selected of embeddedFolders()) {
      const root = await fs.realpath(selected.root).catch(() => undefined);
      if (!root) continue;
      results.push(await syncMcpJson(root, launcher, await repositoriesFor(selected, root), { create }));
    }
    return results;
  }
  // Autoconfig: persist the discovered repositories in each folder setting, then write .mcp.json.
  async function autoconfig() {
    if (!vscode.workspace.isTrusted) throw new Error("Kimono autoconfig requires a trusted workspace.");
    if (config().get("mode", "embedded") !== "embedded") throw new Error("Kimono autoconfig applies to embedded mode only.");
    let repositories = 0;
    for (const selected of embeddedFolders()) {
      const root = await fs.realpath(selected.root).catch(() => undefined);
      if (!root) continue;
      const folder = vscode.workspace.getConfiguration("kimono", selected.uri);
      const declared = folder.get("repositories", []);
      const merged = mergeRepositories(Array.isArray(declared) ? declared : [], await discoverRepositories(root));
      if (merged.length !== declared.length) await folder.update("repositories", merged, vscode.ConfigurationTarget.WorkspaceFolder);
      repositories += merged.length;
    }
    const results = await syncHosts(true);
    const failed = results.find(result => result.error);
    if (failed) throw new Error(failed.error);
    return { repositories, files: results.map(result => result.file) };
  }
  // Full, null-free launch spec shared by MCP definitions and the management panel's own client.
  async function embeddedLaunch(selected) {
    // Validate assets once per activation, before any bundled code is launched.
    nativeAssets ??= native(path.join(context.extensionPath, "native"));
    const environment = await nativeAssets;
    const root = await fs.realpath(selected.root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Kimono ROOT must be an existing directory.");
    const storage = storageFor(selected.identity);
    await fs.mkdir(storage, { recursive: true, mode: 0o700 });
    const profile = config().get("gitProfileFile", "");
    if (profile && !path.isAbsolute(profile)) throw new Error("Kimono Git profile path must be absolute.");
    const configFile = config().get("configFile", "");
    if (configFile && !path.isAbsolute(configFile)) throw new Error("Kimono config path must be absolute.");
    const repositories = await repositoriesFor(selected, root);
    const corpusMode = config().get("corpusMode", "rag");
    if (!["aikido", "rag"].includes(corpusMode)) throw new Error("Kimono corpusMode must be aikido or rag.");
    const device = config().get("semanticDevice", "auto");
    const embeddingPolicy = config().get("embeddingPolicy", "auto-speed");
    const snapshotScope = config().get("snapshotScope", "prompt");
    if (!["prompt", "session", "call"].includes(snapshotScope)) throw new Error("Kimono snapshotScope must be prompt, session or call.");
    const snapshotIdleSeconds = config().get("snapshotIdleSeconds", 120);
    if (!Number.isInteger(snapshotIdleSeconds) || snapshotIdleSeconds < 1 || snapshotIdleSeconds > 3600) throw new Error("Invalid Kimono snapshotIdleSeconds setting.");
    if (!["auto-balanced", "auto-speed", "code", "multilingual-fast", "e5", "custom"].includes(embeddingPolicy)) throw new Error("Invalid Kimono embedding policy.");
    const models = ["code","multilingual-fast","e5","jina-code","bge-m3","nomic-v1.5","mxbai-large","e5-large","minilm"];
    const codeModel = config().get("embeddingCodeModel", "code"), documentsModel = config().get("embeddingDocumentsModel", "multilingual-fast");
    if (!models.includes(codeModel) || !models.includes(documentsModel)) throw new Error("Invalid Kimono custom embedding model.");
    if (!["auto", "cpu", "cuda", "coreml"].includes(device)) throw new Error("Kimono semanticDevice must be auto, cpu, cuda or coreml.");
    const semanticEnvironment = {};
    for (const [key, variable, fallback, minimum, maximum] of [
      ["semanticWorkers", "WORKERS", 0, 0, 32], ["semanticThreads", "THREADS", 0, 0, 32],
      ["semanticBatch", "BATCH", 0, 0, 256], ["semanticCpuPercent", "CPU_PERCENT", 80, 1, 100],
      ["semanticMemoryPercent", "MEMORY_PERCENT", 80, 1, 100],
    ]) {
      const value = config().get(key, fallback);
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid Kimono ${key} setting.`);
      semanticEnvironment[`KIMONO_SEMANTIC_${variable}`] = value === 0 ? "auto" : String(value);
    }
    const logLevel = config().get("logLevel", "error");
    if (!["error", "debug"].includes(logLevel)) throw new Error("Kimono logLevel must be error or debug.");
    return {
      command: nodeExecutable(), args: [serverEntry(), "serve", "--root", selected.root], cwd: root,
      env: {
        ...environment,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: storage, USERPROFILE: storage, TMPDIR: storage, TMP: storage, TEMP: storage,
        MCP_TRANSPORT: "stdio", AIKIDO_ROOT: root,
        KIMONO_CACHE_DIR: path.join(storage, "cache"),
        // Startup default only: the server's saved per-root policy takes precedence.
        KIMONO_EMBEDDING_POLICY: embeddingPolicy,
        KIMONO_SNAPSHOT_SCOPE: snapshotScope,
        KIMONO_SNAPSHOT_IDLE_MS: String(snapshotIdleSeconds * 1000),
        KIMONO_EMBEDDING_CODE_MODEL: codeModel,
        KIMONO_EMBEDDING_DOCUMENTS_MODEL: documentsModel,
        KIMONO_MODELS_DIR: path.join(context.globalStorageUri.fsPath, "models"),
        KIMONO_STATUS_FILE: selected.statusFile,
        KIMONO_CORPUS_MODE: corpusMode,
        KIMONO_SEMANTIC_DEVICE: device,
        ...semanticEnvironment,
        KIMONO_LOG_LEVEL: logLevel,
        ...(configFile ? { KIMONO_CONFIG_FILE: configFile } : {}),
        // Validated again by the server (ROOT-relative, no traversal, credential-free URLs).
        ...(repositories.length ? { KIMONO_REPOSITORIES: JSON.stringify(repositories) } : {}),
        ...(profile ? { KIMONO_GIT_PROFILE_FILE: profile } : {}),
      },
    };
  }
  const provider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions(cancellation = { isCancellationRequested: false }) {
      definitions = new Map();
      if (!vscode.workspace.isTrusted || config().get("mode", "embedded") === "disabled") return [];
      if (config().get("mode", "embedded") === "remote") {
        const url = remoteUrl(config().get("url", ""));
        const server = new vscode.McpHttpServerDefinition("Kimono MCP", vscode.Uri.parse(url), {}, version);
        definitions.set(server, { mode: "remote", url });
        return [server];
      }
      const servers = embeddedFolders().map(selected => {
        const server = new vscode.McpStdioServerDefinition(`Kimono: ${selected.name} [${selected.identity.slice(0, 6)}]`,
          nodeExecutable(), [serverEntry(), "serve", "--root", selected.root], {}, version);
        definitions.set(server, selected);
        return server;
      });
      // Some agent hosts launch discovered definitions without invoking the resolver.
      return (await Promise.all(servers.map(server => provider.resolveMcpServerDefinition(server, cancellation))))
        .filter(server => server !== undefined);
    },
    async resolveMcpServerDefinition(server, cancellation) {
      const selected = definitions.get(server);
      if (cancellation.isCancellationRequested || !vscode.workspace.isTrusted || !selected ||
          selected.mode !== config().get("mode", "embedded")) return undefined;
      if (selected.mode === "remote") {
        if (selected.url !== remoteUrl(config().get("url", ""))) return undefined;
        const stored = await context.secrets.get(tokenKey);
        const secret = stored ? JSON.parse(stored) : undefined;
        if (secret && secret.url !== selected.url) {
          throw new Error("The Kimono endpoint changed. Set a token for this endpoint or clear the saved token.");
        }
        server.headers = secret ? { Authorization: `Bearer ${secret.token}` } : {};
      } else {
        const launch = await embeddedLaunch(selected);
        // VS Code merges env: explicitly remove inherited transport, profile and Node options.
        const allowed = new Set(Object.keys(launch.env).map(key => key.toUpperCase()));
        server.env = {
          ...Object.fromEntries(Object.keys(process.env).filter(key => !allowed.has(key.toUpperCase())).map(key => [key, null])),
          ...launch.env,
        };
        server.cwd = vscode.Uri.file(launch.cwd);
      }
      return cancellation.isCancellationRequested || !vscode.workspace.isTrusted ||
        definitions.get(server) !== selected ? undefined : server;
    },
  };
  const refresh = () => { definitions = new Map(); changed.fire(); };
  const syncSilently = () => syncHosts().then(results => results.filter(result => result.error)
    .forEach(result => vscode.window.showWarningMessage?.(`Kimono MCP: ${result.error}`)), () => {});
  syncSilently();
  const report = error => vscode.window.showErrorMessage(`Kimono MCP: ${error instanceof Error ? error.message : String(error)}`);
  const guarded = action => async (...args) => {
    try { return await action(...args); }
    catch (error) { report(error); throw error; }
  };
  const publicProvider = {
    ...provider,
    provideMcpServerDefinitions: guarded(provider.provideMcpServerDefinitions),
    resolveMcpServerDefinition: guarded(provider.resolveMcpServerDefinition),
  };
  return [
    changed, vscode.lm.registerMcpServerDefinitionProvider(providerId, publicProvider),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("kimono")) { refresh(); syncSilently(); } }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { refresh(); syncSilently(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { refresh(); syncSilently(); }),
    vscode.commands.registerCommand("kimono.autoconfig", guarded(async (options = {}) => {
      const result = await autoconfig();
      if (!options.quiet) vscode.window.showInformationMessage?.(
        `Kimono MCP: ${result.repositories} repositories declared; ${result.files.join(", ") || "no .mcp.json"} up to date.`);
      return result;
    })),
    context.secrets.onDidChange(event => { if (event.key === tokenKey) refresh(); }),
    vscode.commands.registerCommand("kimono.configure", () => vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`)),
    vscode.commands.registerCommand("kimono.setToken", guarded(async () => {
      // Tokens are endpoint-scoped: changing the URL never reuses a credential.
      const url = remoteUrl(config().get("url", ""));
      const token = await vscode.window.showInputBox({ title: "Kimono remote bearer token", password: true, ignoreFocusOut: true });
      if (token === undefined) return;
      if (!token.trim() || /[\r\n]/.test(token)) throw new Error("Enter a nonempty bearer token without newlines, or use Clear Remote Bearer Token.");
      await context.secrets.store(tokenKey, JSON.stringify({ url, token }));
    })),
    vscode.commands.registerCommand("kimono.clearToken", guarded(() => context.secrets.delete(tokenKey))),
    ...(vscode.window?.createTreeView
      ? registerManagement(vscode, context, { config, embeddedFolders, embeddedLaunch, indexedRepositories, remoteUrl, tokenKey, version })
      : []),
  ];
}

function activate(context) {
  const vscode = require("vscode");
  context.subscriptions.push(...register(vscode, context));
}

module.exports = { activate, register, remoteUrl, providerId, tokenKey };
