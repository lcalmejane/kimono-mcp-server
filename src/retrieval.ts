import path from 'node:path';
import { AikidoKnowledgeBase, fileId, type KnowledgeEntry, type SearchMatch } from './knowledge.js';

export const RETRIEVAL_PROPERTIES = {
  pathPrefix: { type: 'string', description: 'Exact ROOT-relative file or directory subtree; not a glob.' },
  scope: { type: 'string', enum: ['all', 'memory', 'code'], default: 'all' },
  type: { type: 'string', enum: ['agent', 'concept', 'technique', 'use_case', 'hard_point', 'markdown', 'script', 'config', 'file'] },
  extension: { type: 'string', description: 'File extension without leading dot, e.g. md.' },
  maxBytes: { type: 'integer', minimum: 2048, maximum: 262144, default: 16384, description: 'Maximum UTF-8 bytes in the serialized JSON response; never a token estimate.' },
};
export const READ_PROPERTIES = {
  startLine: { type: 'integer', minimum: 1, description: 'Inclusive, 1-based. Default 1.' },
  endLine: { type: 'integer', minimum: 1, description: 'Inclusive. Default startLine + 199.' },
  section: { type: 'string', description: 'Exact Markdown heading title. Ambiguous duplicate titles are rejected; use outline and line ranges.' },
  full: { type: 'boolean', default: false, description: 'Explicit whole-file read; incompatible with ranges/section. Default byte budget becomes 16 MiB.' },
  maxBytes: { type: 'integer', minimum: 2048, maximum: 16777216, default: 16384 },
};

interface Passage {
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}
interface Heading {
  title: string;
  level: number;
  startLine: number;
  endLine: number;
}

export function integer(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function structureType(file: string): string {
  if (/\.(md|mdx|mdc)$/i.test(file)) {
    if (/(^|\/)(personas|agents)\//.test(file)) return 'agent';
    if (/(^|\/)concepts\//.test(file)) return 'concept';
    if (/(^|\/)techniques\//.test(file)) return 'technique';
    if (/(^|\/)use_cases\//.test(file)) return 'use_case';
    if (/(^|\/)hard_points\//.test(file)) return 'hard_point';
    return 'markdown';
  }
  if (file.endsWith('.sh')) return 'script';
  if (/\.(json|ya?ml|toml)$/i.test(file)) return 'config';
  return 'file';
}

export function selection(input: Record<string, unknown>, memoryRoot = false): (entry: KnowledgeEntry) => boolean {
  const prefix = optionalText(input, 'pathPrefix')?.replace(/\/$/, '');
  if (prefix !== undefined && (prefix.startsWith('/') || prefix.includes('\\') ||
    prefix.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('pathPrefix must be a ROOT-relative file or directory');
  const scope = input.scope ?? 'all';
  if (!['all', 'memory', 'code'].includes(String(scope))) throw new Error('scope must be all, memory or code');
  const type = optionalText(input, 'type');
  if (type && !['agent', 'concept', 'technique', 'use_case', 'hard_point', 'markdown', 'script', 'config', 'file'].includes(type)) throw new Error('Invalid structure type');
  const extension = optionalText(input, 'extension');
  if (extension && !/^[a-z0-9]+$/i.test(extension)) throw new Error('extension must omit the leading dot');
  return entry => {
    const memory = memoryRoot || entry.path.startsWith('prompts/') || entry.path === 'index.md';
    return (!prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`)) &&
      (scope === 'all' || (scope === 'memory' ? memory : !memory)) &&
      (!type || structureType(entry.path) === type) &&
      (!extension || path.posix.extname(entry.path).slice(1).toLowerCase() === extension.toLowerCase());
  };
}

export function documentLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

function header(lines: string[]): Passage {
  let end = 0;
  if (lines[0]?.replace(/\r$/, '') === '---') {
    const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\r?$/.test(line));
    end = close < 0 ? lines.length : close + 1;
  } else {
    while (end < lines.length && (!lines[end].trim() || /^(# |>\s)/.test(lines[end]))) end++;
  }
  const selected: string[] = [];
  for (const line of lines.slice(0, Math.min(end, 40))) {
    if (Buffer.byteLength([...selected, line].join('\n')) > 4096) break;
    selected.push(line);
  }
  return { startLine: selected.length ? 1 : 0, endLine: selected.length,
    content: selected.join('\n'), truncated: selected.length < end };
}

function headings(lines: string[], headerEnd: number): Heading[] {
  const result: Heading[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let index = headerEnd; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) result.push({ title: match[2].replace(/\s+#+\s*$/, ''), level: match[1].length, startLine: index + 1, endLine: lines.length });
    else if (index > headerEnd && /^ {0,3}(=+|-+)\s*$/.test(line) && lines[index - 1].trim()) {
      result.push({ title: lines[index - 1].trim(), level: line.trim()[0] === '=' ? 1 : 2, startLine: index, endLine: lines.length });
    }
  }
  for (let i = 0; i < result.length; i++) {
    const next = result.slice(i + 1).find(item => item.level <= result[i].level);
    if (next) result[i].endLine = next.startLine - 1;
  }
  return result;
}

type QueryPlanLike = { terms?: unknown; expansions?: Array<{ term: string; relation: string; concept: string; path: string; line: number }>; warnings?: unknown };

function compactMetadata(extra: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['engine', 'model', 'status', 'error', 'index']) if (extra[key] !== undefined) result[key] = extra[key];
  const plan = extra.queryPlan as QueryPlanLike | undefined;
  if (plan && typeof plan === 'object') {
    result.query = {
      terms: plan.terms,
      ...(plan.expansions?.length ? { expansions: plan.expansions.map(item => ({ term: item.term, concept: item.concept, relation: item.relation, source: `${item.path}:${item.line}` })) } : {}),
      ...(Array.isArray(plan.warnings) && plan.warnings.length ? { warnings: plan.warnings } : {}),
    };
  }
  if (Array.isArray(extra.branches) && extra.branches.length > 1 || (Array.isArray(extra.branches) && extra.branches.some(branch => (branch as Record<string, unknown>).status !== 'ok'))) {
    result.branches = (extra.branches as Array<Record<string, unknown>>).map(branch => ({ mode: branch.mode, status: branch.status,
      ms: typeof branch.ms === 'number' ? Math.round(branch.ms) : branch.ms, count: branch.count, ...(branch.error ? { error: branch.error } : {}) }));
  }
  return result;
}

export class Retrieval {
  constructor(private readonly knowledge: AikidoKnowledgeBase,
    private readonly responseMetadata: Record<string, unknown> = {}) {}

  private json(value: object, maxBytes?: number): string {
    const json = JSON.stringify({ ...value, ...this.responseMetadata });
    if (maxBytes !== undefined && Buffer.byteLength(json) > maxBytes) {
      throw new Error('Response exceeds maxBytes; increase the response budget');
    }
    return json;
  }

  private async document(id: string) {
    const { entry, content, modified } = await this.knowledge.read(id);
    if (content.includes('\0')) throw new Error(`Binary content is not readable: ${entry.path}`);
    const lines = documentLines(content);
    const head = header(lines);
    const frontmatterEnd = lines[0]?.replace(/\r$/, '') === '---'
      ? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\r?$/.test(line)) + 1 : 0;
    const outline = /\.(md|mdx|mdc)$/i.test(entry.path) ? headings(lines, frontmatterEnd || 0) : [];
    const check = /(^|\n)(?:last[-_]check):/.test(head.content);
    const metadata = {
      ...entry, file_id: fileId(entry.path), name: path.posix.basename(entry.path),
      type: structureType(entry.path), extension: path.posix.extname(entry.path).slice(1),
      size_bytes: Buffer.byteLength(content), lines: lines.length, modified,
      check_status: (!this.knowledge.isMemoryRoot && !entry.path.startsWith('prompts/')) || !/\.(md|mdx|mdc)$/i.test(entry.path) ? 'N/A'
        : check ? 'present' : head.truncated ? 'unknown-truncated-header' : frontmatterEnd ? 'no-lastcheck' : 'no-header',
      header: head,
    };
    return { metadata, outline, lines, content };
  }

  async list(input: Record<string, unknown>, kind?: KnowledgeEntry['kind']) {
    const limit = integer(input, 'limit', 25, 1, 100);
    const offset = integer(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = integer(input, 'maxBytes', 16384, 2048, 262144);
    const query = optionalText(input, 'query');
    await this.knowledge.refresh();
    const filter = selection(input, this.knowledge.isMemoryRoot);
    const entries = this.knowledge.list(kind, query).filter(filter);
    const output: { count: number; total: number; offset: number; nextOffset: number | null; truncated: boolean; entries: unknown[] } =
      { count: 0, total: entries.length, offset, nextOffset: null, truncated: false, entries: [] };
    for (const entry of entries.slice(offset, offset + limit)) {
      output.entries.push((await this.document(entry.path)).metadata);
      output.count = output.entries.length;
      output.nextOffset = offset + output.count < entries.length ? offset + output.count : null;
      output.truncated = output.nextOffset !== null;
      if (Buffer.byteLength(this.json(output)) > maxBytes) {
        output.entries.pop();
        output.count--;
        break;
      }
    }
    output.nextOffset = offset + output.count < entries.length ? offset + output.count : null;
    output.truncated = output.nextOffset !== null;
    if (!output.count && offset < entries.length) throw new Error('Metadata exceeds maxBytes; increase the response budget');
    return this.json(output, maxBytes);
  }

  async read(input: Record<string, unknown>, id: string): Promise<string> {
    const operation = input.operation ?? 'read';
    if (!['read', 'metadata', 'outline'].includes(String(operation))) throw new Error('Invalid retrieval operation');
    const full = input.full ?? false;
    if (typeof full !== 'boolean') throw new Error('full must be boolean');
    const section = optionalText(input, 'section');
    if ((section && (input.startLine !== undefined || input.endLine !== undefined)) ||
      (full && (section || input.startLine !== undefined || input.endLine !== undefined))) throw new Error('Choose full, section or a line range, not multiple selectors');
    const maxBytes = integer(input, 'maxBytes', full ? 16777216 : 16384, 2048, 16777216);
    await this.knowledge.refresh();
    const document = await this.document(id);
    if (operation === 'metadata') return this.json(document.metadata, maxBytes);
    if (operation === 'outline') {
      const offset = integer(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(input, 'limit', 25, 1, 100);
      const entries = document.outline.slice(offset, offset + limit);
      const result = { document: document.metadata, count: entries.length, total: document.outline.length,
        nextOffset: offset + entries.length < document.outline.length ? offset + entries.length : null, headings: entries };
      while (Buffer.byteLength(this.json(result)) > maxBytes && result.headings.length) {
        result.headings.pop(); result.count--;
        result.nextOffset = offset + result.count;
      }
      if (!result.count && offset < result.total) throw new Error('Outline metadata exceeds maxBytes; increase the response budget');
      return this.json(result, maxBytes);
    }
    let start = integer(input, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER);
    let end = integer(input, 'endLine', full ? Math.max(1, document.lines.length) : start + 199, start, Number.MAX_SAFE_INTEGER);
    if (section) {
      const matches = document.outline.filter(item => item.title === section);
      if (matches.length !== 1) throw new Error(`Section ${JSON.stringify(section)} ${matches.length ? 'is ambiguous; use outline and line ranges' : 'was not found'}`);
      start = matches[0].startLine; end = matches[0].endLine;
    }
    if (start > Math.max(1, document.lines.length)) throw new Error('startLine exceeds document length');
    end = Math.min(end, document.lines.length);
    const selected = document.lines.slice(start - 1, end);
    const result = { document: document.metadata, startLine: start, endLine: end, content: '',
      truncated: false, hasMore: end < document.lines.length, nextLine: end < document.lines.length ? end + 1 : null };
    while (true) {
      result.content = full && selected.length === document.lines.length ? document.content : selected.join('\n');
      result.endLine = selected.length ? start + selected.length - 1 : 0;
      result.truncated = result.endLine < end;
      result.hasMore = result.endLine < document.lines.length;
      result.nextLine = result.hasMore ? Math.max(start, result.endLine + 1) : null;
      if (Buffer.byteLength(this.json(result)) <= maxBytes) break;
      if (!selected.length) throw new Error('Document metadata exceeds maxBytes; increase the response budget');
      selected.pop();
      if (!selected.length) throw new Error('A document line exceeds maxBytes; increase the response budget');
    }
    return this.json(result, maxBytes);
  }

  async search(input: Record<string, unknown>, matches: Array<SearchMatch & { score?: number }>, extra: Record<string, unknown>): Promise<string> {
    const detail = input.detail ?? (input.contextLines !== undefined ? 'excerpts' : 'locations');
    if (detail !== 'locations' && detail !== 'excerpts') throw new Error('detail must be locations or excerpts');
    if (detail === 'locations') {
      if (input.contextLines !== undefined) throw new Error('contextLines requires detail=excerpts; use aikido_file ranges with contextLines');
      return this.locations(input, matches, extra);
    }
    return this.excerpts(input, matches, extra);
  }

  // Token-frugal default: where to look, not what is there. Passages are fetched afterwards in one aikido_file ranges batch.
  private async locations(input: Record<string, unknown>, matches: Array<SearchMatch & { score?: number; matchedTerms?: string[] }>, extra: Record<string, unknown>): Promise<string> {
    const limit = integer(input, 'limit', 25, 1, 100);
    const maxBytes = integer(input, 'maxBytes', 16384, 2048, 262144);
    const head = compactMetadata(extra);
    type Located = { path: string; lines: number; score?: number; hits: Array<number | [number, number]>; terms?: string[] };
    const files: Located[] = [];
    const byPath = new Map<string, Located>();
    const sizes = new Map<string, number>();
    let hits = 0, omitted = matches.length > limit;
    const output = () => ({ ...head, count: hits, files: files.length, truncated: omitted,
      results: files.map(file => ({ ...file, hits: [...file.hits].sort((a, b) => (Array.isArray(a) ? a[0] : a) - (Array.isArray(b) ? b[0] : b)) })) });
    for (const hit of matches) {
      if (hits >= limit) { omitted = true; break; }
      let total = sizes.get(hit.path);
      if (total === undefined) {
        const { content } = await this.knowledge.read(hit.path);
        total = documentLines(content).length;
        sizes.set(hit.path, total);
      }
      if (hit.line < 1 || hit.line > total) throw new Error('Search engine returned an invalid source line');
      const end = Math.min(total, hit.line + Math.max(1, documentLines(hit.excerpt).length) - 1);
      let file = byPath.get(hit.path);
      const created = !file;
      if (!file) {
        file = { path: hit.path, lines: total, ...(typeof hit.score === 'number' ? { score: Number(hit.score.toFixed(4)) } : {}), hits: [] };
        byPath.set(hit.path, file); files.push(file);
      }
      if (file.hits.some(item => Array.isArray(item) ? item[0] <= hit.line && item[1] >= end : item === hit.line && end === hit.line)) continue;
      const previousTerms = file.terms;
      file.hits.push(end > hit.line ? [hit.line, end] : hit.line);
      if (Array.isArray(hit.matchedTerms) && hit.matchedTerms.length) file.terms = [...new Set([...(file.terms ?? []), ...hit.matchedTerms])];
      hits++;
      if (Buffer.byteLength(this.json(output())) > maxBytes) {
        file.hits.pop(); file.terms = previousTerms; hits--; omitted = true;
        if (created) { files.pop(); byPath.delete(hit.path); }
        break;
      }
    }
    if (!hits && matches.length) throw new Error('Search metadata exceeds maxBytes; increase the response budget');
    return this.json(output(), maxBytes);
  }

  // Batched passage retrieval after a locations search: one call, merged per-file ranges, a single byte budget.
  async ranges(input: Record<string, unknown>): Promise<string> {
    const raw = input.ranges;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) throw new Error('ranges must contain 1-50 {path,startLine,endLine?} items');
    const context = integer(input, 'contextLines', 0, 0, 20);
    const maxBytes = integer(input, 'maxBytes', 16384, 2048, 262144);
    const requested = new Map<string, Array<[number, number]>>();
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each range must be an object');
      const range = item as Record<string, unknown>;
      const unknown = Object.keys(range).filter(key => !['path', 'startLine', 'endLine'].includes(key));
      if (unknown.length) throw new Error(`Unknown range field: ${unknown[0]}`);
      const file = optionalText(range, 'path');
      if (!file) throw new Error('Each range requires path');
      const start = integer(range, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER);
      const end = integer(range, 'endLine', start, start, Number.MAX_SAFE_INTEGER);
      requested.set(file, [...(requested.get(file) ?? []), [start, end]]);
    }
    await this.knowledge.refresh();
    const passages: Array<{ path: string; startLine: number; endLine: number; content: string }> = [];
    const errors: Array<{ path: string; error: string }> = [];
    const pending: Array<{ path: string; startLine: number; endLine: number }> = [];
    for (const [file, spans] of requested) {
      let lines: string[];
      try {
        const { entry, content } = await this.knowledge.read(file);
        if (content.includes('\0')) throw new Error(`Binary content is not readable: ${entry.path}`);
        lines = documentLines(content);
      } catch (error) {
        errors.push({ path: file, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const merged: Array<[number, number]> = [];
      for (const [start, end] of spans.map(([start, end]) => [Math.max(1, start - context), Math.min(lines.length, end + context)] as [number, number])
        .filter(([start, end]) => start <= end).sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);
        if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
      }
      if (!merged.length) errors.push({ path: file, error: 'startLine exceeds document length' });
      for (const [start, end] of merged) pending.push({ path: file, startLine: start, endLine: end });
      for (const range of merged) passages.push({ path: file, startLine: range[0], endLine: range[1], content: lines.slice(range[0] - 1, range[1]).join('\n') });
    }
    const output = (returned: typeof passages, remaining: typeof pending) => ({ count: returned.length, truncated: remaining.length > 0,
      passages: returned, ...(errors.length ? { errors } : {}), ...(remaining.length ? { remaining } : {}) });
    const returned: typeof passages = [];
    for (let index = 0; index < passages.length; index++) {
      const passage = passages[index];
      returned.push(passage);
      if (Buffer.byteLength(this.json(output(returned, pending.slice(index + 1)))) <= maxBytes) continue;
      const lines = passage.content.split('\n');
      while (lines.length > 1) {
        lines.pop();
        passage.content = lines.join('\n');
        passage.endLine = passage.startLine + lines.length - 1;
        const rest = [{ path: passage.path, startLine: passage.endLine + 1, endLine: pending[index].endLine }, ...pending.slice(index + 1)];
        if (Buffer.byteLength(this.json(output(returned, rest))) <= maxBytes) return this.json(output(returned, rest), maxBytes);
      }
      returned.pop();
      if (!returned.length) throw new Error('A requested line exceeds maxBytes; increase the response budget');
      return this.json(output(returned, pending.slice(index)), maxBytes);
    }
    return this.json(output(returned, []), maxBytes);
  }

  private async excerpts(input: Record<string, unknown>, matches: Array<SearchMatch & { score?: number }>, extra: Record<string, unknown>): Promise<string> {
    const limit = integer(input, 'limit', 25, 1, 100);
    const context = integer(input, 'contextLines', 2, 0, 20);
    const maxBytes = integer(input, 'maxBytes', 16384, 2048, 262144);
    const documents: Record<string, Awaited<ReturnType<Retrieval['document']>>['metadata']> = {};
    const results: Array<SearchMatch & { score?: number; file_id: string; startLine: number; endLine: number; excerptTruncated: boolean }> = [];
    const loaded = new Map<string, Awaited<ReturnType<Retrieval['document']>>>();
    let omitted = matches.length > limit;
    for (const hit of matches) {
      let doc = loaded.get(hit.path);
      if (!doc) { doc = await this.document(hit.path); loaded.set(hit.path, doc); }
      if (hit.line < 1 || hit.line > doc.lines.length) throw new Error('Search engine returned an invalid source line');
      const hitEnd = Math.min(doc.lines.length, hit.line + Math.max(1, documentLines(hit.excerpt).length) - 1);
      let start = Math.max(1, hit.line - context), end = Math.min(doc.lines.length, hitEnd + context);
      while (start < hit.line && doc.lines.slice(start - 1, end).join('\n').length > 2000) start++;
      while (end > hitEnd && doc.lines.slice(start - 1, end).join('\n').length > 2000) end--;
      const duplicate = results.find(result => result.path === hit.path && result.startLine <= start && result.endLine >= end && !result.excerptTruncated);
      if (duplicate) continue;
      if (results.length >= limit) { omitted = true; break; }
      const text = doc.lines.slice(start - 1, end).join('\n');
      const excerpt = text.slice(0, 2000);
      const file_id = doc.metadata.file_id;
      documents[file_id] = doc.metadata;
      results.push({ ...hit, file_id, startLine: start, endLine: start + documentLines(excerpt).length - 1,
        excerpt, excerptTruncated: excerpt.length < text.length });
      if (Buffer.byteLength(this.json({ ...extra, count: results.length, truncated: true, documents, results })) > maxBytes) {
        results.pop();
        if (!results.some(result => result.file_id === file_id)) delete documents[file_id];
        omitted = true; break;
      }
    }
    if (!results.length && matches.length) throw new Error('Search metadata exceeds maxBytes; increase the response budget');
    return this.json({ ...extra, count: results.length, truncated: omitted, documents, results }, maxBytes);
  }
}
