import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installAikido } from '../src/cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('AI-KIDO installer safety', () => {
  it('rejects non-empty install targets without changing their contents', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'kimono-install-test-'));
    temporaryDirectories.push(parent);
    const target = path.join(parent, 'aikido');
    await mkdir(target);
    await writeFile(path.join(target, 'keep.txt'), 'user data');

    await expect(installAikido(target, 'main')).rejects.toThrow('refusing to overwrite');
  });

  it('rejects unsafe Git refs before starting a clone', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'kimono-install-test-'));
    temporaryDirectories.push(parent);

    await expect(installAikido(path.join(parent, 'aikido'), '--upload-pack=malicious')).rejects.toThrow('Git ref must contain');
  });
});
