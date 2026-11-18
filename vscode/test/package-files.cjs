"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const listed = file => manifest.files.some(entry => entry.endsWith("/**")
  ? file.startsWith(entry.slice(0, -2))
  : file === entry);

function localModules(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = fs.readFileSync(path.join(root, entry), "utf8");
  for (const [, request] of source.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    localModules(path.posix.normalize(path.posix.join(path.posix.dirname(entry), request)), seen);
  }
  return seen;
}

test("every local module loaded at runtime is listed in the VSIX manifest", () => {
  const entries = [path.posix.normalize(manifest.main), "stdio.cjs"];
  const modules = entries.flatMap(entry => [...localModules(entry)]);
  assert.ok(modules.includes("collaboration.cjs"));
  assert.deepEqual([...new Set(modules)].filter(file => !listed(file)), []);
});
