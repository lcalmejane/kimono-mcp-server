"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { nativeEnvironment } = require("./native.cjs");

async function main() {
  const env = await nativeEnvironment(path.join(__dirname, "native"));
  const executable = path.join(__dirname, "runtime", process.platform === "win32" ? "node.exe" : "node");
  const child = spawn(executable, [path.join(__dirname, "server/index.mjs"), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, ...env, MCP_TRANSPORT: "stdio" },
  });
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

main().catch(error => {
  console.error("kimono-mcp:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
