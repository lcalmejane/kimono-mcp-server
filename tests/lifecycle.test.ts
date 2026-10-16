import { afterEach, expect, it, vi } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { terminateChildren } from '../src/process.js';

vi.mock('../src/process.js', () => ({ terminateChildren: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('drains accepted work, rejects new work and closes idempotently', async () => {
  const lifecycle = new Lifecycle();
  let finish!: () => void;
  const accepted = lifecycle.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const cleanup = vi.fn(async () => undefined);
  const closing = lifecycle.close(cleanup, () => undefined);
  expect(lifecycle.close(cleanup, () => undefined)).toBe(closing);
  await expect(lifecycle.run(async () => undefined)).rejects.toThrow('shutting down');
  expect(cleanup).not.toHaveBeenCalled();
  finish();
  await accepted;
  await closing;
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('forces subprocess termination at the grace deadline and reports failure', async () => {
  vi.useFakeTimers();
  const lifecycle = new Lifecycle();
  let finish!: () => void;
  const work = lifecycle.run(() => new Promise<void>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  const force = vi.fn(() => finish());
  const closing = lifecycle.close(async () => undefined, force);
  const failure = expect(closing).rejects.toThrow('forced termination');
  await vi.advanceTimersByTimeAsync(30_000);
  await work;
  await failure;
  expect(terminateChildren).toHaveBeenCalledOnce();
  expect(force).toHaveBeenCalledOnce();
});
