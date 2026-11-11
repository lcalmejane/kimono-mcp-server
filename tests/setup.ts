process.env.KIMONO_SEMANTIC_PERSISTENT_WORKER ??= 'false';
// Legacy suites drive the bundled ONNX model through KIMONO_MODEL_DIR. The product default is auto-speed, which needs a
// confirmed model download, so these suites pin the legacy policy; managed-profile suites and the default test set their own.
process.env.KIMONO_EMBEDDING_POLICY ??= 'e5';
// Capture-level suites expect one snapshot per begin/end. The product default (prompt: shared, idle-closed
// snapshots) is covered by tests/snapshot-scope.test.ts, which sets its own scope.
process.env.KIMONO_SNAPSHOT_SCOPE ??= 'call';
