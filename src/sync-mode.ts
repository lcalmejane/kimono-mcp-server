import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * How the MCP client's workspace relates to the knowledge ROOT this server indexes.
 * - same-root: the client edits the exact ROOT, so files are already synchronized (never stage/publish them).
 * - replica: the MCP repository differs from the client's local one (shared repo, remote server, other mount).
 */
export type SyncMode = 'same-root' | 'replica';

export interface SyncModeResult {
  mode: SyncMode;
  /** True only when the server itself proved the decision (same directory identity, or an explicit operator override). */
  verified: boolean;
  reason: string;
}

export interface SyncModeOptions {
  /** The knowledge ROOT indexed by this server. */
  root: string;
  /** MCP transport; anything but embedded stdio can never be assumed to share a directory. */
  transport?: string;
  /** Absolute path of the client's workspace, as seen from this server's filesystem. */
  clientRoot?: string;
  /** Operator override, normally KIMONO_SYNC_MODE. */
  override?: string;
}

export async function detectSyncMode(options: SyncModeOptions): Promise<SyncModeResult> {
  const override = options.override ?? process.env.KIMONO_SYNC_MODE;
  if (override !== undefined && override !== '') {
    if (override !== 'same-root' && override !== 'replica') throw new Error('KIMONO_SYNC_MODE must be same-root or replica');
    return { mode: override, verified: true, reason: 'Explicit operator override (KIMONO_SYNC_MODE).' };
  }
  if (options.clientRoot !== undefined) {
    if (typeof options.clientRoot !== 'string' || !path.isAbsolute(options.clientRoot) || options.clientRoot.includes('\0')) {
      throw new Error('clientRoot must be an absolute path');
    }
    return (await sameDirectory(options.root, options.clientRoot))
      ? { mode: 'same-root', verified: true, reason: 'The client workspace is the exact ROOT (same directory identity); files are already synchronized.' }
      : { mode: 'replica', verified: true, reason: 'The client workspace is not this ROOT (different or invisible directory); use the per-user overlay.' };
  }
  if ((options.transport ?? 'stdio') === 'stdio') {
    return { mode: 'same-root', verified: false,
      reason: 'Embedded stdio is assumed to edit this ROOT; pass clientRoot to verify, or set KIMONO_SYNC_MODE=replica.' };
  }
  return { mode: 'replica', verified: false,
    reason: 'Remote or HTTP endpoints never share a directory by inference; pass clientRoot to verify.' };
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([realpath(left), realpath(right)]);
    if (a === b) return true;
    const [first, second] = await Promise.all([stat(a), stat(b)]);
    return first.isDirectory() && second.isDirectory() && first.dev === second.dev && first.ino === second.ino && first.ino !== 0;
  } catch {
    return false;
  }
}
