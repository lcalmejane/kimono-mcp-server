import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/test-container.mjs <image>');
const docker = async (...args) => {
  const { stdout, stderr } = await promisify(execFile)('docker', args, { timeout: 120_000 });
  if (stderr) process.stderr.write(stderr);
  return stdout.trim();
};
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const token = randomUUID();
let container;
try {
  container = await docker('run', '--detach', '--publish', '127.0.0.1::3000',
    '--env', 'MCP_TRANSPORT=http', '--env', 'MCP_HOST=0.0.0.0', '--env', 'MCP_PORT=3000',
    '--env', `MCP_AUTH_TOKEN=${token}`, '--env', 'AIKIDO_ROOT=/tmp/kimono-smoke',
    '--env', 'KIMONO_CORPUS_MODE=rag', '--env', 'KIMONO_EMBEDDING_POLICY=e5',
    '--env', 'KIMONO_SEMANTIC_DEVICE=cpu',
    '--env', 'KIMONO_SEMANTIC_PERSISTENT_WORKER=false',
    '--entrypoint', 'sh', image, '-ec',
    'mkdir -p "$AIKIDO_ROOT"; printf "# Container integration\\n" > "$AIKIDO_ROOT/index.md"; exec node dist/index.js');
  const binding = await docker('port', container, '3000/tcp');
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const base = `http://${binding}`;
  const headers = { authorization: `Bearer ${token}` };
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal(await docker('inspect', '--format', '{{.State.Running}}', container), 'true', 'Container exited');
    const response = await fetch(`${base}/readyz`, { headers, signal: AbortSignal.timeout(2000) }).catch(error => {
      if (error.cause?.code !== 'ECONNREFUSED' && error.cause?.code !== 'UND_ERR_SOCKET') throw error;
      console.log(`Waiting for HTTP listener (attempt ${attempt + 1}/60).`);
      return undefined;
    });
    if (response) {
      const status = await response.json();
      if (response.ok) {
        assert.equal(status.ready, true);
        assert.equal(status.server.version, version);
        ready = true;
        break;
      }
      assert.equal(response.status, 503, JSON.stringify(status));
    }
    await setTimeout(1000);
  }
  assert.ok(ready, 'HTTP server did not become ready within the retry window');
  const live = await fetch(`${base}/healthz`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: 'ok' });
  const unauthorized = await fetch(`${base}/statusz`);
  assert.equal(unauthorized.status, 401);
  await unauthorized.text();
  console.log(await docker('exec', container, 'fgr', '--version'));
  const embedded = await docker('exec', container, 'node', '--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    const request = '/tmp/kimono-container-embed.json';
    writeFileSync(request, JSON.stringify({
      operation: 'embed', model: process.env.KIMONO_MODEL_DIR,
      text: 'Container native runtime compatibility', usage: 'query',
    }));
    process.stdout.write(execFileSync('kimono-semantic', [request]));
  `);
  const embedding = JSON.parse(embedded);
  assert.equal(embedding.dimensions, 384);
  assert.equal(embedding.vector.length, 384);
  assert.ok(embedding.vector.every(Number.isFinite));
  console.log(`Container HTTP/authentication and real native embedding passed: ${image}`);
} catch (error) {
  if (container) console.error(await docker('logs', container));
  throw error;
} finally {
  if (container) await docker('rm', '--force', container);
}
