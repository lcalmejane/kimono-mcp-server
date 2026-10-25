import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const children = new Set<ChildProcess>();

export function terminateChildren(): void {
  for (const child of children) child.kill('SIGKILL');
}

export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  allowedExitCodes: number[] = [0],
  timeout = 120_000,
  onStderr?: (chunk: string) => void,
  environment: NodeJS.ProcessEnv = process.env,
  maxBuffer = 4 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const redact = (value: string) => environment.KIMONO_GIT_TOKEN
    ? value.replaceAll(environment.KIMONO_GIT_TOKEN, '[REDACTED]') : value;
  try {
    const execution = execute(executable, args, {
      cwd, timeout, maxBuffer,
      env: { ...environment, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
    });
    children.add(execution.child);
    execution.child.once('close', () => children.delete(execution.child));
    if (onStderr) execution.child.stderr?.on('data', (chunk: Buffer) => onStderr(chunk.toString()));
    const result = await execution;
    return { stdout: redact(result.stdout), stderr: redact(result.stderr), exitCode: 0 };
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'number'
      && allowedExitCodes.includes(error.code) && 'stdout' in error && 'stderr' in error
      && typeof error.stdout === 'string' && typeof error.stderr === 'string') {
      return { stdout: redact(error.stdout), stderr: redact(error.stderr), exitCode: error.code };
    }
    throw new Error(`${executable} failed: ${redact(error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
}
