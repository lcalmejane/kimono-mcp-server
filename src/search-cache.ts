import type { AikidoKnowledgeBase, SearchMatch } from './knowledge.js';

export interface SearchResult {
  results: Array<SearchMatch & { score?: number }>;
  metadata: Record<string, unknown>;
}

export class SearchCache {
  private readonly entries = new Map<string, { promise: Promise<SearchResult>; bytes: number }>();
  private bytes = 0;
  private closed = false;

  constructor(private readonly maxEntries = 128, private readonly maxBytes = 8 * 1024 * 1024) {}

  async search(key: string, compute: () => Promise<SearchResult>): Promise<SearchResult> {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      return structuredClone(await existing.promise);
    }
    this.evict(Buffer.byteLength(key));
    if (this.closed || this.entries.size >= this.maxEntries || this.bytes + Buffer.byteLength(key) > this.maxBytes) {
      return compute();
    }
    const entry = { promise: Promise.resolve().then(compute), bytes: Buffer.byteLength(key) };
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    try {
      const result = await entry.promise;
      if (this.closed || this.entries.get(key) !== entry) return result;
      if (result.metadata.status !== undefined && result.metadata.status !== 'ok') {
        this.remove(key);
      } else {
        const bytes = Buffer.byteLength(JSON.stringify(result));
        this.bytes += bytes;
        entry.bytes += bytes;
        this.evict(0);
      }
      return structuredClone(result);
    } catch (error) {
      if (this.entries.get(key) === entry) this.remove(key);
      throw error;
    }
  }

  clear(): void {
    this.closed = true;
    this.entries.clear();
    this.bytes = 0;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
    }
  }

  private evict(reserve: number): void {
    for (const [key, entry] of this.entries) {
      if (this.bytes + reserve <= this.maxBytes && (reserve === 0 || this.entries.size < this.maxEntries)) break;
      // Pending computations are kept for single-flight deduplication.
      if (entry.bytes > Buffer.byteLength(key)) this.remove(key);
    }
  }
}

const caches = new WeakMap<AikidoKnowledgeBase, SearchCache>();

export function searchCacheFor(knowledge: AikidoKnowledgeBase): SearchCache {
  let cache = caches.get(knowledge);
  if (!cache) {
    cache = new SearchCache();
    caches.set(knowledge, cache);
  }
  return cache;
}

export function clearSearchCache(knowledge: AikidoKnowledgeBase): void {
  caches.get(knowledge)?.clear();
  caches.delete(knowledge);
}
