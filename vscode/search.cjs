"use strict";

const { performance } = require("node:perf_hooks");

// Same request/response contract as the Tatami Core and Tatami Agent Kimono search test.
const searchModes = ["literal", "regex", "text", "semantic", "hybrid"];
const kinds = ["command", "agent", "skill", "workflow", "knowledge"];
const rrfConstant = 60;

const cleanPath = value => value.trim().replace(/^\.?\/+/, "");
const round = (value, digits = 3) => Number(value.toFixed(digits));
const isRecord = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

function parseSearchBench(input) {
  if (!isRecord(input)) throw new Error("Invalid search request.");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query || Buffer.byteLength(query) > 8192) throw new Error("The query must contain 1 to 8192 bytes.");
  const modes = input.modes ?? ["text", "semantic"];
  if (!Array.isArray(modes) || !modes.length || modes.length > searchModes.length ||
      new Set(modes).size !== modes.length || !modes.every(mode => searchModes.includes(mode))) {
    throw new Error("Invalid search modes: literal, regex, text, semantic and/or hybrid.");
  }
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("The limit must be between 1 and 50.");
  if (input.kind !== undefined && !kinds.includes(input.kind)) throw new Error("Invalid knowledge kind.");
  const expected = input.expected ?? [];
  if (!Array.isArray(expected) || expected.length > 20 ||
      !expected.every(value => typeof value === "string" && cleanPath(value) && value.length <= 512)) {
    throw new Error("Invalid expected documents: 20 paths maximum.");
  }
  return { query, modes, limit, kind: input.kind, expected: [...new Set(expected.map(cleanPath))] };
}

function hits(value) {
  if (!Array.isArray(value.results)) throw new Error("Invalid Kimono results.");
  // Measure the exact minimal payload agents receive (detail=compact: {path, ranges}); `hits` is the older locations shape.
  return value.results.filter(isRecord).filter(file => typeof file.path === "string" && Array.isArray(file.hits ?? file.ranges))
    .flatMap((file, index) => (file.hits ?? file.ranges).map(item => {
      const [startLine, endLine] = Array.isArray(item) ? [Number(item[0]) || 0, Number(item[1]) || 0] : [Number(item) || 0, Number(item) || 0];
      return { rank: index + 1, path: file.path, title: "", kind: "", line: startLine, startLine, endLine,
        score: typeof file.score === "number" && Number.isFinite(file.score) ? round(file.score, 4) : null,
        ...(Array.isArray(file.terms) ? { matchedTerms: file.terms.filter(term => typeof term === "string") } : {}) };
    }));
}

const matches = (path, expected) => expected.endsWith("/") ? path.startsWith(expected) : path === expected;

function validateRanking(documents, expected) {
  if (!expected.length) return undefined;
  const ranks = expected.map(path => {
    const index = documents.findIndex(document => matches(document, path));
    return { path, rank: index < 0 ? null : index + 1 };
  });
  const found = ranks.filter(item => item.rank !== null);
  const first = found.length ? Math.min(...found.map(item => item.rank)) : null;
  const relevant = documents.filter(document => expected.some(path => matches(document, path))).length;
  return { expected: ranks, found: found.length, recall: round(found.length / expected.length),
    precision: documents.length ? round(relevant / documents.length) : 0,
    firstRelevantRank: first, reciprocalRank: first ? round(1 / first) : 0 };
}

function compareRuns(runs, limit, expected) {
  const ok = runs.filter(run => run.ok && run.documents);
  const pairs = [];
  for (let left = 0; left < ok.length; left++) {
    for (let right = left + 1; right < ok.length; right++) {
      const a = new Set(ok[left].documents), b = new Set(ok[right].documents);
      const shared = [...a].filter(path => b.has(path));
      const union = new Set([...a, ...b]).size;
      pairs.push({ modes: [ok[left].mode, ok[right].mode], shared, sharedCount: shared.length,
        jaccard: union ? round(shared.length / union) : 0,
        topAgreement: ok[left].documents[0] !== undefined && ok[left].documents[0] === ok[right].documents[0] });
    }
  }
  const exclusive = Object.fromEntries(ok.map(run => [run.mode,
    run.documents.filter(path => ok.every(other => other === run || !other.documents.includes(path)))]));
  if (ok.length < 2) return { pairs, exclusive, fused: null };
  const fused = new Map();
  for (const run of ok) {
    run.documents.forEach((path, index) => {
      const entry = fused.get(path) ?? { path, title: run.results.find(hit => hit.path === path)?.title ?? "", score: 0, ranks: {} };
      entry.score += 1 / (rrfConstant + index + 1);
      entry.ranks[run.mode] = index + 1;
      fused.set(path, entry);
    });
  }
  const ranking = [...fused.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1, score: round(entry.score, 5) }));
  return { pairs, exclusive, fused: { method: `reciprocal-rank-fusion k=${rrfConstant}`, results: ranking,
    validation: validateRanking(ranking.map(entry => entry.path), expected) } };
}

async function runSearchBench(call, raw) {
  const input = parseSearchBench(raw);
  const snapshot = await call("aikido_snapshot", { operation: "begin" });
  if (typeof snapshot.snapshotId !== "string" || !snapshot.snapshotId) throw new Error("Invalid Kimono snapshot.");
  const runs = [];
  try {
    runs.push(...await Promise.all(input.modes.map(async mode => {
      const started = performance.now();
      try {
        const value = await call("aikido_search", { snapshotId: snapshot.snapshotId, query: input.query, mode,
          detail: "compact", limit: input.limit, maxBytes: 131072, ...(input.kind ? { kind: input.kind } : {}) });
        const ms = round(performance.now() - started, 1);
        if (value.status === "not-ready" || value.status === "error") return {
          mode, ok: false, ms, status: value.status, error: String(value.error ?? value.status),
          queryPlan: value.query, branches: value.branches,
        };
        const results = hits(value);
        const documents = [...new Set(results.map(hit => hit.path))];
        return { mode, ok: true, ms, status: value.status ?? "ok", queryPlan: value.query,
          branches: value.branches, engine: typeof value.engine === "string" ? value.engine : "",
          model: typeof value.model === "string" ? value.model : undefined, bytes: Buffer.byteLength(JSON.stringify(value)),
          count: results.length, truncated: value.truncated === true, documents, results,
          validation: validateRanking(documents, input.expected),
          // Exact MCP payload returned to agents, for the panel raw view.
          payload: value };
      } catch (error) {
        return { mode, ok: false, ms: round(performance.now() - started, 1),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
    })));
  } finally {
    await call("aikido_snapshot", { operation: "end", snapshotId: snapshot.snapshotId }).catch(error => {
      console.error("Kimono search snapshot cleanup failed", error instanceof Error ? error.message : String(error));
    });
  }
  return { query: input.query, limit: input.limit, kind: input.kind ?? null, expected: input.expected,
    snapshot: { version: snapshot.version ?? null, documents: snapshot.documents ?? null, capturedAt: snapshot.capturedAt ?? null },
    runs, comparison: compareRuns(runs, input.limit, input.expected) };
}

module.exports = { compareRuns, parseSearchBench, runSearchBench, searchModes, validateRanking };
