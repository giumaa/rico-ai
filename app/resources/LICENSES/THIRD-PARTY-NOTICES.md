# Third-party notices

Rico (MIT, see `Rico-LICENSE.txt`) bundles or downloads the following. Full license texts are in this folder.

| Component | License | File |
|-----------|---------|------|
| Qwen3.5 models (model downloads, "rico-lite") | Apache-2.0 | `Apache-2.0.txt` |
| Gemma 4 models ("rico", "rico-max") | Apache-2.0 + Gemma Prohibited Use Policy (use restrictions that you must pass on) | `Apache-2.0.txt`, `Gemma-Prohibited-Use-Policy.txt` |
| llama.cpp / ggml (`llama-server` sidecar, libmtmd) | MIT | `llama.cpp-MIT.txt` |
| LLVM OpenMP runtime (`libomp.dll`, bundled with the sidecar) | Apache-2.0 with LLVM exception | `LICENSE-LLVM-OpenMP` next to the binary |
| node-llama-cpp | MIT | npm package license |
| Electron / Chromium | MIT / BSD-3-Clause and others | `LICENSE.electron.txt`, `LICENSES.chromium.html` in the app folder |
| Aref Ruqaa, Merienda, JetBrains Mono (bundled fonts) | SIL Open Font License 1.1 | `fonts/*-OFL.txt` |

Models are downloaded (or imported) by the user; they are not part of the installer. Training data notes: Wikipedia-derived
text is CC BY-SA 4.0 (see the `ml/` documentation).
