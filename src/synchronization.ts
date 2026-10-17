import path from 'node:path';

export interface ChangeReport {
  added: string[];
  modified: string[];
  deleted: string[];
}

export function within(file: string, scopes?: string[]): boolean {
  return !scopes || scopes.some(scope => file === scope || file.startsWith(`${scope}/`));
}

export function synchronizationPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') value = [value];
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error('paths must contain 1-256 ROOT-relative file or directory paths');
  }
  const normalized = value.map((item: unknown) => {
    if (typeof item !== 'string' || !item || /[\\\0\r\n]/.test(item) || path.posix.isAbsolute(item)
      || item.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('paths must be safe ROOT-relative paths without traversal');
    }
    const result = item.replace(/\/+$/, '');
    if (!result || result.split('/').some(part => !part)) throw new Error('Invalid synchronization path');
    return result;
  }).sort();
  return [...new Set(normalized)].filter(file => !normalized.some(parent => parent !== file && file.startsWith(`${parent}/`)));
}
