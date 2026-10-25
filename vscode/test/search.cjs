"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRuns, parseSearchBench, runSearchBench, validateRanking } = require("../search.cjs");

const located = (path, hits, score) => ({ path, lines: 20, hits, ...(score === undefined ? {} : { score }) });

test("search bench runs every mode on one snapshot and compares documents", async () => {
  const calls = [];
  const result = await runSearchBench(async (name, input) => {
    calls.push([name, input]);
    if (name === "aikido_snapshot") return input.operation === "begin"
      ? { snapshotId: "snap-1", version: "v1", documents: 4, capturedAt: "2026-10-24T00:00:00Z" } : { ended: true };
    assert.equal(name, "aikido_search", "search must never read source text automatically");
    if (input.mode === "literal") return { engine: "fast-grep", truncated: false,
      results: [located("a.md", [1, 9]), located("b.md", [3])] };
    if (input.mode === "semantic") return { engine: "embsearch-core", model: "e5", truncated: false,
      results: [located("c.md", [[2, 3]], 0.91), located("a.md", [4], 0.8)] };
    throw new Error("bad regex");
  }, { query: "share", modes: ["literal", "regex", "semantic"], limit: 5, expected: ["./a.md", "docs/"] });

  assert.deepEqual(calls.map(([name, input]) => [name, input.operation ?? input.mode, input.snapshotId ?? null]), [
    ["aikido_snapshot", "begin", null], ["aikido_search", "literal", "snap-1"], ["aikido_search", "regex", "snap-1"],
    ["aikido_search", "semantic", "snap-1"],
    ["aikido_snapshot", "end", "snap-1"]]);
  assert.ok(calls.filter(([name]) => name === "aikido_search").every(([, input]) => input.contextLines === undefined && input.detail === "compact"));
  const [literal, regex, semantic] = result.runs;
  assert.doesNotMatch(JSON.stringify(result), /"excerpt|"content"|"passages"/);
  assert.ok(literal.bytes > 0);
  assert.equal(literal.bytes, Buffer.byteLength(JSON.stringify(literal.payload)));
  assert.deepEqual(literal.documents, ["a.md", "b.md"]);
  assert.equal(regex.ok, false);
  assert.match(regex.error, /bad regex/);
  assert.equal(semantic.model, "e5");
  assert.equal(literal.validation.recall, 0.5);
  assert.equal(semantic.validation.firstRelevantRank, 2);
  assert.equal(result.comparison.pairs[0].jaccard, 0.333);
  assert.deepEqual(result.comparison.exclusive, { literal: ["b.md"], semantic: ["c.md"] });
  assert.deepEqual(result.comparison.fused.results.map(entry => [entry.path, entry.ranks]),
    [["a.md", { literal: 1, semantic: 2 }], ["c.md", { semantic: 1 }], ["b.md", { literal: 2 }]]);
});

test("search bench closes its snapshot, validates input and handles empty runs", async () => {
  let ended = false;
  const result = await runSearchBench(async (name, input) => {
    if (name === "aikido_snapshot") { if (input.operation === "end") ended = true; return { snapshotId: "s" }; }
    throw new Error("semantic index missing");
  }, { query: "x", modes: ["semantic"] });
  assert.equal(ended, true);
  assert.equal(result.runs[0].ok, false);
  assert.equal(result.comparison.fused, null);
  for (const input of [{}, { query: " " }, { query: "x", modes: [] }, { query: "x", modes: ["literal", "literal"] },
    { query: "x", modes: ["fuzzy"] }, { query: "x", limit: 51 }, { query: "x", kind: "secret" },
    { query: "x", expected: Array(21).fill("a.md") }]) {
    assert.throws(() => parseSearchBench(input), /invalid|bytes|limit|expected/i);
  }
  assert.equal(validateRanking(["a.md"], []), undefined);
  const comparison = compareRuns([{ mode: "literal", ok: true, ms: 1, documents: [], results: [] },
    { mode: "semantic", ok: true, ms: 1, documents: [], results: [] }], 5, []);
  assert.equal(comparison.pairs[0].jaccard, 0);
});

test("search bench preserves lexical evidence and vocabulary diagnostics", async () => {
  const result = await runSearchBench(async name => name === "aikido_snapshot" ? { snapshotId: "s" }
    : {
      results: [{ ...located("rules.md", [1], 1.4), terms: ["rules"] }],
      query: { terms: ["rules"], warnings: ["Project vocabulary only"] }, branches: [{ mode: "text", status: "ok" }],
    }, { query: "rules", modes: ["text"] });
  assert.deepEqual(result.runs[0].results[0].matchedTerms, ["rules"]);
  assert.deepEqual(result.runs[0].queryPlan, { terms: ["rules"], warnings: ["Project vocabulary only"] });
});

test("search bench also reads the default compact ranges format", async () => {
  const result = await runSearchBench(async (name, input) => {
    if (name === "aikido_snapshot") return { snapshotId: "snap-2" };
    assert.equal(name, "aikido_search");
    return { results: [{ path: "a.md", ranges: [[1, 1], [5, 7]] }, { path: "b.md", ranges: [[2, 2]] }] };
  }, { query: "agent", modes: ["literal"], limit: 5 });
  assert.equal(result.runs[0].count, 3);
  assert.deepEqual(result.runs[0].documents, ["a.md", "b.md"]);
  assert.deepEqual([result.runs[0].results[1].startLine, result.runs[0].results[1].endLine], [5, 7]);
  assert.deepEqual(result.runs[0].payload, {
    results: [{ path: "a.md", ranges: [[1, 1], [5, 7]] }, { path: "b.md", ranges: [[2, 2]] }],
  });
});
