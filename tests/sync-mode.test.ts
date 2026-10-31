import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectSyncMode } from '../src/sync-mode.js';

const directories: string[] = [];
afterEach(async () => {
  delete process.env.KIMONO_SYNC_MODE;
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const base = await mkdtemp(path.resolve('.mode-test-'));
  directories.push(base);
  const root = path.join(base, 'root');
  const other = path.join(base, 'other');
  await mkdir(root);
  await mkdir(other);
  return { base, root, other };
}

describe('sync mode detection', () => {
  it('treats the exact same directory as same-root, also through a symlink', async () => {
    const { base, root } = await workspace();
    const link = path.join(base, 'link');
    await symlink(root, link);
    expect(await detectSyncMode({ root, transport: 'http', clientRoot: root }))
      .toMatchObject({ mode: 'same-root', verified: true });
    expect(await detectSyncMode({ root, transport: 'http', clientRoot: link }))
      .toMatchObject({ mode: 'same-root', verified: true });
  });

  it('treats a different or invisible client workspace as a verified replica', async () => {
    const { base, root, other } = await workspace();
    expect(await detectSyncMode({ root, clientRoot: other })).toMatchObject({ mode: 'replica', verified: true });
    expect(await detectSyncMode({ root, clientRoot: path.join(base, 'absent') })).toMatchObject({ mode: 'replica', verified: true });
  });

  it('never infers same-root for HTTP, and assumes it only for embedded stdio without proof', async () => {
    const { root } = await workspace();
    expect(await detectSyncMode({ root, transport: 'http' })).toMatchObject({ mode: 'replica', verified: false });
    expect(await detectSyncMode({ root, transport: 'stdio' })).toMatchObject({ mode: 'same-root', verified: false });
    expect(await detectSyncMode({ root })).toMatchObject({ mode: 'same-root', verified: false });
  });

  it('lets the operator override the decision and rejects invalid values or relative client roots', async () => {
    const { root, other } = await workspace();
    expect(await detectSyncMode({ root, transport: 'http', clientRoot: root, override: 'replica' }))
      .toMatchObject({ mode: 'replica', verified: true });
    process.env.KIMONO_SYNC_MODE = 'same-root';
    expect(await detectSyncMode({ root, transport: 'http', clientRoot: other })).toMatchObject({ mode: 'same-root', verified: true });
    process.env.KIMONO_SYNC_MODE = 'nope';
    await expect(detectSyncMode({ root })).rejects.toThrow('KIMONO_SYNC_MODE');
    delete process.env.KIMONO_SYNC_MODE;
    await expect(detectSyncMode({ root, clientRoot: 'relative/path' })).rejects.toThrow('absolute');
  });
});
