import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Loads the embedded native engine (semantic binary, ONNX Runtime, default model) automatically:
 * KIMONO_BUNDLE_DIR, then native-bundles/<target>, then the newest installed Kimono VS Code extension.
 * Returns undefined when no verified bundle exists on this machine, so real-engine tests skip instead of failing.
 */
const require = createRequire(import.meta.url);
const { nativeEnvironment } = require('../vscode/native.cjs') as {
  nativeEnvironment(directory: string): Promise<Record<string, string>>;
};
const target = `${process.platform}-${process.arch}`;

function candidates(): string[] {
  const list = [process.env.KIMONO_BUNDLE_DIR, path.resolve('native-bundles', target)];
  for (const base of [path.join(homedir(), '.vscode', 'extensions'), path.join(homedir(), '.vscode-server', 'extensions')]) {
    try {
      list.push(...readdirSync(base).filter(name => name.startsWith('ai-kido.kimono-') && name.endsWith(target))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => path.join(base, name, 'native')));
    } catch { /* no extensions folder */ }
  }
  return list.filter((item): item is string => Boolean(item));
}

export async function embeddedNativeEnvironment(): Promise<Record<string, string> | undefined> {
  if (process.env.KIMONO_MODEL_DIR && process.env.ORT_DYLIB_PATH) return {};
  for (const directory of candidates()) {
    try { return await nativeEnvironment(directory); } catch { /* not a valid bundle for this target */ }
  }
  return undefined;
}
