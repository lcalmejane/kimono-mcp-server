#!/usr/bin/env node
import { main } from './cli.js';

main().catch((error: unknown) => {
  console.error('kimono-mcp-server:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});