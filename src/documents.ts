import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { runProcess } from './process.js';

export const DOCUMENT_EXTENSIONS = ['.xlsx', '.docx', '.pptx', '.pdf'];
const MAX_XML_BYTES = 32 * 1024 * 1024;
const CACHE_BYTES = 16 * 1024 * 1024;
const cache = new Map<string, string>();
let cachedBytes = 0;
type XmlNode = Record<string, unknown>;

export function isExtractedDocument(file: string): boolean {
  return DOCUMENT_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

export function documentSignatureValid(file: string, bytes: Buffer): boolean {
  return path.extname(file).toLowerCase() === '.pdf'
    ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
    : bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

export async function extractDocument(file: string, bytes: Buffer, maxBytes: number, cacheDirectory: string): Promise<string> {
  if (!documentSignatureValid(file, bytes)) throw new Error('Document signature does not match its extension');
  const extension = path.extname(file).toLowerCase();
  const key = `${extension}:${maxBytes}:${createHash('sha256').update(bytes).digest('hex')}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const content = extension === '.pdf'
    ? await pdfText(bytes, maxBytes, cacheDirectory)
    : officeText(await officeParts(bytes), extension, maxBytes);
  const size = Buffer.byteLength(content);
  if (!content.trim()) throw new Error('Document contains no extractable text');
  if (size > maxBytes) throw new Error(`Extracted document exceeds maxFileBytes ${maxBytes}`);
  if (size <= CACHE_BYTES) {
    while (cache.size >= 32 || cachedBytes + size > CACHE_BYTES) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cachedBytes -= Buffer.byteLength(oldest[1]);
      cache.delete(oldest[0]);
    }
    cache.set(key, content);
    cachedBytes += size;
  }
  return content;
}

async function pdfText(bytes: Buffer, maxBytes: number, cacheDirectory: string): Promise<string> {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(cacheDirectory, 'document-'));
  try {
    const input = path.join(temporary, 'input.pdf');
    await writeFile(input, bytes, { mode: 0o600, flag: 'wx' });
    const result = await runProcess('pdftotext', ['-enc', 'UTF-8', '-nopgbrk', input, '-'],
      temporary, [0], 30_000, undefined, process.env, maxBytes);
    return result.stdout.replace(/\r\n?/g, '\n').trim();
  } catch (error) {
    throw new Error('PDF extraction failed; pdftotext (Poppler) must be installed and the PDF must contain readable text', { cause: error });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function officeParts(bytes: Buffer): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(error); return; }
      const parts = new Map<string, string>();
      let total = 0;
      let failed = false;
      const fail = (cause: unknown) => {
        if (failed) return;
        failed = true;
        zip.close();
        reject(cause);
      };
      if (zip.entryCount > 4096) { fail(new Error('Office archive exceeds 4096 entries')); return; }
      zip.on('error', fail);
      zip.on('end', () => { if (!failed) resolve(parts); });
      zip.on('entry', (entry: Entry) => {
        if (failed) return;
        total += entry.uncompressedSize;
        if (entry.isEncrypted() || total > MAX_XML_BYTES) {
          fail(new Error('Encrypted or oversized Office archive'));
          return;
        }
        if (!/^(?:xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)|word\/document\.xml|ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml))$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (parts.has(entry.fileName)) { fail(new Error('Duplicate Office archive part')); return; }
        readPart(zip, entry).then(content => {
          if (failed) return;
          parts.set(entry.fileName, content);
          zip.readEntry();
        }, fail);
      });
      zip.readEntry();
    });
  });
}

async function readPart(zip: ZipFile, entry: Entry): Promise<string> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (error, readable) => error ? reject(error) : resolve(readable));
  });
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_XML_BYTES || length > entry.uncompressedSize) throw new Error('Office part exceeds its declared size');
    chunks.push(bytes);
  }
  if (length !== entry.uncompressedSize) throw new Error('Truncated Office archive part');
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

function parseXml(parts: Map<string, string>, name: string): XmlNode[] {
  const content = parts.get(name);
  if (content === undefined) throw new Error(`Missing Office archive part: ${name}`);
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('XML document type declarations are not supported');
  if (XMLValidator.validate(content) !== true) throw new Error(`Invalid Office XML: ${name}`);
  const parsed: unknown = new XMLParser({
    preserveOrder: true, ignoreAttributes: false,
    transformTagName: name => name.slice(name.indexOf(':') + 1),
    transformAttributeName: name => {
      const separator = name.indexOf(':');
      if (separator < 0) return name;
      const local = name.slice(separator + 1);
      return `@_${local === 'id' ? 'relationshipId' : local}`;
    },
    parseTagValue: false, parseAttributeValue: false, trimValues: false,
  }).parse(content);
  return nodes(parsed);
}

function nodes(value: unknown): XmlNode[] {
  return Array.isArray(value) ? value.filter((item): item is XmlNode => !!item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function descendants(tree: XmlNode[], tag: string): XmlNode[] {
  const result: XmlNode[] = [];
  for (const node of tree) {
    if (Object.hasOwn(node, tag)) result.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key !== ':@') {
        for (const child of descendants(nodes(value), tag)) result.push(child);
      }
    }
  }
  return result;
}

function attribute(node: XmlNode, name: string): string | undefined {
  const attributes = node[':@'];
  if (!attributes || typeof attributes !== 'object') return undefined;
  const value: unknown = Reflect.get(attributes, `@_${name}`);
  return typeof value === 'string' ? value : undefined;
}

function text(tree: XmlNode[]): string {
  return tree.map(node => Object.entries(node).map(([key, value]) => {
    if (key === '#text') return String(value);
    if (key === ':@') return '';
    if (key === 'tab') return '\t';
    if (key === 'br' || key === 'cr') return '\n';
    return text(nodes(value));
  }).join('')).join('');
}

function taggedText(tree: XmlNode[], tag: string): string {
  return descendants(tree, tag).map(node => text(nodes(node[tag]))).join('');
}

function officeText(parts: Map<string, string>, extension: string, maxBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  const append = (line: string) => {
    size += Buffer.byteLength(line) + (lines.length ? 1 : 0);
    if (size > maxBytes) throw new Error(`Extracted document exceeds maxFileBytes ${maxBytes}`);
    lines.push(line);
  };
  if (extension === '.docx') {
    for (const paragraph of descendants(parseXml(parts, 'word/document.xml'), 'p')) {
      const content = text(nodes(paragraph.p)).trim();
      if (content) append(content);
    }
  } else if (extension === '.pptx') {
    const presentation = parseXml(parts, 'ppt/presentation.xml');
    const relationships = descendants(parseXml(parts, 'ppt/_rels/presentation.xml.rels'), 'Relationship');
    const slides = descendants(presentation, 'sldId');
    for (const [index, slide] of slides.entries()) {
      const id = attribute(slide, 'relationshipId');
      const matches = relationships.filter(node => attribute(node, 'Id') === id);
      const relationship = matches[0];
      const target = relationship && attribute(relationship, 'Target');
      if (!id || matches.length !== 1 || !target || attribute(relationship, 'TargetMode') === 'External') {
        throw new Error('Invalid or external PowerPoint slide relationship');
      }
      const slidePath = target.startsWith('/') ? target.slice(1) : path.posix.join('ppt', target);
      if (!/^ppt\/slides\/[^/]+\.xml$/.test(slidePath)) throw new Error('Unsafe PowerPoint slide path');
      for (const paragraph of descendants(parseXml(parts, slidePath), 'p')) {
        const content = text(nodes(paragraph.p)).trim();
        if (content) append(`Slide ${index + 1}: ${content}`);
      }
    }
  } else {
    const workbook = parseXml(parts, 'xl/workbook.xml');
    const relationships = descendants(parseXml(parts, 'xl/_rels/workbook.xml.rels'), 'Relationship');
    const shared = parts.has('xl/sharedStrings.xml')
      ? descendants(parseXml(parts, 'xl/sharedStrings.xml'), 'si').map(node => taggedText(nodes(node.si), 't')) : [];
    for (const sheet of descendants(workbook, 'sheet')) {
      const name = attribute(sheet, 'name');
      const id = attribute(sheet, 'relationshipId');
      const relationship = relationships.find(node => attribute(node, 'Id') === id);
      const target = relationship && attribute(relationship, 'Target');
      if (!name || !id || !target || !relationship || attribute(relationship, 'TargetMode') === 'External') {
        throw new Error('Invalid or external Excel worksheet relationship');
      }
      const sheetPath = target.startsWith('/') ? target.slice(1) : path.posix.join('xl', target);
      if (!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath)) throw new Error('Unsafe Excel worksheet path');
      for (const row of descendants(parseXml(parts, sheetPath), 'row')) {
        const cells: string[] = [];
        for (const cell of descendants(nodes(row.row), 'c')) {
          const address = attribute(cell, 'r');
          if (!address || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new Error('Invalid Excel cell address');
          const type = attribute(cell, 't');
          let value = type === 'inlineStr' ? taggedText(nodes(cell.c), 't') : taggedText(nodes(cell.c), 'v');
          if (type === 's') {
            const index = Number(value);
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(index) || shared[index] === undefined) {
              throw new Error('Invalid Excel shared string reference');
            }
            value = shared[index];
          }
          if (!value) {
            const formula = taggedText(nodes(cell.c), 'f');
            if (formula) value = `=${formula}`;
          }
          if (value) cells.push(`${address}=${singleLine(value)}`);
        }
        if (cells.length) append(`${singleLine(name)}!${cells.join(' | ')}`);
      }
    }
  }
  return lines.join('\n');
}

function singleLine(value: string): string {
  return value.replace(/\r\n?|\n/g, '\\n').replace(/\t/g, '\\t');
}
