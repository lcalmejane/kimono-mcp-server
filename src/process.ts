import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0],
  timeout = 120_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execute(executable, args, {
      cwd, timeout, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number'
      && allowedExitCodes.includes(error.code) && 'stdout' in error && 'stderr' in error
      && typeof error.stdout === 'string' && typeof error.stderr === 'string') {
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
    }
    throw new Error(`${executable} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
