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
