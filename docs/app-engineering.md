# Rico app — engineering notes (Agent A)

## Engine
- **Primary:** `llama-server` sidecar (vision + text), started by main on `127.0.0.1:<random port>` with a random API key
  (env `LLAMA_API_KEY`, never argv), `--offline`, below-normal priority, threads per performance mode. Binaries come from
  `app/scripts/fetch-llama-server.mjs` (pinned release, sha256-verified) into `app/resources/bin/<os>-<arch>/<variant>/`
  and are shipped through `extraResources`. Run `npm run fetch:llama` before `npm run dev` if you need images locally.
- **Fallback:** node-llama-cpp in a utilityProcess (hardware probe + text-only chat) when the sidecar is missing or blocked.
- Vision limits are decided in main (`tuning.ts`): contexts of 4096 tokens or less accept 2 images per message and ask the UI
  for 896 px images (`ModelEntry.maxImages` / `maxImageEdge`); bigger windows allow 4-6. `-b/-ub` are raised to 1024 whenever
  a projector is loaded (Gemma-style non-causal image attention needs `n_ubatch` >= image tokens).

## Packaging
- `npm run dist:win|mac|linux` fetches the sidecar for that platform, builds, then runs electron-builder.
- Fuses: everything in `electron-builder.yml` is on **except `runAsNode`**. node-llama-cpp's Windows Vulkan binary self-test
  uses `child_process.fork()` inside the engine process; with the fuse off it throws and the probe reports "no GPU"
  (verified with a packaged `--dir` build + `RICO_SMOKE_TEST=1`). Turn the fuse off after the probe stops needing
  node-llama-cpp (e.g. parse `llama-server --list-devices`).
- Licenses: `app/resources/LICENSES/` (Apache-2.0, Gemma Prohibited Use Policy, llama.cpp MIT, OFL fonts, notices) and the
  root `LICENSE` ship in `<resources>/LICENSES`. The dev-only persona glossary is not part of `resources/persona`.

## macOS builds without an Apple certificate
arm64 apps with no signature are reported as "damaged". The build uses an ad-hoc signature (`identity: '-'`); users of such
builds run once:

    xattr -dr com.apple.quarantine /Applications/Rico.app

## Windows Smart App Control
Unsigned binaries (Rico.exe, the NSIS installer, `llama-server.exe`, `ggml-*.dll`, node-llama-cpp `.node`) can be blocked
(Win32 error 4551 / exit code 0xC0E90002). Main reports it with a Libyan guidance message (`engineBlocked`), falls back to
text-only chat, and tells the user why images do not work. The real fix is code signing (see the SignPath plan in `docs/signing.md`).
