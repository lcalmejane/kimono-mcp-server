import path from 'node:path';
import { validateBranch, validateGitUrl } from './project-policy.js';

/**
 * A Git repository declared inside ROOT. `path` is ROOT-relative ('' is ROOT
 * itself). A declared nested repository is indexed under its own ignore rules
 * even when the parent repository ignores it (independent Git repositories).
 */
export interface DeclaredRepository {
  path: string;
  name: string;
  gitUrl?: string;
  branch?: string | null;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_REPOSITORIES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePath(value: unknown): string {
  if (value === undefined || value === '' || value === '.') return '';
  if (typeof value !== 'string' || value.length > 512 || /[\\\0\r\n:*?[\]{}]/.test(value)) {
    throw new Error('repositories[].path must be a ROOT-relative directory');
  }
  const normalized = value.replace(/\/+$/, '');
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('repositories[].path must be a ROOT-relative directory without traversal');
  }
  return normalized;
}

/** Validates and normalizes a `repositories` declaration (corpus config or project policy). */
export function parseRepositories(input: unknown): DeclaredRepository[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_REPOSITORIES) {
    throw new Error(`repositories must be an array of up to ${MAX_REPOSITORIES} objects`);
  }
  const result: DeclaredRepository[] = [];
  const paths = new Set<string>();
  const names = new Set<string>();
  for (const item of input) {
    if (!isRecord(item)) throw new Error('repositories[] entries must be objects');
    for (const key of Object.keys(item)) {
      if (!['path', 'name', 'gitUrl', 'branch'].includes(key)) throw new Error(`Unknown repositories[] option: ${key}`);
    }
    const repositoryPath = validatePath(item.path);
    const name = item.name === undefined
      ? (repositoryPath ? path.posix.basename(repositoryPath) : 'root')
      : item.name;
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('repositories[].name must be 1-128 chars [A-Za-z0-9._-]');
    if (paths.has(repositoryPath)) throw new Error(`Duplicate repository path: ${repositoryPath || '(root)'}`);
    if (names.has(name)) throw new Error(`Duplicate repository name: ${name}`);
    paths.add(repositoryPath);
    names.add(name);
    const repository: DeclaredRepository = { path: repositoryPath, name };
    if (item.gitUrl !== undefined && item.gitUrl !== null) repository.gitUrl = validateGitUrl(item.gitUrl);
    if (item.branch !== undefined) repository.branch = validateBranch(item.branch);
    result.push(Object.freeze(repository));
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Declared nested repositories (ROOT itself excluded). */
export function nestedRepositories(repositories: readonly DeclaredRepository[]): DeclaredRepository[] {
  return repositories.filter(repository => repository.path !== '');
}

/** True when `relativePath` is exactly a declared nested repository directory. */
export function isRepositoryRoot(relativePath: string, repositories: readonly DeclaredRepository[]): boolean {
  return repositories.some(repository => repository.path !== '' && repository.path === relativePath);
}

/** The innermost declared repository containing `relativePath` ('' = ROOT). */
export function repositoryOf(relativePath: string, repositories: readonly DeclaredRepository[]): string {
  let best = '';
  for (const repository of repositories) {
    if (repository.path && (relativePath === repository.path || relativePath.startsWith(`${repository.path}/`))
      && repository.path.length > best.length) best = repository.path;
  }
  return best;
}

/** Resolves a repository selector (name or path) to its declaration. ROOT is always selectable as 'root' or ''. */
export function resolveRepository(selector: unknown, repositories: readonly DeclaredRepository[]): DeclaredRepository {
  if (selector === undefined || selector === null || selector === '' || selector === '.') {
    return repositories.find(repository => repository.path === '') ?? { path: '', name: 'root' };
  }
  if (typeof selector !== 'string') throw new Error('repository must be a declared repository name or path');
  const normalized = selector.replace(/\/+$/, '');
  const found = repositories.find(repository => repository.name === normalized || repository.path === normalized);
  if (found) return found;
  if (normalized === 'root') return { path: '', name: 'root' };
  throw new Error(`Unknown repository: ${selector}. Declare it in "repositories".`);
}

/** Path filter for one repository: inside its directory, outside its nested declared repositories. */
export function inRepository(relativePath: string, repository: DeclaredRepository,
  repositories: readonly DeclaredRepository[]): boolean {
  return repositoryOf(relativePath, repositories) === repository.path;
}

/**
 * Union of repositories declared in the corpus config and the project policy.
 * The corpus config wins on a shared path; the policy's legacy single `gitUrl`
 * describes ROOT when no ROOT entry is declared.
 */
export function declaredRepositories(config: { repositories: readonly DeclaredRepository[] },
  policy?: { repositories?: readonly DeclaredRepository[]; gitUrl?: string | null } | null): DeclaredRepository[] {
  const byPath = new Map<string, DeclaredRepository>();
  for (const repository of policy?.repositories ?? []) byPath.set(repository.path, repository);
  for (const repository of config.repositories) byPath.set(repository.path, repository);
  if (!byPath.has('') && policy?.gitUrl) byPath.set('', { path: '', name: 'root', gitUrl: policy.gitUrl });
  const names = new Set<string>();
  for (const repository of byPath.values()) {
    if (names.has(repository.name)) throw new Error(`Duplicate repository name: ${repository.name}`);
    names.add(repository.name);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
