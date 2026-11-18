import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Native search/ONNX workers also use CPU threads; avoid oversubscribing CI hosts.
  test: { setupFiles: ['./tests/setup.ts'], maxWorkers: 2 },
});
