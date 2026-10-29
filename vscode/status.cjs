"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

// Reads the live semantic index status published by any Kimono server on this ROOT.
async function readIndexStatus(file) {
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); } catch { return { phase: "not-indexed" }; }
  if (!value || typeof value !== "object" || typeof value.phase !== "string") return { phase: "not-indexed" };
  const { pid, host, ...status } = value;
  const ownerAlive = host === os.hostname() && alive(pid);
  const workerAlive = !status.worker?.pid || host !== os.hostname() || alive(status.worker.pid);
  const worker = status.worker && (!ownerAlive || !workerAlive) ? { phase: "stopped" } : status.worker;
  const normalized = { ...status, ...(worker ? { worker } : {}) };
  if ((status.phase === "running" || status.phase === "waiting") && !ownerAlive) {
    return { ...normalized, phase: "interrupted" };
  }
  return normalized;
}

const { compact, duration, lines, overall, summarize, view } = require("./management/status-format.js");

module.exports = { compact, duration, lines, overall, readIndexStatus, summarize, view };
