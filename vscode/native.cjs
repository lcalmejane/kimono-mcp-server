"use strict";

const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

async function nativeEnvironment(directory, target = `${process.platform}-${process.arch}`) {
  const root = await fs.realpath(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.target !== target || !manifest.files ||
      typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error(`Install the Kimono VSIX matching the extension host: ${target}.`);
  }
  function asset(relative) {
    if (typeof relative !== "string" || !/^[a-zA-Z0-9_./-]+$/.test(relative) ||
        relative.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error("Unsafe Kimono native asset path.");
    }
    return path.join(root, ...relative.split("/"));
  }
  const required = [manifest.binaries?.fgr, manifest.binaries?.semantic, manifest.onnxRuntime?.library,
    "THIRD_PARTY_NOTICES.md", "versions.json", "licenses/onnxruntime/LICENSE",
    "licenses/onnxruntime/ThirdPartyNotices.txt",
    ...["model.onnx", "tokenizer.json", "model.json", "LICENSE"].map(name => `${manifest.modelDir}/${name}`)];
  for (const relative of required) {
    asset(relative);
    if (!Object.hasOwn(manifest.files, relative)) throw new Error(`Missing Kimono native asset: ${relative}`);
  }
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const filename = asset(relative);
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || await fs.realpath(filename) !== filename ||
        typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid Kimono native asset: ${relative}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    if (hash.digest("hex") !== digest) throw new Error(`Kimono native checksum mismatch: ${relative}`);
  }
  const library = asset(manifest.onnxRuntime.directory);
  return {
    FGR_BIN: asset(manifest.binaries.fgr),
    KIMONO_SEMANTIC_BIN: asset(manifest.binaries.semantic),
    ORT_DYLIB_PATH: asset(manifest.onnxRuntime.library),
    KIMONO_MODEL_DIR: asset(manifest.modelDir),
    PATH: [path.join(root, "bin"), library, process.env.PATH || ""].join(path.delimiter),
    ...(process.platform === "linux" ? { LD_LIBRARY_PATH: library } : {}),
    ...(process.platform === "darwin" ? { DYLD_LIBRARY_PATH: library } : {}),
  };
}

module.exports = { nativeEnvironment };
