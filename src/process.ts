import { execFile, spawn, type ChildProcess } from 'node:child_process';
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
  streamStderr = false,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const redact = (value: string) => environment.KIMONO_GIT_TOKEN
    ? value.replaceAll(environment.KIMONO_GIT_TOKEN, '[REDACTED]') : value;
  try {
    if (streamStderr) {
      const result = await streamingProcess(executable, args, cwd, environment, timeout, maxBuffer, allowedExitCodes, onStderr);
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
    }
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

function streamingProcess(
  executable: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv,
  timeout: number, maxBuffer: number, allowedExitCodes: number[], onStderr?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: {
      ...environment, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '', bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(new Error(`Process timed out after ${timeout} ms`)), timeout);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBuffer) stop(new Error('Process stdout exceeded maxBuffer'));
      else stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      // Progress is consumed live; retain only a bounded diagnostic tail.
      stderr = (stderr + chunk).slice(-64 * 1024);
      onStderr?.(chunk);
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (failure) reject(new Error(`${failure.message}\n${stderr}`, { cause: failure }));
      else if (code === null || !allowedExitCodes.includes(code)) reject(new Error(`Process exited with ${code ?? signal}\n${stderr}`));
      else resolve({ stdout, stderr, exitCode: code });
    });
  });
}
