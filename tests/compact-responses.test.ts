import { describe, expect, it } from 'vitest';
import { compactInfos, compactModels, INFOS_LIST_LIMIT } from '../src/runtime-tools.js';

const files = (count: number) => Array.from({ length: count }, (_, index) => `doc-${index}.md`);

describe('compact Kimono responses (KM1–KM4)', () => {
  const infos = {
    repository: { available: true, dirtyFiles: files(30).map(path => ({ path, status: ' M' })) },
    repositories: [{ path: 'sub', dirtyFiles: [{ path: 'sub/a.md', status: '??' }] }],
    indexes: {
      literal: { freshness: 'fresh', basis: { basisFingerprint: 'abc', documentFingerprints: Object.fromEntries(files(500).map(path => [path, 'f'])), dirtyPaths: files(25) } },
      semantic: { freshness: 'unknown', basis: null },
    },
  };

  it('summarizes fingerprints by basisFingerprint and bounds dirty lists', () => {
    const compact = compactInfos(infos) as any;
    const basis = compact.indexes.literal.basis;
    expect(basis.documentFingerprints).toBeUndefined();
    expect(basis).toMatchObject({ basisFingerprint: 'abc', documentCount: 500, dirtyPathCount: 25, dirtyPathsTruncated: true });
    expect(basis.dirtyPaths).toHaveLength(INFOS_LIST_LIMIT);
    expect(compact.repository).toMatchObject({ dirtyFileCount: 30, dirtyFilesTruncated: true });
    expect(compact.repository.dirtyFiles).toHaveLength(INFOS_LIST_LIMIT);
    expect(compact.repositories[0]).toMatchObject({ dirtyFileCount: 1 });
    expect(compact.repositories[0].dirtyFilesTruncated).toBeUndefined();
    expect(compact.indexes.semantic.basis).toBeNull();
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(infos).length / 5);
  });

  it('returns the full response with detail', () => {
    expect(compactInfos(infos, true)).toBe(infos);
  });

  it('keeps only the required models without detail', () => {
    const status = { requiredModels: ['code'], models: [{ id: 'code', installed: true, size: 1, label: 'Code' }, { id: 'other', installed: false }] };
    expect(compactModels(status)).toMatchObject({ models: [{ id: 'code', installed: true }], catalogueSize: 2, detail: false });
    expect(compactModels(status, true)).toBe(status);
  });
});

describe('general tool listing (KM6)', () => {
  it('hides the general aikido tool on option and keeps it by default', async () => {
    const { listedTools } = await import('../src/server.js');
    expect(listedTools().map(tool => tool.name)).toContain('aikido');
    const hidden = listedTools({ generalTool: false });
    expect(hidden.map(tool => tool.name)).not.toContain('aikido');
    const saved = JSON.stringify(listedTools()).length - JSON.stringify(hidden).length;
    expect(saved).toBeGreaterThan(1000);
    console.log(`KM6: hiding the general tool saves ${saved} bytes of schema`);
  });
});
