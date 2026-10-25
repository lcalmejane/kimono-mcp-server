"use strict";

const childProcess = require("node:child_process");

// Minimal MCP stdio client (newline-delimited JSON-RPC) for the management panel's tests and indexing.
function startMcpClient(launch, { spawn = childProcess.spawn, timeoutMs = 120_000, version = "0.0.0" } = {}) {
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let nextId = 1, buffered = "", stderr = "", exited;
  const fail = error => {
    exited ??= error;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Kimono server stopped (${signal ?? code})${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const waiter = message && pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(String(message.error.message ?? "MCP error")));
      else waiter.resolve(message.result);
    }
  });
  const write = message => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) => {
    if (exited) return Promise.reject(exited);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Kimono ${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ id, method, params });
    });
  };
  const ready = request("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kimono-vscode-panel", version },
  }).then(() => { write({ method: "notifications/initialized" }); });
  return {
    pid: child.pid,
    get running() { return !exited; },
    async call(name, args) {
      await ready;
      const result = await request("tools/call", { name, arguments: args });
      const text = Array.isArray(result?.content) ? result.content.filter(item => item?.type === "text").map(item => item.text).join("") : "";
      if (result?.isError) throw new Error(text || `${name} failed`);
      try { return JSON.parse(text); } catch { throw new Error(`${name} returned a non-JSON result`); }
    },
    close() {
      if (exited) return;
      child.stdin.end();
      setTimeout(() => { if (!exited) child.kill(); }, 2000).unref();
    },
  };
}

module.exports = { startMcpClient };
