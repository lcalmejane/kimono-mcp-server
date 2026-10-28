import { deflateRawSync } from 'node:zlib';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { extractDocument } from '../src/documents.js';
import { AikidoKnowledgeBase } from '../src/knowledge.js';
import { corpusConfig } from '../src/corpus-config.js';
import { SnapshotManager } from '../src/snapshots.js';
import { KnowledgeCollaboration } from '../src/collaboration.js';
import { synchronizeKnowledgeRoot } from '../src/remote-sync.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAikidoMcpServer } from '../src/server.js';
import { Retrieval } from '../src/retrieval.js';
import * as processes from '../src/process.js';

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(options: Record<string, unknown> = {}) {
  const parent = await mkdtemp(path.resolve('.local-runtime-documents-'));
  scratch.push(parent);
  const root = path.join(parent, 'project');
  await mkdir(root);
  vi.stubEnv('KIMONO_CACHE_DIR', path.join(parent, 'cache'));
  const knowledge = new AikidoKnowledgeBase(root, false, corpusConfig(options));
  const write = (file: string, content: string | Buffer) => writeFile(path.join(root, file), content);
  return { root, parent, knowledge, write };
}

it('retains metadata for many unsupported files without per-file production log growth', async () => {
  vi.stubEnv('KIMONO_LOG_LEVEL', 'error');
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { root, knowledge, write } = await fixture({ mode: 'rag' });
  await Promise.all(Array.from({ length: 100 }, (_, index) => write(`opaque-${index}.unknown`, Buffer.from([0, 1, 2]))));
  await knowledge.initialize();
  await knowledge.refresh();
  expect(knowledge.corpusStatus.metadataOnly).toBe(100);
  expect(output.mock.calls.length).toBeLessThanOrEqual(1);
  expect(output.mock.calls.flat().join('\n')).not.toContain('opaque-');
  expect((await readdir(root)).length).toBe(100);
  expect(knowledge.corpusStatus.skippedFiles.length).toBe(50);
});

function archive(parts: Record<string, string>, deflate = true): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(text);
    const data = deflate ? deflateRawSync(bytes) : bytes;
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    local.push(header, nameBytes, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(deflate ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function workbook(value = 'Budget &amp; sales'): Buffer {
  return archive({
    'xl/workbook.xml': '<workbook xmlns:r="urn:relationships"><sheets><sheet name="Costs" sheetId="1" r:id="rId7"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst><si><r><t>${value}</t></r></si></sst>`,
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="5"><c r="A5" t="s"><v>0</v></c><c r="B5"><v>42</v></c><c r="C5" t="inlineStr"><is><t>café</t></is></c></row><row r="8"><c r="D8"><f>SUM(B5:B7)</f></c></row></sheetData></worksheet>',
  });
}

function word(text = 'Local RAG &amp; documents'): Buffer {
  return archive({ 'word/document.xml': `<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>` });
}

function presentationParts(): Record<string, string> {
  return {
    'ppt/presentation.xml': '<p:presentation xmlns:p="urn:presentation" xmlns:r="urn:relationships"><p:sldIdLst><p:sldId r:id="rId2" id="256"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="/ppt/slides/slide7.xml"/></Relationships>',
    'ppt/slides/slide7.xml': '<p:sld xmlns:p="urn:presentation" xmlns:a="urn:drawing"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Quarterly &amp; budget</a:t></a:r><a:br/><a:r><a:t>café</a:t></a:r></a:p></p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Table cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:graphicFrame></p:spTree></p:cSld></p:sld>',
    'ppt/slides/slide1.xml': '<sld><p><r><t>Next steps</t></r></p></sld>',
    'ppt/slides/slide99.xml': '<sld><p><r><t>Unreferenced slide</t></r></p></sld>',
    'ppt/notesSlides/notesSlide1.xml': '<notes><p><r><t>Speaker notes</t></r></p></notes>',
  };
}

it('extracts PowerPoint paragraphs and tables in presentation order with slide numbers', async () => {
  const { parent } = await fixture();
  const expected = 'Slide 1: Quarterly & budget\ncafé\nSlide 1: Table cell\nSlide 2: Next steps';
  const bytes = archive(presentationParts());
  expect(await extractDocument('deck.PPTX', bytes, Buffer.byteLength(expected), parent)).toBe(expected);
  await expect(extractDocument('deck.pptx', bytes, Buffer.byteLength(expected) - 1, parent)).rejects.toThrow('maxFileBytes');
  const parts = presentationParts();
  parts['ppt/slides/slide7.xml'] = '<sld/>';
  expect(await extractDocument('blank-slide.pptx', archive(parts, false), 4096, parent)).toBe('Slide 2: Next steps');
});

it('rejects invalid PowerPoint relationships, missing slides, malformed XML and empty presentations', async () => {
  const { parent } = await fixture();
  for (const relationship of [
    '<Relationship Id="rId2" Target="https://example.invalid/slide.xml" TargetMode="External"/>',
    '<Relationship Id="rId2" Target="../../outside.xml"/>',
    '<Relationship Id="rId2" Target="slides/missing.xml"/>',
    '<Relationship Id="rId2" Target="slides/slide7.xml"/><Relationship Id="rId2" Target="slides/slide1.xml"/>',
    '',
  ]) {
    const parts = presentationParts();
    parts['ppt/_rels/presentation.xml.rels'] = `<Relationships>${relationship}</Relationships>`;
    await expect(extractDocument('invalid.pptx', archive(parts), 4096, parent)).rejects.toThrow();
  }
  for (const slide of ['<sld><p>', '<!DOCTYPE sld [<!ENTITY x "boom">]><sld>&x;</sld>']) {
    const parts = presentationParts();
    parts['ppt/slides/slide7.xml'] = slide;
    await expect(extractDocument('invalid-xml.pptx', archive(parts), 4096, parent)).rejects.toThrow();
  }
  const parts = presentationParts();
  parts['ppt/slides/slide7.xml'] = '<sld/>';
  parts['ppt/slides/slide1.xml'] = '<sld/>';
  await expect(extractDocument('empty.pptx', archive(parts), 4096, parent)).rejects.toThrow('no extractable text');
});

it('searches PowerPoint text and snapshots while retaining original files and metadata fallbacks', async () => {
  const { knowledge, root, write } = await fixture();
  const original = archive(presentationParts());
  await write('deck.pptx', original);
  await write('broken.pptx', 'not a ZIP archive');
  await knowledge.initialize();
  expect((await knowledge.read('deck.pptx')).content).toContain('Slide 1: Quarterly & budget');
  expect((await knowledge.read('broken.pptx')).entry.metadata?.contentStatus).toBe('metadata-only');
  expect((await knowledge.searchIndex.search('Quarterly', undefined, 10))[0]).toMatchObject({ path: 'deck.pptx', line: 1 });
  const manager = new SnapshotManager(knowledge);
  const begin = await manager.begin();
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    expect((await snapshot.knowledge.read('deck.pptx')).content).toContain('Slide 2: Next steps');
    expect((await snapshot.knowledge.searchIndex.search('Quarterly', undefined, 10))[0]?.path).toBe('deck.pptx');
  });
  await manager.end(String(begin.snapshotId));
  expect(await readFile(path.join(root, 'deck.pptx'))).toEqual(original);
});

it('accepts extracted text exactly at maxFileBytes and rejects one byte beyond it', async () => {
  const { parent } = await fixture();
  const expected = 'Threshold\nTable cell';
  const bytes = word('Threshold');
  const limit = Buffer.byteLength(expected);
  expect(await extractDocument('exact.docx', bytes, limit, parent)).toBe(expected);
  await expect(extractDocument('exact.docx', bytes, limit - 1, parent)).rejects.toThrow('maxFileBytes');
});

it('extracts sparse Excel rows with worksheet names, A1 addresses, shared/inline strings and formula fallbacks', async () => {
  const { parent } = await fixture();
  expect(await extractDocument('costs.XLSX', workbook(), 4096, parent))
    .toBe('Costs!A5=Budget & sales | B5=42 | C5=café\nCosts!D8==SUM(B5:B7)');
});

it('extracts ordered Word paragraphs and table cells, and supports stored ZIP parts', async () => {
  const { parent } = await fixture();
  expect(await extractDocument('guide.docx', word(), 4096, parent)).toBe('Local RAG & documents\nTable cell');
  const stored = archive({ 'word/document.xml': '<document><body><p><r><t>First</t><tab/><t>Second</t><br/><t>Third</t></r></p></body></document>' }, false);
  expect(await extractDocument('stored.docx', stored, 4096, parent)).toBe('First\tSecond\nThird');
});

it('rejects malformed archives, invalid signatures, XML entities, unsafe paths and missing parts', async () => {
  const { parent } = await fixture();
  for (const input of [
    Buffer.from('not a document'),
    Buffer.from('PK\u0003\u0004truncated'),
    archive({ 'word/document.xml': '<!DOCTYPE doc [<!ENTITY x "boom">]><p>&x;</p>' }),
    archive({ '../word/document.xml': '<p>outside</p>' }),
    archive({ 'word/document.xml': '<p>unclosed' }),
    archive({ 'xl/workbook.xml': '<workbook/>' }),
  ]) {
    await expect(extractDocument('bad.docx', input, 4096, parent)).rejects.toThrow();
  }
});

it('bounds expanded archive data and extracted text without truncating it into a successful document', async () => {
  const { parent } = await fixture();
  await expect(extractDocument('big.docx', word('x'.repeat(4096)), 2048, parent)).rejects.toThrow('maxFileBytes');
  const expanded = archive({ 'word/document.xml': 'x'.repeat(33 * 1024 * 1024) });
  await expect(extractDocument('bomb.docx', expanded, 4096, parent)).rejects.toThrow('oversized');
});

it('keeps document originals intact while exposing canonical text to snapshots and the lexical index', async () => {
  const { knowledge, write, root } = await fixture();
  const original = workbook('Quarterly budget');
  await write('costs.xlsx', original);
  await write('guide.docx', word());
  await knowledge.initialize();
  expect(knowledge.list().map(entry => entry.path)).toEqual(['costs.xlsx', 'guide.docx']);
  expect((await knowledge.read('costs.xlsx')).content).toContain('Costs!A5=Quarterly budget');
  expect((await knowledge.searchIndex.search('Quarterly', undefined, 10))[0]).toMatchObject({ path: 'costs.xlsx', line: 1 });
  const manager = new SnapshotManager(knowledge);
  const begin = await manager.begin();
  expect(begin.documents).toBe(2);
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    await write('costs.xlsx', workbook('Revised budget'));
    expect((await snapshot.knowledge.read('costs.xlsx')).content).toContain('Quarterly budget');
    expect((await snapshot.knowledge.searchIndex.search('Quarterly', undefined, 10))[0])
      .toMatchObject({ path: 'costs.xlsx', line: 1 });
    await expect(snapshot.knowledge.searchIndex.search('Revised', undefined, 10)).resolves.toEqual([]);
  });
  await manager.end(String(begin.snapshotId));
  await write('costs.xlsx', original);
  expect(await readFile(path.join(root, 'costs.xlsx'))).toEqual(original);
});

it('sends extracted text and original paths to the semantic engine, never ZIP bytes', async () => {
  const { knowledge, write } = await fixture();
  await write('semantic.xlsx', workbook('Semantic budget'));
  await write('deck.pptx', archive(presentationParts()));
  await knowledge.initialize();
  vi.stubEnv('KIMONO_MODEL_DIR', 'test-model');
  const realRun = processes.runProcess;
  let documents: unknown;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
    if (args[0] !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) return realRun(...args);
    documents = JSON.parse(await readFile(args[1][0], 'utf8')).documents;
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model: 'test', chunks: 1,
      embedded: 1, count: 0, results: [], changes: { added: ['semantic.xlsx'], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  await knowledge.semanticIndex.run('update');
  expect(documents).toEqual([{ path: 'deck.pptx', kind: 'knowledge',
    content: 'Slide 1: Quarterly & budget\ncafé\nSlide 1: Table cell\nSlide 2: Next steps' },
  { path: 'semantic.xlsx', kind: 'knowledge',
    content: 'Costs!A5=Semantic budget | B5=42 | C5=café\nCosts!D8==SUM(B5:B7)' }]);
});

it('records failed extraction by filename, respects ignore rules and keeps valid documents available', async () => {
  vi.stubEnv('KIMONO_LOG_LEVEL', 'debug');
  const { knowledge, write } = await fixture();
  await write('.gitignore', 'ignored.xlsx\n');
  await write('ignored.xlsx', workbook());
  await write('bad.docx', Buffer.from([0x50, 0x4b, 3, 4]));
  await write('good.txt', 'Still available');
  const trace = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await knowledge.initialize();
  expect(knowledge.list().filter(entry => !entry.metadata).map(entry => entry.path)).toEqual(['good.txt']);
  expect(knowledge.list().find(entry => entry.path === 'bad.docx')?.metadata?.contentStatus).toBe('metadata-only');
  expect(knowledge.list().some(entry => entry.path === 'ignored.xlsx')).toBe(false);
  expect(knowledge.corpusStatus.skippedFiles).toContainEqual(expect.objectContaining({ file: 'bad.docx' }));
  expect(trace).toHaveBeenCalledWith(expect.stringContaining('bad.docx'));
});

it('keeps document extensions opt-in in AI-KIDO mode and honors custom RAG allowlists', async () => {
  const { root, write } = await fixture();
  await write('index.md', '# Index');
  await write('costs.xlsx', workbook());
  await write('deck.pptx', archive(presentationParts()));
  const aikido = new AikidoKnowledgeBase(root, false, corpusConfig({ mode: 'aikido' }));
  await aikido.initialize();
  expect(aikido.list().map(entry => entry.path)).toEqual(['index.md']);
  const custom = new AikidoKnowledgeBase(root, false, corpusConfig({ extensions: ['.xlsx'] }));
  await custom.initialize();
  expect(custom.list().filter(entry => !entry.metadata).map(entry => entry.path)).toEqual(['costs.xlsx']);
  expect(custom.list().find(entry => entry.path === 'index.md')?.metadata?.contentStatus).toBe('metadata-only');
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'retains filesystem metadata when a previously indexed file becomes unreadable', async () => {
    const { knowledge, write, root } = await fixture();
    await write('unreadable.txt', 'Previously readable content');
    await knowledge.initialize();
    const info = await stat(path.join(root, 'unreadable.txt'));
    await chmod(path.join(root, 'unreadable.txt'), 0o000);
    const document = await knowledge.tryRead('unreadable.txt');
    expect(document?.entry.metadata).toMatchObject({
      contentStatus: 'metadata-only', sizeBytes: info.size, modified: info.mtime.toISOString(),
    });
    expect(knowledge.corpusStatus.metadataOnly).toBe(1);
    expect(document?.content).toContain('unreadable.txt');
    const matches = await knowledge.searchIndex.search('unreadable.txt', undefined, 10);
    expect(matches.some(hit => hit.path === 'unreadable.txt')).toBe(true);
  },
);

it('excludes document originals from collaboration and never overwrites them when publishing text', async () => {
  const { knowledge, write, root } = await fixture();
  const original = workbook();
  await write('costs.xlsx', original);
  await write('guide.docx', word());
  await write('deck.pptx', archive(presentationParts()));
  await write('index.md', '# Index');
  await knowledge.initialize();
  const collaboration = new KnowledgeCollaboration(knowledge);
  const status = await collaboration.call({ operation: 'status' });
  expect(Object.keys(status.localManifest as Record<string, string>)).toEqual(['index.md']);
  const publication = await synchronizeKnowledgeRoot(knowledge, new Map([['index.md', '# Updated']]),
    status.localManifest as Record<string, string>);
  await publication.finalize();
  expect(await readFile(path.join(root, 'costs.xlsx'))).toEqual(original);
  expect(await readFile(path.join(root, 'deck.pptx'))).toEqual(archive(presentationParts()));
  expect(await readFile(path.join(root, 'index.md'), 'utf8')).toBe('# Updated');
  await expect(collaboration.call({ operation: 'publish', expectedSharedVersion: status.sharedVersion,
    changes: [{ path: 'costs.xlsx', content: 'not an Excel file' }] })).rejects.toThrow();
  await expect(collaboration.call({ operation: 'publish', expectedSharedVersion: status.sharedVersion,
    changes: [{ path: 'deck.pptx', content: 'not a PowerPoint file' }] })).rejects.toThrow();
});

it('advertises document resources as extracted text/plain and serves readable text through MCP', async () => {
  const { knowledge, write } = await fixture();
  await write('guide.docx', word('MCP document'));
  await knowledge.initialize();
  const server = createAikidoMcpServer(knowledge);
  const client = new Client({ name: 'document-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listResources();
    expect(listed.resources.find(resource => resource.uri === 'aikido://guide.docx')?.mimeType).toBe('text/plain');
    expect((await client.readResource({ uri: 'aikido://guide.docx' })).contents[0])
      .toMatchObject({ mimeType: 'text/plain', text: 'MCP document\nTable cell' });
  } finally {
    await client.close();
    await server.close();
  }
});

it('extracts PDFs through a bounded Poppler subprocess and cleans up its private input', async () => {
  const { parent } = await fixture();
  vi.spyOn(processes, 'runProcess').mockImplementation(async (executable, args, cwd, codes, timeout, stderr, env, maxBuffer) => {
    expect(executable).toBe('pdftotext');
    expect(args.slice(0, 3)).toEqual(['-enc', 'UTF-8', '-nopgbrk']);
    expect(await readFile(args[3], 'utf8')).toContain('%PDF-1.7');
    expect(timeout).toBe(30_000);
    expect(maxBuffer).toBe(4096);
    return { stdout: 'PDF lines\r\nSecond line\n', stderr: '', exitCode: 0 };
  });
  expect(await extractDocument('sample.pdf', Buffer.from('%PDF-1.7\nstub'), 4096, parent)).toBe('PDF lines\nSecond line');
  expect((await readdir(parent)).filter(name => name.startsWith('document-'))).toEqual([]);
});

it('reports missing Poppler and scanned PDFs explicitly without preventing other files from indexing', async () => {
  const { knowledge, write } = await fixture();
  await write('missing-tool.pdf', '%PDF-1.7\nmissing tool fixture');
  await write('other.txt', 'Available');
  const run = vi.spyOn(processes, 'runProcess').mockRejectedValue(new Error('pdftotext ENOENT'));
  const trace = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await knowledge.initialize();
  expect(knowledge.list().map(entry => entry.path)).toEqual(['missing-tool.pdf', 'other.txt']);
  expect(knowledge.list()[0].metadata?.contentStatus).toBe('metadata-only');
  expect(knowledge.corpusStatus.skippedFiles[0]).toMatchObject({ file: 'missing-tool.pdf', reason: expect.stringContaining('Poppler') });
  expect(trace).toHaveBeenCalled();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  await knowledge.refresh();
  expect(knowledge.corpusStatus.skippedFiles[0].reason).toContain('no extractable text');
});

it('indexes filesystem metadata for unsupported, binary, oversized and corrupt files, including snapshot search', async () => {
  const { knowledge, write, root } = await fixture({ maxFileBytes: 1024 });
  const binary = Buffer.from([0, 1, 2, 3, 4]);
  await write('photograph.png', binary);
  await write('broken.txt', binary);
  await write('oversized.txt', 'x'.repeat(2048));
  await write('corrupt.xlsx', 'not a spreadsheet');
  await write('.env.secret', 'private');
  await write('ignored.png', binary);
  await write('.gitignore', 'ignored.png');
  await knowledge.initialize();
  for (const file of ['photograph.png', 'broken.txt', 'oversized.txt', 'corrupt.xlsx']) {
    const document = await knowledge.read(file);
    expect(document.entry.metadata).toMatchObject({ contentStatus: 'metadata-only', sizeBytes: expect.any(Number),
      modified: expect.any(String), extension: path.extname(file) });
    expect(document.content).toContain(`Path: "${file}"`);
    const matches = await knowledge.searchIndex.search(file, undefined, 10);
    expect(matches.some(hit => hit.path === file)).toBe(true);
    const compact = JSON.parse(await new Retrieval(knowledge).search({}, matches, {}));
    expect(compact.results.find((entry: { path: string }) => entry.path === file)?.contentStatus).toBe('metadata-only');
  }
  expect(knowledge.list().some(entry => entry.path === '.env.secret' || entry.path === 'ignored.png')).toBe(false);
  const before = (await knowledge.read('photograph.png')).entry.metadata;
  const manager = new SnapshotManager(knowledge);
  const begin = await manager.begin();
  await rm(path.join(root, 'photograph.png'));
  await manager.withSnapshot(String(begin.snapshotId), async snapshot => {
    expect((await snapshot.knowledge.read('photograph.png')).entry.metadata).toEqual(before);
    expect((await snapshot.knowledge.searchIndex.search('photograph.png', undefined, 10))[0].path).toBe('photograph.png');
  });
  await manager.end(String(begin.snapshotId));
});

it('reports incomplete semantic indexing rather than claiming a fresh complete index', async () => {
  const { knowledge, write } = await fixture();
  await write('content.txt', 'Some passages are available');
  await knowledge.initialize();
  vi.stubEnv('KIMONO_MODEL_DIR', 'test-model');
  const realRun = processes.runProcess;
  vi.spyOn(processes, 'runProcess').mockImplementation(async (...args) => {
    if (args[0] !== (process.env.KIMONO_SEMANTIC_BIN ?? 'kimono-semantic')) return realRun(...args);
    return { stdout: JSON.stringify({ engine: 'embsearch-core', version: 'test', model: 'test', chunks: 1,
      embedded: 1, skippedChunks: 2, count: 0, results: [], changes: { added: ['content.txt'], modified: [], deleted: [] } }),
      stderr: '', exitCode: 0 };
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await knowledge.semanticIndex.run('update')).toMatchObject({ skippedChunks: 2 });
  expect(knowledge.semanticIndex.status()).toMatchObject({ skippedChunks: 2 });
  expect(JSON.parse(await readFile(path.join(knowledge.searchIndex.directory, 'semantic-basis.json'), 'utf8')))
    .toMatchObject({ phase: 'partial', lastSuccessful: null });
});

it.runIf(!!process.env.KIMONO_MODEL_DIR)('indexes Office content and binary file metadata with the real semantic engine', async () => {
  const { knowledge, write } = await fixture();
  await write('budget.xlsx', workbook('Quarterly financial budget'));
  await write('diagram.png', Buffer.from([0, 1, 2, 3]));
  await knowledge.initialize();
  const indexed = await knowledge.semanticIndex.run('update');
  expect(indexed.chunks).toBeGreaterThanOrEqual(2);
  const result = await knowledge.semanticIndex.run('search', { query: 'Quarterly financial budget', limit: 10 });
  expect(result.results.find(hit => hit.path === 'budget.xlsx')?.excerpt).toContain('financial budget');
  expect(result.results.find(hit => hit.path === 'diagram.png')?.metadata?.contentStatus).toBe('metadata-only');
}, 60_000);

it.runIf(process.env.KIMONO_TEST_PDF === '1')('extracts text from a real PDF using installed Poppler', async () => {
  const { parent } = await fixture();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 12 Tf 30 250 Td (Local PDF extraction) Tj ET\n';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  expect(await extractDocument('real.pdf', Buffer.from(pdf), 4096, parent)).toBe('Local PDF extraction');
});
