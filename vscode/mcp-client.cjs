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
  const request = (method, params, timeout = timeoutMs) => {
    if (exited) return Promise.reject(exited);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Kimono ${method} timed out`)); }, timeout);
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
      const result = await request("tools/call", { name, arguments: args },
        name === "aikido_models" && args.operation === "install" ? 1_800_000 : timeoutMs);
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

// Uses only the host's validated configured URL and SecretStorage token.
function startRemoteMcpClient(url, token, { version = "0.0.0" } = {}) {
  let sequence = 0, session, protocol = "2025-03-26", closed = false;
  async function rpc(method, params, timeout = 120_000, notification = false) {
    if (closed) throw new Error("Kimono connection closed.");
    const id = ++sequence;
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol, ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, params }),
    });
    if (!response.ok) throw new Error(`Kimono HTTP ${response.status}`);
    session = response.headers.get("mcp-session-id") ?? session;
    if (notification) { await response.body?.cancel(); return; }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Kimono response too large.");
    const frames = response.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\r?\n\r?\n/).map(frame => frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n")).filter(Boolean) : [text];
    for (const frame of frames) {
      const envelope = JSON.parse(frame);
      if (envelope.id !== id) continue;
      if (envelope.error) throw new Error("Kimono refused the request.");
      return envelope.result;
    }
    throw new Error("Invalid Kimono response.");
  }
  const ready = rpc("initialize", { protocolVersion: protocol, capabilities: {},
    clientInfo: { name: "kimono-vscode-models", version } }).then(async result => {
    protocol = result.protocolVersion;
    await rpc("notifications/initialized", {}, 30_000, true);
  });
  return {
    get running() { return !closed; },
    async call(name, args) {
      await ready;
      const result = await rpc("tools/call", { name, arguments: args },
        name === "aikido_models" && args.operation === "install" ? 1_800_000 : 120_000);
      const text = result?.content?.filter(item => item.type === "text").map(item => item.text).join("");
      if (result?.isError) throw new Error(text || "Kimono model operation failed.");
      return JSON.parse(text);
    },
    close() {
      closed = true;
      if (session) void fetch(url, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { "mcp-session-id": session, "mcp-protocol-version": protocol,
          ...(token ? { authorization: `Bearer ${token}` } : {}) } }).then(response => response.body?.cancel()).catch(() => {});
    },
  };
}

module.exports = { startMcpClient, startRemoteMcpClient };
