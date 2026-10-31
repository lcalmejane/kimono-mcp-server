import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import path from 'node:path';
import type { AikidoKnowledgeBase } from './knowledge.js';

export const EMBEDDING_POLICIES = ['auto-balanced', 'auto-speed', 'code', 'multilingual-fast', 'e5'] as const;
export type EmbeddingPolicy = typeof EMBEDDING_POLICIES[number];
export type ModelId = 'code' | 'multilingual-fast' | 'e5';
type DownloadFile = { name: string; bytes: number; sha256: string };
export interface CatalogueModel {
  id: ModelId; repository: string; revision: string; license: string;
  backend: 'model2vec' | 'onnx'; dimensions: number; chunkChars: number;
  downloadBytes: number; estimatedMemoryBytes: number; files: DownloadFile[];
}
const file = (name: string, bytes: number, sha256: string): DownloadFile => ({ name, bytes, sha256 });
const codeFiles = [
  file('model.safetensors', 32490072, '75cf7a6c2171b230ad19b1e7d8e0b1aee86da5a02af8e7cacedd9921d227623c'),
  file('tokenizer.json', 1024340, '107bbdcbad4bff1d299b7a4c3a2fb17c52890688b7dd0e4c9deab79d3c4f3d45'),
  file('config.json', 59, '148e5691a6fcc553437156859701fba017a1ba5d340b170f17e0f3668fb861a7'),
  file('README.md', 5301, '835e4161a3942cd5284d423dbdb4ca69024b671436273142d7512153e770794c'),
];
const multilingualFiles = [
  file('model.safetensors', 512361560, '14b5eb39cb4ce5666da8ad1f3dc6be4346e9b2d601c073302fa0a31bf7943397'),
  file('tokenizer.json', 18616131, '19f1909063da3cfe3bd83a782381f040dccea475f4816de11116444a73e1b6a1'),
  file('config.json', 271, '595e4cab2093732efd5dbe084fd5c1826b5eea693b73b4c1fd971672867d2e54'),
  file('README.md', 5575, '9505454b6a3efbb25257124de875cb73e02bd663a822528525a3c29b1c4d91ac'),
];
export const EMBEDDING_CATALOGUE: readonly CatalogueModel[] = [
  { id: 'code', repository: 'minishlab/potion-code-16M-v2', revision: 'e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b',
    license: 'MIT', backend: 'model2vec', dimensions: 256, chunkChars: 750,
    downloadBytes: codeFiles.reduce((sum, item) => sum + item.bytes, 0),
    estimatedMemoryBytes: 32490072 + 1024340 * 4 + 32 * 1024 * 1024, files: codeFiles },
  { id: 'multilingual-fast', repository: 'minishlab/potion-multilingual-128M', revision: '73908c3438cf03b6a01bcb9611d62b23d0726f08',
    license: 'MIT', backend: 'model2vec', dimensions: 256, chunkChars: 750,
    downloadBytes: multilingualFiles.reduce((sum, item) => sum + item.bytes, 0),
    estimatedMemoryBytes: 512361560 + 18616131 * 4 + 32 * 1024 * 1024, files: multilingualFiles },
  { id: 'e5', repository: 'Xenova/multilingual-e5-small', revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    license: 'MIT', backend: 'onnx', dimensions: 384, chunkChars: 500,
    downloadBytes: 0, estimatedMemoryBytes: 256 * 1024 * 1024, files: [] },
];

export const isCodeSource = (file: string): boolean =>
  /\.(?:c|cc|cpp|cs|h|hpp|fs|fsx|go|java|kt|kts|js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro|css|scss|sass|less|html|php|py|rb|rake|rs|scala|swift|m|mm|sql|graphql|gql|proto|ex|exs|erl|hrl|clj|cljs|dart|lua|r|jl|pl|pm|sh|ps1|bat|cmd|bash|zsh|fish|dockerfile|gradle|tf|tfvars|hcl|cmake)$/i.test(file)
  || /^(?:Dockerfile|Containerfile|Makefile|GNUmakefile|Justfile|Jenkinsfile|Gemfile|Rakefile|Procfile|CMakeLists\.txt)$/i.test(path.posix.basename(file));
/**
 * Policy used when a ROOT has no saved choice and the host sets no KIMONO_EMBEDDING_POLICY.
 * Selected by content type (code, documents or both); the matching model still needs a confirmed download.
 * An explicit `e5` keeps the bundled legacy model, and an existing legacy index is never migrated implicitly.
 */
export const DEFAULT_EMBEDDING_POLICY: EmbeddingPolicy = 'auto-speed';
export function configuredEmbeddingPolicy(): EmbeddingPolicy {
  return embeddingPolicy(process.env.KIMONO_EMBEDDING_POLICY || DEFAULT_EMBEDDING_POLICY);
}
export function embeddingPolicy(value: unknown): EmbeddingPolicy {
  if (!EMBEDDING_POLICIES.some(policy => policy === value)) throw new Error('Invalid embedding policy.');
  return value as EmbeddingPolicy;
}
export function catalogueModel(value: unknown): CatalogueModel {
  const model = EMBEDDING_CATALOGUE.find(item => item.id === value);
  if (!model) throw new Error('Unknown embedding model; only the pinned catalogue is allowed.');
  return model;
}
export interface EmbeddingProfile {
  id: 'multilingual' | 'code'; model: ModelId; directory: string; scope: 'all' | 'code' | 'documents';
}
export interface EmbeddingSelection {
  policy: EmbeddingPolicy; reason: string; signature: string; generation?: string; profiles: EmbeddingProfile[];
}
export interface EmbeddingSettings {
  version: 1; requestedPolicy: EmbeddingPolicy; active?: EmbeddingSelection; error?: string;
}
export function modelsDirectory(root: string): string {
  const directory = path.resolve(process.env.KIMONO_MODELS_DIR ?? path.join(homedir(), '.cache', 'kimono-models'));
  if (directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error('KIMONO_MODELS_DIR must be outside ROOT.');
  return directory;
}
export function modelDirectory(root: string, id: ModelId): string {
  if (id === 'e5') {
    if (!process.env.KIMONO_MODEL_DIR) return path.join(modelsDirectory(root), 'host-e5');
    return path.resolve(root, process.env.KIMONO_MODEL_DIR);
  }
  const model = catalogueModel(id);
  return path.join(modelsDirectory(root), `${id}-${model.revision}`);
}
export function modelDescriptor(model: CatalogueModel) {
  return {
    name: `${model.repository.split('/')[1]}@${model.revision}`, backend: 'model2vec',
    dim: model.dimensions, pooling: 'mean', normalize: true, max_tokens: 32768,
    chunk_chars: model.chunkChars, query_prefix: null, document_prefix: null,
  };
}
async function exists(file: string): Promise<boolean> {
  try { return (await lstat(file)).isFile(); }
  catch (error) { if (missing(error)) return false; throw error; }
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function modelInstalled(root: string, id: ModelId): Promise<boolean> {
  if (id === 'e5') return Boolean(process.env.KIMONO_MODEL_DIR)
    && await exists(path.join(modelDirectory(root, id), 'model.json'))
    && await exists(path.join(modelDirectory(root, id), 'model.onnx'));
  const model = catalogueModel(id), directory = modelDirectory(root, id);
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Model cache must be a regular directory.');
    const descriptor: unknown = JSON.parse(await readFile(path.join(directory, 'model.json'), 'utf8'));
    if (JSON.stringify(descriptor) !== JSON.stringify(modelDescriptor(model))) throw new Error(`Invalid installed descriptor for ${id}; reinstall the model.`);
    for (const item of model.files) {
      const info = await lstat(path.join(directory, item.name));
      if (!info.isFile() || info.size !== item.bytes) throw new Error(`Invalid installed file ${id}/${item.name}; reinstall the model.`);
    }
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}
export function corpusComposition(knowledge: AikidoKnowledgeBase) {
  const codeFiles = knowledge.list().filter(entry => isCodeSource(entry.path)).length;
  return { codeFiles, documentFiles: knowledge.list().length - codeFiles, bytes: knowledge.corpusStatus.bytes };
}
export function resolveEmbedding(knowledge: AikidoKnowledgeBase, policy: EmbeddingPolicy): EmbeddingSelection {
  const corpus = corpusComposition(knowledge);
  const profiles: EmbeddingProfile[] = [];
  const add = (model: ModelId, scope: EmbeddingProfile['scope'], id: EmbeddingProfile['id']) =>
    profiles.push({ id, model, directory: modelDirectory(knowledge.root, model), scope });
  if (policy === 'auto-balanced' || policy === 'auto-speed') {
    if (corpus.codeFiles) add('code', corpus.documentFiles ? 'code' : 'all', 'code');
    if (corpus.documentFiles || !corpus.codeFiles) add(policy === 'auto-speed' ? 'multilingual-fast' : 'e5',
      corpus.codeFiles ? 'documents' : 'all', 'multilingual');
  } else add(policy, 'all', policy === 'code' ? 'code' : 'multilingual');
  const signature = createHash('sha256').update(JSON.stringify(profiles)).digest('hex').slice(0, 24);
  const reason = policy.startsWith('auto-')
    ? `${corpus.codeFiles} code files, ${corpus.documentFiles} documents (${corpus.bytes} UTF-8 bytes): ${profiles.map(profile =>
      `${profile.model} (${profile.scope})`).join(' + ')}. Selection follows content type, not an unmeasured size/quality threshold.`
    : `Manual ${policy} profile for every file; no automatic substitution.`;
  return { policy, reason, signature, profiles };
}
export const embeddingSettingsFile = (knowledge: AikidoKnowledgeBase) =>
  path.join(knowledge.searchIndex.directory, 'embedding-settings.json');
export async function readEmbeddingSettings(knowledge: AikidoKnowledgeBase): Promise<EmbeddingSettings | undefined> {
  let text: string;
  try { text = await readFile(embeddingSettingsFile(knowledge), 'utf8'); }
  catch (error) { if (missing(error)) return undefined; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('requestedPolicy' in value)) throw new Error('Invalid embedding settings.');
  const requestedPolicy = embeddingPolicy(value.requestedPolicy);
  let active: EmbeddingSelection | undefined;
  if ('active' in value && value.active !== undefined) {
    const selected = value.active;
    if (!selected || typeof selected !== 'object' || !('policy' in selected) || !('signature' in selected)
      || typeof selected.signature !== 'string' || !/^[a-f0-9]{24}$/.test(selected.signature)
      || !('reason' in selected) || typeof selected.reason !== 'string'
      || !('profiles' in selected) || !Array.isArray(selected.profiles)
      || !selected.profiles.length || selected.profiles.length > 2) throw new Error('Invalid active embedding selection.');
    const profiles: EmbeddingProfile[] = selected.profiles.map((profile: unknown) => {
      if (!profile || typeof profile !== 'object' || !('model' in profile) || !('scope' in profile)
        || !['all', 'code', 'documents'].includes(String(profile.scope))
        || !('id' in profile) || !['multilingual', 'code'].includes(String(profile.id))
        || !('directory' in profile) || typeof profile.directory !== 'string' || !path.isAbsolute(profile.directory)) {
        throw new Error('Invalid active embedding profile.');
      }
      const model = catalogueModel(profile.model).id;
      if (profile.directory !== modelDirectory(knowledge.root, model)) throw new Error('Embedding model location changed; configure and rebuild explicitly.');
      return { id: profile.id as EmbeddingProfile['id'], model, directory: profile.directory, scope: profile.scope as EmbeddingProfile['scope'] };
    });
    if ('generation' in selected && (typeof selected.generation !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(selected.generation))) {
      throw new Error('Invalid embedding generation.');
    }
    active = { policy: embeddingPolicy(selected.policy), signature: selected.signature, reason: selected.reason, profiles,
      ...('generation' in selected && typeof selected.generation === 'string' ? { generation: selected.generation } : {}) };
    if (createHash('sha256').update(JSON.stringify(profiles)).digest('hex').slice(0, 24) !== active.signature) {
      throw new Error('Invalid active embedding signature.');
    }
  }
  return { version: 1, requestedPolicy, ...(active ? { active } : {}),
    ...('error' in value && typeof value.error === 'string' ? { error: value.error } : {}) };
}
export async function saveEmbeddingSettings(knowledge: AikidoKnowledgeBase, settings: EmbeddingSettings): Promise<void> {
  if (knowledge.immutable) throw new Error('Snapshot model configuration is immutable.');
  await mkdir(knowledge.searchIndex.directory, { recursive: true, mode: 0o700 });
  const pending = `${embeddingSettingsFile(knowledge)}.${randomUUID()}.pending`;
  try {
    await writeFile(pending, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
    await rename(pending, embeddingSettingsFile(knowledge));
  } finally { await rm(pending, { force: true }); }
}
export function assertEmbeddingMemory(selection: EmbeddingSelection): void {
  const percent = Number(process.env.KIMONO_SEMANTIC_MEMORY_PERCENT ?? 80);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('Invalid semantic memory budget.');
  const bytes = selection.profiles.reduce((sum, profile) => sum + catalogueModel(profile.model).estimatedMemoryBytes, 0);
  // Node's freemem excludes reclaimable cache on some hosts; the native runtime checks availability at load time.
  if (bytes > totalmem() * percent / 100) throw new Error(`Embedding profiles need approximately ${bytes} bytes, above the configured physical-memory budget. Choose another profile or increase the budget; no model was substituted.`);
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Live state of a model download, published in `aikido_index status` and `aikido_models status` (in-process). */
export interface ModelDownload {
  model: ModelId; state: 'downloading' | 'verifying' | 'done' | 'error';
  file?: string; fileIndex: number; fileCount: number; bytes: number; totalBytes: number;
  startedAt: string; updatedAt: string; error?: string;
}
const downloads = new Map<ModelId, ModelDownload>();
const FINISHED_DOWNLOAD_VISIBLE_MS = 60_000;
/** Running downloads, plus finished or failed ones for one minute so a panel can show the outcome. */
export function downloadProgress(): ModelDownload[] {
  const now = Date.now();
  for (const [id, item] of downloads) {
    if ((item.state === 'done' || item.state === 'error') && now - Date.parse(item.updatedAt) > FINISHED_DOWNLOAD_VISIBLE_MS) downloads.delete(id);
  }
  return [...downloads.values()].map(item => ({ ...item }));
}
export async function installEmbeddingModel(root: string, id: unknown, confirmed: unknown): Promise<void> {
  if (confirmed !== true) throw new Error('Explicit confirmation is required before downloading an embedding model.');
  const model = catalogueModel(id);
  if (model.id === 'e5') throw new Error('E5 is supplied by the host bundle; it is not downloaded by this operation.');
  if (await modelInstalled(root, model.id)) return;
  const directory = modelDirectory(root, model.id), parent = modelsDirectory(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${directory}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('This model is already being installed. Retry after completion; after a crash an administrator must remove the model lock.');
    throw error;
  });
  const pending = `${directory}.${randomUUID()}.pending`;
  const started = new Date().toISOString();
  const progress: ModelDownload = { model: model.id, state: 'downloading', fileIndex: 0, fileCount: model.files.length,
    bytes: 0, totalBytes: model.files.reduce((sum, item) => sum + item.bytes, 0), startedAt: started, updatedAt: started };
  const publish = (patch: Partial<ModelDownload>): void => {
    Object.assign(progress, patch, { updatedAt: new Date().toISOString() });
    downloads.set(model.id, progress);
  };
  try {
    if (await modelInstalled(root, model.id)) return;
    await mkdir(pending, { mode: 0o700 });
    publish({});
    let completed = 0;
    for (const [index, item] of model.files.entries()) {
      publish({ file: item.name, fileIndex: index + 1, state: 'downloading', bytes: completed });
      const response = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.revision}/${item.name}`,
        { signal: AbortSignal.timeout(15 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}): ${item.name}`);
      if (!response.url.startsWith('https://')) throw new Error('Model download redirected to an insecure endpoint.');
      const target = path.join(pending, item.name);
      const handle = await open(target, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > item.bytes) throw new Error(`Model download exceeds pinned size: ${item.name}`);
          await handle.writeFile(chunk);
          publish({ bytes: completed + bytes });
        }
      } finally { await handle.close(); }
      publish({ state: 'verifying' });
      if (bytes !== item.bytes || await digest(target) !== item.sha256) throw new Error(`Model checksum/size mismatch: ${item.name}`);
      completed += item.bytes;
      publish({ bytes: completed, state: 'downloading' });
    }
    await writeFile(path.join(pending, 'model.json'), JSON.stringify(modelDescriptor(model)), { flag: 'wx', mode: 0o600 });
    await rename(pending, directory);
    publish({ state: 'done', bytes: progress.totalBytes });
  } catch (error) {
    publish({ state: 'error', error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
    throw error;
  } finally {
    await rm(pending, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
