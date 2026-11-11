# Third-party components

Kimono is MIT licensed. These upstream components remain under their own
licenses; Kimono's license does not replace them.

| Component | Version / revision | License / source |
| --- | --- | --- |
| fast-grep | 0.5.0 | [MIT, published crate](https://crates.io/crates/fast-grep/0.5.0) |
| embsearch-core | 0.3.4 | [MIT, published crate](https://crates.io/crates/embsearch-core/0.3.4) |
| fast-xml-parser | See npm lockfile | [MIT, XML parser](https://github.com/NaturalIntelligence/fast-xml-parser) |
| yauzl | See npm lockfile | [MIT, ZIP reader](https://github.com/thejoshwolfe/yauzl) |
| Poppler utilities (Docker/system PDF extraction) | Distribution package | [GPL-2.0-or-later, Poppler](https://poppler.freedesktop.org/) |
| ort Rust bindings | 2.0.0-rc.10 | [MIT / Apache-2.0, published crate](https://crates.io/crates/ort/2.0.0-rc.10) |
| ONNX Runtime | 1.31.0 | [MIT, Microsoft](https://github.com/microsoft/onnxruntime/tree/v1.31.0) |
| ONNX Runtime (`darwin-x64` only) | 1.23.2 | [MIT, Microsoft](https://github.com/microsoft/onnxruntime/tree/v1.23.2); last release with a macOS Intel archive |
| multilingual-e5-small | Xenova revision 761b726dd34fb83930e26aab4e9ac3899aa1fa78 | [ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78), [original model / MIT license declaration](https://huggingface.co/intfloat/multilingual-e5-small) |
| potion-code-16M-v2 (optional download) | e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b | [MIT model card](https://huggingface.co/minishlab/potion-code-16M-v2/blob/e9d2a44ca6a05ac6685f3b23709ea57eb7352d5b/README.md) |
| potion-multilingual-128M (optional download) | 73908c3438cf03b6a01bcb9611d62b23d0726f08 | [MIT model card](https://huggingface.co/minishlab/potion-multilingual-128M/blob/73908c3438cf03b6a01bcb9611d62b23d0726f08/README.md) |

The image retains ONNX Runtime's upstream license and third-party notices in
`/opt/kimono/onnxruntime/`. Model provenance and build checksums are in
`/opt/kimono/versions.json`; the upstream E5 project's MIT license is retained in
`/opt/kimono/model/LICENSE`. Transitive Rust dependencies are recorded in
[Cargo.lock](semantic/Cargo.lock); JavaScript dependencies in
[package-lock.json](package-lock.json).

Optional static models are not bundled or fetched automatically. Confirmed
downloads retain the pinned upstream model card and config alongside the weights;
the model catalogue records SHA256 checksums for every downloaded file.

## Tree-sitter (kimono-semantic)

Grammars statically linked into the semantic engine for definition-aware chunking. Copyleft grammars (GPL/LGPL) are deliberately excluded; see `scripts/tree-sitter-grammars.json` (`_excluded`). `tree-sitter-newick` is under CeCILL-C, a file-level weak copyleft: its own files stay under CeCILL-C.

| Component | Version | License / source |
| --- | --- | --- |
| tree-sitter | 0.27.2 | [MIT, published crate](https://crates.io/crates/tree-sitter/0.27.2) |
| tree-sitter-actions | 0.11.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-actions/0.11.1) |
| tree-sitter-ada | 0.9.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-ada/0.9.2) |
| tree-sitter-adl | 0.7.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-adl/0.7.0) |
| tree-sitter-agda | 1.3.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-agda/1.3.3) |
| tree-sitter-applesoft | 5.0.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-applesoft/5.0.0) |
| tree-sitter-arduino | 0.24.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-arduino/0.24.0) |
| tree-sitter-arkts | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-arkts/0.3.0) |
| tree-sitter-asm | 0.24.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-asm/0.24.0) |
| tree-sitter-astro-next | 0.1.1 | [MIT or Apache-2.0, published crate](https://crates.io/crates/tree-sitter-astro-next/0.1.1) |
| tree-sitter-bash | 0.25.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-bash/0.25.1) |
| tree-sitter-batch | 0.11.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-batch/0.11.1) |
| tree-sitter-bicep | 1.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-bicep/1.1.0) |
| tree-sitter-blk | 1.0.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-blk/1.0.1) |
| tree-sitter-bpf-c | 0.2.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-bpf-c/0.2.3) |
| tree-sitter-bsl | 0.1.7 | [MIT, published crate](https://crates.io/crates/tree-sitter-bsl/0.1.7) |
| tree-sitter-c | 0.24.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-c/0.24.2) |
| tree-sitter-c-sharp | 0.23.5 | [MIT, published crate](https://crates.io/crates/tree-sitter-c-sharp/0.23.5) |
| tree-sitter-ccomment-code-split | 0.20.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-ccomment-code-split/0.20.3) |
| tree-sitter-cfengine | 1.1.12 | [MIT, published crate](https://crates.io/crates/tree-sitter-cfengine/1.1.12) |
| tree-sitter-cfml | 0.26.44 | [MIT, published crate](https://crates.io/crates/tree-sitter-cfml/0.26.44) |
| tree-sitter-clingo | 1.0.6 | [MIT, published crate](https://crates.io/crates/tree-sitter-clingo/1.0.6) |
| tree-sitter-clojure-orchard | 0.2.9 | [CC0-1.0, published crate](https://crates.io/crates/tree-sitter-clojure-orchard/0.2.9) |
| tree-sitter-cmake | 0.7.6 | [MIT, published crate](https://crates.io/crates/tree-sitter-cmake/0.7.6) |
| tree-sitter-comment | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-comment/0.3.0) |
| tree-sitter-commonlisp | 0.4.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-commonlisp/0.4.1) |
| tree-sitter-containerfile | 0.9.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-containerfile/0.9.2) |
| tree-sitter-cpp | 0.23.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-cpp/0.23.4) |
| tree-sitter-crystal | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-crystal/0.1.0) |
| tree-sitter-css | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-css/0.25.0) |
| tree-sitter-cuda | 0.21.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-cuda/0.21.2) |
| tree-sitter-cypher | 0.2.6 | [MIT, published crate](https://crates.io/crates/tree-sitter-cypher/0.2.6) |
| tree-sitter-d | 0.8.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-d/0.8.2) |
| tree-sitter-d2 | 0.7.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-d2/0.7.2) |
| tree-sitter-dafny | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-dafny/0.1.0) |
| tree-sitter-dart | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-dart/0.3.0) |
| tree-sitter-dart-orchard | 0.7.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-dart-orchard/0.7.1) |
| tree-sitter-daslang | 0.6.0 | [BSD-3-Clause, published crate](https://crates.io/crates/tree-sitter-daslang/0.6.0) |
| tree-sitter-devicetree | 0.15.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-devicetree/0.15.0) |
| tree-sitter-diff | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-diff/0.1.0) |
| tree-sitter-dm | 0.26.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-dm/0.26.0) |
| tree-sitter-dshl | 1.0.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-dshl/1.0.0) |
| tree-sitter-elisp | 1.7.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-elisp/1.7.2) |
| tree-sitter-elixir | 0.3.5 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-elixir/0.3.5) |
| tree-sitter-elm | 5.9.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-elm/5.9.4) |
| tree-sitter-embedded-template | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-embedded-template/0.25.0) |
| tree-sitter-epics-db | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-epics-db/0.2.0) |
| tree-sitter-erlang | 0.21.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-erlang/0.21.0) |
| tree-sitter-flatbuffers | 0.1.8 | [MIT, published crate](https://crates.io/crates/tree-sitter-flatbuffers/0.1.8) |
| tree-sitter-fluentbit | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-fluentbit/0.1.0) |
| tree-sitter-fortran | 0.6.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-fortran/0.6.0) |
| tree-sitter-fsharp | 0.3.12 | [MIT, published crate](https://crates.io/crates/tree-sitter-fsharp/0.3.12) |
| tree-sitter-gdscript | 6.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-gdscript/6.1.0) |
| tree-sitter-gdshader | 0.4.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-gdshader/0.4.0) |
| tree-sitter-gh-actions-expressions | 0.5.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-gh-actions-expressions/0.5.1) |
| tree-sitter-gitcommit | 0.5.0 | [WTFPL, published crate](https://crates.io/crates/tree-sitter-gitcommit/0.5.0) |
| tree-sitter-gleam | 1.0.0 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-gleam/1.0.0) |
| tree-sitter-glsl | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-glsl/0.2.0) |
| tree-sitter-go | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-go/0.25.0) |
| tree-sitter-godot-resource | 0.7.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-godot-resource/0.7.0) |
| tree-sitter-golang | 1.27.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-golang/1.27.1) |
| tree-sitter-gomod-orchard | 0.5.8 | [MIT, published crate](https://crates.io/crates/tree-sitter-gomod-orchard/0.5.8) |
| tree-sitter-gosum-orchard | 0.3.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-gosum-orchard/0.3.4) |
| tree-sitter-graphql | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-graphql/0.3.0) |
| tree-sitter-groovy | 0.1.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-groovy/0.1.2) |
| tree-sitter-grug | 0.2.15 | [MIT, published crate](https://crates.io/crates/tree-sitter-grug/0.2.15) |
| tree-sitter-gwbasic | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-gwbasic/0.2.0) |
| tree-sitter-harn | 0.10.196 | [MIT OR Apache-2.0, published crate](https://crates.io/crates/tree-sitter-harn/0.10.196) |
| tree-sitter-haskell | 0.24.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-haskell/0.24.1) |
| tree-sitter-hcl | 1.1.0 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-hcl/1.1.0) |
| tree-sitter-heex | 0.8.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-heex/0.8.1) |
| tree-sitter-hlsl | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-hlsl/0.2.0) |
| tree-sitter-html | 0.23.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-html/0.23.2) |
| tree-sitter-hygen-template | 0.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-hygen-template/0.5.0) |
| tree-sitter-ini | 1.4.0 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-ini/1.4.0) |
| tree-sitter-ink-lbz | 0.0.5 | [MIT, published crate](https://crates.io/crates/tree-sitter-ink-lbz/0.0.5) |
| tree-sitter-integerbasic | 3.0.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-integerbasic/3.0.0) |
| tree-sitter-irules | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-irules/0.2.0) |
| tree-sitter-java | 0.23.5 | [MIT, published crate](https://crates.io/crates/tree-sitter-java/0.23.5) |
| tree-sitter-java-orchard | 0.5.23 | [MIT, published crate](https://crates.io/crates/tree-sitter-java-orchard/0.5.23) |
| tree-sitter-javadoc | 0.3.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-javadoc/0.3.1) |
| tree-sitter-javascript | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-javascript/0.25.0) |
| tree-sitter-jinja-dialects | 0.1.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-jinja-dialects/0.1.1) |
| tree-sitter-jinja2 | 0.0.16 | [MIT, published crate](https://crates.io/crates/tree-sitter-jinja2/0.0.16) |
| tree-sitter-jsdoc | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-jsdoc/0.25.0) |
| tree-sitter-json | 0.24.8 | [MIT, published crate](https://crates.io/crates/tree-sitter-json/0.24.8) |
| tree-sitter-json5-orchard | 0.1.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-json5-orchard/0.1.1) |
| tree-sitter-jsonnet | 0.1.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-jsonnet/0.1.1) |
| tree-sitter-julia | 0.23.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-julia/0.23.1) |
| tree-sitter-kconfig | 1.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-kconfig/1.3.0) |
| tree-sitter-kdl | 2.0.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-kdl/2.0.0) |
| tree-sitter-kotlin-ng | 1.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-kotlin-ng/1.1.0) |
| tree-sitter-lammps | 0.0.8 | [MIT, published crate](https://crates.io/crates/tree-sitter-lammps/0.0.8) |
| tree-sitter-language | 0.1.9 | [MIT, published crate](https://crates.io/crates/tree-sitter-language/0.1.9) |
| tree-sitter-llvm | 1.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-llvm/1.1.0) |
| tree-sitter-lolcode | 0.0.2 | [ISC, published crate](https://crates.io/crates/tree-sitter-lolcode/0.0.2) |
| tree-sitter-lua | 0.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-lua/0.5.0) |
| tree-sitter-luau | 1.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-luau/1.2.0) |
| tree-sitter-mage | 0.4.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-mage/0.4.0) |
| tree-sitter-make | 1.1.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-make/1.1.1) |
| tree-sitter-matlab | 1.3.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-matlab/1.3.3) |
| tree-sitter-md | 0.5.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-md/0.5.4) |
| tree-sitter-mdn | 0.1.7 | [MIT, published crate](https://crates.io/crates/tree-sitter-mdn/0.1.7) |
| tree-sitter-merlin6502 | 4.0.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-merlin6502/4.0.0) |
| tree-sitter-mermaid | 0.3.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-mermaid/0.3.3) |
| tree-sitter-mlir | 0.2.0 | [Apache-2.0 WITH LLVM-exception, published crate](https://crates.io/crates/tree-sitter-mlir/0.2.0) |
| tree-sitter-mozcpp-code-split | 0.20.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-mozcpp-code-split/0.20.4) |
| tree-sitter-mozjs-code-split | 0.20.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-mozjs-code-split/0.20.3) |
| tree-sitter-msbasic2 | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-msbasic2/0.2.0) |
| tree-sitter-muttrc | 0.1.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-muttrc/0.1.4) |
| tree-sitter-netlinx | 1.0.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-netlinx/1.0.4) |
| tree-sitter-newick | 1.1.0 | [CeCILL-C (LICENSE.txt), published crate](https://crates.io/crates/tree-sitter-newick/1.1.0) |
| tree-sitter-nginx | 1.0.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-nginx/1.0.1) |
| tree-sitter-nickel | 0.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-nickel/0.5.0) |
| tree-sitter-nim | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-nim/0.1.0) |
| tree-sitter-nix | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-nix/0.3.0) |
| tree-sitter-objc | 3.0.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-objc/3.0.2) |
| tree-sitter-objectscript | 1.11.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-objectscript/1.11.0) |
| tree-sitter-ocaml | 0.26.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-ocaml/0.26.0) |
| tree-sitter-ocamllex | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-ocamllex/0.25.0) |
| tree-sitter-odin | 1.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-odin/1.3.0) |
| tree-sitter-openscad-ng | 0.7.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-openscad-ng/0.7.1) |
| tree-sitter-owl-ms | 1.4.0 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-owl-ms/1.4.0) |
| tree-sitter-pact | 0.0.10 | [MIT, published crate](https://crates.io/crates/tree-sitter-pact/0.0.10) |
| tree-sitter-pascal | 0.10.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-pascal/0.10.2) |
| tree-sitter-php | 0.25.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-php/0.25.1) |
| tree-sitter-postgres | 1.2.4 | [BSD-3-Clause, published crate](https://crates.io/crates/tree-sitter-postgres/1.2.4) |
| tree-sitter-powershell | 0.26.6 | [MIT, published crate](https://crates.io/crates/tree-sitter-powershell/0.26.6) |
| tree-sitter-preproc-code-split | 0.20.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-preproc-code-split/0.20.3) |
| tree-sitter-printf | 0.5.1 | [ISC, published crate](https://crates.io/crates/tree-sitter-printf/0.5.1) |
| tree-sitter-prisma-io | 1.6.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-prisma-io/1.6.0) |
| tree-sitter-prolog | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-prolog/0.1.0) |
| tree-sitter-properties | 0.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-properties/0.3.0) |
| tree-sitter-proto | 0.6.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-proto/0.6.0) |
| tree-sitter-puppet | 1.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-puppet/1.3.0) |
| tree-sitter-python | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-python/0.25.0) |
| tree-sitter-python-orchard | 0.6.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-python-orchard/0.6.1) |
| tree-sitter-qbasic | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-qbasic/0.2.0) |
| tree-sitter-ql | 0.23.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-ql/0.23.1) |
| tree-sitter-ql-dbscheme | 0.23.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-ql-dbscheme/0.23.1) |
| tree-sitter-qmljs | 0.3.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-qmljs/0.3.1) |
| tree-sitter-quirrel | 4.43.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-quirrel/4.43.3) |
| tree-sitter-r | 1.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-r/1.3.0) |
| tree-sitter-racket | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-racket/0.25.0) |
| tree-sitter-razor | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-razor/0.1.0) |
| tree-sitter-regex | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-regex/0.25.0) |
| tree-sitter-reinhardt-form | 0.3.25 | [BSD-3-Clause, published crate](https://crates.io/crates/tree-sitter-reinhardt-form/0.3.25) |
| tree-sitter-reinhardt-head | 0.3.25 | [BSD-3-Clause, published crate](https://crates.io/crates/tree-sitter-reinhardt-head/0.3.25) |
| tree-sitter-reinhardt-page | 0.3.25 | [BSD-3-Clause, published crate](https://crates.io/crates/tree-sitter-reinhardt-page/0.3.25) |
| tree-sitter-requirements | 0.6.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-requirements/0.6.1) |
| tree-sitter-rigz | 0.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-rigz/0.5.0) |
| tree-sitter-riscv | 0.3.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-riscv/0.3.1) |
| tree-sitter-rsml | 0.1.13 | [MIT, published crate](https://crates.io/crates/tree-sitter-rsml/0.1.13) |
| tree-sitter-rst | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-rst/0.2.0) |
| tree-sitter-ruby | 0.23.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-ruby/0.23.1) |
| tree-sitter-rules | 0.0.6 | [MIT, published crate](https://crates.io/crates/tree-sitter-rules/0.0.6) |
| tree-sitter-rush | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-rush/0.2.0) |
| tree-sitter-rust | 0.24.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-rust/0.24.2) |
| tree-sitter-rust-orchard | 0.16.11 | [MIT, published crate](https://crates.io/crates/tree-sitter-rust-orchard/0.16.11) |
| tree-sitter-scala | 0.26.11 | [MIT, published crate](https://crates.io/crates/tree-sitter-scala/0.26.11) |
| tree-sitter-scheme | 0.25.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-scheme/0.25.0) |
| tree-sitter-sdml | 0.4.14 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-sdml/0.4.14) |
| tree-sitter-sequel | 0.3.13 | [MIT, published crate](https://crates.io/crates/tree-sitter-sequel/0.3.13) |
| tree-sitter-slang | 0.3.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-slang/0.3.1) |
| tree-sitter-slint | 0.24.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-slint/0.24.0) |
| tree-sitter-solidity | 1.2.13 | [MIT, published crate](https://crates.io/crates/tree-sitter-solidity/1.2.13) |
| tree-sitter-souffle | 0.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-souffle/0.5.0) |
| tree-sitter-sparql | 0.25.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-sparql/0.25.2) |
| tree-sitter-starlark | 1.3.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-starlark/1.3.0) |
| tree-sitter-structured-text | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-structured-text/0.1.0) |
| tree-sitter-svelte-ng | 1.0.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-svelte-ng/1.0.2) |
| tree-sitter-swift | 0.7.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-swift/0.7.4) |
| tree-sitter-sysml | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-sysml/0.1.0) |
| tree-sitter-systemverilog | 0.4.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-systemverilog/0.4.1) |
| tree-sitter-t32 | 9.0.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-t32/9.0.3) |
| tree-sitter-templ | 2.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-templ/2.2.0) |
| tree-sitter-tlaplus | 1.5.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-tlaplus/1.5.0) |
| tree-sitter-tmux | 0.1.5 | [MIT, published crate](https://crates.io/crates/tree-sitter-tmux/0.1.5) |
| tree-sitter-toml-ng | 0.7.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-toml-ng/0.7.0) |
| tree-sitter-tsquery | 0.8.0 | [Apache-2.0, published crate](https://crates.io/crates/tree-sitter-tsquery/0.8.0) |
| tree-sitter-typescript | 0.23.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-typescript/0.23.2) |
| tree-sitter-varlink | 0.6.1 | [MIT, published crate](https://crates.io/crates/tree-sitter-varlink/0.6.1) |
| tree-sitter-vb-dotnet | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-vb-dotnet/0.1.0) |
| tree-sitter-verilog | 1.0.3 | [MIT, published crate](https://crates.io/crates/tree-sitter-verilog/1.0.3) |
| tree-sitter-vhdl | 1.4.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-vhdl/1.4.0) |
| tree-sitter-vlang | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-vlang/0.1.0) |
| tree-sitter-vue-next | 0.1.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-vue-next/0.1.0) |
| tree-sitter-wgsl-bevy | 0.1.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-wgsl-bevy/0.1.4) |
| tree-sitter-xcompose | 0.4.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-xcompose/0.4.0) |
| tree-sitter-xml | 0.7.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-xml/0.7.0) |
| tree-sitter-yaml | 0.7.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-yaml/0.7.2) |
| tree-sitter-yarnlock | 0.2.0 | [MIT, published crate](https://crates.io/crates/tree-sitter-yarnlock/0.2.0) |
| tree-sitter-zathurarc | 0.1.7 | [MIT, published crate](https://crates.io/crates/tree-sitter-zathurarc/0.1.7) |
| tree-sitter-zig | 1.1.2 | [MIT, published crate](https://crates.io/crates/tree-sitter-zig/1.1.2) |
| tree-sitter-zsh | 0.63.4 | [MIT, published crate](https://crates.io/crates/tree-sitter-zsh/0.63.4) |
