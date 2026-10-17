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

export class Retrieval {
  constructor(private readonly knowledge: AikidoKnowledgeBase) {}

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
      if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) {
        output.entries.pop();
        output.count--;
        break;
      }
    }
    output.nextOffset = offset + output.count < entries.length ? offset + output.count : null;
    output.truncated = output.nextOffset !== null;
    if (!output.count && offset < entries.length) throw new Error('Metadata exceeds maxBytes; increase the response budget');
    return JSON.stringify(output);
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
    if (operation === 'metadata') return checkedJson(document.metadata, maxBytes);
    if (operation === 'outline') {
      const offset = integer(input, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(input, 'limit', 25, 1, 100);
      const entries = document.outline.slice(offset, offset + limit);
      const result = { document: document.metadata, count: entries.length, total: document.outline.length,
        nextOffset: offset + entries.length < document.outline.length ? offset + entries.length : null, headings: entries };
      while (Buffer.byteLength(JSON.stringify(result)) > maxBytes && result.headings.length) {
        result.headings.pop(); result.count--;
        result.nextOffset = offset + result.count;
      }
      if (!result.count && offset < result.total) throw new Error('Outline metadata exceeds maxBytes; increase the response budget');
      return checkedJson(result, maxBytes);
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
      if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) break;
      if (!selected.length) throw new Error('Document metadata exceeds maxBytes; increase the response budget');
      selected.pop();
      if (!selected.length) throw new Error('A document line exceeds maxBytes; increase the response budget');
    }
    return JSON.stringify(result);
  }

  async search(input: Record<string, unknown>, matches: Array<SearchMatch & { score?: number }>, extra: Record<string, unknown>): Promise<string> {
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
      if (Buffer.byteLength(JSON.stringify({ ...extra, count: results.length, truncated: true, documents, results })) > maxBytes) {
        results.pop();
        if (!results.some(result => result.file_id === file_id)) delete documents[file_id];
        omitted = true; break;
      }
    }
    if (!results.length && matches.length) throw new Error('Search metadata exceeds maxBytes; increase the response budget');
    return checkedJson({ ...extra, count: results.length, truncated: omitted, documents, results }, maxBytes);
  }
}

function checkedJson(value: unknown, maxBytes: number): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) throw new Error('Response exceeds maxBytes; increase the response budget');
  return json;
}
