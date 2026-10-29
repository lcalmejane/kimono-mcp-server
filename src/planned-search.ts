import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { AikidoKnowledgeBase, KnowledgeEntry, KnowledgeKind, SearchMatch } from './knowledge.js';
import { identifierTerms, lexicalPattern, normalize, type QueryPlan } from './query-plan.js';

type RankedHit = SearchMatch & { score: number; matchedTerms?: string[]; sources?: string[];
  ranks?: Record<string, number>; sourceScores?: Record<string, number>;
  scoreDetails?: { coverage: number; aliases: number; definitions: number; phrase: number; title: number; heading: number;
    identifier?: number; symbolDefinition?: number; symbolPath?: number; coherence?: number; noise?: number;
    documentMultiplier?: number } };
type Branch = { mode: string; status: 'ok' | 'not-ready' | 'error'; ms: number; engine: string;
  results: RankedHit[]; error?: string; index?: unknown; model?: string; candidatesTruncated?: boolean;
  chunks?: number; embedded?: number; changes?: unknown; candidates?: number };
const round = (value: number) => Math.round(value * 10000) / 10000;
const codeFile = /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|scala|sh|swift|ts|tsx|vue)$/i;

function codeNoisePenalty(file: string, excerpt: string, plan: QueryPlan): number {
  const requestedNoise = [...plan.terms, ...identifierTerms(plan.original)]
    .some(term => /^(?:test|tests|spec|specs|example|examples|fixture|fixtures)$/.test(term));
  if (requestedNoise) return 0;
  if (/(?:^|\/)(?:__tests__|tests?|specs?|examples?|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file)) {
    return -0.25;
  }
  if (/(?:^|\/)generated(?:\/|$)|\.generated\.[^.]+$/i.test(file)) return -0.2;
  const basename = path.posix.basename(file);
  if (/^index\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|mjs|php|py|rb|rs|scala|sh|swift|ts|tsx|vue)$/i.test(basename)
    && excerpt.split('\n').filter(line => line.trim()).every(line => /^\s*(?:export|import|from|use)\b/.test(line))) {
    return -0.12;
  }
  return 0;
}

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
        coverage: plan.terms.filter(term => contains(text, term))
          .reduce((sum, term) => sum + weights.get(term)!, 0) / totalWeight,
      }]));
      const pathBoost = plan.intent === 'path' ? 0.85 : 0.6;
      const folderBoost = plan.intent === 'path' ? 0.35 : 0.2;
      const ranked: RankedHit[] = candidates.matches.flatMap(hit => {
        const text = ` ${normalize(hit.excerpt)} `;
        const code = codeFile.test(hit.path);
        const queryIdentifiers = code && (plan.intent !== 'natural-language'
          || /[a-z][A-Z]|[A-Z]{2,}[a-z]|[A-Za-z]_[A-Za-z]/.test(plan.original))
          ? [...identifierTerms(plan.original)] : [];
        const excerptIdentifiers = code ? identifierTerms(hit.excerpt) : new Set<string>();
        const coveredTerms = plan.terms.filter(term => text.includes(` ${term} `));
        const matchedTerms = [...new Set([
          ...coveredTerms,
          ...queryIdentifiers.filter(term => excerptIdentifiers.has(term)),
        ])];
        const expanded = plan.expansions.filter(item => text.includes(` ${item.term} `));
        if (!matchedTerms.length && !expanded.some(item => item.relation === 'alias')) return [];
        const identifier = queryIdentifiers.length
          ? round((plan.intent === 'natural-language' ? 0.12 : 0.3)
            * queryIdentifiers.filter(term => excerptIdentifiers.has(term)).length / queryIdentifiers.length) : 0;
        const symbolDefinition = code && identifier > 0
          && /^\s*(?:(?:export|pub|async|static|public|private|protected|default)\s+)*(?:function|class|interface|type|struct|enum|trait|def|fn|func)\s+[\w$]+/mi.test(hit.excerpt)
          ? plan.intent === 'natural-language' ? 0.12 : 0.2 : 0;
        const fileIdentifiers = code ? identifierTerms(path.posix.basename(hit.path)) : new Set<string>();
        const symbolPath = queryIdentifiers.length && queryIdentifiers.some(term => fileIdentifiers.has(term))
          ? plan.intent === 'natural-language' ? 0.08 : 0.18 : 0;
        const documentCoverage = perDocument.get(hit.path)!.coverage;
        const passageCoverage = coveredTerms.reduce((sum, term) => sum + weights.get(term)!, 0) / totalWeight;
        const scoreDetails = {
          coverage: round(passageCoverage),
          aliases: expanded.some(item => item.relation === 'alias') ? 0.35 : 0,
          definitions: expanded.some(item => item.relation === 'definition') ? 0.1 : 0,
          phrase: plan.normalized && text.includes(` ${plan.normalized} `) ? 0.4 : 0,
          // Search-plan style document evidence: query terms spread over several lines of the same document.
          document: round(0.5 * documentCoverage),
          coherence: code ? round(0.15 * Math.max(0, documentCoverage - passageCoverage)) : 0,
          noise: code ? codeNoisePenalty(hit.path, hit.excerpt, plan) : 0,
          title: round(0.25 * plan.terms.filter(term => contains(normalize(hit.title), term)).length / Math.max(1, plan.terms.length)),
          path: round((pathBoost * pathWeight(hit.path, 'file') + folderBoost * pathWeight(hit.path, 'folder')) / totalWeight),
          heading: /^\s{0,3}#{1,6}\s/.test(hit.excerpt) ? 0.15 : 0,
          identifier, symbolDefinition, symbolPath,
        };
        return [{ ...hit, score: round(Math.max(0, Object.values(scoreDetails).reduce((sum, value) => sum + value, 0))),
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
  if (!successful.length) throw new Error(branches.map(branch => `${branch.mode}: ${branch.error}`).join('; '));
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
    status: successful.length === branches.length ? 'ok' : 'partial',
    queryPlan: plan, queryIntent: plan.intent,
    ranking: mode === 'hybrid' ? 'passage reciprocal-rank-fusion k=60' : mode === 'text'
      ? 'document-frequency weighted whole-term coverage (passage + document) + cross-passage code coherence + bounded code-only test/generated/barrel noise penalties + file-name/path, project alias, phrase/title/heading boosts; repeated-document penalty 0.2'
      : 'cosine similarity',
    branches: branches.map(({ results: hits, ...branch }) => ({ ...branch, count: hits.length })),
  } };
}
