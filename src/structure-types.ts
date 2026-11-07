import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * File typing for the structure view. The default table covers everything Kimono can index
 * (RAG_EXTENSIONS / RAG_FILENAMES) plus the common files it cannot (images, fonts, archives,
 * binaries…), so every visible file gets a stable type. Hosts can put their own rules first with
 * KIMONO_TYPES_FILE; a rule may inspect the head of a file to tell apart documents sharing an extension.
 */

export interface TypeInfo { label: string; group: string }

export interface TypeRule {
  /** Glob; without "/" it matches the basename at any depth, otherwise the ROOT-relative path. */
  pattern: string;
  type: string;
  label?: string;
  group?: string;
  /** Regex tested on the first HEAD_BYTES of the file; the rule applies only when it matches. */
  head?: string;
}

export const HEAD_BYTES = 2048;
const MAX_RULES = 512;
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

type Row = [id: string, label: string, group: string, extensions: string[]];

// Extensions are lowercase without the leading dot. Order is irrelevant: each extension is claimed once.
const ROWS: Row[] = [
  // Documentation
  ['md', 'Markdown', 'doc', ['md', 'mdx', 'mdc', 'markdown']],
  ['txt', 'Text', 'doc', ['txt', 'text']],
  ['markup', 'Markup document', 'doc', ['rst', 'adoc', 'tex', 'bib', 'org']],
  ['pdf', 'PDF', 'doc', ['pdf']],
  ['office', 'Office document', 'doc', ['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key']],
  // Web
  ['html', 'HTML', 'web', ['html', 'htm', 'xhtml']],
  ['style', 'Stylesheet', 'web', ['css', 'scss', 'sass', 'less', 'styl']],
  ['component', 'UI component', 'web', ['vue', 'svelte', 'astro']],
  ['template', 'Template', 'web', ['pug', 'hbs', 'handlebars', 'ejs', 'njk', 'twig', 'liquid', 'mustache', 'jinja', 'jinja2', 'j2',
    'erb', 'haml', 'slim', 'tmpl', 'gotmpl', 'jsp', 'jspx', 'cshtml', 'razor', 'heex', 'eex', 'phtml']],
  // Languages
  ['ts', 'TypeScript', 'code', ['ts', 'mts', 'cts']],
  ['tsx', 'TypeScript JSX', 'code', ['tsx']],
  ['js', 'JavaScript', 'code', ['js', 'mjs', 'cjs', 'coffee']],
  ['jsx', 'JavaScript JSX', 'code', ['jsx']],
  ['py', 'Python', 'code', ['py', 'pyi', 'pyw']],
  ['java', 'Java', 'code', ['java']],
  ['kotlin', 'Kotlin', 'code', ['kt', 'kts']],
  ['groovy', 'Groovy', 'code', ['groovy', 'gvy', 'gradle']],
  ['scala', 'Scala', 'code', ['scala', 'sc', 'sbt']],
  ['clojure', 'Clojure', 'code', ['clj', 'cljs', 'cljc', 'edn']],
  ['cs', 'C#', 'code', ['cs', 'csx']],
  ['fs', 'F#', 'code', ['fs', 'fsx', 'fsi']],
  ['vb', 'Visual Basic', 'code', ['vb']],
  ['go', 'Go', 'code', ['go']],
  ['rust', 'Rust', 'code', ['rs']],
  ['c', 'C', 'code', ['c', 'h']],
  ['cpp', 'C++', 'code', ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'inl', 'ipp', 'cu', 'cuh', 'ino']],
  ['zig', 'Zig', 'code', ['zig']],
  ['nim', 'Nim', 'code', ['nim']],
  ['crystal', 'Crystal', 'code', ['cr']],
  ['odin', 'Odin', 'code', ['odin']],
  ['asm', 'Assembly', 'code', ['asm', 's']],
  ['vala', 'Vala', 'code', ['vala']],
  ['swift', 'Swift', 'code', ['swift']],
  ['objc', 'Objective-C', 'code', ['m', 'mm']],
  ['dart', 'Dart', 'code', ['dart']],
  ['gdscript', 'GDScript', 'code', ['gd']],
  ['php', 'PHP', 'code', ['php']],
  ['ruby', 'Ruby', 'code', ['rb', 'rake', 'gemspec']],
  ['perl', 'Perl', 'code', ['pl', 'pm', 't']],
  ['lua', 'Lua', 'code', ['lua']],
  ['r', 'R', 'code', ['r', 'rmd']],
  ['julia', 'Julia', 'code', ['jl']],
  ['tcl', 'Tcl', 'code', ['tcl']],
  ['elixir', 'Elixir', 'code', ['ex', 'exs']],
  ['erlang', 'Erlang', 'code', ['erl', 'hrl']],
  ['haskell', 'Haskell', 'code', ['hs', 'lhs', 'cabal']],
  ['ocaml', 'OCaml', 'code', ['ml', 'mli']],
  ['elm', 'Elm', 'code', ['elm']],
  ['purescript', 'PureScript', 'code', ['purs']],
  ['lisp', 'Lisp', 'code', ['lisp', 'cl', 'el', 'scm', 'rkt']],
  ['fortran', 'Fortran', 'code', ['f', 'f90', 'f95', 'for']],
  ['cobol', 'COBOL', 'code', ['cob', 'cbl']],
  ['pascal', 'Pascal', 'code', ['pas', 'pp', 'dpr']],
  ['ada', 'Ada', 'code', ['adb', 'ads']],
  ['contract', 'Smart contract', 'code', ['sol', 'vy']],
  ['hdl', 'Hardware description', 'code', ['sv', 'svh', 'vhd', 'vhdl']],
  ['shader', 'Shader', 'code', ['glsl', 'vert', 'frag', 'hlsl', 'wgsl', 'shader', 'cginc']],
  // Scripts and build
  ['shell', 'Shell script', 'script', ['sh', 'bash', 'zsh', 'fish', 'ksh', 'nu']],
  ['powershell', 'PowerShell', 'script', ['ps1', 'psm1', 'psd1']],
  ['batch', 'Batch script', 'script', ['bat', 'cmd']],
  ['script', 'Script', 'script', ['awk', 'sed', 'vim', 'ahk']],
  ['build', 'Build file', 'build', ['mk', 'make', 'just', 'bzl', 'bazel', 'star', 'cmake']],
  ['project', 'Project file', 'build', ['csproj', 'fsproj', 'vbproj', 'sln', 'slnx', 'props', 'targets', 'pbxproj']],
  ['manifest', 'Package manifest', 'build', ['mod', 'work']],
  ['lock', 'Lock file', 'build', ['lock', 'sum']],
  // Data, schema and infrastructure
  ['json', 'JSON', 'config', ['json', 'jsonc', 'json5']],
  ['yaml', 'YAML', 'config', ['yaml', 'yml']],
  ['toml', 'TOML', 'config', ['toml']],
  ['config', 'Configuration', 'config', ['ini', 'cfg', 'conf', 'properties', 'config', 'runsettings', 'ruleset', 'ld']],
  ['xml', 'XML', 'data', ['xml', 'xsl', 'xslt', 'xsd', 'wsdl', 'resx', 'xaml', 'axaml', 'storyboard', 'plist', 'entitlements', 'nuspec']],
  ['table', 'Table data', 'data', ['csv', 'tsv']],
  ['dataset', 'Dataset', 'data', ['jsonl', 'ndjson', 'parquet', 'feather', 'arrow', 'avro', 'orc']],
  ['sql', 'SQL', 'data', ['sql']],
  ['database', 'Database', 'data', ['sqlite', 'sqlite3', 'db', 'mdb', 'accdb', 'realm']],
  ['schema', 'Schema', 'data', ['graphql', 'gql', 'proto', 'thrift', 'avsc', 'prisma']],
  ['iac', 'Infrastructure as code', 'infra', ['tf', 'tfvars', 'nomad', 'hcl', 'bicep', 'cue', 'rego', 'nix', 'dhall']],
  ['docker', 'Dockerfile', 'infra', ['dockerfile']],
  // Not indexed by Kimono, but visible in the structure
  ['image', 'Image', 'media', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'icns', 'svg', 'psd', 'ai', 'sketch', 'fig']],
  ['audio', 'Audio', 'media', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'aiff', 'mid', 'midi']],
  ['video', 'Video', 'media', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv']],
  ['font', 'Font', 'media', ['woff', 'woff2', 'ttf', 'otf', 'eot']],
  ['model3d', '3D model', 'media', ['glb', 'gltf', 'obj', 'fbx', 'stl', 'blend', 'usdz']],
  ['archive', 'Archive', 'binary', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'vsix', 'jar', 'war', 'ear', 'nupkg', 'whl', 'apk', 'aab', 'ipa', 'deb', 'rpm']],
  ['binary', 'Binary', 'binary', ['exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'wasm', 'bin', 'node', 'pyc', 'dmg', 'iso', 'pdb', 'lib', 'obj']],
  ['map', 'Source map', 'generated', ['map']],
];

const BY_EXTENSION = new Map<string, string>();
const TYPES = new Map<string, TypeInfo>();
for (const [id, label, group, extensions] of ROWS) {
  TYPES.set(id, { label, group });
  for (const extension of extensions) if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, id);
}
// Types reached by name or path rather than by extension.
const EXTRA: Array<[string, string, string]> = [
  ['file', 'File', 'other'], ['readme', 'Readme', 'doc'], ['license', 'License or notice', 'doc'],
  ['changelog', 'Changelog', 'doc'], ['instructions', 'Agent instructions', 'doc'],
  ['agent', 'Agent or persona', 'aikido'], ['concept', 'Concept', 'aikido'], ['technique', 'Technique', 'aikido'],
  ['use_case', 'Use case', 'aikido'], ['hard_point', 'Hard point', 'aikido'], ['command', 'Command', 'aikido'],
  ['skill', 'Skill', 'aikido'], ['test', 'Test', 'code'], ['ci', 'CI workflow', 'infra'], ['compose', 'Compose file', 'infra'],
  ['ignore', 'Ignore rules', 'config'],
];
for (const [id, label, group] of EXTRA) TYPES.set(id, { label, group });

const BY_NAME = new Map<string, string>();
const named = (id: string, names: string[]) => { for (const name of names) BY_NAME.set(name, id); };
named('docker', ['Dockerfile', 'Containerfile']);
named('build', ['Makefile', 'GNUmakefile', 'Justfile', 'Rakefile', 'Jenkinsfile', 'CMakeLists.txt', 'BUILD', 'WORKSPACE', 'Taskfile',
  'Tiltfile', 'Earthfile', 'Vagrantfile', 'Brewfile', 'Guardfile', 'Capfile', 'Fastfile', 'Appfile']);
named('shell', ['gradlew', 'mvnw']);
named('manifest', ['package.json', 'Cargo.toml', 'pom.xml', 'build.gradle', 'settings.gradle', 'gradle.properties', 'Gemfile', 'Pipfile',
  'Podfile', 'Cartfile', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'go.mod', 'go.work', 'composer.json', 'pyproject.toml',
  'requirements.txt', 'setup.py', 'setup.cfg', 'global.json', 'nuget.config', 'NuGet.Config', 'Directory.Build.props',
  'Directory.Build.targets', 'Directory.Packages.props', 'packages.config', 'dotnet-tools.json', 'MODULE.bazel']);
named('lock', ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'go.work.sum', 'Pipfile.lock', 'poetry.lock',
  'composer.lock', 'Gemfile.lock', 'Podfile.lock', 'bun.lockb']);
named('config', ['.editorconfig', '.gitattributes', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc', '.clang-format', '.clang-tidy',
  '.rubocop.yml', '.tool-versions', '.node-version', '.python-version', '.ruby-version', 'Procfile', 'Caddyfile', 'launchSettings.json']);
named('ignore', ['.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore']);
named('instructions', ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.clinerules', '.roorules', '.windsurfrules', 'copilot-instructions.md']);

const NAME_PATTERNS: Array<[RegExp, string]> = [
  [/^README(?:\.|$)/i, 'readme'],
  [/^(?:LICENSE|LICENCE|COPYING|NOTICE|THIRD_PARTY_NOTICES)(?:\.|$)/i, 'license'],
  [/^(?:CHANGELOG|CHANGES|HISTORY|RELEASES)(?:\.|$)/i, 'changelog'],
  [/^(?:Dockerfile|Containerfile)\./, 'docker'],
  [/^(?:docker-)?compose(?:\..+)?\.ya?ml$/i, 'compose'],
  [/^SKILL\.md$/, 'skill'],
  [/\.(?:test|spec)\.[a-z0-9]+$/i, 'test'],
];
// AI-KIDO memory-bank conventions, applied to Markdown only (same order as the historical `type` filter).
const MARKDOWN_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)(?:personas|agents)\//, 'agent'], [/(^|\/)concepts\//, 'concept'], [/(^|\/)techniques\//, 'technique'],
  [/(^|\/)use_cases\//, 'use_case'], [/(^|\/)hard_points\//, 'hard_point'], [/(^|\/)commands\//, 'command'],
];

/** Pure path-based type from the built-in tables (no file access). */
export function defaultType(file: string): string {
  const basename = path.posix.basename(file);
  const byName = BY_NAME.get(basename);
  if (byName) return byName;
  for (const [pattern, id] of NAME_PATTERNS) if (pattern.test(basename)) return id;
  if (/^\.github\/workflows\//.test(file)) return 'ci';
  const extension = path.posix.extname(basename).slice(1).toLowerCase();
  if (BY_EXTENSION.get(extension) === 'md') {
    for (const [pattern, id] of MARKDOWN_PATHS) if (pattern.test(file)) return id;
  }
  return BY_EXTENSION.get(extension) ?? 'file';
}

export function defaultTypes(): ReadonlyMap<string, TypeInfo> { return TYPES; }

interface CompiledRule extends TypeRule { head?: string; test: RegExp | undefined; basename: boolean }

export class TypeResolver {
  readonly fingerprint: string;
  private readonly rules: CompiledRule[];
  private readonly custom = new Map<string, TypeInfo>();

  constructor(rules: TypeRule[] = []) {
    this.rules = rules.map(rule => ({ ...rule, basename: !rule.pattern.includes('/'), test: rule.head ? new RegExp(rule.head, 'm') : undefined }));
    for (const rule of rules) {
      if (rule.label || rule.group) {
        const known = TYPES.get(rule.type);
        this.custom.set(rule.type, { label: rule.label ?? known?.label ?? rule.type, group: rule.group ?? known?.group ?? 'other' });
      }
    }
    this.fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 12);
  }

  get customRules(): number { return this.rules.length; }

  info(id: string): TypeInfo { return this.custom.get(id) ?? TYPES.get(id) ?? { label: id, group: 'other' }; }

  /** `readHead` is only called when a rule whose pattern matched also carries a `head` regex. */
  async resolve(file: string, readHead?: () => Promise<string | undefined>): Promise<string> {
    if (this.rules.length) {
      const basename = path.posix.basename(file);
      let head: string | undefined;
      let loaded = false;
      for (const rule of this.rules) {
        if (!path.posix.matchesGlob(rule.basename ? basename : file, rule.pattern)) continue;
        if (rule.test) {
          if (!readHead) continue;
          if (!loaded) { head = await readHead(); loaded = true; }
          if (head === undefined || !rule.test.test(head)) continue;
        }
        return rule.type;
      }
    }
    return defaultType(file);
  }
}

export function parseTypeRules(value: unknown): TypeRule[] {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as Record<string, unknown>).rules : undefined;
  if (!Array.isArray(list) || list.length > MAX_RULES) throw new Error(`Kimono types file must hold up to ${MAX_RULES} rules (array or {"rules": [...]})`);
  return list.map((raw: unknown, index) => {
    const where = `types rule #${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} must be an object`);
    const rule = raw as Record<string, unknown>;
    for (const key of Object.keys(rule)) if (!['pattern', 'type', 'label', 'group', 'head'].includes(key)) throw new Error(`${where}: unknown option ${key}`);
    const { pattern, type, label, group, head } = rule;
    if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || /[\\\0\r\n]/.test(pattern) || path.posix.isAbsolute(pattern)
      || pattern.split('/').some(part => part === '..')) throw new Error(`${where}: pattern must be a ROOT-relative glob`);
    if (typeof type !== 'string' || !ID.test(type)) throw new Error(`${where}: type must match ${ID}`);
    if (label !== undefined && (typeof label !== 'string' || !label || label.length > 64 || /[\0-\x1f]/.test(label))) throw new Error(`${where}: invalid label`);
    if (group !== undefined && (typeof group !== 'string' || !ID.test(group))) throw new Error(`${where}: invalid group`);
    if (head !== undefined) {
      if (typeof head !== 'string' || !head || head.length > 256) throw new Error(`${where}: head must be a regex of at most 256 characters`);
      try { new RegExp(head, 'm'); } catch { throw new Error(`${where}: head is not a valid regex`); }
    }
    return { pattern, type, ...(label !== undefined ? { label } : {}), ...(group !== undefined ? { group } : {}),
      ...(head !== undefined ? { head } : {}) } as TypeRule;
  });
}

let cached: { key: string; resolver: TypeResolver } | undefined;
const DEFAULT_RESOLVER = new TypeResolver();

/** Resolver for the host's KIMONO_TYPES_FILE (re-read when the file changes); built-in table otherwise. */
export async function loadTypeResolver(): Promise<TypeResolver> {
  const filename = process.env.KIMONO_TYPES_FILE;
  if (!filename) return DEFAULT_RESOLVER;
  if (!path.isAbsolute(filename)) throw new Error('KIMONO_TYPES_FILE must be an absolute path');
  let info;
  try { info = await stat(filename); }
  catch (error) { throw new Error(`Cannot read Kimono types file: ${filename}`, { cause: error }); }
  const key = `${filename}\0${info.size}\0${info.mtimeMs}`;
  if (cached?.key === key) return cached.resolver;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot parse Kimono types file: ${filename}`, { cause: error }); }
  cached = { key, resolver: new TypeResolver(parseTypeRules(parsed)) };
  return cached.resolver;
}

export async function readHead(filename: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(filename, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return undefined; }
  finally { await handle?.close(); }
}
