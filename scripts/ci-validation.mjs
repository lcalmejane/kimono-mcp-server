import { appendFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export async function previousValidation({
  repository, sha, runId, token, request = fetch, pause = setTimeout,
}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)
    || !/^\d+$/.test(runId) || !token) {
    throw new Error('Repository, full commit SHA, run ID and GitHub token are required.');
  }
  const url = new URL(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs`);
  url.search = new URLSearchParams({ head_sha: sha, branch: 'main', event: 'push', per_page: '100' }).toString();
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await request(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot inspect previous CI validation: HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body.workflow_runs)) throw new Error('Invalid GitHub workflow-runs response.');
    const runs = body.workflow_runs.filter(run => run.head_sha === sha && run.head_branch === 'main'
      && run.event === 'push' && String(run.id) !== runId);
    const passed = runs.find(run => run.status === 'completed' && run.conclusion === 'success');
    if (passed) {
      const artifactsResponse = await request(
        `https://api.github.com/repos/${repository}/actions/runs/${passed.id}/artifacts?per_page=100`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!artifactsResponse.ok) throw new Error(`Cannot inspect validated artifacts: HTTP ${artifactsResponse.status}`);
      const { artifacts } = await artifactsResponse.json();
      if (!Array.isArray(artifacts)) throw new Error('Invalid GitHub artifacts response.');
      if (!['kimono-native-linux-x64', 'kimono-vscode-linux-x64'].every(
        name => artifacts.some(artifact => artifact.name === name && !artifact.expired),
      )) {
        console.log(`Validated Linux artifacts for run ${passed.id} are missing or expired; performing full validation.`);
        return undefined;
      }
      console.log(`Reusing successful main CI run ${passed.id} for ${sha}.`);
      return String(passed.id);
    }
    if (runs.length && !runs.some(run => run.status !== 'completed')) {
      throw new Error(`Main CI did not pass for ${sha}; refusing to release this commit.`);
    }
    // Allow simultaneous branch/tag push events time to register before validating locally.
    if (!runs.length && attempt >= 5) {
      console.log(`No main CI run exists for ${sha}; this run will perform the full validation.`);
      return undefined;
    }
    console.log(`Waiting for main CI validation of ${sha} (attempt ${attempt + 1}/120).`);
    await pause(15_000);
  }
  throw new Error(`Main CI validation of ${sha} did not finish within 30 minutes.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runId = await previousValidation({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GH_TOKEN,
  });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required.');
  await appendFile(process.env.GITHUB_OUTPUT, `reused=${Boolean(runId)}\nrun-id=${runId ?? process.env.GITHUB_RUN_ID}\n`);
}
