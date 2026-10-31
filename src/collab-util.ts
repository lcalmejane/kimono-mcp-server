import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isKnowledgeFile, isSensitiveKnowledgePath } from './knowledge.js';

/** Shared limits and helpers for collaboration revisions and per-user overlays. */
export const MAX_FILES = 2_000;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.ssh', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__',
  '.next', '.nuxt', '.cache', '.nyc_output', 'temp', 'credentials', 'secrets',
]);

export function validatePath(file: unknown): string {
  if (typeof file !== 'string' || !file || Buffer.byteLength(file) > 1024 || file.startsWith('/')
    || /^[a-z]:/i.test(file) || file.includes('\\') || /[\u0000-\u001f\u007f]/.test(file)
    || file.split('/').some(part => !part || part === '.' || part === '..' || EXCLUDED_DIRECTORIES.has(part.toLowerCase()))
    || (process.env.AIKIDO_INCLUDE_SPEC !== 'true' && (file === 'spec' || file.startsWith('spec/') || file === 'prompts/spec' || file.startsWith('prompts/spec/')))
    || path.posix.normalize(file) !== file || !isKnowledgeFile(file) || isSensitiveKnowledgePath(file)) {
    throw new Error(`Unsafe or ineligible relative knowledge path: ${String(file)}`);
  }
  return file;
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function writeAtomic(target: string, content: Buffer): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const pending = `${target}.${randomUUID()}.pending`;
  try {
    await writeFile(pending, content, { mode: 0o600, flag: 'wx' });
    await rename(pending, target);
  } finally {
    await rm(pending, { force: true });
  }
}
