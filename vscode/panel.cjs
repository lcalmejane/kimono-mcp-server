"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { startMcpClient, startRemoteMcpClient } = require("./mcp-client.cjs");
const modelActions = require("./management/model-actions.js");
const { runSearchBench } = require("./search.cjs");
const { lines, readIndexStatus, summarize } = require("./status.cjs");

const website = "https://ai-kido.fr";
const nativeActions = {
  servers: ["workbench.mcp.listServer"],
  mcpSettings: ["workbench.action.openSettings", "mcp"],
};

function registerManagement(vscode, context, host) {
  const { config, embeddedFolders, embeddedLaunch, remoteUrl, tokenKey, version } = host;
  const icon = vscode.Uri.file(path.join(context.extensionPath, "media", "kimono.svg"));
  const clients = new Map();
  const bar = vscode.window.createStatusBarItem?.(vscode.StatusBarAlignment?.Left, 0);
  let panel, statuses = new Map(), lastSnapshot = "";
  const language = String(vscode.env?.language ?? "en").toLowerCase().startsWith("fr") ? "fr" : "en";
  const l = (en, fr) => language === "fr" ? fr : en;

  const trusted = () => {
    if (!vscode.workspace.isTrusted) throw new Error(l("Trust this workspace before starting Kimono.", "Approuvez ce dossier avant de démarrer Kimono."));
  };
  const embedded = () => {
    if (config().get("mode", "embedded") !== "embedded") {
      throw new Error(l("Search tests and indexing from this panel use the embedded server. Switch Mode to Embedded.", "Les tests de recherche et l'indexation depuis ce panneau utilisent le serveur intégré. Passez le serveur en mode Intégré."));
    }
  };
  const folderById = id => {
    const selected = embeddedFolders().find(folder => folder.uri.toString() === id) ?? (id ? undefined : embeddedFolders()[0]);
    if (!selected) throw new Error(l("Open a local folder to use Kimono.", "Ouvrez un dossier local pour utiliser Kimono."));
    return selected;
  };

  async function client(selected) {
    const existing = clients.get(selected.identity);
    if (existing?.running) return existing;
    const started = startMcpClient(await embeddedLaunch(selected), { version });
    clients.set(selected.identity, started);
    return started;
  }

  // A panel-started indexer keeps running until done, then its private server stops.
  function release() {
    for (const [identity, started] of clients) {
      const selected = embeddedFolders().find(folder => folder.identity === identity);
      const poll = async () => {
        const status = selected ? await readIndexStatus(selected.statusFile) : { phase: "ready" };
        if (panel || status.phase === "running" || status.phase === "waiting") {
          if (!panel) setTimeout(poll, 2000).unref?.();
          return;
        }
        started.close();
        if (clients.get(identity) === started) clients.delete(identity);
      };
      void poll();
    }
  }

  async function refreshStatuses() {
    const next = new Map();
    if (vscode.workspace.isTrusted && config().get("mode", "embedded") === "embedded") {
      for (const folder of embeddedFolders()) next.set(folder.identity, await readIndexStatus(folder.statusFile));
    }
    const snapshot = JSON.stringify([...next]);
    statuses = next;
    updateStatusBar();
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      if (panel) await panel.webview.postMessage({ type: "status", value: folderStates() });
    }
  }

  function updateStatusBar() {
    if (!bar) return;
    const values = [...statuses.values()];
    if (!values.length) { bar.hide(); return; }
    const running = values.find(status => status.phase === "running" || status.phase === "waiting");
    const shown = running ?? values.find(status => status.phase !== "ready") ?? values[0];
    bar.text = `Kimono: ${summarize(shown, language)}`;
    bar.tooltip = embeddedFolders().filter(folder => statuses.has(folder.identity)).map(folder => {
      const status = statuses.get(folder.identity);
      return [`${folder.name}: ${summarize(status, language)}`, ...lines(status, language).map(line => `  ${line.label}: ${line.value}`)].join("\n");
    }).join("\n\n");
    bar.command = "kimono.openPanel";
    bar.show();
  }

  function folderStates() {
    return embeddedFolders().map(folder => {
      const status = statuses.get(folder.identity) ?? { phase: "not-indexed" };
      return { id: folder.uri.toString(), name: folder.name, root: folder.root,
        rootSetting: vscode.workspace.getConfiguration("kimono", folder.uri).get("root", ""), status };
    });
  }

  async function state() {
    const available = new Set(await vscode.commands.getCommands(true));
    return {
      version, language, trusted: vscode.workspace.isTrusted,
      settings: Object.fromEntries(["mode", "corpusMode", "url", "configFile", "gitProfileFile"].map(key => [key, config().get(key)])),
      hasToken: Boolean(await context.secrets.get(tokenKey)),
      folders: folderStates(),
      actions: Object.fromEntries(Object.entries(nativeActions).map(([key, [command]]) => [key, available.has(command)])),
    };
  }

  const absoluteOrEmpty = value => typeof value === "string" && (value === "" || path.isAbsolute(value));
  const settingRules = {
    mode: value => ["embedded", "remote", "disabled"].includes(value),
    corpusMode: value => ["rag", "aikido"].includes(value),
    url: value => typeof value === "string" && (value === "" || Boolean(remoteUrl(value))),
    configFile: absoluteOrEmpty,
    gitProfileFile: absoluteOrEmpty,
    root: value => typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/.test(value),
  };

  async function updateSetting(message) {
    trusted();
    const rule = Object.hasOwn(settingRules, message.key) && settingRules[message.key];
    if (!rule || !rule(message.value)) throw new Error(l("Invalid or unsupported Kimono setting.", "Paramètre Kimono invalide ou non pris en charge."));
    if (message.key === "root") {
      const folder = folderById(message.folder);
      return vscode.workspace.getConfiguration("kimono", folder.uri).update("root", message.value || undefined,
        vscode.ConfigurationTarget.WorkspaceFolder);
    }
    return config().update(message.key, message.value, vscode.ConfigurationTarget.Global);
  }

  async function startIndex(id, operation = "update") {
    trusted(); embedded();
    const selected = folderById(id);
    const started = await client(selected);
    const value = await started.call("aikido_index", { operation, mode: "semantic", background: true });
    await refreshStatuses();
    return value;
  }

  async function search(id, input) {
    trusted(); embedded();
    const started = await client(folderById(id));
    return runSearchBench((name, args) => started.call(name, args), input);
  }

  async function models(message) {
    trusted();
    const action = modelActions.parse(message.input);
    const mode = config().get("mode", "embedded");
    let started, remote = false;
    if (mode === "embedded") started = await client(folderById(message.folder));
    else if (mode === "remote") {
      const url = remoteUrl(config().get("url", ""));
      if (!url) throw new Error("Configure a valid remote Kimono URL first.");
      const stored = await context.secrets.get(tokenKey);
      const secret = stored ? JSON.parse(stored) : undefined;
      if (secret && (secret.url !== url || typeof secret.token !== "string" || !secret.token || /[\r\n]/.test(secret.token))) {
        throw new Error("The Kimono endpoint changed. Set a token for this endpoint or clear the saved token.");
      }
      started = startRemoteMcpClient(url, secret?.token, { version });
      remote = true;
    } else throw new Error("Enable Kimono to manage models.");
    try {
      let value = await started.call("aikido_models", { operation: "status" });
      if (action.operation !== "status") {
        const accept = l("Confirm", "Confirmer");
        if (await vscode.window.showWarningMessage(modelActions.confirmation(action, value, language),
          { modal: true }, accept) === accept) {
          await started.call("aikido_models", { ...action, confirmed: true });
          value = await started.call("aikido_models", { operation: "status" });
        }
      }
      return value;
    } finally { if (remote) started.close(); }
  }

  async function openPanel(focus) {
    if (panel) {
      panel.reveal();
      if (focus) await panel.webview.postMessage({ type: "focus", value: focus });
      return;
    }
    const directory = path.join(context.extensionPath, "management");
    const html = await fs.readFile(path.join(directory, "kimono.html"), "utf8");
    const created = vscode.window.createWebviewPanel("kimono.management", "Kimono MCP", vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(directory), vscode.Uri.file(path.join(context.extensionPath, "media"))],
    });
    panel = created;
    created.iconPath = icon;
    let busy = false;
    const post = message => created.webview.postMessage(message);
    const render = async () => post({ type: "state", value: await state() });
    const configuration = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("kimono")) render().catch(() => {});
    });
    const secrets = context.secrets.onDidChange(event => { if (event.key === tokenKey) render().catch(() => {}); });
    const listener = created.webview.onDidReceiveMessage(async message => {
      try {
        if (!message || typeof message !== "object") throw new Error(l("Invalid Kimono message.", "Message Kimono invalide."));
        if (message.action === "refresh") { await refreshStatuses(); await render(); return; }
        if (message.action === "website") { await vscode.env.openExternal(vscode.Uri.parse(website)); return; }
        if (busy) throw new Error(l("Another Kimono action is running.", "Une autre action Kimono est en cours."));
        busy = true;
        try {
          if (message.action === "setting") { await updateSetting(message); await post({ type: "done", message: l("Setting saved. Kimono servers restart with the new configuration.", "Paramètre enregistré. Les serveurs Kimono redémarrent avec la nouvelle configuration.") }); }
          else if (message.action === "indexStart") { await startIndex(message.folder); await post({ type: "done", message: l("Indexing started. Progress updates live above.", "Indexation lancée. La progression s'affiche en direct ci-dessus.") }); }
          else if (message.action === "indexRebuild") {
            trusted(); embedded();
            const selected = folderById(message.folder);
            const confirm = l("Rebuild", "Reconstruire");
            if (await vscode.window.showWarningMessage(
              l(`Rebuild the entire semantic index for ${selected.name}? This recalculates all vectors and may take a long time. Sources and snapshots are unchanged; the previous generation is kept until success.`,
                `Reconstruire tout l'index sémantique de ${selected.name} ? Tous les vecteurs seront recalculés, ce qui peut être long. Sources et snapshots inchangés ; l'ancienne génération est conservée jusqu'à réussite.`),
              { modal: true }, confirm) !== confirm) {
              await post({ type: "done", message: l("Rebuild cancelled.", "Reconstruction annulée.") });
            } else {
              await startIndex(message.folder, "rebuild");
              await post({ type: "done", message: l("Rebuild started. Progress updates live above.", "Reconstruction lancée. La progression s'affiche en direct ci-dessus.") });
            }
          }
          else if (message.action === "models") await post({ type: "models", value: await models(message) });
          else if (message.action === "search") await post({ type: "search", value: await search(message.folder, message.input) });
          else if (message.action === "setToken") { await vscode.commands.executeCommand("kimono.setToken"); await post({ type: "done" }); }
          else if (message.action === "clearToken") { await vscode.commands.executeCommand("kimono.clearToken"); await post({ type: "done" }); }
          else if (message.action === "settings") { await vscode.commands.executeCommand("kimono.configure"); await post({ type: "done" }); }
          else {
            const native = Object.hasOwn(nativeActions, message.action) && nativeActions[message.action];
            if (!native) throw new Error(l("Kimono action not allowed.", "Action Kimono non autorisée."));
            if (!(await vscode.commands.getCommands(true)).includes(native[0])) throw new Error(l("This VS Code version does not provide that MCP command.", "Cette version de VS Code ne fournit pas cette commande MCP."));
            await vscode.commands.executeCommand(...native);
            await post({ type: "done" });
          }
        } finally { busy = false; }
      } catch (error) {
        await post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
    const closed = created.onDidDispose(() => {
      panel = undefined;
      configuration.dispose(); secrets.dispose(); listener.dispose(); closed.dispose();
      release();
    });
    const nonce = randomBytes(24).toString("hex");
    created.webview.html = html.replaceAll("{{csp}}", created.webview.cspSource)
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{lang}}", language)
      .replaceAll("{{base}}", created.webview.asWebviewUri(vscode.Uri.file(directory)).toString().replace(/\/$/, ""))
      .replaceAll("{{icon}}", created.webview.asWebviewUri(icon).toString());
    if (focus) await post({ type: "focus", value: focus });
  }

  // VS Code activity-bar containers require a view. Use it only as a launcher, like Tatami Agent.
  const tree = vscode.window.createTreeView("kimono.status", {
    treeDataProvider: { getTreeItem: element => element, getChildren: () => [] },
  });
  const report = error => vscode.window.showErrorMessage(`Kimono MCP: ${error instanceof Error ? error.message : String(error)}`);
  const openManagement = async () => {
    try {
      await vscode.commands.executeCommand("workbench.action.closeSidebar");
      await openPanel();
    } catch (error) { report(error); }
  };
  let ticks = 0;
  const timer = setInterval(() => {
    const active = [...statuses.values()].some(status => status.phase === "running" || status.phase === "waiting");
    if (tree.visible || panel || active || ++ticks % 5 === 0) refreshStatuses().catch(() => {});
  }, 1000);
  timer.unref?.();
  refreshStatuses().catch(() => {});
  if (tree.visible) void openManagement();
  return [
    tree, ...(bar ? [bar] : []),
    { dispose: () => { clearInterval(timer); panel?.dispose(); for (const started of clients.values()) started.close(); clients.clear(); } },
    tree.onDidChangeVisibility(event => { if (event.visible) void openManagement(); }),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration("kimono")) { lastSnapshot = ""; refreshStatuses().catch(() => {}); } }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { lastSnapshot = ""; refreshStatuses().catch(() => {}); }),
    vscode.commands.registerCommand("kimono.openPanel", () => openPanel().catch(report)),
    vscode.commands.registerCommand("kimono.testSearch", () => openPanel("search").catch(report)),
    vscode.commands.registerCommand("kimono.startIndex", async () => {
      try {
        const folders = embeddedFolders();
        const picked = folders.length > 1
          ? await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.root, folder })), { title: l("Index which Kimono ROOT?", "Quel ROOT Kimono indexer ?") })
          : { folder: folders[0] };
        if (!picked) return;
        await startIndex(picked.folder?.uri.toString());
      } catch (error) { report(error); }
    }),
  ];
}

module.exports = { registerManagement, website };
