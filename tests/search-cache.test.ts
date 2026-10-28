import { describe, expect, it, vi } from 'vitest';
import { SearchCache, type SearchResult } from '../src/search-cache.js';

const result = (): SearchResult => ({ results: [], metadata: { engine: 'test', status: 'ok' } });

describe('snapshot search cache', () => {
  it('deduplicates in-flight searches and returns isolated result copies', async () => {
    const cache = new SearchCache();
    let finish!: (value: SearchResult) => void;
    const compute = vi.fn(() => new Promise<SearchResult>(resolve => { finish = resolve; }));
    const first = cache.search('same', compute);
    const second = cache.search('same', compute);
    await Promise.resolve();
    expect(compute).toHaveBeenCalledTimes(1);
    finish(result());
    const [one, two] = await Promise.all([first, second]);
    one.metadata.engine = 'changed';
    expect(two.metadata.engine).toBe('test');
    expect((await cache.search('same', compute)).metadata.engine).toBe('test');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not retain failures or partial/not-ready responses', async () => {
    const cache = new SearchCache();
    const fail = vi.fn(async () => { throw new Error('failed'); });
    await expect(cache.search('error', fail)).rejects.toThrow('failed');
    await expect(cache.search('error', fail)).rejects.toThrow('failed');
    expect(fail).toHaveBeenCalledTimes(2);
    for (const status of ['partial', 'not-ready', 'error']) {
      const compute = vi.fn(async () => ({ ...result(), metadata: { status } }));
      await cache.search(status, compute);
      await cache.search(status, compute);
      expect(compute).toHaveBeenCalledTimes(2);
    }
  });

  it('bounds entries using LRU eviction and limits cached bytes', async () => {
    const cache = new SearchCache(2, 1024);
    const compute = vi.fn(async () => result());
    for (const key of ['a', 'b', 'a', 'c', 'a']) await cache.search(key, compute);
    expect(compute).toHaveBeenCalledTimes(3);
    await cache.search('b', compute);
    expect(compute).toHaveBeenCalledTimes(4);
    const oversized = vi.fn(async () => ({ ...result(), metadata: { text: 'x'.repeat(2048) } }));
    await cache.search('large', oversized);
    await cache.search('large', oversized);
    expect(oversized).toHaveBeenCalledTimes(2);
    const tiny = new SearchCache(128, 1);
    await tiny.search('long-key', compute);
    await tiny.search('long-key', compute);
    expect(compute).toHaveBeenCalledTimes(6);
  });

  it('does not repopulate after disposal even when work is in flight', async () => {
    const cache = new SearchCache();
    let finish!: (value: SearchResult) => void;
    const pending = cache.search('a', () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.clear();
    finish(result());
    await pending;
    const compute = vi.fn(async () => result());
    await cache.search('a', compute);
    await cache.search('a', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct keys and snapshot instances isolated', async () => {
    const first = new SearchCache(), second = new SearchCache();
    const compute = vi.fn(async () => result());
    await first.search('one', compute);
    await first.search('two', compute);
    await second.search('one', compute);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('keeps pending computations deduplicated when capacity is full', async () => {
    const cache = new SearchCache(1, 1024);
    let finish!: (value: SearchResult) => void;
    const compute = vi.fn(() => new Promise<SearchResult>(resolve => { finish = resolve; }));
    const first = cache.search('pending', compute);
    await Promise.resolve();
    const uncached = vi.fn(async () => result());
    await cache.search('other', uncached);
    await cache.search('other', uncached);
    const second = cache.search('pending', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(uncached).toHaveBeenCalledTimes(2);
    finish(result());
    await Promise.all([first, second]);
  });
});
