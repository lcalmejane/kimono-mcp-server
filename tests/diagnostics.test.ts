import { afterEach, expect, it, vi } from 'vitest';
import { debug, debugEnabled, nativeDiagnostics } from '../src/diagnostics.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('disables detailed diagnostics by default, including in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  delete process.env.KIMONO_LOG_LEVEL;
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  debug('optional detail');
  const diagnostics = nativeDiagnostics();
  for (let index = 0; index < 10000; index++) diagnostics.line('KIMONO_PROGRESS {"completed":1,"total":2}');
  diagnostics.flush();
  expect(debugEnabled()).toBe(false);
  expect(output).not.toHaveBeenCalled();
});

it('keeps actionable errors but bounds native diagnostic volume per operation', () => {
  vi.stubEnv('KIMONO_LOG_LEVEL', 'error');
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const diagnostics = nativeDiagnostics();
  for (let index = 0; index < 1000; index++) diagnostics.line('x'.repeat(10000));
  diagnostics.flush();
  expect(output).toHaveBeenCalledTimes(21);
  expect(output.mock.calls.slice(0, 20).every(([line]) => String(line).length <= 4111)).toBe(true);
  expect(output.mock.lastCall?.[0]).toContain('980 additional diagnostic lines omitted');
});

it('makes debug opt-in and keeps progress separate from the error budget', () => {
  vi.stubEnv('KIMONO_LOG_LEVEL', 'debug');
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  debug('detail');
  const diagnostics = nativeDiagnostics();
  for (let index = 0; index < 100; index++) diagnostics.line('KIMONO_PROGRESS {}');
  diagnostics.line('model failure');
  diagnostics.flush();
  expect(output).toHaveBeenCalledTimes(22);
  expect(output.mock.lastCall?.[0]).toContain('model failure');
});

it('rejects invalid diagnostic configuration', () => {
  vi.stubEnv('KIMONO_LOG_LEVEL', 'verbose');
  expect(debugEnabled).toThrow('KIMONO_LOG_LEVEL must be error or debug');
});
