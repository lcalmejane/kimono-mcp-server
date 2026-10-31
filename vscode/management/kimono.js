"use strict";

const vscode = acquireVsCodeApi();
const script = document.currentScript;
const view = KimonoView.create(document.getElementById("kimono"), {
  icon: script.dataset.icon, origin: "VS Code", language: document.documentElement.lang,
  onIndexStart: folder => send({ action: "indexStart", folder }, view.t("indexing")),
  onIndexRebuild: folder => send({ action: "indexRebuild", folder }, view.t("indexing")),
  onIndexStop: folder => send({ action: "indexStop", folder }, view.t("indexing")),
  onIndexReset: folder => send({ action: "indexReset", folder }, view.t("indexing")),
  onModelsRequest: (input, folder) => send({ action: "models", input, folder }),
  onSearch: ({ folder, input }) => send({ action: "search", folder, input }, text.searchingPrivate),
  onWebsite: () => vscode.postMessage({ action: "website" }),
});
const text = {
  en: {
    working: "Working…", saving: "Saving…", searchingPrivate: "Searching… (the first query starts a private Kimono server)", done: "Done.",
    untrusted: "Trust this workspace to start Kimono.", remote: "Remote mode: indexing is managed by the remote Kimono server.",
    disabled: "Kimono is disabled.", noFolder: "Open a local folder to index it with Kimono.",
    searchEmbedded: "Search tests and indexing from this panel use the embedded server.",
    settings: "Settings", settingsIntro: "Saved in your VS Code user settings (ROOT per folder). Kimono servers restart automatically with the new configuration.",
    server: "Server", serverOptions: { embedded: "Embedded · bundled local server", remote: "Remote · existing HTTP MCP", disabled: "Disabled" },
    corpus: "Corpus mode", corpusOptions: { rag: "RAG · any project (default)", aikido: "AI-KIDO · knowledge base" },
    url: "Remote endpoint", urlHint: "(HTTPS, or loopback HTTP; never put credentials in the URL)",
    setToken: "Set remote token…", clearToken: "Clear remote token", tokenSaved: "A token is saved in VS Code SecretStorage.", noToken: "No token saved.",
    advanced: "Advanced", configFile: "Corpus config file", configHint: "(absolute path to a host-controlled JSON; empty = defaults)",
    gitProfile: "Git read-profile file", gitHint: "(absolute path, 0600, outside the ROOT; AI-KIDO remote sync only)",
    root: "ROOT for {name}", rootHint: "(relative to the folder or absolute; empty = the folder itself)", allSettings: "All Kimono settings",
    mcp: "MCP server", mcpIntro: "Kimono is declared to VS Code's MCP list for every trusted local folder. Start, stop, restart and read logs from the native list; VS Code confirmations and permissions stay active.",
    servers: "Start · stop · restart · logs…", mcpSettings: "Native MCP settings", standalone: "standalone",
  },
  fr: {
    working: "Action en cours…", saving: "Enregistrement…", searchingPrivate: "Recherche en cours… (la première requête démarre un serveur Kimono privé)", done: "Terminé.",
    untrusted: "Approuvez ce dossier pour démarrer Kimono.", remote: "Mode distant : l'indexation est gérée par le serveur Kimono distant.",
    disabled: "Kimono est désactivé.", noFolder: "Ouvrez un dossier local pour l'indexer avec Kimono.",
    searchEmbedded: "Les tests de recherche et l'indexation depuis ce panneau utilisent le serveur intégré.",
    settings: "Réglages", settingsIntro: "Enregistrés dans vos paramètres utilisateur VS Code (ROOT par dossier). Les serveurs Kimono redémarrent automatiquement avec la nouvelle configuration.",
    server: "Serveur", serverOptions: { embedded: "Intégré · serveur local inclus", remote: "Distant · MCP HTTP existant", disabled: "Désactivé" },
    corpus: "Mode de corpus", corpusOptions: { rag: "RAG · tout projet (par défaut)", aikido: "AI-KIDO · base de connaissances" },
    url: "Point d'accès distant", urlHint: "(HTTPS, ou HTTP en boucle locale ; jamais d'identifiants dans l'URL)",
    setToken: "Définir le jeton distant…", clearToken: "Effacer le jeton distant", tokenSaved: "Un jeton est enregistré dans le SecretStorage de VS Code.", noToken: "Aucun jeton enregistré.",
    advanced: "Avancé", configFile: "Fichier de configuration du corpus", configHint: "(chemin absolu d'un JSON contrôlé par l'hôte ; vide = valeurs par défaut)",
    gitProfile: "Fichier de profil Git en lecture", gitHint: "(chemin absolu, 0600, hors du ROOT ; synchronisation distante AI-KIDO uniquement)",
    root: "ROOT de {name}", rootHint: "(relatif au dossier ou absolu ; vide = le dossier lui-même)", allSettings: "Tous les paramètres Kimono",
    mcp: "Serveur MCP", mcpIntro: "Kimono est déclaré dans la liste MCP de VS Code pour chaque dossier local approuvé. Démarrez, arrêtez, redémarrez et lisez les journaux depuis la liste native ; les confirmations et permissions de VS Code restent actives.",
    servers: "Démarrer · arrêter · redémarrer · journaux…", mcpSettings: "Paramètres MCP natifs", standalone: "autonome",
  },
}[view.language];
let state;

function node(tag, value, parent, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  parent?.append(element);
  return element;
}
function field(parent, id, label, control, hint) {
  const wrapper = node("label", label, parent);
  wrapper.htmlFor = id;
  if (hint) { wrapper.append(" "); node("small", hint, wrapper); }
  control.id = id;
  wrapper.append(control);
  return control;
}
function choice(parent, id, label, options, key) {
  const select = field(parent, id, label, document.createElement("select"));
  for (const [value, title] of Object.entries(options)) node("option", title, select).value = value;
  select.dataset.setting = key;
  return select;
}
function textInput(parent, id, label, hint, key) {
  const input = field(parent, id, label, document.createElement("input"), hint);
  Object.assign(input, { type: "text", autocomplete: "off", spellcheck: false });
  if (key) input.dataset.setting = key;
  return input;
}
function actionButton(parent, label, action, secondary) {
  const button = node("button", label, parent, secondary ? "secondary" : undefined);
  button.type = "button";
  button.dataset.action = action;
  button.addEventListener("click", () => { if (!view.pending) send({ action }); });
  return button;
}

const settings = view.section("settings", text.settings, { intro: text.settingsIntro });
const grid = node("div", undefined, settings, "kv-grid");
choice(grid, "mode", text.server, text.serverOptions, "mode");
choice(grid, "corpusMode", text.corpus, text.corpusOptions, "corpusMode");
textInput(settings, "url", text.url, text.urlHint, "url");
const tokenRow = node("div", undefined, settings, "kv-actions");
actionButton(tokenRow, text.setToken, "setToken", true);
actionButton(tokenRow, text.clearToken, "clearToken", true);
const tokenState = node("span", "", tokenRow, "kv-muted");
const advanced = node("details", undefined, settings);
node("summary", text.advanced, advanced);
textInput(advanced, "configFile", text.configFile, text.configHint, "configFile");
textInput(advanced, "gitProfileFile", text.gitProfile, text.gitHint, "gitProfileFile");
const roots = node("div", undefined, advanced);
actionButton(node("div", undefined, advanced, "kv-actions"), text.allSettings, "settings", true);

const server = view.section("server", text.mcp, { intro: text.mcpIntro });
const serverActions = node("div", undefined, server, "kv-actions");
actionButton(serverActions, text.servers, "servers");
actionButton(serverActions, text.mcpSettings, "mcpSettings", true);

function setBusy(value) {
  view.setBusy(value);
  document.querySelectorAll(".kv-slot-settings button,.kv-slot-settings input,.kv-slot-settings select,.kv-slot-server button").forEach(element => {
    element.disabled = value || element.dataset.locked === "true";
  });
}
function send(message, notice = text.working) {
  view.setError("");
  view.setNotice(notice);
  setBusy(true);
  vscode.postMessage(message);
}

function statusMessage(value) {
  if (!value.trusted) return text.untrusted;
  if (value.settings.mode === "remote") return text.remote;
  if (value.settings.mode !== "embedded") return text.disabled;
  if (!value.folders.length) return text.noFolder;
  return undefined;
}
function showStatus(value) {
  const message = statusMessage(value);
  view.setStatus(message ? [] : value.folders, message);
}

function render(value) {
  state = value;
  view.setHeader({ corpusMode: value.settings.corpusMode, version: value.version, context: text.standalone });
  for (const key of ["mode", "corpusMode", "url", "configFile", "gitProfileFile"]) {
    const element = document.getElementById(key);
    if (document.activeElement !== element) element.value = value.settings[key] ?? "";
  }
  tokenState.textContent = value.hasToken ? text.tokenSaved : text.noToken;
  roots.replaceChildren();
  value.folders.forEach((folder, index) => {
    const input = textInput(roots, `root-${index}`, text.root.replace("{name}", folder.name), text.rootHint);
    input.value = folder.rootSetting ?? "";
    input.addEventListener("change", () => send({ action: "setting", key: "root", folder: folder.id, value: input.value.trim() }, text.saving));
  });
  document.querySelectorAll(".kv-slot-settings [data-setting],.kv-slot-settings input,[data-action]").forEach(element => {
    const action = element.dataset.action;
    element.dataset.locked = String(action === "settings" ? false : !value.trusted || Boolean(action && value.actions[action] === false));
  });
  const available = value.trusted && value.settings.mode === "embedded" && value.folders.length > 0;
  view.configureModels({ folders: value.settings.mode === "embedded" ? value.folders : [],
    available: value.trusted && (available || value.settings.mode === "remote") });
  view.setEnabled(available);
  view.configureSearch({ folders: value.folders, kinds: value.settings.corpusMode === "aikido", available,
    reason: statusMessage(value) ?? text.searchEmbedded });
  showStatus(value);
  setBusy(false);
}

document.querySelectorAll("[data-setting]").forEach(element => element.addEventListener("change", () => {
  const value = element.tagName === "INPUT" ? element.value.trim() : element.value;
  if (state && value === (state.settings[element.dataset.setting] ?? "")) return;
  send({ action: "setting", key: element.dataset.setting, value }, text.saving);
}));

window.addEventListener("message", event => {
  const message = event.data;
  if (message.type === "state") { view.setNotice(""); render(message.value); }
  if (message.type === "status" && state) { state.folders = message.value; showStatus(state); }
  if (message.type === "focus" && message.value === "search") view.focusSearch();
  if (message.type === "search") { setBusy(false); view.setNotice(""); view.showSearch(message.value); }
  if (message.type === "models") { setBusy(false); view.setNotice(message.cancelled ? text.done : ""); view.showModels(message.value); }
  if (message.type === "done") { setBusy(false); view.setNotice(message.message ?? text.done); vscode.postMessage({ action: "refresh" }); }
  if (message.type === "error") { setBusy(false); view.setError(message.message); }
});
vscode.postMessage({ action: "refresh" });
