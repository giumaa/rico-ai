# Review round 1 — action items (owner in brackets)

## Critical
1. [A] Download fallback broken: catalog.ts:56-99 / modelManager.ts:494-519 ignore fallbackSha256/fallbackSizeBytes on files[0] (packaged:true convention) and only know `fallbackFiles`. Single HF file is tried against shard-1 size/sha → always SizeMismatchError; shards 2..N have no fallback. Fix in parseCatalog: if files[0].fallbackUrl && (f0.fallbackSha256 || files.length>1) && !model.fallbackFiles → model.fallbackFiles=[{url:files[0].fallbackUrl, sha256:f0.fallbackSha256, sizeBytes:f0.fallbackSizeBytes}]; delete files[0].fallbackUrl. Keep per-file fallbackUrl for mmproj only. Add a test parsing the real models/catalog.json.
2. [D] build-app.yml:52-56 never runs fetch-llama-server.mjs → installers ship without llama-server (no vision). Add matrix field plat (win-x64|mac-arm64|mac-x64|linux-x64), run `node scripts/fetch-llama-server.mjs --platform ${{matrix.plat}}` with GITHUB_TOKEN env, then assert the binary exists.
3. [D] package-models.yml:118 / train-kaggle.yml:107 use --clobber on same-named assets with new bytes → shipped apps' bundled sha256 fail forever. Never clobber a referenced name: new tag (models-v2…) or versioned filenames; clobber only if bytes identical.

## High
4. [A] modelManager.ts:517 / downloader.ts:285-297: .part deleted after every failed URL incl. last; retry counter never resets after progress. Only delete .part if next URL has a different sha256; reset attempt=0 when received grew; ~8 consecutive no-progress failures.
5. [A] serverEngine.ts:290-319,374: this.child set only after /health OK → stop/unload/shutdown can't kill a starting server (orphan multi-GB process, EBUSY on remove). Set this.starting=child right after spawn; stop() kills it; startup poll checks a cancelled flag.
6. [D+A] Smart App Control blocks unsigned binaries (Rico.exe, NSIS, llama-server.exe, ggml-*.dll, node-llama-cpp .node). Free path: SignPath Foundation (needs OSI LICENSE at root — orchestrator adds MIT; package.json license must match). [D] build llama-server from source in CI (cmake, -DGGML_VULKAN=ON + CPU, pinned b11321) and prepare an (initially disabled) SignPath signing job: electron-builder --dir → zip → signpath/github-action-submit-signing-request (deep-sign *.exe,*.dll,*.node) → electron-builder --prepackaged → sign installer. Document in docs/signing.md. [A] add msg('engineBlocked') with guidance when classifyServerExit==='blocked'.
7. [D] ml/collect_recent.py:165-168: TextExtracts returns a full extract for only ONE page per request without exintro → 19/20 pages silently dropped (only 76 articles). Fetch one title per call or follow continue.excontinue fully. Re-run collection.

## Medium
8. [A] electron-builder.yml: add electronFuses {runAsNode:false, enableNodeOptionsEnvironmentVariable:false, enableNodeCliInspectArguments:false, enableEmbeddedAsarIntegrityValidation:true, onlyLoadAppFromAsar:true, enableCookieEncryption:true} (verify utilityProcess still works).
9. [A] macOS arm64 unsigned → "damaged". Set mac.identity "-" (ad-hoc); document `xattr -dr com.apple.quarantine /Applications/Rico.app`.
10. [A] fetch-llama-server.mjs:174 fs.cp breaks symlinks → use verbatimSymlinks:true. serverEngine on Linux: env.LD_LIBRARY_PATH=dirname(exe).
11. [A] serverCore.ts:41-42: eco gives -ub 256; Gemma image tokens need non-causal attention with n_ubatch ≥ image tokens → when mmprojPath set use -b/-ub ≥ 1024.
12. [A/B] 4 images × ~1200 tokens overflow 4096 ctx on 8 GB machines. When contextSize ≤ 4096: limit 2 images or 896px long edge, or `--image-max-tokens` if the flag exists in b11321; reject early with a clear message.
13. [D] ml/train_lora.py:271 merge_adapter tries AutoModelForCausalLM first; for multimodal Qwen3.5 use AutoModelForImageTextToText first; assert adapter keys match base module names; verify config.architectures unchanged before convert_hf_to_gguf.
14. [D] train-kaggle.yml kernel metadata: add "machine_shape": "NvidiaTeslaT4" (API push with enable_gpu defaults to P100 sm_60, unsupported by Unsloth/Triton).
15. [A/D] Ship LICENSES/ via extraResources: Apache-2.0 (Qwen, Gemma) + Gemma Prohibited Use Policy, llama.cpp MIT, OFL fonts. [D] CC BY-SA 4.0 notice in ml/data/recent/ and the generated rico_sft.jsonl.
16. [C] eval/run_eval.mjs:121: add chat_template_kwargs:{enable_thinking:false}.
17. [C] system-prompt.md: add «جمعة أبوراس (Juma Abouras)». [A] chat.ts: append local `تاريخ اليوم: YYYY-MM-DD` to the system prompt.
18. [B] AppProvider.tsx:624 boot awaits system.getInfo() (spawns worker + Vulkan probe up to 45 s) → dispatch BOOTED first, patch info later. AppProvider.tsx:99 LOAD_TIMEOUT_MS 180_000 too short for rico-max → 15 min or rely on load-state error.
19. [A] manifest.json stores no sha256 → catalog updates with same filenames invisible. Store sha256 per file; show "update available" when different.

## Low
20. [A] After the hardware probe, shut down the node-llama-cpp worker while the sidecar is active (holds Vulkan context/VRAM on 4 GB cards).
21. [A] downloadFile re-hashes every completed shard on each retry → write a .verified marker (size+mtime).
22. [A] messages.ts main-process error strings are فصحى while UI is Libyan; English visionNote spliced into Arabic. Localize and match tone.
23. [A] ensureLoaded silently returns after 3 attempts → throw RicoError('loading').
24. [A] ipc.ts:230 eagerly reloads on perfMode change though comment says lazily → defer to next generate.
25. [A] ChatStore.loadIndex reads every chat (with base64 images) at startup → keep an index.json.
26. [C/A] few-shots sent as real prior turns can be quoted by the model → move to an "examples" block in the system prompt.
27. [C] fewshots.json «تبيها أرسمي شوية» → «تبيها رسمية أكثر شوية ولا هكي باهية؟».
28. [C] persona/glossary.json shipped but unused → use in eval/distill or exclude from packaging (tell A).
29. [B] Announce finished answers via a polite live region (log is aria-live="off").
30. [B] fonts.css: Merienda unicode-range U+2000-206F includes ZWJ/ZWNJ (U+200C-200F) → exclude them so Ruqaa joining isn't broken.
31. [A] package.json homepage → https://github.com/giumaa/rico-ai.
32. [A] api.ts has a BOM and mojibake (`â‰¤1280px`) in a comment → remove BOM, fix to ≤.
33. [A] fetch-llama-server.mjs comments reference serverArgs.ts (actually serverCore.ts).

## From the tester
T1. [A] Load state flashes error during sidecar→fallback (serverEngine.ts:166 emits error; hybrid.ts:29 forwards it). Add loadInFlight in HybridEngine.load(); suppress forwarding while set.
T2. [A] Progress bar flashes 0% on resume (modelManager.ts:488 forced emit before tracker seeded with .part size) → seed from existing partials.
T3. [C] Small models sometimes answer English questions in Arabic → strengthen English mirroring (an English example).
