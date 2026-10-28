import { describe, expect, it } from 'vitest';
import { runProcess } from '../src/process.js';

describe('streaming native diagnostics', () => {
  it('consumes more than maxBuffer of progress without retaining the whole stderr', async () => {
    let bytes = 0;
    const output = await runProcess(process.execPath, ['-e',
      'process.stderr.write("é".repeat(300000)); process.stdout.write("done")'],
    process.cwd(), [0], 10_000, chunk => { bytes += Buffer.byteLength(chunk); }, process.env, 1024, true);
    expect(output.stdout).toBe('done');
    expect(bytes).toBe(600000);
    expect(output.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(output.stderr).not.toContain('\uFFFD');
  });

  it('preserves allowed exit codes, bounded error diagnostics and credential redaction', async () => {
    const environment = { ...process.env, KIMONO_GIT_TOKEN: 'fixture-secret' };
    const output = await runProcess(process.execPath, ['-e',
      'process.stderr.write("fixture-secret"); process.exitCode = 3'],
    process.cwd(), [3], 10_000, undefined, environment, 1024, true);
    expect(output).toMatchObject({ exitCode: 3, stderr: '[REDACTED]' });
    await expect(runProcess(process.execPath, ['-e', 'process.stderr.write("diagnostic"); process.exitCode = 2'],
      process.cwd(), [0], 10_000, undefined, process.env, 1024, true)).rejects.toThrow('diagnostic');
  });

  it('fails and terminates on excessive stdout or timeout', async () => {
    await expect(runProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(10000))'],
      process.cwd(), [0], 10_000, undefined, process.env, 1024, true)).rejects.toThrow('stdout exceeded maxBuffer');
    await expect(runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(), [0], 100, undefined, process.env, 1024, true)).rejects.toThrow('timed out');
  });
});
