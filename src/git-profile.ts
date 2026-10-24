import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProcess } from './process.js';

export interface GitReadProfile {
  host: string;
  transport: 'ssh' | 'https';
  username: string;
  secret: string;
  knownHosts?: string;
}

interface Profile extends GitReadProfile {
  knownHosts: string;
  authorName: string;
  authorEmail: string;
}

export interface GitContext {
  env?: NodeJS.ProcessEnv;
  args: string[];
  validateUrl(url: string): void;
}

export interface GitCredentialRequest {
  gitUrl: string;
  branch?: string | null;
  connectionId?: string;
}

export type GitCredentialResolver = (request: GitCredentialRequest) => Promise<GitReadProfile | null>;

const requestProfiles = new AsyncLocalStorage<GitReadProfile | null>();

export function withGitProfileContext<T>(profile: GitReadProfile | null, action: () => T): T {
  return requestProfiles.run(profile, action);
}

export function currentGitProfileContext(): GitReadProfile | null | undefined {
  return requestProfiles.getStore();
}

export function parseGitProfileHeader(encoded: string): GitReadProfile {
  try {
    if (!encoded || encoded.length > 90_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 64 * 1024 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error();
    return parseGitReadProfile(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error('Invalid trusted Git profile header');
  }
}

export async function readGitProfileFile(root: string): Promise<GitReadProfile | null> {
  const configured = process.env.KIMONO_GIT_PROFILE_FILE;
  if (!configured) return null;
  try {
    if (!path.isAbsolute(configured)) throw new Error();
    const configuredPath = path.resolve(configured);
    const info = await lstat(configuredPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 65536
      || ![0o600, 0o400].includes(info.mode & 0o777)) throw new Error();
    const file = await realpath(configuredPath);
    const rootPath = path.resolve(root);
    let actualRoot = rootPath;
    try { actualRoot = await realpath(rootPath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if ([rootPath, actualRoot].some(base => file === base || file.startsWith(`${base}${path.sep}`))) throw new Error();
    return parseGitReadProfile(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    throw new Error('Invalid or unavailable KIMONO_GIT_PROFILE_FILE');
  }
}

export async function withGitProfile<T>(root: string, action: (context: GitContext) => Promise<T>): Promise<T> {
  const configured = process.env.KIMONO_GIT_PROFILE_FILE;
  if (!configured) return action({ args: [], validateUrl: () => undefined });
  let profile: Profile;
  try {
    if (!path.isAbsolute(configured)) throw new Error('Git profile path must be absolute');
    const configuredPath = path.resolve(configured);
    const info = await lstat(configuredPath);
    if (info.isSymbolicLink()) throw new Error('Git profile must not be a symbolic link');
    const file = await realpath(configuredPath);
    const rootPath = path.resolve(root);
    let actualRoot = rootPath;
    try { actualRoot = await realpath(rootPath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if ([rootPath, actualRoot].some((base) => file === base || file.startsWith(`${base}${path.sep}`))) {
      throw new Error('Git profile must be outside AIKIDO_ROOT');
    }
    if (!info.isFile() || info.size > 65536 || ![0o600, 0o400].includes(info.mode & 0o777)) {
      throw new Error('Git profile must be a regular file <=64 KiB with owner-only permissions (0600/0400)');
    }
    profile = parseProfile(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // Never include JSON/parser diagnostics: they can contain credentials.
    console.error('Unable to load the configured Git profile; check its location, permissions and schema');
    throw new Error('Invalid or unavailable KIMONO_GIT_PROFILE_FILE');
  }
  return withProfile(profile, action);
}

export async function withRemoteGitProfile<T>(
  profileInput: GitReadProfile | null,
  privateHome: string,
  action: (context: GitContext) => Promise<T>,
): Promise<T> {
  if (!profileInput) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_') || key.startsWith('SSH_')) delete env[key];
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      HOME: privateHome,
      XDG_CONFIG_HOME: privateHome,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
    return action({
      args: ['-c', 'http.followRedirects=false', '-c', 'http.extraHeader=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always'],
      env, validateUrl: () => undefined,
    });
  }
  return withProfile(toProfile(parseGitReadProfile(profileInput)), action);
}

async function withProfile<T>(profile: Profile, action: (context: GitContext) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimono-git-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') || key.startsWith('SSH_')) delete env[key];
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: profile.authorName, GIT_AUTHOR_EMAIL: profile.authorEmail,
    GIT_COMMITTER_NAME: profile.authorName, GIT_COMMITTER_EMAIL: profile.authorEmail,
    GIT_SSH_VARIANT: 'ssh',
  });
  const args = ['-c', 'credential.helper=', '-c', 'credential.interactive=false',
    '-c', 'http.followRedirects=false', '-c', 'http.extraHeader=',
    '-c', 'protocol.allow=never', '-c', `protocol.${profile.transport}.allow=always`];
  try {
    if (profile.transport === 'https') {
      const askpass = path.join(directory, 'askpass');
      await writeFile(askpass, `#!${process.execPath}\nprocess.stdout.write(process.argv[2]?.includes('Username') ? process.env.KIMONO_GIT_USERNAME : process.env.KIMONO_GIT_TOKEN);\n`, { mode: 0o700 });
      env.GIT_ASKPASS = askpass;
      env.KIMONO_GIT_USERNAME = profile.username;
      env.KIMONO_GIT_TOKEN = profile.secret;
    } else {
      const key = path.join(directory, 'key');
      const hosts = path.join(directory, 'known_hosts');
      await writeFile(key, profile.secret + '\n', { mode: 0o600 });
      await writeFile(hosts, profile.knownHosts + '\n', { mode: 0o600 });
      try {
        await runProcess('ssh-keygen', ['-y', '-P', '', '-f', key], directory);
        await runProcess('ssh-keygen', ['-l', '-f', hosts], directory);
      } catch { throw new Error('Invalid SSH key (passphrases unsupported) or known_hosts'); }
      const wrapper = path.join(directory, 'ssh');
      const sshOptions = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${hosts}`,
        '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=15',
        '-l', profile.username, '-i', key];
      await writeFile(wrapper, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst result=spawnSync('ssh', [...${JSON.stringify(sshOptions)}, ...process.argv.slice(2)], {stdio:'inherit'});\nif(result.error) { console.error('SSH execution failed'); process.exit(1); }\nprocess.exit(result.status ?? 1);\n`, { mode: 0o700 });
      // Git can otherwise use core.sshCommand from the repository.
      env.GIT_SSH = wrapper;
      args.push('-c', `core.sshCommand=${quote(wrapper)}`);
    }
    const result = await action({
      env, args,
      validateUrl(url) {
        const normalized = url.replace(/^git@([^:]+):/, 'ssh://git@$1/');
        let parsed: URL;
        try { parsed = new URL(normalized); }
        catch { throw new Error('Managed Git profile requires an HTTPS or SSH remote'); }
        if (parsed.protocol !== `${profile.transport}:` || parsed.hostname.toLowerCase() !== profile.host
          || parsed.password || parsed.search || parsed.hash
          || parsed.port && parsed.port !== (profile.transport === 'ssh' ? '22' : '443')
          || parsed.username && (profile.transport === 'https' || decodeURIComponent(parsed.username) !== profile.username)) {
          throw new Error('Git remote does not match the configured profile host, transport, port or username');
        }
      },
    });
    return result;
  } catch {
    // Git errors can include credentials from helpers or remote output.
    throw new Error('Managed Git operation failed: verify profile, remote host/transport, server keys, repository permissions and Git arguments');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function parseProfile(raw: unknown): Profile {
  const readProfile = parseGitReadProfile(raw);
  const data = raw as Record<string, unknown>;
  const authorName = data.authorName;
  const authorEmail = data.authorEmail;
  if (typeof authorName !== 'string' || !authorName.trim() || /[\r\n]/.test(authorName)
    || typeof authorEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(authorEmail)) {
    throw new Error('Invalid profile identity');
  }
  return { ...readProfile, knownHosts: readProfile.knownHosts ?? '', authorName, authorEmail };
}

function parseGitReadProfile(raw: unknown): GitReadProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected profile object');
  const data = raw as Record<string, unknown>;
  const string = (key: string, maximum = 32768) => {
    const value = data[key];
    if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error('Invalid profile field');
    return value;
  };
  const host = string('host', 253).toLowerCase();
  const username = string('username', 128);
  const secret = string('secret', 32768);
  if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)
    || !/^[a-zA-Z0-9_.@+-]+$/.test(username)
    || !['ssh', 'https'].includes(String(data.transport))) throw new Error('Invalid profile schema');
  const transport = data.transport === 'ssh' ? 'ssh' : 'https';
  const knownHosts = transport === 'ssh' ? string('knownHosts', 16384) : undefined;
  if (transport === 'https' && /[\r\n]/.test(secret)) throw new Error('Invalid token');
  if (transport === 'ssh' && !knownHosts!.trim().split('\n').every((line) => {
    const [server, algorithm, key] = line.trim().split(/\s+/);
    return server === host && /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/.test(algorithm ?? '')
      && /^[A-Za-z0-9+/]+={0,3}$/.test(key ?? '');
  })) throw new Error('known_hosts must contain verified keys for the exact profile host');
  return { host, transport, username, secret, ...(knownHosts !== undefined ? { knownHosts } : {}) };
}

function toProfile(profile: GitReadProfile): Profile {
  return {
    ...profile,
    knownHosts: profile.knownHosts ?? '',
    authorName: '',
    authorEmail: '',
  };
}
