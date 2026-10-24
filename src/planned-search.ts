import { performance } from 'node:perf_hooks';
import type { AikidoKnowledgeBase, KnowledgeEntry, KnowledgeKind, SearchMatch } from './knowledge.js';
import { lexicalPattern, normalize, type QueryPlan } from './query-plan.js';

type RankedHit = SearchMatch & { score: number; matchedTerms?: string[]; sources?: string[];
  ranks?: Record<string, number>; sourceScores?: Record<string, number>;
  scoreDetails?: { coverage: number; aliases: number; definitions: number; phrase: number; title: number; heading: number;
    documentMultiplier?: number } };
type Branch = { mode: string; status: 'ok' | 'not-ready' | 'error'; ms: number; engine: string;
  results: RankedHit[]; error?: string; index?: unknown; model?: string; candidatesTruncated?: boolean;
  chunks?: number; embedded?: number; changes?: unknown; candidates?: number };
const round = (value: number) => Math.round(value * 10000) / 10000;

export async function plannedSearch(knowledge: AikidoKnowledgeBase, plan: QueryPlan, mode: 'text' | 'semantic' | 'hybrid',
  kind: KnowledgeKind | undefined, filter: (entry: KnowledgeEntry) => boolean, limit: number,
  semanticAvailability?: { error: string; index: unknown }) {
  const timed = async (branch: 'text' | 'semantic'): Promise<Branch> => {
    const started = performance.now();
    const engine = branch === 'text' ? 'fast-grep' : 'embsearch-core';
    try {
      if (branch === 'semantic' && semanticAvailability) {
        return { mode: branch, status: 'not-ready', ms: round(performance.now() - started), engine, results: [], ...semanticAvailability };
      }
      if (branch === 'semantic') {
        const result = await knowledge.semanticIndex.run('search', { query: plan.semanticQuery, kind,
          paths: knowledge.list(kind).filter(filter).map(entry => entry.path), limit });
        return { mode: branch, status: 'ok', ms: round(performance.now() - started), engine, model: result.model,
          chunks: result.chunks, embedded: result.embedded, changes: result.changes, results: result.results };
      }
      const pattern = lexicalPattern(plan);
      // Both fgr passes run concurrently; the exact-phrase pass is merged only when candidate caps were hit.
      const [candidates, exact] = await Promise.all([
        pattern ? knowledge.searchIndex.searchCandidates(pattern, kind, 4000, true, filter, 40)
          : Promise.resolve({ matches: [], truncated: false }),
        plan.terms.length > 1 ? knowledge.searchIndex.searchCandidates(
          lexicalPattern({ ...plan, terms: [plan.normalized], expansions: [] }), kind, 1000, true, filter, 10) : undefined,
      ]);
      const perFile = new Map<string, number>();
      for (const hit of candidates.matches) perFile.set(hit.path, (perFile.get(hit.path) ?? 0) + 1);
      // The exact-phrase pass only recovers lines lost to the global or per-file candidate caps.
      const capped = candidates.truncated || [...perFile.values()].some(count => count >= 40);
      if (exact && capped) {
        const unique = new Map([...exact.matches, ...candidates.matches].map(hit => [`${hit.path}:${hit.line}`, hit]));
        candidates.matches = [...unique.values()];
        candidates.truncated ||= exact.truncated;
      }
      const parts = new Map<string, string[]>();
      for (const hit of candidates.matches) {
        const text = normalize(hit.excerpt);
        parts.set(hit.path, [...(parts.get(hit.path) ?? [normalize(hit.title)]), text]);
      }
      const documents = new Map([...parts].map(([file, texts]) => [file, texts.join(' ')]));
      const contains = (text: string, term: string) => ` ${text} `.includes(` ${term} `);
      const weights = new Map(plan.terms.map(term => [term, 1 + Math.log((documents.size + 1)
        / (1 + [...documents.values()].filter(text => contains(text, term)).length))]));
      const totalWeight = [...weights.values()].reduce((sum, weight) => sum + weight, 0) || 1;
      const pathWeight = (file: string, part: 'file' | 'folder') => {
        const segments = file.split('/');
        const stem = segments.pop()!.replace(/\.[^.]+$/, '');
        const text = normalize((part === 'file' ? stem : segments.join(' ')).replace(/[-_.]+/g, ' '));
        return plan.terms.filter(term => contains(text, term)).reduce((sum, term) => sum + weights.get(term)!, 0);
      };
      const perDocument = new Map([...documents].map(([file, text]) => [file, {
        document: round(0.5 * plan.terms.filter(term => contains(text, term))
          .reduce((sum, term) => sum + weights.get(term)!, 0) / totalWeight),
        // Search plans rank file names first: weighted query terms found in the file stem, then in parent folders.
        path: round((0.6 * pathWeight(file, 'file') + 0.2 * pathWeight(file, 'folder')) / totalWeight),
      }]));
      const ranked: RankedHit[] = candidates.matches.flatMap(hit => {
        const text = ` ${normalize(hit.excerpt)} `;
        const matchedTerms = plan.terms.filter(term => text.includes(` ${term} `));
        const expanded = plan.expansions.filter(item => text.includes(` ${item.term} `));
        if (!matchedTerms.length && !expanded.some(item => item.relation === 'alias')) return [];
        const scoreDetails = {
          coverage: round(matchedTerms.reduce((sum, term) => sum + weights.get(term)!, 0) / totalWeight),
          aliases: expanded.some(item => item.relation === 'alias') ? 0.35 : 0,
          definitions: expanded.some(item => item.relation === 'definition') ? 0.1 : 0,
          phrase: plan.normalized && text.includes(` ${plan.normalized} `) ? 0.4 : 0,
          // Search-plan style document evidence: query terms spread over several lines of the same document.
          document: perDocument.get(hit.path)!.document,
          title: round(0.25 * plan.terms.filter(term => contains(normalize(hit.title), term)).length / Math.max(1, plan.terms.length)),
          path: perDocument.get(hit.path)!.path,
          heading: /^\s{0,3}#{1,6}\s/.test(hit.excerpt) ? 0.15 : 0,
        };
        return [{ ...hit, score: round(Object.values(scoreDetails).reduce((sum, value) => sum + value, 0)),
          scoreDetails, matchedTerms: [...matchedTerms, ...expanded.map(item => item.term)] }];
      }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
      // Diversify equal/repeated evidence without forbidding multiple useful passages.
      const results: RankedHit[] = [];
      const seen = new Map<string, number>();
      while (ranked.length && results.length < limit) {
        ranked.sort((a, b) => b.score / (1 + (seen.get(b.path) ?? 0) * 0.2)
          - a.score / (1 + (seen.get(a.path) ?? 0) * 0.2) || a.path.localeCompare(b.path) || a.line - b.line);
        const hit = ranked.shift()!;
        const multiplier = 1 / (1 + (seen.get(hit.path) ?? 0) * 0.2);
        results.push({ ...hit, score: round(hit.score * multiplier),
          scoreDetails: { ...hit.scoreDetails!, documentMultiplier: round(multiplier) } });
        seen.set(hit.path, (seen.get(hit.path) ?? 0) + 1);
      }
      return { mode: branch, status: 'ok', ms: round(performance.now() - started), engine, results,
        candidates: candidates.matches.length, candidatesTruncated: candidates.truncated };
    } catch (error) {
      return { mode: branch, status: 'error', ms: round(performance.now() - started), engine, results: [],
        error: error instanceof Error ? error.message : String(error) };
    }
  };
  const branches = await Promise.all((mode === 'hybrid' ? ['text', 'semantic'] as const : [mode]).map(timed));
  const successful = branches.filter(branch => branch.status === 'ok');
  const fused = new Map<string, RankedHit>();
  for (const branch of successful) {
    branch.results.forEach((hit, index) => {
      const key = `${hit.path}:${hit.line}`;
      const previous = fused.get(key);
      fused.set(key, { ...hit, score: round((previous?.score ?? 0) + 1 / (60 + index + 1)),
        sources: [...(previous?.sources ?? []), branch.mode], ranks: { ...previous?.ranks, [branch.mode]: index + 1 },
        sourceScores: { ...previous?.sourceScores, [branch.mode]: hit.score } });
    });
  }
  const results = mode === 'hybrid'
    ? [...fused.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit)
    : successful[0]?.results ?? [];
  return { results, metadata: {
    engine: mode === 'hybrid' ? 'hybrid' : branches[0].engine, model: branches.find(branch => branch.model)?.model,
    ...(mode === 'semantic' ? { chunks: branches[0].chunks, embedded: branches[0].embedded, changes: branches[0].changes } : {}),
    status: successful.length === branches.length ? 'ok' : successful.length ? 'partial' : branches[0].status,
    queryPlan: plan, ranking: mode === 'hybrid' ? 'passage reciprocal-rank-fusion k=60' : mode === 'text'
      ? 'document-frequency weighted whole-term coverage (passage + document) + file-name/path boost + bounded project aliases + phrase/title/heading boosts; repeated-document penalty 0.2' : 'cosine similarity',
    branches: branches.map(({ results: hits, ...branch }) => ({ ...branch, count: hits.length })),
    ...(successful.length ? {} : { error: branches.map(branch => branch.error).filter(Boolean).join('; ') }),
  } };
}
