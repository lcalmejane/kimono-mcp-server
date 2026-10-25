"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { nativeEnvironment } = require("./native.cjs");
const { registerManagement } = require("./panel.cjs");

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
    const corpusMode = config().get("corpusMode", "rag");
    if (!["aikido", "rag"].includes(corpusMode)) throw new Error("Kimono corpusMode must be aikido or rag.");
    return {
      command: nodeExecutable(), args: [serverEntry(), "serve", "--root", selected.root], cwd: root,
      env: {
        ...environment,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: storage, USERPROFILE: storage, TMPDIR: storage, TMP: storage, TEMP: storage,
        MCP_TRANSPORT: "stdio", AIKIDO_ROOT: root,
        KIMONO_CACHE_DIR: path.join(storage, "cache"),
        KIMONO_STATUS_FILE: selected.statusFile,
        KIMONO_CORPUS_MODE: corpusMode,
        ...(configFile ? { KIMONO_CONFIG_FILE: configFile } : {}),
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
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("kimono")) refresh(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidGrantWorkspaceTrust(refresh),
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
      ? registerManagement(vscode, context, { config, embeddedFolders, embeddedLaunch, remoteUrl, tokenKey, version })
      : []),
  ];
}

function activate(context) {
  const vscode = require("vscode");
  context.subscriptions.push(...register(vscode, context));
}

module.exports = { activate, register, remoteUrl, providerId, tokenKey };
