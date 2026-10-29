import { terminateChildren } from './process.js';
import { shutdownSemanticWorkers } from './semantic-worker.js';

export class Lifecycle {
  stopping = false;
  private readonly active = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('Kimono is shutting down; retry on a running instance');
    const task = Promise.resolve().then(action);
    this.active.add(task);
    try { return await task; }
    finally { this.active.delete(task); }
  }

  close(cleanup: () => Promise<void>, forceConnections: () => void): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      let forced = false;
      const timeout = setTimeout(() => {
        forced = true;
        console.error('Kimono shutdown grace period exceeded; terminating subprocesses');
        terminateChildren();
        forceConnections();
      }, 30_000);
      try {
        await Promise.allSettled(this.active);
        await cleanup();
        await shutdownSemanticWorkers();
        if (forced) throw new Error('Kimono shutdown required forced termination');
      } finally { clearTimeout(timeout); }
    })();
    return this.closing;
  }
}

export function shutdownSignals(close: () => Promise<void>): () => void {
  const handler = () => {
    void close().catch((error: unknown) => {
      console.error('Kimono shutdown failed:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
