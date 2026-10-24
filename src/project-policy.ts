import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ProjectPolicy {
  projectId?: string;
  gitUrl?: string | null;
  gitMode?: string;
  gitPolicy?: unknown;
  gitPushAllowed?: boolean;
  execution?: string;
}

export interface RetargetMetadata {
  gitUrl: string;
  branch?: string | null;
  updatedAt: string;
}

export interface RemoteSourceMetadata {
  gitUrl: string;
  branch: string;
  commit: string;
  syncedAt: string;
  indexedAt?: string;
  corpusFingerprint?: string;
}

export function validateGitUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\0\r\n]/.test(value)) {
    throw new Error('gitUrl must be a credential-free HTTPS/SSH Git URL');
  }
  const scp = /^git@([A-Za-z0-9.-]+):([A-Za-z0-9._/-]+?)(?:\.git)?$/.exec(value);
  if (scp) {
    validateRemotePath(scp[2]);
    return value;
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error('gitUrl must be a credential-free HTTPS/SSH Git URL'); }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.password
    || (parsed.username && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
    || parsed.search || parsed.hash || parsed.port && !/^\d{1,5}$/.test(parsed.port)) {
    throw new Error('gitUrl must not contain credentials, query parameters or fragments');
  }
  const remotePath = decodeURIComponent(parsed.pathname).replace(/^\/|\/$/g, '').replace(/\.git$/i, '');
  validateRemotePath(remotePath);
  return value;
}

export function validateBranch(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.startsWith('-') || value.includes('..') || value.includes('//') || value.includes('@{')
    || value.endsWith('.') || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    throw new Error('branch must be a safe Git branch name or null');
  }
  return value;
}

export async function readProjectPolicy(root: string): Promise<ProjectPolicy | null> {
  const file = process.env.KIMONO_PROJECT_POLICY_FILE;
  if (!file) return null;
  const rootPath = await realpath(root);
  const absolute = path.resolve(file);
  if (inside(rootPath, absolute)) throw new Error('KIMONO_PROJECT_POLICY_FILE must be outside AIKIDO_ROOT');
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
    throw new Error('KIMONO_PROJECT_POLICY_FILE must be a regular file outside AIKIDO_ROOT, at most 64 KiB');
  }
  const actualPath = await realpath(absolute);
  if (inside(rootPath, actualPath)) throw new Error('KIMONO_PROJECT_POLICY_FILE must be outside AIKIDO_ROOT');
  const raw: unknown = JSON.parse(await readFile(actualPath, 'utf8'));
  if (!isRecord(raw)) throw new Error('KIMONO_PROJECT_POLICY_FILE must contain a JSON object');
  const policy: ProjectPolicy = {};
  if (raw.projectId !== undefined) {
    if (typeof raw.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.projectId)) throw new Error('Invalid projectId in project policy');
    policy.projectId = raw.projectId;
  }
  if (raw.gitUrl === '') policy.gitUrl = null;
  else if (raw.gitUrl !== undefined && raw.gitUrl !== null) policy.gitUrl = validateGitUrl(raw.gitUrl);
  else if (raw.gitUrl === null) policy.gitUrl = null;
  if (raw.gitMode !== undefined) {
    if (typeof raw.gitMode !== 'string' || raw.gitMode.length > 64) throw new Error('Invalid gitMode in project policy');
    policy.gitMode = raw.gitMode;
  }
  if (raw.gitPolicy !== undefined) {
    const encoded = JSON.stringify(raw.gitPolicy);
    if (Buffer.byteLength(encoded) > 8192) throw new Error('gitPolicy exceeds 8 KiB');
    policy.gitPolicy = redactSensitiveKeys(raw.gitPolicy);
  }
  if (raw.gitPushAllowed !== undefined) {
    if (typeof raw.gitPushAllowed !== 'boolean') throw new Error('gitPushAllowed must be boolean');
    policy.gitPushAllowed = raw.gitPushAllowed;
  }
  if (raw.execution !== undefined) {
    if (typeof raw.execution !== 'string' || raw.execution.length > 64) throw new Error('Invalid execution policy');
    policy.execution = raw.execution;
  }
  return policy;
}

export async function readRetargetMetadata(cacheDirectory: string): Promise<RetargetMetadata | null> {
  try {
    const data: unknown = JSON.parse(await readFile(path.join(cacheDirectory, 'project-retarget.json'), 'utf8'));
    if (!isRecord(data) || typeof data.gitUrl !== 'string' || typeof data.updatedAt !== 'string') {
      throw new Error('Invalid project retarget metadata');
    }
    return { gitUrl: validateGitUrl(data.gitUrl), branch: validateBranch(data.branch), updatedAt: data.updatedAt };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function saveRetargetMetadata(cacheDirectory: string, value: { gitUrl: unknown; branch: unknown }): Promise<RetargetMetadata> {
  const metadata: RetargetMetadata = {
    gitUrl: validateGitUrl(value.gitUrl),
    branch: validateBranch(value.branch),
    updatedAt: new Date().toISOString(),
  };
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(cacheDirectory, 'project-retarget.json');
  const pending = path.join(cacheDirectory, `project-retarget-${randomUUID()}.pending`);
  try {
    await writeFile(pending, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
    await rename(pending, target);
  } finally {
    await rm(pending, { force: true });
  }
  return metadata;
}

export async function readRemoteSourceMetadata(cacheDirectory: string): Promise<RemoteSourceMetadata | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(cacheDirectory, 'project-remote.json'), 'utf8'));
    if (!isRecord(raw) || typeof raw.gitUrl !== 'string' || typeof raw.branch !== 'string'
      || typeof raw.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(raw.commit)
      || typeof raw.syncedAt !== 'string'
      || (raw.indexedAt !== undefined && typeof raw.indexedAt !== 'string')
      || (raw.corpusFingerprint !== undefined && (typeof raw.corpusFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/.test(raw.corpusFingerprint)))) throw new Error('Invalid remote source metadata');
    return { gitUrl: validateGitUrl(raw.gitUrl), branch: validateBranch(raw.branch)!, commit: raw.commit,
      syncedAt: raw.syncedAt,
      ...(typeof raw.indexedAt === 'string' ? { indexedAt: raw.indexedAt } : {}),
      ...(typeof raw.corpusFingerprint === 'string' ? { corpusFingerprint: raw.corpusFingerprint } : {}) };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function writeRemoteSourceMetadata(cacheDirectory: string, value: RemoteSourceMetadata): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(cacheDirectory, 'project-remote.json');
  const pending = path.join(cacheDirectory, `project-remote-${randomUUID()}.pending`);
  try {
    await writeFile(pending, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(pending, target);
  } finally {
    await rm(pending, { force: true });
  }
}

function validateRemotePath(value: string): void {
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > 8
    || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..'
      || segment.startsWith('-'))) {
    throw new Error('gitUrl must identify a repository path without credentials');
  }
}

function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|secret|password|credential|private.?key)/i.test(key))
    .map(([key, item]) => [key, redactSensitiveKeys(item)]));
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
