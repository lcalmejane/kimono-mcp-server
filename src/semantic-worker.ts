import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { registerChild } from './process.js';

interface WorkerResponse {
  version: 1;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ActiveRequest {
  id: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  onStderr?: (chunk: string) => void;
  timer: NodeJS.Timeout;
}

export interface SemanticWorkerStatus {
  phase: 'starting' | 'ready' | 'error' | 'restarting' | 'stopped' | 'disabled';
  pid?: number;
  error?: string;
}

const workers = new Map<string, SemanticWorker>();
const MAX_QUEUED_REQUESTS = 8;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function workerKey(model: string, environment: NodeJS.ProcessEnv): string {
  const binary = environment.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic';
  return JSON.stringify([binary, model, ...[
    'ORT_DYLIB_PATH', 'KIMONO_SEMANTIC_DEVICE', 'KIMONO_SEMANTIC_WORKERS',
    'KIMONO_SEMANTIC_THREADS', 'KIMONO_SEMANTIC_BATCH',
    'KIMONO_SEMANTIC_CPU_PERCENT', 'KIMONO_SEMANTIC_MEMORY_PERCENT',
  ].map(name => environment[name])]);
}

export function semanticWorkerEnabled(): boolean {
  return process.env.KIMONO_SEMANTIC_PERSISTENT_WORKER !== 'false';
}

export function semanticWorkerStatus(model: string, environment: NodeJS.ProcessEnv): SemanticWorkerStatus | undefined {
  return workers.get(workerKey(model, environment))?.status();
}

export function semanticWorkerFor(
  model: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  onStatus?: (status: SemanticWorkerStatus) => void,
): SemanticWorker {
  const binary = environment.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic';
  const key = workerKey(model, environment);
  let worker = workers.get(key);
  if (!worker) {
    worker = new SemanticWorker(binary, model, cwd, environment);
    workers.set(key, worker);
  }
  if (onStatus) worker.onStatus(onStatus);
  return worker;
}

export async function shutdownSemanticWorkers(): Promise<void> {
  const closing = [...workers.values()];
  workers.clear();
  await Promise.all(closing.map(worker => worker.close()));
}

export class SemanticWorker {
  private child?: ChildProcessWithoutNullStreams;
  private active?: ActiveRequest;
  private stdout = '';
  private stderr = '';
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private closing = false;
  private warmed = false;
  private everStarted = false;
  private phase: SemanticWorkerStatus['phase'] = 'stopped';
  private lastError?: string;
  private readonly statusListeners = new Set<(status: SemanticWorkerStatus) => void>();

  get ready(): boolean { return this.warmed && Boolean(this.child && !this.child.killed); }

  status(): SemanticWorkerStatus {
    return {
      phase: this.phase,
      ...(this.child?.pid ? { pid: this.child.pid } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  onStatus(listener: (status: SemanticWorkerStatus) => void): void {
    this.statusListeners.add(listener);
    listener(this.status());
  }

  private setPhase(phase: SemanticWorkerStatus['phase']): void {
    this.phase = phase;
    const status = this.status();
    for (const listener of this.statusListeners) listener(status);
  }

  constructor(
    private readonly binary: string,
    private readonly model: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  /** `signal` interrupts this request only: queued, it never starts; active, the child is killed (a native batch cannot be paused). */
  request(requestPath: string, timeout: number, onStderr?: (chunk: string) => void, signal?: AbortSignal): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error('Semantic worker is shutting down'));
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.queued >= MAX_QUEUED_REQUESTS) {
      return Promise.reject(new Error(`Semantic worker queue is full (maximum ${MAX_QUEUED_REQUESTS})`));
    }
    this.queued++;
    const deadline = Date.now() + timeout;
    const result = this.queue.then(() => {
      if (signal?.aborted) throw abortReason(signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Semantic worker request timed out after waiting in the queue`);
      return this.send({ version: 1, id: randomUUID(), operation: 'request', requestPath }, remaining, onStderr, signal);
    });
    this.queue = result.then(() => undefined, () => undefined).finally(() => { this.queued--; });
    return result;
  }

  async close(): Promise<void> {
    if (this.closing) return this.queue;
    this.closing = true;
    await this.queue;
    const child = this.child;
    if (!child) {
      this.lastError = undefined;
      this.setPhase('stopped');
      return;
    }
    try {
      await this.send({ version: 1, id: randomUUID(), operation: 'shutdown' }, 1000);
    } catch {
      child.kill('SIGTERM');
    }
    if (this.child === child) {
      const exited = once(child, 'close').then(() => true, () => false);
      if (await Promise.race([exited, delay(1000).then(() => false)])) return;
      child.kill('SIGTERM');
    }
  }

  private async send(
    message: { version: 1; id: string; operation: string; requestPath?: string },
    timeout: number,
    onStderr?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const child = this.ensureChild();
    if (this.active) throw new Error('Semantic worker already has an active request');
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Semantic worker request timed out after ${timeout} ms`), true);
      }, timeout);
      timer.unref();
      this.active = { id: message.id, resolve, reject, onStderr, timer };
    });
    if (signal) {
      const interrupt = () => {
        if (this.active?.id !== message.id) return;
        this.fail(abortReason(signal), true);
        // A deliberate stop is not a worker fault: do not report it as an error.
        this.lastError = undefined;
        this.warmed = false;
        this.setPhase('stopped');
      };
      signal.addEventListener('abort', interrupt, { once: true });
      void result.then(() => undefined, () => undefined).finally(() => signal.removeEventListener('abort', interrupt));
      if (signal.aborted) interrupt();
    }
    try {
      if (!child.stdin.write(`${JSON.stringify(message)}\n`)) await once(child.stdin, 'drain');
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), true);
    }
    return result;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const phase = this.everStarted ? 'restarting' : 'starting';
    this.lastError = undefined;
    const child = spawn(this.binary, ['--worker', this.model], {
      cwd: this.cwd,
      env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.everStarted = true;
    this.warmed = false;
    this.stdout = '';
    this.stderr = '';
    this.setPhase(phase);
    registerChild(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_BYTES);
      this.active?.onStderr?.(chunk);
    });
    child.once('error', error => this.fail(error, true));
    child.once('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.warmed = false;
      if (this.closing) {
        this.lastError = undefined;
        this.setPhase('stopped');
      } else {
        const error = new Error(`Semantic worker exited with ${code ?? signal}\n${this.stderr}`);
        if (this.active) this.fail(error, false);
        this.lastError = error.message.slice(0, 2048);
        this.setPhase('error');
      }
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > MAX_RESPONSE_BYTES && !this.stdout.includes('\n')) {
      this.fail(new Error('Semantic worker response exceeded the protocol limit'), true);
      return;
    }
    let newline: number;
    while ((newline = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
        this.fail(new Error('Semantic worker response exceeded the protocol limit'), true);
        return;
      }
      this.accept(line);
    }
  }

  private accept(line: string): void {
    const active = this.active;
    if (!active) {
      this.fail(new Error('Semantic worker emitted an unsolicited protocol response'), true);
      return;
    }
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      this.fail(new Error('Semantic worker emitted invalid JSON', { cause: error }), true);
      return;
    }
    if (!isResponse(value) || value.id !== active.id) {
      this.fail(new Error('Semantic worker response did not match the active request'), true);
      return;
    }
    clearTimeout(active.timer);
    this.active = undefined;
    this.warmed = true;
    this.lastError = undefined;
    this.setPhase('ready');
    if (!value.ok) active.reject(new Error(value.error ?? 'Semantic worker request failed'));
    else active.resolve(value.result);
  }

  private fail(error: Error, stop: boolean): void {
    this.lastError = error.message.slice(0, 2048);
    this.setPhase('error');
    const active = this.active;
    this.active = undefined;
    if (active) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    if (stop) {
      const child = this.child;
      this.child = undefined;
      child?.kill('SIGTERM');
    }
  }
}

function isResponse(value: unknown): value is WorkerResponse {
  return value !== null && typeof value === 'object'
    && (value as WorkerResponse).version === 1
    && typeof (value as WorkerResponse).id === 'string'
    && typeof (value as WorkerResponse).ok === 'boolean'
    && ((value as WorkerResponse).ok
      ? 'result' in value
      : typeof (value as WorkerResponse).error === 'string');
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Semantic worker request cancelled');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
