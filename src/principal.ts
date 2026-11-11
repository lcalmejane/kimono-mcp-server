import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Authenticated user behind a trusted proxy (Tatami): one Kimono instance serves a project for many users, and research
 * snapshots are shared per user. Distinct from `owner`, which selects a staged overlay to merge.
 */
const principals = new AsyncLocalStorage<string | undefined>();
const PRINCIPAL = /^[A-Za-z0-9_.@:-]{1,128}$/;

export function parsePrincipalHeader(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PRINCIPAL.test(value)) throw new Error('Invalid trusted principal');
  return value;
}
export function withPrincipal<T>(principal: string | undefined, action: () => T): T {
  return principals.run(principal, action);
}
export function currentPrincipal(): string | undefined {
  return principals.getStore();
}
