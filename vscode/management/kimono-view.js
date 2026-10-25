// Kimono management panel view, shared verbatim by the standalone VS Code extension,
// Tatami Agent and the Tatami Core web UI so every mode shows the same panel.
// Canonical source: kimono-mcp-server/vscode/management/kimono-view.js — keep copies identical.
// Requires KimonoStatus (status-format.js) loaded first.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./status-format.js"));
  else root.KimonoView = factory(root.KimonoStatus);
}(typeof self !== "undefined" ? self : this, function (KimonoStatus) {
  "use strict";

  const strings = {
    en: {
      subtitleRag: "Local project RAG for your coding agents", subtitleAikido: "AI-KIDO knowledge base for your coding agents",
      modeRag: "RAG mode", modeAikido: "AI-KIDO mode",
      statusTitle: "Indexing status · live",
      statusIntro: "Files read, estimated tokens (UTF-8 bytes / 4) and embedded chunks versus totals, published in real time by the Kimono server. Lexical search works while the semantic index is being built.",
      noIndex: "No index yet. Kimono indexes automatically when an MCP client starts it, or start now.",
      startIndex: "Start indexing now", indexing: "Indexing…", refresh: "Refresh", progressOf: "{name} indexing progress",
      searchTitle: "Test a search",
      searchIntro: "Query Kimono exactly as an agent would. All modes share one snapshot; latency is measured from {origin}. Nothing in your project is modified.",
      searchNote: "Enriched text splits phrases and uses the repository glossaries; exact text keeps the whole phrase. While the semantic index is being built, text search stays available and semantic search reports its state.",
      folder: "Folder", modes: "Modes", limit: "Results per mode", kind: "Knowledge type", query: "Query",
      expected: "Expected documents", expectedHint: "(optional, comma-separated paths; folders end with /)", run: "Run search", searching: "Searching…",
      modeOptions: { "text+semantic": "Text and semantic (compare)", hybrid: "Hybrid", text: "Enriched text", literal: "Exact text",
        regex: "Regular expression", semantic: "Semantic", "literal+text+semantic": "All three" },
      kinds: { "": "All types", knowledge: "Knowledge", agent: "Agent", skill: "Skill", command: "Command", workflow: "Workflow" },
      modeLabels: { literal: "Exact text", text: "Enriched text", regex: "Regex", semantic: "Semantic", hybrid: "Hybrid" },
      snapshot: "Snapshot {version} · {documents} documents", performance: "Performance per mode",
      columns: ["Mode", "Status", "Latency", "Hits", "Documents", "MCP response", "Engine"], validationColumns: ["Recall", "Precision", "First relevant"],
      notReady: "Index preparing", partial: "Partial", ok: "OK", error: "Error",
      bytesTitle: "Exact compact MCP search response, without source text or automatic file reads",
      comparison: "Comparison", pair: "{modes}: {shared} shared documents · Jaccard {jaccard} · {top}", sameTop: "same top document", differentTop: "different top documents",
      only: "Only in {mode}: {paths}", fused: "Fused ranking (RRF)", fusedIntro: "Reciprocal rank fusion of successful modes: a document found by several modes ranks higher.",
      fusedValidation: "Recall {recall} · first relevant {first}", results: "Results · {mode} ({count})", noResults: "No results.", raw: "Full test report (JSON)", payload: "Raw MCP response · {mode} ({bytes} bytes, compact format sent to agents)",
      footer: "Kimono is part of the AI-KIDO toolset: Tatami Agent, Tatami IDE, Tatami Core and the AI-KIDO method.", website: "Discover ai-kido.fr",
    },
    fr: {
      subtitleRag: "RAG local du projet pour vos agents de code", subtitleAikido: "Base de connaissances AI-KIDO pour vos agents de code",
      modeRag: "mode RAG", modeAikido: "mode AI-KIDO",
      statusTitle: "État d'indexation · en direct",
      statusIntro: "Fichiers lus, tokens estimés (octets UTF-8 / 4) et passages vectorisés par rapport aux totaux, publiés en temps réel par le serveur Kimono. La recherche lexicale fonctionne pendant la construction de l'index sémantique.",
      noIndex: "Pas encore d'index. Kimono indexe automatiquement quand un client MCP le démarre, ou lancez-le maintenant.",
      startIndex: "Lancer l'indexation", indexing: "Indexation…", refresh: "Actualiser", progressOf: "Progression de l'indexation de {name}",
      searchTitle: "Tester une recherche",
      searchIntro: "Interrogez Kimono exactement comme un agent. Tous les modes partagent un même snapshot ; la latence est mesurée depuis {origin}. Aucun fichier du projet n'est modifié.",
      searchNote: "Le texte enrichi décompose les phrases et utilise les glossaires du dépôt ; le texte exact conserve la phrase entière. Pendant la construction de l'index sémantique, le texte reste disponible et la recherche sémantique indique son état.",
      folder: "Dossier", modes: "Modes", limit: "Résultats par mode", kind: "Type de connaissance", query: "Requête",
      expected: "Documents attendus", expectedHint: "(facultatif : chemins séparés par des virgules, dossier terminé par /)", run: "Lancer la recherche", searching: "Recherche en cours…",
      modeOptions: { "text+semantic": "Texte et sémantique (comparer)", hybrid: "Hybride", text: "Texte enrichi", literal: "Texte exact",
        regex: "Expression régulière", semantic: "Sémantique", "literal+text+semantic": "Les trois modes" },
      kinds: { "": "Tous les types", knowledge: "Connaissance", agent: "Agent", skill: "Skill", command: "Commande", workflow: "Workflow" },
      modeLabels: { literal: "Texte exact", text: "Texte enrichi", regex: "Regex", semantic: "Sémantique", hybrid: "Hybride" },
      snapshot: "Snapshot {version} · {documents} documents", performance: "Performance par mode",
      columns: ["Mode", "Statut", "Latence", "Passages", "Documents", "Réponse MCP", "Moteur"], validationColumns: ["Rappel", "Précision", "1er pertinent"],
      notReady: "Index en préparation", partial: "Partiel", ok: "OK", error: "Erreur",
      bytesTitle: "Réponse MCP compacte exacte, sans texte source ni lecture automatique de fichiers",
      comparison: "Comparaison", pair: "{modes} : {shared} documents communs · Jaccard {jaccard} · {top}", sameTop: "même premier document", differentTop: "premiers documents différents",
      only: "Uniquement en {mode} : {paths}", fused: "Classement fusionné (RRF)", fusedIntro: "Fusion par rang réciproque des modes réussis : un document trouvé par plusieurs modes remonte.",
      fusedValidation: "Rappel {recall} · 1er pertinent {first}", results: "Résultats · {mode} ({count})", noResults: "Aucun résultat.", raw: "Rapport de test complet (JSON)", payload: "Réponse MCP brute · {mode} ({bytes} octets, format compact envoyé aux agents)",
      footer: "Kimono fait partie des outils AI-KIDO : Tatami Agent, Tatami IDE, Tatami Core et la méthode AI-KIDO.", website: "Découvrir ai-kido.fr",
    },
  };
  const order = ["status", "settings", "sharing", "server", "search", "governance"];

  function language(value) {
    const raw = value ?? (typeof document !== "undefined" ? document.documentElement.lang || navigator.language : "en");
    return String(raw).toLowerCase().startsWith("fr") ? "fr" : "en";
  }
  function translator(lang) {
    const table = strings[language(lang)];
    const t = (key, values) => String(table[key] ?? strings.en[key] ?? key)
      .replace(/\{(\w+)\}/g, (match, name) => values && name in values ? String(values[name]) : match);
    t.table = table;
    return t;
  }

  function node(tag, text, parent, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    parent?.append(element);
    return element;
  }
  function option(value, label, parent) {
    const element = node("option", label, parent);
    element.value = value;
    return element;
  }
  function labelled(parent, id, text, control, hint) {
    const label = node("label", text, parent);
    label.htmlFor = id;
    if (hint) { label.append(" "); node("small", hint, label); }
    control.id = id;
    label.append(control);
    return control;
  }

  // Builds the canonical panel skeleton inside `root`. Sections appear in a fixed order;
  // a product only fills the sections it supports (settings, sharing, server, governance).
  function create(root, options = {}) {
    const lang = language(options.language);
    const t = translator(lang);
    const prefix = options.idPrefix ?? "kimono";
    const handlers = { start: options.onIndexStart, search: options.onSearch, refresh: options.onRefresh };
    let folders = [], pending = false, enabled = true, timer, fetcher, intervals = { activeMs: 1500, idleMs: 15000 };
    root.classList.add("kv");

    const header = node("header", undefined, root, "kv-header");
    if (options.icon) { const image = node("img", undefined, header); image.src = options.icon; image.alt = ""; }
    const heading = node("div", undefined, header);
    node(options.headingTag ?? "h1", options.title ?? "Kimono MCP", heading);
    const subtitle = node("span", "", heading, "kv-muted");
    const notice = node("div", "", root, "kv-notice"); notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite");
    const failure = node("div", "", root, "kv-error"); failure.setAttribute("role", "alert");
    const slots = Object.fromEntries(order.map(name => [name, node("div", undefined, root, `kv-slot kv-slot-${name}`)]));
    const footer = node("p", `${t("footer")} `, root, "kv-muted kv-footer");
    const website = node("a", t("website"), footer);
    website.href = "https://ai-kido.fr";
    website.target = "_blank";
    website.rel = "noopener noreferrer";
    if (options.onWebsite) website.addEventListener("click", event => { event.preventDefault(); options.onWebsite(); });

    function setHeader({ corpusMode, version, context } = {}) {
      const aikido = corpusMode === "aikido";
      subtitle.textContent = [options.subtitle ?? t(aikido ? "subtitleAikido" : "subtitleRag"), t(aikido ? "modeAikido" : "modeRag"),
        context, version ? `v${version}` : undefined].filter(Boolean).join(" · ");
    }

    // Returns the body of a canonical section. `collapsible` renders a <details> card.
    function section(name, title, { intro, collapsible = false, open = false } = {}) {
      const slot = slots[name];
      if (!slot) throw new Error(`Unknown Kimono section: ${name}`);
      slot.replaceChildren();
      const card = node(collapsible ? "details" : "section", undefined, slot, "kv-card");
      const titleId = `${prefix}-${name}-title`;
      if (collapsible) { node("summary", title, card).id = titleId; card.open = open; }
      else node("h2", title, card).id = titleId;
      card.setAttribute("aria-labelledby", titleId);
      if (intro) node("p", intro, card, "kv-muted");
      return card;
    }

    const statusCard = section("status", t("statusTitle"), { intro: t("statusIntro") });
    const statusList = node("div", undefined, statusCard);
    const statusMessage = node("p", "", statusCard, "kv-muted");

    function renderStatus() {
      statusList.replaceChildren();
      for (const folder of folders) {
        const view = KimonoStatus.view(folder.status, lang);
        const block = node("div", undefined, statusList, "kv-folder");
        const title = node("h3", `${folder.name} `, block);
        node("span", view.summary, title, `kv-badge kv-phase-${view.phase}`);
        if (folder.root) node("div", folder.root, block, "kv-muted kv-path");
        const bar = node("progress", undefined, block);
        bar.max = 1;
        if (view.progress === null) bar.removeAttribute("value"); else bar.value = view.progress;
        bar.setAttribute("aria-label", t("progressOf", { name: folder.name }));
        if (view.lines.length) {
          const list = node("dl", undefined, block);
          for (const line of view.lines) { node("dt", line.label, list); node("dd", line.value, list); }
        } else node("p", t("noIndex"), block, "kv-muted");
        const actions = node("div", undefined, block, "kv-actions");
        if (handlers.start) {
          const start = node("button", view.active ? t("indexing") : t("startIndex"), actions);
          start.type = "button";
          start.dataset.kvLocked = String(view.active || !enabled || folder.canStart === false);
          start.disabled = pending || start.dataset.kvLocked === "true";
          start.addEventListener("click", () => { if (!pending) handlers.start(folder.id); });
        }
        if (handlers.refresh) {
          const refresh = node("button", t("refresh"), actions, "secondary");
          refresh.type = "button";
          refresh.dataset.kvLocked = String(!enabled);
          refresh.disabled = pending || !enabled;
          refresh.addEventListener("click", () => { if (!pending) handlers.refresh(folder.id); });
        }
      }
    }

    function setStatus(next, message) {
      folders = Array.isArray(next) ? next : [];
      statusMessage.textContent = message ?? "";
      statusMessage.hidden = !message;
      renderStatus();
      if (fetcher) schedule();
    }

    // Polls `fetch` (resolving to folders) fast while indexing and slowly otherwise.
    function poll(fetch, { activeMs = 1500, idleMs = 15000 } = {}) {
      fetcher = fetch;
      intervals = { activeMs, idleMs };
      void tick();
    }
    async function tick() {
      clearTimeout(timer);
      if (!fetcher || !root.isConnected) return;
      try { setStatus(await fetcher()); }
      catch (error) { statusMessage.textContent = error.message; statusMessage.hidden = false; schedule(); }
    }
    function schedule() {
      clearTimeout(timer);
      if (!fetcher) return;
      const active = folders.some(folder => KimonoStatus.active(folder.status));
      timer = setTimeout(() => { if (root.isConnected) void tick(); }, active ? intervals.activeMs : intervals.idleMs);
    }

    const searchCard = section("search", t("searchTitle"), { intro: t("searchIntro", { origin: options.origin ?? "VS Code" }) });
    const form = node("form", undefined, searchCard);
    const grid = node("div", undefined, form, "kv-grid");
    const folderSelect = labelled(grid, `${prefix}-search-folder`, t("folder"), document.createElement("select"));
    const folderLabel = folderSelect.parentElement;
    const modes = labelled(grid, `${prefix}-search-modes`, t("modes"), document.createElement("select"));
    for (const [value, label] of Object.entries(t.table.modeOptions)) option(value, label, modes);
    const limit = labelled(grid, `${prefix}-search-limit`, t("limit"), document.createElement("select"));
    for (const value of ["5", "10", "20", "50"]) option(value, value, limit);
    limit.value = "10";
    const kind = labelled(grid, `${prefix}-search-kind`, t("kind"), document.createElement("select"));
    for (const [value, label] of Object.entries(t.table.kinds)) option(value, label, kind);
    const kindLabel = kind.parentElement;
    const query = labelled(form, `${prefix}-search-query`, t("query"), document.createElement("input"));
    Object.assign(query, { type: "search", required: true, maxLength: 8192, autocomplete: "off" });
    const expected = labelled(form, `${prefix}-search-expected`, t("expected"), document.createElement("input"), t("expectedHint"));
    Object.assign(expected, { type: "text", autocomplete: "off" });
    const submitRow = node("div", undefined, form, "kv-actions");
    const run = node("button", t("run"), submitRow);
    run.type = "submit";
    const searchMessage = node("p", "", searchCard, "kv-muted");
    node("p", t("searchNote"), searchCard, "kv-muted");
    const output = node("div", undefined, searchCard, "kv-output");
    output.setAttribute("role", "status");
    output.setAttribute("aria-live", "polite");
    const searchControls = [folderSelect, modes, limit, kind, query, expected, run];

    function configureSearch({ folders: choices = [], kinds = false, available = true, reason } = {}) {
      const previous = folderSelect.value;
      folderSelect.replaceChildren(...choices.map(choice => option(choice.id, choice.name)));
      if (choices.some(choice => choice.id === previous)) folderSelect.value = previous;
      folderLabel.hidden = choices.length < 2;
      kindLabel.hidden = !kinds;
      if (!kinds) kind.value = "";
      for (const control of searchControls) control.dataset.kvLocked = String(!available);
      searchMessage.textContent = available ? "" : reason ?? "";
      searchMessage.hidden = available || !reason;
      setBusy(pending);
    }

    form.addEventListener("submit", event => {
      event.preventDefault();
      if (pending || !handlers.search) return;
      const values = expected.value.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
      output.replaceChildren(node("p", t("searching"), undefined, "kv-muted"));
      handlers.search({ folder: folderSelect.value || undefined, input: { query: query.value, modes: modes.value.split("+"),
        limit: Number(limit.value), ...(kind.value ? { kind: kind.value } : {}), expected: values } });
    });

    const modeLabel = mode => t.table.modeLabels[mode] ?? mode;
    const percent = number => `${Math.round(number * 100)}${lang === "fr" ? " " : ""}%`;
    function showSearch(value) {
      output.replaceChildren();
      if (!value) return;
      node("p", t("snapshot", { version: value.snapshot?.version ?? "—", documents: value.snapshot?.documents ?? "—" }), output, "kv-muted");
      const withExpected = value.expected?.length > 0;
      const table = node("table", undefined, output);
      node("caption", t("performance"), table);
      const head = node("tr", undefined, node("thead", undefined, table));
      for (const title of [...t.table.columns, ...(withExpected ? t.table.validationColumns : [])]) node("th", title, head).scope = "col";
      const body = node("tbody", undefined, table);
      for (const item of value.runs) {
        const row = node("tr", undefined, body);
        node("th", modeLabel(item.mode), row).scope = "row";
        node("td", item.status === "not-ready" ? t("notReady") : item.status === "partial" ? t("partial") : item.ok ? t("ok") : t("error"), row);
        node("td", `${item.ms} ms`, row);
        node("td", item.ok ? `${item.count}${item.truncated ? "+" : ""}` : "—", row);
        node("td", item.ok ? String(item.documents.length) : "—", row);
        node("td", item.ok ? `${item.bytes} B` : "—", row).title = t("bytesTitle");
        node("td", item.ok ? [item.engine, item.model].filter(Boolean).join(" · ") : item.error, row);
        if (withExpected) {
          node("td", item.validation ? percent(item.validation.recall) : "—", row);
          node("td", item.validation ? percent(item.validation.precision) : "—", row);
          node("td", item.validation?.firstRelevantRank ? `#${item.validation.firstRelevantRank}` : "—", row);
        }
      }
      const comparison = value.comparison ?? { pairs: [], exclusive: {} };
      if (comparison.pairs.length) {
        node("h3", t("comparison"), output);
        const list = node("ul", undefined, output);
        for (const pair of comparison.pairs) {
          node("li", t("pair", { modes: pair.modes.map(modeLabel).join(" ↔ "), shared: pair.sharedCount, jaccard: percent(pair.jaccard),
            top: t(pair.topAgreement ? "sameTop" : "differentTop") }), list);
        }
        for (const [mode, paths] of Object.entries(comparison.exclusive ?? {})) {
          if (paths.length) node("li", t("only", { mode: modeLabel(mode), paths: paths.join(", ") }), list);
        }
      }
      if (comparison.fused) {
        const fused = node("details", undefined, output);
        node("summary", t("fused"), fused);
        node("p", t("fusedIntro"), fused, "kv-muted");
        const validation = comparison.fused.validation;
        if (validation) node("p", t("fusedValidation", { recall: percent(validation.recall), first: validation.firstRelevantRank ? `#${validation.firstRelevantRank}` : "—" }), fused);
        const ranking = node("ol", undefined, fused);
        for (const entry of comparison.fused.results) {
          node("li", `${entry.path} · ${Object.entries(entry.ranks).map(([mode, rank]) => `${modeLabel(mode)} #${rank}`).join(" · ")}`, ranking);
        }
      }
      for (const item of value.runs.filter(entry => entry.ok)) {
        const details = node("details", undefined, output);
        node("summary", t("results", { mode: modeLabel(item.mode), count: item.count }), details);
        if (!item.results.length) node("p", t("noResults"), details);
        const list = node("ol", undefined, details);
        for (const hit of item.results) {
          const entry = node("li", undefined, list);
          const lines = hit.startLine ? (hit.endLine && hit.endLine !== hit.startLine ? `${hit.startLine}-${hit.endLine}` : String(hit.startLine)) : String(hit.line ?? "");
          node("strong", `${hit.path}:${lines}${hit.score === null || hit.score === undefined ? "" : ` · score ${hit.score}`}`, entry);
        }
      }
      for (const item of value.runs.filter(entry => entry.ok && entry.payload !== undefined)) {
        const payload = node("details", undefined, output);
        node("summary", t("payload", { mode: modeLabel(item.mode), bytes: item.bytes }), payload);
        node("pre", JSON.stringify(item.payload), payload);
      }
      const report = { ...value, runs: value.runs.map(({ payload, ...entry }) => entry) };
      const raw = node("details", undefined, output);
      node("summary", t("raw"), raw);
      node("pre", JSON.stringify(report, null, 2), raw);
    }

    function setBusy(value) {
      pending = Boolean(value);
      root.querySelectorAll(".kv-slot-status button, .kv-slot-search button, .kv-slot-search input, .kv-slot-search select").forEach(element => {
        element.disabled = pending || element.dataset.kvLocked === "true";
      });
    }
    function setEnabled(value) { enabled = Boolean(value); renderStatus(); }
    function setNotice(text) { notice.textContent = text ?? ""; if (text) failure.textContent = ""; }
    function setError(text) { failure.textContent = text ?? ""; if (text) notice.textContent = ""; }
    function focusSearch() { searchCard.scrollIntoView?.(); query.focus(); }
    function dispose() { clearTimeout(timer); fetcher = undefined; }

    setHeader(options);
    return { t, language: lang, section, setHeader, setStatus, poll, refreshStatus: tick, configureSearch, showSearch,
      setBusy, setEnabled, setNotice, setError, focusSearch, dispose, get pending() { return pending; } };
  }

  return { create, language, strings, translator };
}));
