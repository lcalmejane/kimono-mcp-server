import { describe, expect, it, vi } from 'vitest';
import { previousValidation } from '../scripts/ci-validation.mjs';

const sha = 'a'.repeat(40);
const options = { repository: 'owner/repo', sha, runId: '20', token: 'test-token', pause: vi.fn() };
const run = (overrides = {}) => ({
  id: 10, event: 'push', head_sha: sha, head_branch: 'main', status: 'completed', conclusion: 'success',
  ...overrides,
});
const response = (runs: unknown[]) => new Response(JSON.stringify({ workflow_runs: runs }));
const artifacts = [
  { name: 'kimono-native-linux-x64', expired: false },
  { name: 'kimono-vscode-linux-x64', expired: false },
];

describe('release validation reuse', () => {
  it('waits for the exact main commit and reuses its successful run', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response([run({ status: 'in_progress', conclusion: null })]))
      .mockResolvedValueOnce(response([run()]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ artifacts })));
    const pause = vi.fn();
    expect(await previousValidation({ ...options, request, pause })).toBe('10');
    expect(pause).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0][0])).toContain(`head_sha=${sha}`);
  });

  it('ignores a different commit, PR, tag and the current run before validating locally', async () => {
    const request = vi.fn().mockImplementation(async () => response([
      run({ head_sha: 'b'.repeat(40) }), run({ event: 'pull_request' }),
      run({ head_branch: 'v1.0.0' }), run({ id: 20 }),
    ]));
    const pause = vi.fn();
    expect(await previousValidation({ ...options, request, pause })).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(6);
    expect(pause).toHaveBeenCalledTimes(5);
  });

  it.each(['failure', 'cancelled'])('refuses to bypass %s on the same commit', async conclusion => {
    const request = vi.fn().mockResolvedValue(response([run({ conclusion })]));
    await expect(previousValidation({ ...options, request })).rejects.toThrow('refusing to release');
  });

  it('revalidates when a successful run no longer has all required artifacts', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response([run()]))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        artifacts: artifacts.map(artifact => ({ ...artifact, expired: true })),
      })));
    expect(await previousValidation({ ...options, request })).toBeUndefined();
  });

  it('does not turn GitHub API errors into successful reuse or a local fallback', async () => {
    const request = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
    await expect(previousValidation({ ...options, request })).rejects.toThrow('HTTP 403');
  });

  it('fails explicitly when the branch validation never finishes', async () => {
    const request = vi.fn().mockImplementation(async () => response([run({ status: 'in_progress' })]));
    await expect(previousValidation({ ...options, request })).rejects.toThrow('within 30 minutes');
    expect(request).toHaveBeenCalledTimes(120);
  });
});
