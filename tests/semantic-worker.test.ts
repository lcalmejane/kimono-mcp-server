import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { semanticWorkerFor, shutdownSemanticWorkers } from '../src/semantic-worker.js';

const directories: string[] = [];

afterEach(async () => {
  await shutdownSemanticWorkers();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('reuses one worker process across correlated requests and shuts it down cleanly', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-worker-test-'));
  directories.push(root);
  const binary = path.join(root, 'fake-semantic-worker');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
let count = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const respond = result => process.stdout.write(JSON.stringify({
    version: 1, id: request.id, ok: true, result
  }) + '\\n');
  if (request.operation === 'shutdown') { respond({ shutdown: true }); process.exit(0); }
  const payload = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
  respond({ pid: process.pid, count: ++count, payload });
});
`);
  await chmod(binary, 0o700);
  const model = path.join(root, 'model');
  const env = { ...process.env, KIMONO_SEMANTIC_BIN: binary };
  const phases: string[] = [];
  const worker = semanticWorkerFor(model, root, env, status => phases.push(status.phase));
  expect(phases).toEqual(['stopped']);
  const firstPath = path.join(root, 'request-one.json');
  const secondPath = path.join(root, 'request-two.json');
  await writeFile(firstPath, JSON.stringify({ operation: 'search' }));
  await writeFile(secondPath, JSON.stringify({ operation: 'stats' }));

  const [first, second] = await Promise.all([
    worker.request(firstPath, 5000) as Promise<{ pid: number; count: number; payload: { operation: string } }>,
    worker.request(secondPath, 5000) as Promise<{ pid: number; count: number; payload: { operation: string } }>,
  ]);
  expect(second.pid).toBe(first.pid);
  expect([first.count, second.count]).toEqual([1, 2]);
  expect([first.payload.operation, second.payload.operation]).toEqual(['search', 'stats']);
  expect(worker.status()).toMatchObject({ phase: 'ready', pid: first.pid });
  expect(phases).toContain('starting');
  expect(phases).toContain('ready');
  await worker.close();
  expect(worker.status()).toEqual({ phase: 'stopped' });
  expect(phases.at(-1)).toBe('stopped');
});

it('reports a worker failure and recovers on the next request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-worker-restart-test-'));
  directories.push(root);
  const binary = path.join(root, 'fake-semantic-worker');
  const marker = path.join(root, 'crashed-once');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (!fs.existsSync(process.env.KIMONO_TEST_CRASH_MARKER)) {
  fs.writeFileSync(process.env.KIMONO_TEST_CRASH_MARKER, '1');
  process.exit(17);
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    version: 1, id: request.id, ok: true, result: { recovered: true }
  }) + '\\n');
});
`);
  await chmod(binary, 0o700);
  const model = path.join(root, 'model');
  const env = { ...process.env, KIMONO_SEMANTIC_BIN: binary, KIMONO_TEST_CRASH_MARKER: marker };
  const worker = semanticWorkerFor(model, root, env);
  const request = path.join(root, 'request.json');
  await writeFile(request, JSON.stringify({ operation: 'search' }));

  await expect(worker.request(request, 5000)).rejects.toThrow('Semantic worker exited with 17');
  expect(worker.status()).toMatchObject({ phase: 'error' });
  await expect(worker.request(request, 5000)).resolves.toEqual({ recovered: true });
  expect(worker.status()).toMatchObject({ phase: 'ready' });
});

it('does not let a timed-out worker overwrite the restarted worker status', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-worker-stale-close-test-'));
  directories.push(root);
  const binary = path.join(root, 'fake-semantic-worker');
  const marker = path.join(root, 'first-worker');
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const firstWorker = !fs.existsSync(process.env.KIMONO_TEST_FIRST_WORKER);
if (firstWorker) fs.writeFileSync(process.env.KIMONO_TEST_FIRST_WORKER, '1');
process.on('SIGTERM', () => {
  if (firstWorker) setTimeout(() => process.exit(0), 150);
});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const respond = result => process.stdout.write(JSON.stringify({
    version: 1, id: request.id, ok: true, result
  }) + '\\n');
  if (request.operation === 'shutdown') { respond({ shutdown: true }); process.exit(0); }
  const payload = JSON.parse(fs.readFileSync(request.requestPath, 'utf8'));
  const result = { recovered: true, pid: process.pid };
  if (firstWorker && payload.slow) setTimeout(() => respond(result), 500);
  else respond(result);
});
`);
  await chmod(binary, 0o700);
  const model = path.join(root, 'model');
  const env = {
    ...process.env,
    KIMONO_SEMANTIC_BIN: binary,
    KIMONO_TEST_FIRST_WORKER: marker,
  };
  const worker = semanticWorkerFor(model, root, env);
  const slowRequest = path.join(root, 'slow-request.json');
  const fastRequest = path.join(root, 'fast-request.json');
  await writeFile(slowRequest, JSON.stringify({ slow: true }));
  await writeFile(fastRequest, JSON.stringify({ slow: false }));

  await expect(worker.request(slowRequest, 50)).rejects.toThrow('timed out');
  const recovered = await worker.request(fastRequest, 5000) as { recovered: boolean; pid: number };
  await new Promise(resolve => setTimeout(resolve, 200));

  expect(recovered.recovered).toBe(true);
  expect(worker.status()).toMatchObject({ phase: 'ready', pid: recovered.pid });
});

it('rejects requests beyond the bounded worker queue', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kimono-worker-queue-test-'));
  directories.push(root);
  const binary = path.join(root, 'fake-semantic-worker');
  await writeFile(binary, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.operation === 'shutdown') {
    process.stdout.write(JSON.stringify({
      version: 1, id: request.id, ok: true, result: { shutdown: true }
    }) + '\\n');
    process.exit(0);
  }
  setTimeout(() => process.stdout.write(JSON.stringify({
    version: 1, id: request.id, ok: true, result: { completed: true }
  }) + '\\n'), 25);
});
`);
  await chmod(binary, 0o700);
  const model = path.join(root, 'model');
  const env = { ...process.env, KIMONO_SEMANTIC_BIN: binary };
  const worker = semanticWorkerFor(model, root, env);
  const request = path.join(root, 'request.json');
  await writeFile(request, '{}');

  const accepted = Array.from({ length: 8 }, () => worker.request(request, 5000));
  await expect(worker.request(request, 5000)).rejects.toThrow('queue is full');
  await expect(Promise.all(accepted)).resolves.toHaveLength(8);
});
