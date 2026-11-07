import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DOCUMENT_EXTENSIONS } from './documents.js';

export interface CorpusConfig {
  mode: 'aikido' | 'rag';
  extensions: string[];
  filenames: string[];
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  maxFiles: number;
  maxCorpusBytes: number;
  snapshotMaxBytes: number;
  snapshotsTotalBytes: number;
  maxSnapshots: number;
  snapshotTtlMs: number;
}

const MIB = 1024 * 1024;
export const AIKIDO_EXTENSIONS = [
  '.md', '.mdx', '.mdc', '.txt', '.json', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.sh', '.py', '.ts', '.xml',
];
// Extensions are grouped by ecosystem so a missing language is easy to spot; the list is the
// default RAG allowlist and can still be replaced wholesale through the `extensions` option.
export const RAG_EXTENSIONS = [...new Set([...AIKIDO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  // Web
  '.tsx', '.jsx', '.mts', '.cts', '.vue', '.svelte', '.astro', '.css', '.scss', '.sass', '.less', '.html', '.htm',
  '.jsonc', '.json5', '.coffee', '.pug', '.hbs', '.handlebars', '.ejs', '.njk', '.twig', '.liquid', '.mustache',
  '.jinja', '.jinja2', '.j2', '.erb', '.haml', '.slim', '.xsl', '.xslt', '.xsd', '.wsdl',
  // JVM
  '.java', '.jsp', '.jspx', '.kt', '.kts', '.groovy', '.gvy', '.gradle', '.scala', '.sc', '.sbt', '.clj', '.cljs',
  '.cljc', '.edn', '.properties',
  // .NET (C#, F#, VB.NET, Razor, WPF/MAUI/Avalonia, MSBuild/NuGet project files)
  '.cs', '.csx', '.fs', '.fsx', '.fsi', '.vb', '.cshtml', '.razor', '.xaml', '.axaml', '.resx', '.csproj', '.fsproj',
  '.vbproj', '.sln', '.slnx', '.props', '.targets', '.nuspec', '.config', '.runsettings', '.ruleset', '.bicep',
  // Go
  '.go', '.mod', '.sum', '.work', '.tmpl', '.gotmpl',
  // Systems
  '.rs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.inl', '.ipp', '.cu', '.cuh', '.ino', '.zig',
  '.nim', '.cr', '.odin', '.asm', '.s', '.ld', '.vala',
  // Apple and mobile
  '.swift', '.m', '.mm', '.dart', '.gd', '.pbxproj', '.plist', '.entitlements', '.storyboard',
  // Scripting
  '.php', '.phtml', '.rb', '.rake', '.gemspec', '.py', '.pyi', '.pyw', '.pl', '.pm', '.t', '.lua', '.r', '.rmd',
  '.jl', '.tcl', '.awk', '.sed', '.vim', '.ahk',
  // Functional and others
  '.ex', '.exs', '.heex', '.eex', '.erl', '.hrl', '.hs', '.lhs', '.cabal', '.ml', '.mli', '.elm', '.purs', '.lisp',
  '.cl', '.el', '.scm', '.rkt', '.f', '.f90', '.f95', '.for', '.cob', '.cbl', '.pas', '.pp', '.dpr', '.adb', '.ads',
  '.sol', '.vy', '.sv', '.svh', '.vhd', '.vhdl',
  // Shell and automation
  '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.bash', '.zsh', '.fish', '.ksh', '.nu', '.mk', '.make', '.just',
  // Data, API and infrastructure
  '.sql', '.graphql', '.gql', '.proto', '.thrift', '.avsc', '.prisma', '.dockerfile', '.ini', '.cfg', '.conf',
  '.tf', '.tfvars', '.hcl', '.nomad', '.cue', '.rego', '.nix', '.dhall', '.bzl', '.bazel', '.star',
  '.cmake', '.tex', '.bib', '.rst', '.adoc', '.csv', '.tsv',
  // Game and shader languages
  '.glsl', '.vert', '.frag', '.hlsl', '.wgsl', '.shader', '.cginc',
])];
// Build and project files without a distinctive extension.
export const RAG_FILENAMES = ['Dockerfile', 'Containerfile', 'Makefile', 'GNUmakefile', 'Justfile', 'Jenkinsfile', 'Gemfile', 'Rakefile',
  'Procfile', 'CMakeLists.txt', 'README', 'LICENSE', 'NOTICE', 'CHANGELOG',
  // Go
  'go.mod', 'go.sum', 'go.work', 'go.work.sum',
  // .NET
  'global.json', 'nuget.config', 'NuGet.Config', 'Directory.Build.props', 'Directory.Build.targets',
  'Directory.Packages.props', 'packages.config', 'dotnet-tools.json', 'launchSettings.json',
  // JVM, Python, Ruby, Apple, Elixir, Dart, others
  'gradlew', 'mvnw', 'pom.xml', 'build.gradle', 'settings.gradle', 'gradle.properties', 'Pipfile', 'Podfile', 'Cartfile',
  'Vagrantfile', 'Brewfile', 'Guardfile', 'Capfile', 'Fastfile', 'Appfile', 'Tiltfile', 'Earthfile', 'Caddyfile',
  'Taskfile', 'BUILD', 'WORKSPACE', 'MODULE.bazel', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'Cargo.toml',
  '.editorconfig', '.gitattributes', '.dockerignore', '.nvmrc', '.prettierrc', '.eslintrc', '.babelrc',
  '.clang-format', '.clang-tidy', '.rubocop.yml', '.tool-versions', '.node-version', '.python-version', '.ruby-version'];

export function corpusConfig(value: unknown = {}): Readonly<CorpusConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Kimono corpus config must be a JSON object');
  const input = value as Record<string, unknown>;
  const mode = input.mode ?? 'rag';
  if (mode !== 'aikido' && mode !== 'rag') throw new Error('Kimono corpus mode must be aikido or rag');
  const defaults: CorpusConfig = {
    mode, extensions: mode === 'rag' ? RAG_EXTENSIONS : AIKIDO_EXTENSIONS,
    filenames: mode === 'rag' ? RAG_FILENAMES : [],
    include: [], exclude: [], maxFileBytes: mode === 'rag' ? 4 * MIB : 2 * MIB,
    maxFiles: 100_000, maxCorpusBytes: 512 * MIB,
    snapshotMaxBytes: mode === 'rag' ? 256 * MIB : 64 * MIB,
    snapshotsTotalBytes: mode === 'rag' ? 512 * MIB : 256 * MIB,
    maxSnapshots: 8, snapshotTtlMs: 15 * 60 * 1000,
  };
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown Kimono corpus option: ${key}`);
  for (const key of ['extensions', 'filenames', 'include', 'exclude'] as const) {
    const list = input[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 256 || !list.every((item: unknown): item is string =>
      typeof item === 'string' && item.length > 0 && item.length <= 512 && !/[\\\0\r\n]/.test(item))) {
      throw new Error(`${key} must be an array of up to 256 nonempty strings`);
    }
    if (key === 'extensions' && list.some(item => !/^\.[a-z0-9]+$/i.test(item))) throw new Error('extensions must use leading dots, e.g. .tsx');
    if (key === 'filenames' && list.some(item => item.includes('/') || item === '.' || item === '..')) throw new Error('filenames must be basenames');
    if ((key === 'include' || key === 'exclude') && list.some(item =>
      path.posix.isAbsolute(item) || item.includes(':') || item.startsWith('!') || item.split('/').some(part => part === '..' || part === '.'))) {
      throw new Error(`${key} must contain ROOT-relative glob patterns without traversal or negation`);
    }
    defaults[key] = [...new Set(key === 'extensions' ? list.map(item => item.toLowerCase()) : list)];
  }
  const ranges = {
    maxFileBytes: [1, 64 * MIB], maxFiles: [1, 1_000_000], maxCorpusBytes: [1, 8 * 1024 * MIB],
    snapshotMaxBytes: [1, 8 * 1024 * MIB], snapshotsTotalBytes: [1, 16 * 1024 * MIB],
    maxSnapshots: [1, 32], snapshotTtlMs: [1000, 24 * 60 * 60 * 1000],
  };
  for (const key of Object.keys(ranges) as Array<keyof typeof ranges>) {
    const number = input[key];
    if (number === undefined) continue;
    const [min, max] = ranges[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
    defaults[key] = number;
  }
  if (defaults.snapshotMaxBytes > defaults.snapshotsTotalBytes) throw new Error('snapshotMaxBytes must not exceed snapshotsTotalBytes');
  for (const key of ['extensions', 'filenames', 'include', 'exclude'] as const) Object.freeze(defaults[key]);
  return Object.freeze(defaults);
}

export function loadCorpusConfig(): Readonly<CorpusConfig> {
  const filename = process.env.KIMONO_CONFIG_FILE;
  let input: unknown = {};
  if (filename) {
    if (!path.isAbsolute(filename)) throw new Error('KIMONO_CONFIG_FILE must be an absolute path');
    try { input = JSON.parse(readFileSync(filename, 'utf8')); }
    catch (error) { throw new Error(`Cannot read Kimono corpus config: ${filename}`, { cause: error }); }
  }
  if (process.env.KIMONO_CORPUS_MODE !== undefined) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Kimono corpus config must be a JSON object');
    input = { ...input, mode: process.env.KIMONO_CORPUS_MODE };
  }
  return corpusConfig(input);
}
