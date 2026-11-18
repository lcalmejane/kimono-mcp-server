"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { startMcpClient, startRemoteMcpClient } = require("./mcp-client.cjs");

/**
 * Collaboration de connaissance de Kimono (repris de tatami-agent, 0.9.10) : comparer, récupérer et publier entre ce
 * ROOT local et une réplique Kimono distante, ou la connaissance partagée d'un projet Tatami Core. Kimono porte son propre
 * connecteur Tatami Core (appairage d'extension, jeton limité au projet) : aucune autre extension ne sert de relais.
 */
const tatamiKey = "kimono.tatamiConnection";

// Image IDE de Tatami : l'origine publique est jointe par l'adresse interne de la stack.
function coreTransportOrigin(origin, environment = process.env) {
  const publicOrigin = environment.TATAMI_CORE_PUBLIC_URL;
  const internalOrigin = environment.TATAMI_CORE_INTERNAL_URL;
  if (!publicOrigin || !internalOrigin || origin !== new URL(publicOrigin).origin) return origin;
  const target = new URL(internalOrigin);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password ||
      target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Invalid managed Tatami Core transport origin.");
  }
  return target.origin;
}

const toolName = "aikido_collaboration";
const maxFiles = 2000;
const maxFileBytes = 256 * 1024;
const maxTotalBytes = 8 * 1024 * 1024;
const pageSize = 100;
const textExtensions = new Set([
  ".md", ".mdx", ".mdc", ".txt", ".json", ".yaml", ".yml", ".toml", ".js", ".mjs", ".cjs",
  ".sh", ".py", ".ts", ".xml",
]);
const excludedDirectories = new Set([
  ".git", ".ssh", "node_modules", "dist", "build", "coverage", ".venv", "__pycache__", ".next",
  ".nuxt", ".cache", ".nyc_output", "temp", "credentials", "secrets",
]);
const blockedSegments = new Set([".git", ".ssh", "credentials", "secrets"]);
const baseKeyPrefix = "kimono.collaboration.base.";

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f]/g, " ").slice(0, 500);
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} returned invalid JSON.`); }
}

function decodeToolResult(serialized, parseText = true) {
  const wrapper = parseJson(serialized, "Kimono");
  if (wrapper?.isError) throw new Error("Kimono reported a tool error.");
  const text = wrapper?.content?.find(item => item?.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Kimono returned no collaboration result.");
  try { return JSON.parse(text); }
  catch {
    if (parseText) throw new Error("Kimono collaboration returned invalid JSON.");
    return { message: text };
  }
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kimono returned an invalid manifest.");
  const entries = Object.entries(value);
  if (entries.length > maxFiles || entries.some(([name, hash]) => !validKnowledgePath(name) || !validHash(hash))) {
    throw new Error("Kimono returned an invalid or oversized manifest.");
  }
  return value;
}

function validKnowledgePath(value) {
  if (typeof value !== "string" || !value || value.length > 1000 || value.includes("\\") ||
      value.startsWith("/") || /^[a-zA-Z]:/.test(value) || value.includes("\0")) return false;
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || blockedSegments.has(segment.toLowerCase()))) return false;
  if (segments[0] === "prompts" && segments[1] === "spec" && process.env.AIKIDO_INCLUDE_SPEC !== "true") return false;
  if (segments[0] === "spec" && process.env.AIKIDO_INCLUDE_SPEC !== "true") return false;
  if (!textExtensions.has(path.extname(value).toLowerCase())) return false;
  const lower = value.toLowerCase();
  return !/(?:^|\/)\.env(?:$|\.)/.test(lower) &&
    !/(?:^|\/)(?:id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc)$/.test(lower) &&
    !/\.(?:pem|key|p12|pfx)$/.test(lower);
}

function cleanRecords(value, label) {
  if (!Array.isArray(value) || value.length > maxFiles) throw new Error(`Kimono returned invalid ${label}.`);
  return value.map(record => {
    if (!record || typeof record !== "object" || !validKnowledgePath(record.path)) {
      throw new Error(`Kimono returned an unsafe path in ${label}.`);
    }
    for (const key of ["baseHash", "localHash", "sharedHash"]) {
      if (record[key] !== undefined && record[key] !== null && !validHash(record[key])) {
        throw new Error(`Kimono returned an invalid hash in ${label}.`);
      }
    }
    return record;
  });
}

function collaborationBaseKey(root, target) {
  const identity = crypto.createHash("sha256").update(`${root}\0${target}`).digest("hex");
  return `${baseKeyPrefix}${identity}`;
}

function manifestHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function shouldSkipFile(relative, includeSpec) {
  const segments = relative.split("/");
  const lowerSegments = segments.map(segment => segment.toLowerCase());
  if (lowerSegments.some(segment => excludedDirectories.has(segment) || blockedSegments.has(segment))) return true;
  if (!includeSpec && (lowerSegments[0] === "spec" ||
      lowerSegments[0] === "prompts" && lowerSegments[1] === "spec")) return true;
  const lower = relative.toLowerCase();
  return /(?:^|\/)\.env(?:$|\.)/.test(lower) ||
    /(?:^|\/)(?:id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc)$/.test(lower) ||
    /\.(?:pem|key|p12|pfx)$/.test(lower);
}

async function scanReplica(root) {
  const canonicalRoot = await fs.realpath(root);
  const includeSpec = process.env.AIKIDO_INCLUDE_SPEC === "true";
  const candidates = [];
  let hasGitIgnore = false;
  async function walk(directory, relative = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name === ".gitignore" && entry.isFile()) hasGitIgnore = true;
      if (shouldSkipFile(name, includeSpec)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(fullPath, name);
      } else if (entry.isFile() && textExtensions.has(path.extname(entry.name).toLowerCase())) {
        candidates.push(name);
        if (candidates.length > maxFiles * 10) throw new Error("Workspace has too many candidate knowledge files to sync safely.");
      }
    }
  }
  await walk(canonicalRoot);

  const ignored = new Set();
  if (candidates.length) {
    let hasRepository = false;
    let directory = canonicalRoot;
    while (true) {
      try { await fs.lstat(path.join(directory, ".git")); hasRepository = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!hasRepository && hasGitIgnore) {
      throw new Error("This non-Git workspace has .gitignore rules that cannot be evaluated safely; initialize Git before remote knowledge sync.");
    }
    if (hasRepository) for (let offset = 0; offset < candidates.length; offset += 500) {
      const batch = candidates.slice(offset, offset + 500);
      let output = "";
      try {
        output = execFileSync("git", ["-C", canonicalRoot, "check-ignore", "--no-index", "-z", "--stdin"], {
          input: `${batch.join("\0")}\0`, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        if (error.code === "ENOENT") throw new Error("Git is required to respect .gitignore during remote Kimono collaboration.");
        if (error.status !== 1) throw new Error("Unable to evaluate .gitignore for the workspace.");
        output = error.stdout ?? "";
      }
      for (const item of output.split("\0")) if (item) ignored.add(item);
    }
  }

  const manifest = {};
  let totalBytes = 0;
  const paths = candidates.filter(name => !ignored.has(name)).sort();
  if (paths.length > maxFiles) throw new Error(`Workspace exceeds the ${maxFiles}-file Kimono collaboration limit.`);
  for (const relative of paths) {
    const fullPath = path.join(canonicalRoot, ...relative.split("/"));
    const info = await fs.lstat(fullPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Workspace file changed during scan: ${relative}`);
    if (info.size > maxFileBytes) throw new Error(`Workspace file exceeds the 256 KiB sync limit: ${relative}`);
    const content = await fs.readFile(fullPath);
    if (content.length > maxFileBytes) throw new Error(`Workspace file exceeds the 256 KiB sync limit: ${relative}`);
    if (!Buffer.from(content.toString("utf8"), "utf8").equals(content)) {
      throw new Error(`Knowledge file is not valid UTF-8 and cannot be synchronized: ${relative}`);
    }
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) throw new Error("Workspace exceeds the 8 MiB Kimono collaboration limit.");
    manifest[relative] = manifestHash(content);
  }
  return { root: canonicalRoot, manifest, totalBytes };
}

async function verifyRootFile(root, relative, expectedHash, { createParents = false } = {}) {
  if (!validKnowledgePath(relative)) throw new Error(`Unsafe knowledge path: ${relative}`);
  const canonicalRoot = await fs.realpath(root);
  const fullPath = path.resolve(canonicalRoot, ...relative.split("/"));
  const rel = path.relative(canonicalRoot, fullPath);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Knowledge path escapes the workspace: ${relative}`);
  const segments = rel.split(path.sep);
  let parent = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    try {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory in knowledge path: ${relative}`);
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) throw error.code === "ENOENT" ? new Error(`Knowledge directory is missing: ${relative}`) : error;
      await fs.mkdir(parent);
    }
    if (await fs.realpath(parent) !== parent) throw new Error(`Knowledge path resolves through a symlink: ${relative}`);
  }
  let current = null;
  try {
    const stat = await fs.lstat(fullPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe target file: ${relative}`);
    if (await fs.realpath(fullPath) !== fullPath) throw new Error(`Knowledge path resolves through a symlink: ${relative}`);
    const content = await fs.readFile(fullPath);
    if (content.length > maxFileBytes) throw new Error(`Local file exceeds the 256 KiB sync limit: ${relative}`);
    current = { content, hash: manifestHash(content), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if ((current?.hash ?? null) !== expectedHash) throw new Error(`Local file changed after comparison; refresh before retrying: ${relative}`);
  return { fullPath, current };
}

async function writeReplicaFile(root, relative, content, expectedHash, nextHash) {
  const { fullPath, current } = await verifyRootFile(root, relative, expectedHash, { createParents: content !== null });
  if (content === null) {
    if (current) await fs.unlink(fullPath);
    return;
  }
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > maxFileBytes ||
      manifestHash(Buffer.from(content, "utf8")) !== nextHash) {
    throw new Error(`Invalid or oversized shared content for ${relative}`);
  }
  const parent = path.dirname(fullPath);
  const temporary = path.join(parent, `.tatami-collaboration-${crypto.randomBytes(12).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode: current?.mode ?? 0o600 });
    const latest = await verifyRootFile(root, relative, expectedHash);
    if (latest.fullPath !== fullPath) throw new Error("Workspace path changed during collaboration.");
    await fs.rename(temporary, fullPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readLocalChanges(root, localManifest, records) {
  const changes = [];
  let total = 0;
  for (const record of records) {
    const expected = record.localHash ?? null;
    const { fullPath, current } = await verifyRootFile(root, record.path, expected);
    if (expected === null) {
      changes.push({ path: record.path, content: null });
      continue;
    }
    if (!current || localManifest[record.path] !== expected) {
      throw new Error(`Local file changed after comparison; refresh before retrying: ${record.path}`);
    }
    const content = current.content.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(current.content)) {
      throw new Error(`Local knowledge is not valid UTF-8: ${record.path}`);
    }
    total += Buffer.byteLength(content, "utf8");
    if (total > maxTotalBytes) throw new Error("Local changes exceed the 8 MiB publication limit.");
    changes.push({ path: record.path, content });
  }
  return changes;
}

function pageRecords(page, key, label) {
  return cleanRecords(page[key] ?? [], label);
}

async function remoteSnapshot(kimono, root, workspaceState, target) {
  const rootScan = await scanReplica(root);
  const status = await callMcp(kimono, { operation: "status" });
  if (typeof status.sharedVersion !== "string" || !status.sharedVersion) {
    throw new Error("Kimono status did not include a shared revision.");
  }
  const manifest = validManifest(status.sharedManifest ?? status.manifest);
  const rootConflicts = cleanRecords(status.rootConflicts ?? [], "ROOT conflicts");
  const baseKey = collaborationBaseKey(rootScan.root, target);
  let baseVersion = workspaceState.get(baseKey);
  if (baseVersion !== undefined && baseVersion !== null && typeof baseVersion !== "string") {
    throw new Error("Stored Kimono collaboration baseline is invalid.");
  }
  if (!baseVersion) {
    baseVersion = status.sharedVersion;
    await workspaceState.update(baseKey, baseVersion);
  }
  const compare = await collectCompare(kimono, rootScan.manifest, baseVersion);
  if (compare.sharedVersion !== status.sharedVersion) {
    throw new Error("Shared Kimono knowledge changed during comparison. Refresh and retry.");
  }
  return {
    ...status, manifest, rootConflicts, localManifest: rootScan.manifest,
    localBytes: rootScan.totalBytes, baseVersion, baseKey, ...compare,
  };
}

async function callMcp(kimono, args) {
  const { targetTool = toolName, ...input } = args;
  const result = decodeToolResult(await kimono.call(targetTool, input, {
    mode: input.operation === "publish" || targetTool === "aikido_index" && ["update", "rebuild"].includes(input.operation)
      || targetTool === "aikido_models" && input.operation !== "status" ? "act" : "plan",
    permissions: "allow", yolo: true, approve: async () => false,
  }), targetTool !== "aikido_index" && targetTool !== "aikido_models");
  return result;
}

async function collectCompare(kimono, localManifest, baseVersion) {
  const result = { sharedVersion: "", additions: [], modifications: [], deletions: [], localChanges: [], conflicts: [] };
  const paths = new Set();
  let offset = 0;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await callMcp(kimono, {
      operation: "compare", localManifest, ...(baseVersion ? { baseVersion } : {}), offset, limit: pageSize,
    });
    if (typeof page.sharedVersion !== "string" || !page.sharedVersion) throw new Error("Kimono compare did not include a shared revision.");
    if (result.sharedVersion && page.sharedVersion !== result.sharedVersion) throw new Error("Shared Kimono knowledge changed during pagination.");
    result.sharedVersion = page.sharedVersion;
    for (const key of ["additions", "modifications", "deletions", "localChanges", "conflicts"]) {
      result[key].push(...pageRecords(page, key, key));
      if (result[key].length > maxFiles) throw new Error("Kimono comparison exceeds the 2000-file limit.");
      for (const record of result[key]) {
        paths.add(record.path);
        if (paths.size > maxFiles) throw new Error("Kimono comparison exceeds the 2000-file limit.");
      }
    }
    if (page.nextOffset === null || page.nextOffset === undefined) return result;
    if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Kimono returned invalid comparison pagination.");
    offset = page.nextOffset;
  }
  throw new Error("Kimono comparison exceeded its pagination limit.");
}

function allSharedChanges(snapshot) {
  return [...snapshot.additions, ...snapshot.modifications, ...snapshot.deletions];
}

async function chooseResolutions(vscode, conflicts, language = "en") {
  const resolutions = {};
  for (const conflict of conflicts) {
    const local = conflict.localHash === null ? (language === "fr" ? "Supprimer localement" : "Keep local deletion") :
      (language === "fr" ? "Conserver la version locale" : "Keep local version");
    const shared = conflict.sharedHash === null ? (language === "fr" ? "Supprimer la version partagée" : "Accept shared deletion") :
      (language === "fr" ? "Prendre la version partagée" : "Use shared version");
    const choice = await vscode.window.showQuickPick([
      { label: local, value: "local", description: `${language === "fr" ? "Local" : "Local"} · ${conflict.path}` },
      { label: shared, value: "shared", description: `${language === "fr" ? "Partagé" : "Shared"} · ${conflict.path}` },
    ], { title: language === "fr" ? `Conflit de connaissance · ${conflict.path}` : `Knowledge conflict · ${conflict.path}`,
      placeHolder: language === "fr" ? "Choisissez explicitement une version" : "Choose one version explicitly", ignoreFocusOut: true });
    if (!choice) return undefined;
    resolutions[conflict.path] = choice.value;
  }
  return resolutions;
}

function snapshotSummary(snapshot, language) {
  const fr = language === "fr";
  if (snapshot.counts) {
    return fr ? `${snapshot.counts.local} local · ${snapshot.counts.shared} partagé · ${snapshot.counts.conflict} conflits`
      : `${snapshot.counts.local} local · ${snapshot.counts.shared} shared · ${snapshot.counts.conflict} conflicts`;
  }
  const shared = allSharedChanges(snapshot).length;
  const rootConflicts = snapshot.rootConflicts?.length ?? 0;
  return fr ? `${snapshot.localChanges.length} local · ${shared} partagé · ${snapshot.conflicts.length} conflits · ${rootConflicts} conflits ROOT`
    : `${snapshot.localChanges.length} local · ${shared} shared · ${snapshot.conflicts.length} conflicts · ${rootConflicts} ROOT conflicts`;
}

function itemsFromSnapshot(snapshot, language) {
  if (Array.isArray(snapshot.changes)) return snapshot.changes.map(change => ({
    label: `${change.status === "conflict" ? "⚠ " : ""}${change.path}`,
    description: change.status === "conflict" ? (language === "fr" ? "Conflit · résolution obligatoire" : "Conflict · resolution required") :
      change.status === "shared" ? (language === "fr" ? "Disponible dans les connaissances partagées" : "Available in shared knowledge") :
        (language === "fr" ? "Modification locale" : "Local change"),
  }));
  return [
    ...snapshot.additions.map(item => ({ label: `+ ${item.path}`, description: language === "fr" ? "Ajout partagé" : "Shared addition" })),
    ...snapshot.modifications.map(item => ({ label: `~ ${item.path}`, description: language === "fr" ? "Modification partagée" : "Shared modification" })),
    ...snapshot.deletions.map(item => ({ label: `− ${item.path}`, description: language === "fr" ? "Suppression partagée" : "Shared deletion" })),
    ...snapshot.localChanges.map(item => ({ label: `● ${item.path}`, description: language === "fr" ? "Modification locale à publier" : "Local change to publish" })),
    ...snapshot.conflicts.map(item => ({ label: `⚠ ${item.path}`, description: language === "fr" ? "Conflit · résolution obligatoire" : "Conflict · resolution required" })),
    ...(snapshot.rootConflicts ?? []).map(item => ({
      label: `⚠ ROOT · ${item.path}`,
      description: language === "fr" ? "Conflit du ROOT configuré côté Kimono, à résoudre avant publication" :
        "Conflict in the Kimono-configured ROOT; resolve before publishing",
    })),
  ];
}

async function selectWorkspaceRoot(vscode) {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === "file");
  if (!folders.length) throw new Error("Open a filesystem workspace before using Kimono collaboration.");
  let selected = folders[0];
  if (folders.length > 1) {
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })),
      { placeHolder: "Choose the local workspace for Kimono knowledge sync" });
    if (!choice) return undefined;
    selected = choice.folder;
  }
  return fs.realpath(selected.uri.fsPath);
}

async function coreRequest(origin, token, route, method = "GET", body, timeout = 30_000) {
  const response = await fetch(new URL(route, `${coreTransportOrigin(origin)}/`), {
    method, redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Tatami Core returned an oversized collaboration response.");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Tatami Core returned invalid collaboration data."); }
  if (!response.ok) {
    const detail = typeof value.error === "string" ? value.error.replaceAll(token, "[redacted]") :
      `Tatami Core request failed (${response.status}).`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return value;
}

function validateCoreSnapshot(snapshot) {
  if (!snapshot || !["string", "object"].includes(typeof snapshot) ||
      typeof snapshot.localVersion !== "string" || typeof snapshot.sharedVersion !== "string" ||
      !Array.isArray(snapshot.changes) || !snapshot.counts ||
      !["local", "shared", "conflict"].every(key => Number.isInteger(snapshot.counts[key]) && snapshot.counts[key] >= 0)) {
    throw new Error("Tatami Core returned an invalid collaboration snapshot.");
  }
  for (const change of snapshot.changes) {
    if (!change || !validKnowledgePath(change.path) || !["local", "shared", "conflict"].includes(change.status)) {
      throw new Error("Tatami Core returned an unsafe collaboration path.");
    }
    for (const key of ["localHash", "sharedHash", "baseHash"]) {
      if (change[key] !== undefined && change[key] !== null && !validHash(change[key])) {
        throw new Error("Tatami Core returned an invalid collaboration hash.");
      }
    }
  }
  return snapshot;
}

function registerCollaborationCommands(vscode, context, { api, config: settings = () => vscode.workspace.getConfiguration("kimono"), showError, pair = pairWithTatami }) {
  let tatami;
  const loadTatami = async () => {
    const stored = await context.secrets.get(tatamiKey);
    tatami = stored ? JSON.parse(stored) : undefined;
  };
  void loadTatami();
  const isManaged = () => !!tatami;
  const readBootstrap = async () => {
    await loadTatami();
    if (!tatami) throw new Error("Connect Kimono to a Tatami Core project first (Kimono: Connect to Tatami Core).");
    return tatami;
  };
  const kimonoConfiguration = () => {
    const config = settings();
    return { mode: config.get("mode", "embedded"), url: config.get("url", "") };
  };
  // Client MCP sur la connexion choisie par Kimono (même adaptateur que celui de ses consommateurs).
  const contextKimono = (_vscode, _context, root) => {
    let client;
    const open = () => client ??= api.connection(root).then(connection => {
      if (!connection) throw new Error("Kimono is disabled or the workspace is not trusted.");
      const version = context.extension?.packageJSON?.version;
      return connection.transport === "http"
        ? startRemoteMcpClient(connection.url, connection.headers.Authorization?.replace(/^Bearer /, ""), { version })
        : startMcpClient(connection, { version });
    });
    return {
      async call(name, args) {
        const result = await (await open()).call(name, args);
        return JSON.stringify({ content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] });
      },
      async dispose() { const opened = client && await client.catch(() => undefined); opened?.close?.(); client = undefined; },
    };
  };
  const output = vscode.window.createOutputChannel("Kimono knowledge collaboration");
  function report(text) {
    output.appendLine(text);
    output.show(true);
    void vscode.window.showInformationMessage(text.slice(0, 300));
  }
  function fail(error) {
    showError(error);
    output.appendLine(`Error: ${errorMessage(error)}`);
    output.show(true);
  }
  async function getCore() {
    if (!vscode.workspace.isTrusted) throw new Error("Trust the workspace before syncing project knowledge.");
    const saved = await readBootstrap();
    const identity = await coreRequest(saved.origin, saved.token, "/api/me");
    if (!identity.projects?.some(project => project.id === saved.projectId)) {
      throw new Error("The authenticated Core user no longer has access to this project.");
    }
    return { ...saved, path: `/api/workspaces/${encodeURIComponent(saved.projectId)}/kimono/collaboration` };
  }
  async function getCoreSnapshot(core) {
    return validateCoreSnapshot(await coreRequest(core.origin, core.token, core.path));
  }
  async function getStandalone(root) {
    if (!vscode.workspace.isTrusted) throw new Error("Trust the workspace before syncing shared knowledge.");
    const config = kimonoConfiguration();
    if (config.mode === "embedded") {
      throw new Error("The embedded Kimono MCP uses this same local ROOT. Reindex its local knowledge instead of pulling or publishing.");
    }
    if (config.mode !== "remote") throw new Error("Enable a remote Kimono MCP before using replica collaboration.");
    const storageDirectory = path.join(context.globalStorageUri.fsPath,
      crypto.createHash("sha256").update(root).digest("hex"));
    const kimono = contextKimono(vscode, context, root, storageDirectory);
    return { kimono, config, target: config.url };
  }
  async function snapshot() {
    if (isManaged()) {
      const core = await getCore();
      return { source: "core", core, value: await getCoreSnapshot(core) };
    }
    const root = await selectWorkspaceRoot(vscode);
    if (!root) return undefined;
    const standalone = await getStandalone(root);
    try {
      const value = await remoteSnapshot(standalone.kimono, root, context.workspaceState, standalone.target);
      return { source: "remote", root, kimono: standalone.kimono, config: standalone.config, value };
    } catch (error) {
      await standalone.kimono.dispose();
      throw error;
    }
  }
  async function compare() {
    try {
        if (!isManaged()) {
          const root = await selectWorkspaceRoot(vscode);
          if (!root) return;
          const config = kimonoConfiguration();
          if (config.mode === "embedded") {
            const storageDirectory = path.join(context.globalStorageUri.fsPath,
              crypto.createHash("sha256").update(root).digest("hex"));
            const kimono = contextKimono(vscode, context, root, storageDirectory);
            try {
              const status = await callMcp(kimono, { targetTool: "aikido_index", operation: "status" });
              report(`Shared-directory mode: VS Code and embedded Kimono use this same local ROOT. No replica compare, pull or publish is needed. Local index status: ${JSON.stringify(status).slice(0, 300)}. Reindex after edits when needed; Git remains separate.`);
            } finally { await kimono.dispose(); }
            return;
          }
        }
        const current = await snapshot();
      if (!current) return;
      const items = itemsFromSnapshot(current.value, "en");
      const summary = snapshotSummary(current.value, "en");
      output.appendLine(`Mode: ${current.source === "core" ? "Tatami Core project-shared knowledge" : "Remote Kimono personal replica"}; Git publication is separate.`);
      output.appendLine(summary);
      items.forEach(item => output.appendLine(`${item.label} — ${item.description}`));
      if (!items.length) report("Kimono knowledge is in sync. Git publication is separate.");
      else {
        output.show(true);
        void vscode.window.showInformationMessage(`Kimono: ${summary}. Review full paths in the Kimono collaboration output. No Git operation was performed.`);
      }
    } catch (error) { fail(error); }
    finally {
      if (current?.kimono) await current.kimono.dispose().catch(() => {});
    }
  }
  async function resolveConflicts(conflicts, language = "en") {
    return chooseResolutions(vscode, conflicts, language);
  }
  async function coreApply(operation) {
    const core = await getCore();
    const snapshotValue = await getCoreSnapshot(core);
    const conflicts = snapshotValue.changes.filter(change => change.status === "conflict");
    const resolutions = await resolveConflicts(conflicts);
    if (!resolutions) return;
    const count = operation === "pull" ? snapshotValue.counts.shared : snapshotValue.counts.local;
    if (count === 0 && conflicts.length === 0) {
      report("No knowledge changes to synchronize. Git remains unchanged.");
      return;
    }
    const description = operation === "pull"
      ? "Pull project-shared knowledge into this project workspace"
      : "Publish local knowledge into this project's shared knowledge";
    const confirmation = await vscode.window.showWarningMessage(
      `${description}?\n${count} change(s), ${conflicts.length} conflict(s). Project-shared knowledge only; no Git commit, push, pull, or merge will occur.`,
      { modal: true }, operation === "pull" ? "Pull knowledge" : "Publish knowledge");
    if (!confirmation) return;
    const result = await coreRequest(core.origin, core.token, core.path, "POST", {
      operation, expectedLocalVersion: snapshotValue.localVersion, expectedSharedVersion: snapshotValue.sharedVersion, resolutions,
    });
    report(operation === "pull"
      ? `Pulled ${result.saved ?? count} knowledge change(s). Git remains unchanged.`
      : `Published ${result.saved ?? count} knowledge change(s) to project-shared knowledge. Git remains unchanged.`);
  }
  async function getSharedRead(kimono, sharedVersion, paths) {
    const files = {};
    for (let offset = 0; offset < paths.length; offset += pageSize) {
      const page = await callMcp(kimono, { operation: "read", sharedVersion, paths: paths.slice(offset, offset + pageSize) });
      if (page.sharedVersion !== sharedVersion || !page.files || typeof page.files !== "object" || Array.isArray(page.files)) {
        throw new Error("Kimono returned an invalid shared knowledge snapshot.");
      }
      Object.assign(files, page.files);
    }
    return files;
  }
  async function remotePull(snapshotValue, kimono, root) {
    const conflicts = snapshotValue.conflicts;
    const resolutions = await resolveConflicts(conflicts);
    if (!resolutions) return;
    const apply = new Map(allSharedChanges(snapshotValue).map(record => [record.path, record]));
    for (const conflict of conflicts) if (resolutions[conflict.path] === "shared") apply.set(conflict.path, conflict);
    for (const conflict of conflicts) if (resolutions[conflict.path] === "local") apply.delete(conflict.path);
    const paths = [...apply.keys()];
    if (!paths.length) {
      report("No shared knowledge changes to pull. Git remains unchanged.");
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Pull ${paths.length} shared knowledge change(s) from the configured remote Kimono service? ${conflicts.length} conflict(s) will use your explicit selections. This writes eligible local knowledge files only; Git is unchanged.`,
      { modal: true }, "Pull knowledge");
    if (!confirmation) return;
    const files = await getSharedRead(kimono, snapshotValue.sharedVersion, paths);
    let total = 0;
    for (const [relative, record] of apply) {
      if (!Object.hasOwn(files, relative)) throw new Error(`Kimono omitted a requested shared path: ${relative}`);
      const content = files[relative];
      const expectedSharedHash = record.sharedHash ?? (snapshotValue.manifest[relative] ?? null);
      if (content !== null && typeof content !== "string") throw new Error(`Kimono returned invalid content for ${relative}`);
      if (content !== null) {
        const bytes = Buffer.byteLength(content, "utf8");
        total += bytes;
        if (bytes > maxFileBytes || total > maxTotalBytes || manifestHash(Buffer.from(content, "utf8")) !== expectedSharedHash) {
          throw new Error(`Shared content failed size or hash validation: ${relative}`);
        }
      } else if (expectedSharedHash !== null) {
        throw new Error(`Shared deletion does not match its manifest: ${relative}`);
      }
      await verifyRootFile(root, relative, snapshotValue.localManifest[relative] ?? null, { createParents: content !== null });
    }
    for (const [relative, record] of apply) {
      await writeReplicaFile(root, relative, files[relative], snapshotValue.localManifest[relative] ?? null,
        record.sharedHash ?? (snapshotValue.manifest[relative] ?? null));
    }
    await context.workspaceState.update(snapshotValue.baseKey, snapshotValue.sharedVersion);
    report(`Pulled ${paths.length} shared knowledge change(s). No Git operation was performed.`);
  }
  async function remotePublish(snapshotValue, kimono, root) {
    if (snapshotValue.rootConflicts?.length) {
      throw new Error("The configured Kimono ROOT has unresolved conflicts with shared knowledge. Resolve those on the Kimono server before publishing a replica.");
    }
    const resolutions = await resolveConflicts(snapshotValue.conflicts);
    if (!resolutions) return;
    const localRecords = new Map(snapshotValue.localChanges.map(record => [record.path, record]));
    for (const conflict of snapshotValue.conflicts) {
      if (conflict.localHash !== conflict.baseHash) localRecords.set(conflict.path, conflict);
    }
    const changes = await readLocalChanges(root, snapshotValue.localManifest, [...localRecords.values()]);
    if (!changes.length && !snapshotValue.conflicts.length) {
      report("No local knowledge changes to publish. Git remains unchanged.");
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Send ${changes.length} local knowledge change(s) to the configured remote Kimono service? ${snapshotValue.conflicts.length} conflict(s) will use your explicit selections. Check that service's access policy; this is separate from Git publication.`,
      { modal: true }, "Publish knowledge");
    if (!confirmation) return;
    const payload = {
      operation: "publish",
      expectedSharedVersion: snapshotValue.sharedVersion,
      ...(snapshotValue.baseVersion ? { baseVersion: snapshotValue.baseVersion } : {}),
      localManifest: snapshotValue.localManifest,
      changes,
      resolutions,
    };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 512 * 1024) {
      throw new Error("Kimono collaboration publication exceeds the 512 KiB MCP request limit. Split the knowledge change into smaller explicit batches.");
    }
    const result = await callMcp(kimono, payload);
    if (Array.isArray(result.conflicts) && result.conflicts.length) {
      throw new Error("Kimono detected unresolved or stale conflicts. Compare again and choose a resolution; no baseline was advanced.");
    }
    if (typeof result.sharedVersion !== "string" || !result.sharedVersion) throw new Error("Kimono did not confirm the published revision.");
    await context.workspaceState.update(snapshotValue.baseKey, result.sharedVersion);
    report(`Published ${changes.length} knowledge change(s) to the configured Kimono shared knowledge. No Git operation was performed.`);
  }
  async function applyRemote(operation) {
    let current;
    try {
      current = await snapshot();
      if (!current) return;
      if (current.source !== "remote") throw new Error("This operation uses a managed Core path.");
      if (operation === "pull") await remotePull(current.value, current.kimono, current.root);
      else await remotePublish(current.value, current.kimono, current.root);
    } catch (error) { fail(error); }
    finally { if (current?.kimono) await current.kimono.dispose().catch(() => {}); }
  }
  async function reindexLocal() {
    let kimono;
    try {
      if (isManaged()) throw new Error("Tatami Core manages shared project knowledge. Use Compare, Pull or Publish.");
      if (!vscode.workspace.isTrusted) throw new Error("Trust the workspace before reindexing Kimono knowledge.");
      const root = await selectWorkspaceRoot(vscode);
      if (!root) return;
      const config = kimonoConfiguration();
      if (config.mode === "remote") throw new Error("A remote Kimono MCP owns a different ROOT. Use Compare, Pull or Publish for that replica.");
      if (config.mode !== "embedded") throw new Error("Enable embedded Kimono before reindexing the shared local ROOT.");
      const confirmation = await vscode.window.showWarningMessage(
        "Reindex eligible knowledge from this same local ROOT into the private Kimono search cache? This does not pull, publish, or change Git.",
        { modal: true }, "Reindex local knowledge");
      if (!confirmation) return;
      const storageDirectory = path.join(context.globalStorageUri.fsPath,
        crypto.createHash("sha256").update(root).digest("hex"));
      kimono = contextKimono(vscode, context, root, storageDirectory);
      await callMcp(kimono, { operation: "update", targetTool: "aikido_index" });
      report("Local Kimono knowledge reindex completed. No pull, publication, or Git operation occurred.");
    } catch (error) { fail(error); }
    finally { if (kimono) await kimono.dispose().catch(() => {}); }
  }
  async function run(action) {
    if (action === "compare") return compare();
    if (action === "pull" || action === "publish") {
      if (isManaged()) return coreApply(action).catch(fail);
      return applyRemote(action);
    }
    if (action === "reindex") return reindexLocal();
    throw new Error("Unknown Kimono collaboration action.");
  }
  const commands = [
    ["kimono.compare", "compare"],
    ["kimono.pull", "pull"],
    ["kimono.publish", "publish"],
    ["kimono.reindex", "reindex"],
  ].map(([id, action]) => vscode.commands.registerCommand(id, () => run(action).catch(fail)));
  commands.push(
    context.secrets.onDidChange(event => { if (event.key === tatamiKey) void loadTatami(); }),
    vscode.commands.registerCommand("kimono.connectTatami", () => (async () => {
      const origin = await vscode.window.showInputBox({ title: "Tatami Core server", placeHolder: "https://tatami.example.com", ignoreFocusOut: true });
      if (!origin) return;
      const connection = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
        title: "Approve Kimono in the browser (choose the Tatami Core project)…" }, (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return pair(origin, { openExternal: url => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))), signal: controller.signal });
      });
      await context.secrets.store(tatamiKey, JSON.stringify(connection));
      await loadTatami();
      report(`Kimono connected to ${connection.origin} (project ${connection.projectId}).`);
    })().catch(fail)),
    vscode.commands.registerCommand("kimono.disconnectTatami", () => (async () => {
      await loadTatami();
      if (tatami) await coreRequest(tatami.origin, tatami.token, "/api/extension-auth/revoke", "POST", {}).catch(() => undefined);
      await context.secrets.delete(tatamiKey);
      await loadTatami();
      report("Kimono disconnected from Tatami Core.");
    })().catch(fail)),
  );
  return {
    run,
    mode() {
      if (isManaged()) return "core";
      try {
        const mode = kimonoConfiguration().mode;
        return mode === "embedded" ? "shared-directory" : mode === "remote" ? "personal-replica" : "unavailable";
      }
      catch { return "unavailable"; }
    },
    commands,
    output,
  };
}

/** Appairage d'extension de tatami-core (même protocole que l'extension Core Agent) : jeton limité au projet, compte vérifié. */
async function pairWithTatami(origin, { openExternal, signal, fetcher = fetch, intervalMs = 2000 }) {
  const url = new URL(origin);
  if (url.username || url.password || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Tatami Core requires HTTPS (or loopback HTTP), without credentials.");
  }
  const base = url.origin, transport = coreTransportOrigin(base);
  const post = async (route, body) => {
    const response = await fetcher(new URL(route, `${transport}/`), { method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Tatami Core: HTTP ${response.status}.`);
    return value;
  };
  const created = await post("/extension-auth/pairings", {});
  const pairingUrl = new URL(String(created.pairingUrl));
  if (pairingUrl.origin !== base) throw new Error("Unexpected Tatami Core pairing address.");
  await openExternal(pairingUrl.href);
  const deadline = Number(created.expiresAt) || Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Pairing cancelled.");
    const poll = await post("/extension-auth/pairings/poll", { pairingId: String(created.pairingId) });
    if (poll.status === "approved") {
      const token = String(poll.accessToken), projectId = String(poll.projectId);
      const me = await coreRequest(base, token, "/api/me");
      if (!me.user?.id) throw new Error("Tatami Core account not found.");
      return { origin: base, token, projectId, expiresAt: Number(poll.expiresAt), userName: me.user.name ?? me.user.id };
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error("Pairing expired: connect again.");
}

module.exports = {
  pairWithTatami, tatamiKey,
  collaborationBaseKey, decodeToolResult, manifestHash, readLocalChanges, scanReplica, validKnowledgePath,
  registerCollaborationCommands,
};
