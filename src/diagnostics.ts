export function debugEnabled(): boolean {
  const level = process.env.KIMONO_LOG_LEVEL ?? 'error';
  if (level !== 'error' && level !== 'debug') throw new Error('KIMONO_LOG_LEVEL must be error or debug');
  return level === 'debug';
}

export function debug(message: string): void {
  if (debugEnabled()) console.error(message.slice(0, 4096));
}

/** Per-operation budget; no file sink, persistent queue or diagnostic history. */
export function nativeDiagnostics(): { line: (value: string) => void; flush: () => void } {
  const detailed = debugEnabled();
  let emitted = 0, progress = 0, omitted = 0;
  return {
    line(value) {
      if (!value.trim()) return;
      if (value.startsWith('KIMONO_PROGRESS ')) {
        if (detailed && progress++ < 20) console.error(value.slice(0, 4096));
        return;
      }
      if (emitted++ < 20) console.error(`Kimono native: ${value.slice(0, 4096)}`);
      else omitted++;
    },
    flush() {
      if (omitted) console.error(`Kimono native: ${omitted} additional diagnostic lines omitted; operation errors and index status remain available`);
    },
  };
}
