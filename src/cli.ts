#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './commands.js';
export { main, installAikido } from './commands.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error('kimono-mcp-server:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
