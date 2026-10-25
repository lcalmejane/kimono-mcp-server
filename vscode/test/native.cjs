"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { nativeEnvironment } = require("../native.cjs");

test("native manifest validates required assets, target, checksums and traversal", async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), ".local-runtime-native-"));
  const files = [
    "bin/fgr", "bin/kimono-semantic", "lib/libonnxruntime.so",
    "THIRD_PARTY_NOTICES.md", "versions.json", "licenses/onnxruntime/LICENSE",
    "licenses/onnxruntime/ThirdPartyNotices.txt",
    "model/model.onnx", "model/tokenizer.json", "model/model.json", "model/LICENSE",
  ];
  const manifest = {
    schemaVersion: 1, target: "linux-arm64",
    binaries: { fgr: files[0], semantic: files[1] },
    onnxRuntime: { library: files[2], directory: "lib" },
    modelDir: "model", files: {},
  };
  const save = () => fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  try {
    for (const relative of files) {
      await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
      await fs.writeFile(path.join(directory, relative), relative);
      manifest.files[relative] = createHash("sha256").update(relative).digest("hex");
    }
    await save();
    const env = await nativeEnvironment(directory, "linux-arm64");
    assert.equal(env.FGR_BIN, path.join(await fs.realpath(directory), files[0]));
    await assert.rejects(() => nativeEnvironment(directory, "linux-x64"), /matching/);
    await fs.writeFile(path.join(directory, files[0]), "tampered");
    await assert.rejects(() => nativeEnvironment(directory, "linux-arm64"), /checksum mismatch/);
    await fs.writeFile(path.join(directory, files[0]), files[0]);
    manifest.binaries.fgr = "../outside";
    await save();
    await assert.rejects(() => nativeEnvironment(directory, "linux-arm64"), /Unsafe/);
    manifest.binaries.fgr = files[0];
    delete manifest.files["model/model.onnx"];
    await save();
    await assert.rejects(() => nativeEnvironment(directory, "linux-arm64"), /Missing/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
