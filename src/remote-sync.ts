import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import type { AikidoKnowledgeBase } from './knowledge.js';
import { AikidoKnowledgeBase as KnowledgeBase, isKnowledgeFile, isSensitiveKnowledgePath } from './knowledge.js';
import { runProcess } from './process.js';
import { withRemoteGitProfile, type GitReadProfile } from './git-profile.js';
import { validateBranch, validateGitUrl } from './project-policy.js';
import { sourceSnapshot } from './index-basis.js';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_CORPUS_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;
const TEXT = new TextDecoder('utf-8', { fatal: true });

export interface RemoteSyncTarget {
  gitUrl: string;
  branch?: string | null;
  profile?: GitReadProfile | null;
}

export interface PublishedRemote {
  gitUrl: string;
  branch: string;
  commit: string;
  syncedAt: string;
  remoteFiles: Record<string, string>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface RootPublication {
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export async function synchronizeKnowledgeRoot(
  knowledge: AikidoKnowledgeBase,
  desired: Map<string, string>,
  expectedManifest: Record<string, string>,
): Promise<RootPublication> {
  await knowledge.refresh();
  const metadataOnly = new Set(knowledge.list().filter(entry => entry.metadata).map(entry => entry.path));
  for (const file of desired.keys()) {
    if (metadataOnly.has(file)) throw new Error(`Cannot replace metadata-only file during text publication: ${file}`);
  }
  const previousFiles = await readManagedFiles(knowledge);
  const currentManifest: Record<string, string> = {};
  for (const [file, content] of previousFiles) currentManifest[file] = hash(content);
  if (JSON.stringify(sortedManifest(currentManifest)) !== JSON.stringify(sortedManifest(expectedManifest))) {
    throw new Error('AIKIDO_ROOT changed while collaboration publication was prepared; refresh and compare before retrying');
  }
  const rootPath = await validateRootForPublication(knowledge.root);
  const touched = new Set([...previousFiles.keys(), ...desired.keys()]);
  let published = false;
  try {
    published = true;
    await publishFiles(rootPath, desired, touched);
    await knowledge.refresh();
    const writtenFiles = await readManagedFiles(knowledge);
    const writtenManifest: Record<string, string> = {};
    for (const [file, content] of writtenFiles) writtenManifest[file] = hash(content);
    const desiredManifest: Record<string, string> = {};
    for (const [file, content] of desired) desiredManifest[file] = hash(content);
    if (JSON.stringify(sortedManifest(writtenManifest)) !== JSON.stringify(sortedManifest(desiredManifest))) {
      throw new Error('Published collaboration revision is not eligible under the current ROOT rules; no revision was advanced');
    }
    return {
      rollback: async () => {
        if (published) await publishFiles(rootPath, previousFiles, touched);
        published = false;
      },
      finalize: async () => { published = false; },
    };
  } catch (error) {
    if (published) {
      try {
        await publishFiles(rootPath, previousFiles, touched);
        await knowledge.refresh();
      }
      catch {
        throw new Error('Collaboration publication failed and could not restore AIKIDO_ROOT; inspect the knowledge directory before retrying');
      }
    }
    throw error;
  }
}

export async function publishRemoteKnowledge(knowledge: AikidoKnowledgeBase, target: RemoteSyncTarget): Promise<PublishedRemote> {
  const gitUrl = validateGitUrl(target.gitUrl);
  const requestedBranch = validateBranch(target.branch);
  await knowledge.refresh();
  const sourceBefore = await sourceSnapshot(knowledge);
  const cacheRoot = knowledge.searchIndex.directory;
  const stage = path.join(cacheRoot, 'remote-staging', randomUUID());
  const bare = path.join(stage, 'repo.git');
  const archive = path.join(stage, 'repo.tar');
  const remoteRoot = path.join(stage, 'remote');
  const publishRoot = path.join(stage, 'published');
  const gitHome = path.join(cacheRoot, 'remote-home');
  let published = false;
  let rootPath = '';
  let previousFiles = new Map<string, string>();
  let nextFiles = new Map<string, string>();
  try {
    await mkdir(stage, { recursive: true, mode: 0o700 });
    await mkdir(gitHome, { recursive: true, mode: 0o700 });
    const remote = await withRemoteGitProfile(target.profile ?? null, gitHome, async context => {
      context.validateUrl(gitUrl);
      const git = (args: string[], timeout: number) => runProcess(
        'git', [...context.args, ...args], stage, [0], timeout, undefined, context.env,
      );
      const cloneArgs = ['clone', '--bare', '--no-tags', '--no-recurse-submodules'];
      if (requestedBranch) cloneArgs.push('--branch', requestedBranch);
      cloneArgs.push('--', gitUrl, bare);
      try {
        await git(cloneArgs, 600_000);
      } catch {
        throw new Error('Remote sync failed: repository is unavailable or requires valid read credentials');
      }
      const branch = (await git(['-C', bare, 'symbolic-ref', '--short', 'HEAD'], 30_000)).stdout.trim();
      validateBranch(branch);
      if (requestedBranch && branch !== requestedBranch) throw new Error('Remote clone did not select the requested existing branch');
      const commit = (await git(['-C', bare, 'rev-parse', '--verify', 'HEAD'], 30_000)).stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Remote returned an invalid commit identifier');
      await git(['-C', bare, 'archive', '--format=tar', `--output=${archive}`, commit], 120_000);
      return { branch, commit };
    });
    const { branch, commit } = remote;
    const archiveInfo = await stat(archive);
    if (archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error(`Remote archive exceeds ${MAX_ARCHIVE_BYTES} bytes`);
    await mkdir(remoteRoot, { recursive: true, mode: 0o700 });
    const remoteFiles = await extractKnowledgeArchive(archive, remoteRoot);
    const remoteKnowledge = new KnowledgeBase(remoteRoot, false, knowledge.config);
    await remoteKnowledge.initialize();
    const remoteHashes = await hashKnowledge(remoteKnowledge);

    const previousRemote = await readRemoteFileManifest(cacheRoot);
    const currentHashes = await hashKnowledge(knowledge);
    const conflicts = Object.keys(previousRemote).filter(file => {
      const current = currentHashes[file] ?? null;
      return current !== previousRemote[file] && current !== (remoteHashes[file] ?? null);
    }).sort();
    if (conflicts.length) {
      throw new Error(`Remote sync conflicts with unpublished local knowledge: ${conflicts.slice(0, 20).join(', ')}. Publish to Git or explicitly reconcile these paths before retrying; ROOT was not changed`);
    }
    await copyLocalUnpublishedKnowledge(knowledge, remoteKnowledge, remoteRoot, previousRemote);
    await mkdir(publishRoot, { recursive: true, mode: 0o700 });
    await copyDirectory(remoteRoot, publishRoot);
    const nextKnowledge = new KnowledgeBase(publishRoot, false, knowledge.config);
    await nextKnowledge.initialize();
    nextFiles = await readManagedFiles(nextKnowledge);
    previousFiles = await readManagedFiles(knowledge);
    const oldIgnores = await collectIgnoreFiles(knowledge.root);
    for (const [file, content] of oldIgnores) {
      if (!remoteFiles.has(file)) previousFiles.set(file, content);
    }
    const newIgnores = await collectIgnoreFiles(publishRoot);
    for (const [file, content] of newIgnores) nextFiles.set(file, content);
    if (nextFiles.size > MAX_FILES) throw new Error(`Remote knowledge exceeds the ${MAX_FILES} file limit`);

    rootPath = await validateRootForPublication(knowledge.root);
    const sourceNow = await sourceSnapshot(knowledge);
    if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceNow)) {
      throw new Error('Local knowledge changed while remote sync was staging; retry to preserve the newer files');
    }
    const backup = new Map(previousFiles);
    const touched = new Set([...previousFiles.keys(), ...nextFiles.keys()]);
    published = true;
    await publishFiles(rootPath, nextFiles, touched);
    const manifestPath = path.join(cacheRoot, 'project-remote-files.json');
    const previousManifest = await readFile(manifestPath).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });

    return {
      gitUrl,
      branch,
      commit,
      syncedAt: new Date().toISOString(),
      remoteFiles: remoteHashes,
      rollback: async () => {
        if (published) await publishFiles(rootPath, backup, touched);
        if (previousManifest) await writeAtomic(manifestPath, previousManifest);
        else await rm(manifestPath, { force: true });
        published = false;
        await rm(stage, { recursive: true, force: true });
      },
      finalize: async () => {
        await writeRemoteFileManifest(cacheRoot, remoteHashes);
        await rm(stage, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (published && rootPath) {
      try { await publishFiles(rootPath, previousFiles, new Set([...previousFiles.keys(), ...nextFiles.keys()])); }
      catch {
        console.error('Remote sync rollback failed; inspect the shared knowledge directory before retrying');
        throw new Error('Remote sync failed and could not restore the previous knowledge corpus');
      }
    }
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function extractKnowledgeArchive(archive: string, root: string): Promise<Map<string, string>> {
  const buffer = await readFile(archive);
  if (buffer.length > MAX_ARCHIVE_BYTES || buffer.length % 512 !== 0) throw new Error('Remote archive has an invalid size');
  const files = new Map<string, string>();
  let offset = 0;
  let pendingPath: string | undefined;
  let totalBytes = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    verifyTarChecksum(header);
    const prefix = field(header, 345, 155);
    const headerName = field(header, 0, 100);
    const size = parseOctal(field(header, 124, 12));
    const type = String.fromCharCode(header[156] || 48);
    const headerPath = pendingPath ?? [prefix, headerName].filter(Boolean).join('/');
    pendingPath = undefined;
    offset += 512;
    if (size > buffer.length - offset) throw new Error('Remote archive entry exceeds archive bounds');
    const content = buffer.subarray(offset, offset + size);
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += paddedSize;
    if (type === 'x') {
      pendingPath = paxPath(content);
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5') continue;
    const normalized = safeArchivePath(headerPath);
    if (type === '5' || !normalized || isSensitiveKnowledgePath(normalized)) continue;
    if (normalized !== '.gitignore' && !normalized.endsWith('/.gitignore') && !isKnowledgeFile(normalized)) continue;
    if (size > MAX_DOCUMENT_BYTES) continue;
    let text: string;
    try { text = TEXT.decode(content); }
    catch { continue; }
    if (text.includes('\0')) continue;
    totalBytes += size;
    if (totalBytes > MAX_CORPUS_BYTES) throw new Error(`Remote knowledge exceeds the ${MAX_CORPUS_BYTES} byte corpus limit`);
    const target = path.resolve(root, ...normalized.split('/'));
    if (!within(root, target)) throw new Error(`Remote archive path escaped staging: ${normalized}`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, text, { mode: 0o600, flag: 'wx' });
    files.set(normalized, text);
    if (files.size > MAX_FILES) throw new Error(`Remote knowledge exceeds the ${MAX_FILES} file limit`);
  }
  if (!files.has('prompts/index.md') && !files.has('index.md')) throw new Error('Remote repository has no AI-KIDO entry point');
  return files;
}

async function copyLocalUnpublishedKnowledge(
  current: AikidoKnowledgeBase,
  remote: AikidoKnowledgeBase,
  remoteRoot: string,
  priorRemote: Record<string, string>,
): Promise<void> {
  const remotePaths = new Set(remote.list().map(entry => entry.path));
  for (const entry of current.list().filter(entry => isKnowledgeFile(entry.path) && !entry.metadata)) {
    const { content } = await current.read(entry.path);
    const previousHash = priorRemote[entry.path];
    const currentHash = hash(content);
    const isRemoteOwnedAndUnchanged = previousHash !== undefined && previousHash === currentHash;
    if (isRemoteOwnedAndUnchanged) continue;

    const remoteContent = remotePaths.has(entry.path) ? (await remote.read(entry.path)).content : undefined;
    if (remoteContent === content) continue;
    const destination = remoteContent === undefined ? entry.path
      : entry.path.startsWith('local-seed/') ? `local-seed-conflicts/${entry.path.slice('local-seed/'.length)}`
        : `local-seed/${entry.path}`;
    const safeDestination = safeArchivePath(destination);
    if (!safeDestination || isSensitiveKnowledgePath(safeDestination)) continue;
    const target = path.resolve(remoteRoot, ...safeDestination.split('/'));
    if (!within(remoteRoot, target)) throw new Error(`Unsafe local seed path: ${entry.path}`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    let existing: string | undefined;
    try { existing = await readFile(target, 'utf8'); }
    catch (error) { if (!isMissing(error)) throw error; }
    if (existing === undefined) await writeFile(target, content, { mode: 0o600, flag: 'wx' });
    else if (existing !== content) throw new Error(`Local unpublished knowledge conflicts at ${destination}`);
  }
}

async function readManagedFiles(knowledge: AikidoKnowledgeBase): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let total = 0;
  for (const entry of knowledge.list().filter(entry => isKnowledgeFile(entry.path) && !entry.metadata)) {
    const { content } = await knowledge.read(entry.path);
    total += Buffer.byteLength(content);
    if (total > MAX_CORPUS_BYTES) throw new Error(`Knowledge corpus exceeds ${MAX_CORPUS_BYTES} bytes`);
    files.set(entry.path, content);
  }
  return files;
}

async function publishFiles(root: string, desired: Map<string, string>, touched: Set<string>): Promise<void> {
  const rootReal = await realpath(root);
  for (const [relative, content] of desired) {
    validateManagedPath(relative);
    const target = path.resolve(rootReal, ...relative.split('/'));
    if (!within(rootReal, target)) throw new Error(`Refusing to publish outside knowledge ROOT: ${relative}`);
    await ensureSafeParents(rootReal, relative, true);
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing to replace symlink: ${relative}`);
    } catch (error) { if (!isMissing(error)) throw error; }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.kimono-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  for (const relative of touched) {
    if (desired.has(relative)) continue;
    validateManagedPath(relative);
    const target = path.resolve(rootReal, ...relative.split('/'));
    if (!within(rootReal, target)) throw new Error(`Refusing to remove outside knowledge ROOT: ${relative}`);
    await ensureSafeParents(rootReal, relative, false);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing to remove non-file knowledge path: ${relative}`);
      await unlink(target);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
}

async function validateRootForPublication(root: string): Promise<string> {
  const absolute = path.resolve(root);
  if (absolute === path.parse(absolute).root || absolute === homedir()) throw new Error('Refusing to publish a remote into a filesystem or home root');
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('AIKIDO_ROOT must be a real directory for safe remote publication');
  return realpath(absolute);
}

async function ensureSafeParents(root: string, relative: string, create: boolean): Promise<void> {
  let current = root;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe symlink or non-directory parent: ${relative}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function collectIgnoreFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (directory: string, relative: string) => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const child of children) {
      const file = relative ? `${relative}/${child.name}` : child.name;
      if (child.isSymbolicLink() || isSensitiveKnowledgePath(file)) continue;
      if (child.isDirectory()) {
        if (['.git', 'node_modules', '.cache', 'secrets', 'credentials', '.ssh'].includes(child.name)) continue;
        await walk(path.join(directory, child.name), file);
      } else if (child.isFile() && child.name === '.gitignore') {
        const content = await readFile(path.join(directory, child.name), 'utf8');
        if (Buffer.byteLength(content) <= 64 * 1024) result.set(file, content);
      }
    }
  };
  await walk(root, '');
  return result;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  const walk = async (directory: string, relative: string) => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const sourcePath = path.join(directory, child.name);
      const file = relative ? `${relative}/${child.name}` : child.name;
      if (child.isSymbolicLink() || isSensitiveKnowledgePath(file)) continue;
      if (child.isDirectory()) {
        await mkdir(path.join(destination, ...file.split('/')), { recursive: true, mode: 0o700 });
        await walk(sourcePath, file);
      } else if (child.isFile()) {
        const target = path.join(destination, ...file.split('/'));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, await readFile(sourcePath), { mode: 0o600, flag: 'wx' });
      }
    }
  };
  await walk(source, '');
}

async function hashKnowledge(knowledge: AikidoKnowledgeBase): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of knowledge.list().filter(entry => isKnowledgeFile(entry.path) && !entry.metadata)) {
    const { content } = await knowledge.read(entry.path);
    result[entry.path] = hash(content);
  }
  return result;
}

export async function remoteSyncChanges(knowledge: AikidoKnowledgeBase): Promise<{
  available: boolean;
  changes: Array<{ path: string; kind: 'addition' | 'modification' | 'deletion'; localHash: string | null; syncedHash: string | null }>;
}> {
  const cacheRoot = knowledge.searchIndex.directory;
  const manifestPath = path.join(cacheRoot, 'project-remote-files.json');
  try { await readFile(manifestPath); }
  catch (error) {
    if (isMissing(error)) return { available: false, changes: [] };
    throw error;
  }
  const synced = await readRemoteFileManifest(cacheRoot);
  await knowledge.refresh();
  const current: Record<string, string> = {};
  for (const entry of knowledge.list().filter(entry => isKnowledgeFile(entry.path) && !entry.metadata)) {
    const { content } = await knowledge.read(entry.path);
    current[entry.path] = hash(content);
  }
  const changes: Array<{ path: string; kind: 'addition' | 'modification' | 'deletion'; localHash: string | null; syncedHash: string | null }> = [];
  const paths = new Set([...Object.keys(current), ...Object.keys(synced)]);
  for (const file of [...paths].sort((a, b) => a.localeCompare(b))) {
    const localHash = current[file] ?? null;
    const syncedHash = synced[file] ?? null;
    if (localHash === syncedHash) continue;
    changes.push({
      path: file,
      kind: syncedHash === null ? 'addition' : localHash === null ? 'deletion' : 'modification',
      localHash,
      syncedHash,
    });
  }
  return { available: true, changes };
}

async function readRemoteFileManifest(cacheRoot: string): Promise<Record<string, string>> {
  return readJsonMap(path.join(cacheRoot, 'project-remote-files.json'));
}

async function readJsonMap(file: string): Promise<Record<string, string>> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(value) || !Object.entries(value).every(([key, hashValue]) =>
      safeArchivePath(key) === key && typeof hashValue === 'string' && /^[a-f0-9]{64}$/.test(hashValue))) {
      throw new Error(`Invalid sync manifest: ${path.basename(file)}`);
    }
    return value as Record<string, string>;
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function writeRemoteFileManifest(cacheRoot: string, files: Record<string, string>): Promise<void> {
  await writeAtomic(path.join(cacheRoot, 'project-remote-files.json'), Buffer.from(JSON.stringify(files)));
}

async function writeAtomic(target: string, content: Buffer): Promise<void> {
  const temporary = `${target}.${randomUUID()}.pending`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

function safeArchivePath(value: string): string | undefined {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return undefined;
  const normalized = path.posix.normalize(value).replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.split('/').some(part => part === '..' || part === '.')) return undefined;
  return normalized;
}

function validateManagedPath(value: string): void {
  if (safeArchivePath(value) !== value || value.startsWith('.git/')) throw new Error(`Unsafe managed knowledge path: ${value}`);
}

function verifyTarChecksum(header: Buffer): void {
  const expected = parseOctal(field(header, 148, 8));
  let checksum = 0;
  for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
  if (checksum !== expected) throw new Error('Remote archive entry has an invalid checksum');
}

function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function parseOctal(value: string): number {
  const trimmed = value.replace(/\0.*$/, '').trim();
  if (!trimmed) return 0;
  if (!/^[0-7]+$/.test(trimmed)) throw new Error('Remote archive has an invalid numeric field');
  const parsed = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error('Remote archive numeric field exceeds limits');
  return parsed;
}

function paxPath(content: Buffer): string | undefined {
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    if (space < 0) throw new Error('Remote archive has malformed extended metadata');
    const lengthText = content.subarray(offset, space).toString('ascii');
    if (!/^\d+$/.test(lengthText)) throw new Error('Remote archive has malformed extended metadata length');
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > content.length) {
      throw new Error('Remote archive extended metadata exceeds bounds');
    }
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator > 0 && record.slice(0, separator) === 'path') return record.slice(separator + 1);
    offset += length;
  }
  return undefined;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortedManifest(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
