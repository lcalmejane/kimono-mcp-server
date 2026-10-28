import type { Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import { FastGrepIndex } from './search.js';
import { SemanticIndex } from './semantic.js';
import { within } from './synchronization.js';
import { ProjectVocabulary } from './query-plan.js';
import { AIKIDO_EXTENSIONS, loadCorpusConfig, type CorpusConfig } from './corpus-config.js';
import { documentSignatureValid, extractDocument, isExtractedDocument } from './documents.js';
import { debug, debugEnabled } from './diagnostics.js';

export type KnowledgeKind = 'command' | 'agent' | 'skill' | 'workflow' | 'knowledge';

export interface FileMetadata {
  contentStatus: 'metadata-only';
  reason: string;
  sizeBytes: number | null;
  modified: string | null;
  extension: string;
}

export interface KnowledgeEntry {
  id: string;
  path: string;
  kind: KnowledgeKind;
  title: string;
  metadata?: FileMetadata;
}

export interface SearchMatch extends KnowledgeEntry {
  excerpt: string;
  line: number;
}

// Each ignored document is traced once per process to keep long-lived servers quiet.
const reportedSkips = new Set<string>();
const reportedSkipReasons = new Set<string>();

const EXCLUDED_DIRECTORIES = new Set(['.git', '.ssh', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__', '.next', '.nuxt', '.cache', '.nyc_output', 'temp', 'credentials', 'secrets']);
const RAG_EXCLUDED_DIRECTORIES = new Set(['target', 'vendor', '.gradle', '.terraform', '.idea', '.tox', '.mypy_cache', '.pytest_cache', '.turbo']);
const KNOWLEDGE_EXTENSIONS = new Set(AIKIDO_EXTENSIONS);

export class AikidoKnowledgeBase {
  readonly root: string;
  readonly searchIndex: FastGrepIndex;
  readonly semanticIndex: SemanticIndex;
  readonly vocabulary: ProjectVocabulary;
  private initialized = false;
  private memoryRoot = false;
  private entries: KnowledgeEntry[] = [];
  private byId = new Map<string, KnowledgeEntry>();
  private sizes = new Map<string, number>();
  private skipped = new Map<string, string>();
  private scanStats = { files: 0, bytes: 0, oversized: 0, binary: 0, metadataOnly: 0 };

  constructor(root: string, readonly immutable = false, readonly config: Readonly<CorpusConfig> = loadCorpusConfig(),
    private readonly snapshotMemoryRoot?: boolean, readonly materializedText = false,
    readonly snapshotMetadata: ReadonlyMap<string, FileMetadata> = new Map()) {
    this.root = path.resolve(root);
    this.searchIndex = new FastGrepIndex(this);
    this.semanticIndex = new SemanticIndex(this);
    this.vocabulary = new ProjectVocabulary(this);
  }

  get isInitialized(): boolean { return this.initialized; }
  get isMemoryRoot(): boolean { return this.memoryRoot; }
  get corpusStatus() {
    return {
      mode: this.config.mode, ...this.scanStats,
      skipped: this.skipped.size,
      skippedFiles: [...this.skipped].slice(0, 50).map(([file, reason]) => ({ file, reason })),
      config: this.config,
    };
  }

  /** Records unavailable content while keeping its filesystem metadata searchable. */
  private skip(file: string, reason: string): void {
    this.skipped.set(file, reason);
    if (!reportedSkipReasons.has(reason) && reportedSkipReasons.size < 32) {
      reportedSkipReasons.add(reason);
      console.error(`Kimono: content unavailable (${reason.slice(0, 1024)}); affected files remain searchable through metadata; see corpus status for paths`);
    }
    if (!debugEnabled()) return;
    const key = `${this.root}\0${file}\0${reason}`;
    if (reportedSkips.has(key)) return;
    if (reportedSkips.size > 10_000) reportedSkips.clear();
    reportedSkips.add(key);
    debug(`Kimono: content unavailable; file metadata retained (${reason}): ${file}`);
  }

  /**
   * Non-blocking read for indexing loops: an unreadable or unsupported document
   * is traced and represented by explicit metadata instead of aborting indexing.
   */
  async tryRead(idOrPath: string): Promise<{ entry: KnowledgeEntry; content: string; modified: string } | undefined> {
    try { return await this.read(idOrPath); }
    catch (error) {
      this.skip(idOrPath, skipReason(error, idOrPath));
      const entry = this.byId.get(idOrPath.replaceAll('\\', '/').replace(/^\/+/, ''));
      if (!entry) return undefined;
      const info = await lstat(path.join(this.root, entry.path)).catch(error => {
        this.skip(entry.path, skipReason(error, entry.path));
        return undefined;
      });
      if (!entry.metadata) this.scanStats.metadataOnly++;
      entry.metadata = {
        contentStatus: 'metadata-only', reason: skipReason(error, idOrPath),
        sizeBytes: info?.size ?? null, modified: info?.mtime.toISOString() ?? null,
        extension: path.posix.extname(entry.path).toLowerCase(),
      };
      const size = Buffer.byteLength(fileMetadataText(entry.path, entry.metadata));
      this.scanStats.bytes += size - (this.sizes.get(entry.path) ?? 0);
      this.sizes.set(entry.path, size);
      return this.metadataDocument(entry);
    }
  }

  acceptsFile(file: string): boolean {
    return this.config.extensions.includes(path.posix.extname(file).toLowerCase()) || this.config.filenames.includes(path.posix.basename(file));
  }

  async initialize(): Promise<void> {
    const rootInfo = await stat(this.root).catch((error: unknown) => {
      throw new Error(`AIKIDO_ROOT is unavailable: ${this.root}`, { cause: error });
    });
    if (!rootInfo.isDirectory()) throw new Error(`AIKIDO_ROOT is not a directory: ${this.root}`);

    const realRoot = await realpath(this.root);
    const indexCandidates = ['prompts/index.md', 'index.md'];
    const indexes = await Promise.all(indexCandidates.map(async (candidate) => {
      try {
        const info = await stat(path.join(realRoot, candidate));
        return info.isFile();
      } catch {
        return false;
      }
    }));
    if (!indexes.some(Boolean) && this.config.mode === 'aikido' && !this.immutable) {
      throw new Error(`No AI-KIDO entry point found in ${this.root} (expected prompts/index.md or index.md)`);
    }

    this.memoryRoot = this.snapshotMemoryRoot ?? (this.config.mode === 'aikido' && !indexes[0]);
    this.scanStats = { files: 0, bytes: 0, oversized: 0, binary: 0, metadataOnly: 0 };
    this.sizes.clear();
    this.skipped.clear();
    this.entries = await this.scanDirectory(realRoot, '');
    this.byId = new Map();
    for (const entry of this.entries) {
      const hash = fileId(entry.path);
      if (this.byId.has(hash)) throw new Error(`AI-KIDO file ID collision: ${entry.path}`);
      this.byId.set(hash, entry);
      this.byId.set(entry.path, entry);
    }
    this.initialized = true;
  }

  async refresh(paths?: string[]): Promise<number> {
    if (this.immutable && this.initialized) return this.entries.length;
    if (!paths) await this.initialize();
    else {
      this.requireInitialized();
      this.scanStats = { files: 0, bytes: 0, oversized: 0, binary: 0, metadataOnly: 0 };
      for (const file of this.sizes.keys()) if (within(file, paths)) this.sizes.delete(file);
      for (const file of this.skipped.keys()) if (within(file, paths)) this.skipped.delete(file);
      const selected = await this.scanDirectory(await realpath(this.root), '', [], paths);
      this.entries = [...this.entries.filter(entry => !within(entry.path, paths)), ...selected]
        .sort((a, b) => a.path.localeCompare(b.path));
      this.byId = new Map(this.entries.flatMap(entry => [[entry.path, entry], [fileId(entry.path), entry]]));
      const bytes = [...this.sizes.values()].reduce((total, size) => total + size, 0);
      this.enforceLimits(this.entries.length, bytes);
      this.scanStats.files = this.entries.length;
      this.scanStats.bytes = bytes;
      this.scanStats.metadataOnly = this.entries.filter(entry => entry.metadata).length;
    }
    return this.entries.length;
  }

  list(kind?: KnowledgeKind, query?: string): KnowledgeEntry[] {
    this.requireInitialized();
    const needle = query?.trim().toLocaleLowerCase();
    return this.entries.filter((entry) => {
      if (kind && entry.kind !== kind) return false;
      return !needle || `${entry.path} ${entry.title}`.toLocaleLowerCase().includes(needle);
    });
  }

  async read(idOrPath: string): Promise<{ entry: KnowledgeEntry; content: string; modified: string }> {
    this.requireInitialized();
    const normalized = idOrPath.replaceAll('\\', '/').replace(/^\/+/, '');
    const entry = this.byId.get(normalized);
    if (!entry) throw new Error(`AI-KIDO document not found: ${idOrPath}`);
    if (entry.metadata) return this.metadataDocument(entry);

    const filePath = path.resolve(this.root, entry.path);
    const rootReal = await realpath(this.root);
    const fileReal = await realpath(filePath);
    if (!fileReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`Refusing to read a path outside AIKIDO_ROOT: ${idOrPath}`);
    }
    const info = await stat(fileReal);
    if (!info.isFile() || info.size > this.config.maxFileBytes) {
      throw new Error(`Document is not a readable text file (maximum ${this.config.maxFileBytes} bytes): ${idOrPath}`);
    }
    const bytes = await readFile(fileReal);
    if (bytes.length > this.config.maxFileBytes) throw new Error(`Document exceeds maxFileBytes: ${idOrPath}`);
    if (!this.materializedText && isExtractedDocument(entry.path)) {
      return { entry, content: await extractDocument(entry.path, bytes, this.config.maxFileBytes, this.searchIndex.directory),
        modified: info.mtime.toISOString() };
    }
    if (hasBinaryNul(bytes)) throw new Error(`Binary content is not supported: ${idOrPath}`);
    const content = decodeText(bytes);
    if (Buffer.byteLength(content) > this.config.maxFileBytes) throw new Error(`Decoded document exceeds maxFileBytes: ${idOrPath}`);
    return { entry, content, modified: info.mtime.toISOString() };
  }

  private metadataDocument(entry: KnowledgeEntry) {
    if (!entry.metadata) throw new Error(`Missing fallback metadata for ${entry.path}`);
    return { entry, content: fileMetadataText(entry.path, entry.metadata),
      modified: entry.metadata.modified ?? 'unavailable' };
  }

  async search(query: string, kind?: KnowledgeKind, limit = 25): Promise<SearchMatch[]> {
    this.requireInitialized();
    if (!query.trim()) throw new Error('Search query must not be empty');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be between 1 and 100');
    await this.refresh();
    return this.searchIndex.search(query, kind, limit);
  }

  private async scanDirectory(realRoot: string, relativeDirectory: string, inherited: Array<{ base: string; rules: Ignore }> = [], scopes?: string[]): Promise<KnowledgeEntry[]> {
    const directoryPath = path.join(realRoot, relativeDirectory);
    let children: Dirent[];
    try { children = await readdir(directoryPath, { withFileTypes: true }); }
    catch (error) {
      if (!relativeDirectory) throw error;
      this.skip(`${relativeDirectory}/`, skipReason(error, relativeDirectory));
      return [];
    }
    const rules = [...inherited];
    if (!this.materializedText && children.some(child => child.name === '.gitignore' && child.isFile())) {
      try {
        rules.push({ base: relativeDirectory, rules: ignore().add(decodeText(await readFile(path.join(directoryPath, '.gitignore')))) });
      } catch (error) {
        this.skip(path.posix.join(relativeDirectory.split(path.sep).join('/'), '.gitignore'), skipReason(error, '.gitignore'));
        if (!relativeDirectory) throw error;
        return [];
      }
    }
    const result: KnowledgeEntry[] = [];
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join('/'), child.name);
      // Visit only selected subtrees and their ancestors (for inherited ignore rules).
      if (scopes && !within(relativePath, scopes)
        && !scopes.some(scope => scope.startsWith(`${relativePath}/`))) continue;
      if (child.name.startsWith('.env') || /(?:\.log|\.tmp|\.sw[po]|~)$/.test(child.name)) continue;
      if (isSensitiveKnowledgePath(relativePath)) continue;
      let ignored = false;
      for (const layer of rules) {
        const local = relativePath.slice(layer.base ? layer.base.length + 1 : 0) + (child.isDirectory() ? '/' : '');
        const decision = layer.rules.test(local);
        if (decision.ignored) ignored = true;
        else if (decision.unignored) ignored = false;
      }
      if (ignored) continue;
      if (this.config.exclude.some(pattern => path.posix.matchesGlob(relativePath, pattern) ||
        child.isDirectory() && path.posix.matchesGlob(`${relativePath}/`, pattern))) continue;
      if (child.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(child.name)) continue;
        if (this.config.mode === 'rag' && RAG_EXCLUDED_DIRECTORIES.has(child.name)) continue;
        if (this.config.mode === 'aikido' && process.env.AIKIDO_INCLUDE_SPEC !== 'true' && (relativePath === 'prompts/spec' || relativePath === 'spec')) continue;
        for (const entry of await this.scanDirectory(realRoot, relativePath, rules, scopes)) result.push(entry);
      } else if (child.isFile() && (this.acceptsFile(relativePath) || this.config.mode === 'rag')) {
        if (!within(relativePath, scopes)) continue;
        if (this.config.include.length && !this.config.include.some(pattern => path.posix.matchesGlob(relativePath, pattern))) continue;
        const probed = await this.probe(path.join(realRoot, relativePath), relativePath);
        if (!probed) continue;
        this.scanStats.files++;
        this.scanStats.bytes += probed.size;
        this.enforceLimits(this.scanStats.files, this.scanStats.bytes);
        this.sizes.set(relativePath, probed.size);
        if (probed.metadata) this.scanStats.metadataOnly++;
        result.push({
          id: relativePath,
          path: relativePath,
          kind: this.config.mode === 'rag' ? 'knowledge' : classify(relativePath),
          title: titleFromPath(relativePath),
          ...(probed.metadata ? { metadata: probed.metadata } : {}),
        });
      }

    }
    return result;
  }

  /** Accounts for readable content or its explicit metadata-only replacement. */
  private async probe(fullPath: string, relativePath: string): Promise<{ size: number; metadata?: FileMetadata }> {
    let sizeBytes: number | null = null;
    let modified: string | null = null;
    const metadataOnly = (reason: string) => {
      this.skip(relativePath, reason);
      const metadata: FileMetadata = { contentStatus: 'metadata-only', reason, sizeBytes, modified,
        extension: path.posix.extname(relativePath).toLowerCase() };
      return { size: Buffer.byteLength(fileMetadataText(relativePath, metadata)), metadata };
    };
    try {
      const info = await stat(fullPath);
      sizeBytes = info.size;
      modified = info.mtime.toISOString();
      const capturedMetadata = this.snapshotMetadata.get(relativePath);
      if (capturedMetadata) return { size: info.size, metadata: capturedMetadata };
      if (!this.acceptsFile(relativePath)) return metadataOnly('unsupported content format');
      if (info.size > this.config.maxFileBytes) {
        this.scanStats.oversized++;
        return metadataOnly(`larger than maxFileBytes ${this.config.maxFileBytes}`);
      }
      const handle = await open(fullPath, 'r');
      try {
        const sample = Buffer.alloc(Math.min(info.size, 8192));
        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
        if (!this.materializedText && isExtractedDocument(relativePath)) {
          if (!documentSignatureValid(relativePath, sample.subarray(0, bytesRead))) {
            throw new Error('Document signature does not match its extension');
          }
          const bytes = await handle.readFile();
          if (bytes.length > this.config.maxFileBytes) throw new Error(`Document exceeds maxFileBytes ${this.config.maxFileBytes}`);
          const content = await extractDocument(relativePath, bytes, this.config.maxFileBytes, this.searchIndex.directory);
          return { size: Math.max(info.size, Buffer.byteLength(content)) };
        }
        if (hasBinaryNul(sample.subarray(0, bytesRead))) {
          this.scanStats.binary++;
          return metadataOnly('binary content');
        }
      } finally { await handle.close(); }
      return { size: info.size };
    } catch (error) {
      return metadataOnly(`unreadable: ${skipReason(error, relativePath)}`);
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('AI-KIDO knowledge base is not initialized');
  }

  private enforceLimits(files: number, bytes: number): void {
    if (files > this.config.maxFiles || bytes > this.config.maxCorpusBytes) {
      throw new Error(`Corpus limit exceeded (${files} files, ${bytes} bytes); narrow include/exclude or raise maxFiles/maxCorpusBytes in the host config`);
    }
  }
}

export function fileMetadataText(file: string, metadata: FileMetadata): string {
  return [
    'Content status: metadata-only (file content unavailable)',
    `Name: ${JSON.stringify(path.posix.basename(file))}`,
    `Path: ${JSON.stringify(file)}`,
    `Extension: ${metadata.extension || '(none)'}`,
    `Size bytes: ${metadata.sizeBytes ?? 'unavailable'}`,
    `Modified: ${metadata.modified ?? 'unavailable'}`,
    `Reason: ${metadata.reason}`,
  ].join('\n');
}

function skipReason(error: unknown, file: string): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : error.message.replace(`: ${file}`, '');
}

function hasUtf16Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff);
}

/** NUL bytes mark binary content, except in BOM-prefixed UTF-16 text. */
export function hasBinaryNul(bytes: Uint8Array): boolean {
  return !hasUtf16Bom(bytes) && bytes.includes(0);
}

/**
 * Decodes any text file: UTF-8 first, UTF-16 when BOM-prefixed, otherwise the
 * legacy 8-bit Windows-1252 charset. Never throws on invalid UTF-8.
 */
export function decodeText(bytes: Buffer): string {
  if (hasUtf16Bom(bytes)) {
    try { return new TextDecoder(bytes[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(bytes.subarray(2)); }
    catch { /* UTF-16BE requires full ICU; fall through to the generic path */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { /* not UTF-8: decode as a legacy 8-bit charset */ }
  try { return new TextDecoder('windows-1252').decode(bytes); }
  catch { return bytes.toString('latin1'); }
}

export function fileId(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 12);
}

export function isKnowledgeFile(filePath: string): boolean {
  return KNOWLEDGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isSensitiveKnowledgePath(filePath: string): boolean {
  const segments = filePath.replaceAll('\\', '/').split('/');
  const basename = segments.at(-1) ?? '';
  return segments.some(segment => ['.git', '.ssh', 'credentials', 'secrets'].includes(segment.toLowerCase()))
    || segments.some(segment => segment.startsWith('.env'))
    || /\.(?:pem|key|p12|pfx)$/i.test(basename)
    || /^(?:id_(?:rsa|ed25519)(?:\.pub)?|credentials(?:\.[^.]+)?|\.netrc|\.npmrc|\.pypirc)$/i.test(basename);
}

function classify(filePath: string): KnowledgeKind {
  const normalized = filePath.toLowerCase();
  if (/(^|\/)commands\//.test(normalized) || /(^|\/)commands_list\.md$/.test(normalized)) return 'command';
  if (/(^|\/)workflows\//.test(normalized)) return 'workflow';
  if (/(^|\/)(agents|personas)\//.test(normalized) || /(^|\/)agents_list\.md$/.test(normalized)) return 'agent';
  if (/(^|\/)skills\//.test(normalized) || /(^|\/)skills_list\.md$/.test(normalized) || /(^|\/)skills?\.md$/.test(normalized)) return 'skill';
  return 'knowledge';
}

function titleFromPath(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.[^.]+$/, '').replaceAll('-', ' ').replaceAll('_', ' ');
}
