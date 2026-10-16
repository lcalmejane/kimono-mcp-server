import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

it.each(['SIGTERM', 'SIGINT'] as const)('shuts down the real stdio runner cleanly on %s', async (signal) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'kimono-stop-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(), env: { ...process.env, AIKIDO_ROOT: path.join(parent, 'absent'),
      MCP_TRANSPORT: 'stdio' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  try {
    await new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes('ready on stdio')) resolve();
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`Runner exited before readiness: ${stderr}`)));
    });
    child.kill(signal);
    const [code, exitSignal] = await closed;
    expect(code).toBe(0);
    expect(exitSignal).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(parent, { recursive: true, force: true });
  }
}, 15_000);
