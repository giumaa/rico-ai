# Rico ML pipeline · خط إنتاج نماذج ريكو

> Owner: Agent D · Files: `models/catalog.json`, `ml/**`, `.github/**`, this document.

## Catalog convention · قاعدة ملف الكتالوج (`models/catalog.json`)

**EN.** The app reads `models/catalog.json` (shipped with the app). Per model: `id, name{ar,en}, description{ar,en}, sizeGB, minRamGB, contextLength, license, baseModel, files[], mmproj`.

* `files[]` is **ordered**. One entry = one downloadable piece `{url, fallbackUrl, sha256, sizeBytes}`; `sha256`/`sizeBytes` describe the file at `url`. For split models every shard has its own entry (`…-00001-of-0000N.gguf`, in order); node-llama-cpp loads the model from the **first** shard (all shards must sit in the same folder).
* **Fallback rule:** only the **first** entry carries `fallbackUrl` (+ `fallbackSha256`, `fallbackSizeBytes`): the *single-file* Hugging Face GGUF of the same tier. If any release shard cannot be downloaded, the app downloads that one file instead, verifies `fallbackSha256`, and ignores the other entries. Other entries have `fallbackUrl: null`. (The fallback is the unmodified base GGUF – the app injects the Rico persona itself.)
* `mmproj` = vision projector `{url, fallbackUrl, sha256, sizeBytes}` (single file ≤ 1.2 GB, never split). Pass it to the engine together with the first shard; images only work when it is installed. It is **never modified** (its sha256 equals the Hugging Face file), and it is the *base* model's projector even for fine-tuned models (see "Vision" below).
* Store each model in its own folder (`<userData>/models/<id>/`): in the initial HF state all three mmproj files are called `mmproj-F16.gguf`; after packaging they are `<tier>-mmproj-F16.gguf`.
* `packaged: false` (initial state, committed): `files[0].url` points **directly at Hugging Face** (real sha256 from the HF API) so the app works before any release exists. After the *Package models* workflow ran, `packaged: true` and `url`s become `https://github.com/giumaa/rico-ai/releases/download/models-v1/<file>` shards with their real sha256. The app logic is the same in both states.
* `sizeGB` = total download (text + projector), decimal GB. `contextLength` = recommended default context for the app (RAM-safe); `maxContextLength` = trained maximum. `source` = upstream file used by the packaging scripts (ignored by the app).
* The release repo must be **public**, otherwise release assets need authentication.

**AR.** يقرأ التطبيق ملف `models/catalog.json`. `files` مرتّبة؛ كل عنصر قطعة تنزيل `{url, fallbackUrl, sha256, sizeBytes}` والتحقق يخص الملف في `url`. في النماذج المقسومة لكل شريحة عنصر مستقل بالترتيب، ويفتح التطبيق النموذج من **الشريحة الأولى**. **قاعدة البديل:** `fallbackUrl` يوجد في **العنصر الأول فقط** (مع `fallbackSha256` و`fallbackSizeBytes`) ويشير إلى ملف GGUF الواحد على Hugging Face؛ إذا فشل تنزيل أي شريحة ينزّل التطبيق هذا الملف الواحد ويتجاهل بقية العناصر. `mmproj` هو مُسقِط الرؤية (ملف واحد، لا يُقسَّم، لا يُعدَّل) ويُمرَّر للمحرك مع الشريحة الأولى كي تعمل الصور. الحالة الابتدائية `packaged:false` تعني أن الروابط تشير إلى Hugging Face مباشرة (تعمل فورًا)؛ وبعد تشغيل workflow التغليف تصبح `packaged:true` وتشير إلى شرائح GitHub Release (يجب أن يكون المستودع عامًا).

---

## 1. Chosen models · النماذج المختارة (verified 2026-10-01)

| Tier | Base model (license) | File (Q4_K_M) | + mmproj F16 | Why |
|---|---|---|---|---|
| `rico-lite` (8 GB) | **Qwen3.5-4B** (Apache-2.0) – `lmstudio-community/Qwen3.5-4B-GGUF` | 2.71 GB | 0.67 GB | Native vision; 248K vocab (compact Arabic tokens); model-card multilingual scores: MMMLU 76.1, MMLU-ProX 71.5, INCLUDE 71.0 – vs Qwen3-4B-Instruct-2507: ProX 61.6, INCLUDE 60.1 |
| `rico` (16 GB) | **Gemma-4-12B-it** (Apache-2.0 + Gemma Prohibited-Use Policy) – `lmstudio-community/gemma-4-12B-it-GGUF` | 7.38 GB | 0.18 GB | MMMLU 83.4; native vision; thinking off by default; Gemma family = strongest Arabic generation among open models of this size |
| `rico-max` (32 GB+) | **Gemma-4-26B-A4B-it** MoE (3.8 B active) (same license) – `lmstudio-community/gemma-4-26B-A4B-it-GGUF` | 16.80 GB | 1.19 GB | MMMLU 86.3; MoE = fast on CPU; leaves ~15 GB headroom on a 32 GB PC |

Exact URLs / byte sizes / sha256 are in `models/catalog.json` (taken from the Hugging Face API `lfs.oid` and re-checked with `x-linked-etag`). `mmproj` files come from `unsloth/*-GGUF` (`mmproj-F16.gguf`; F16 runs fast on every backend).

**Considered and rejected:** Qwen3-4B-Instruct-2507 / Qwen3-30B-A3B-Instruct-2507 (the previous defaults: older, no vision; INCLUDE 60.1/71.9 vs 71.0 for Qwen3.5-4B); Qwen3.6-35B-A3B and Qwen3.5-35B-A3B (22 GB Q4 – too tight on 32 GB RAM with the OS); Qwen3.5-9B (5.7 GB, MMMLU 81.2 – good alternative for `rico`); Gemma-4-31B (dense, ~1.5 tok/s on CPU); Falcon-H1-Arabic (TII Falcon license, not Apache); Jais-2-8B (gated download); Fanar-2-27B (Gemma-3-derived, too big); Llama (license requires "Llama" naming).
**Caveat:** public benchmarks (MMMLU, INCLUDE, OALL…) measure Arabic *knowledge*, not Libyan *dialect*. Run `eval/` on candidates; swapping a base = edit `source` in the catalog and re-run *Package models*.
**Runtime notes:** Qwen3.5 is a hybrid (Gated-DeltaNet) model and *thinks by default* – the packaged chat template defaults `enable_thinking` to **false**; node-llama-cpp ≥ 3.18 supports it (3.22.1 pinned in the app). Gemma 4 needs node-llama-cpp ≥ 3.19.

## 2. Pipeline order · ترتيب التنفيذ

```
Package models ─► Distill (collect recent ─► 20 × generate ─► merge) ─► Train (Kaggle / local) ─► Package fine-tuned ─► catalog
```

| Step | What | Where |
|---|---|---|
| 1 | **Package models** – base GGUFs stamped "Rico", split, + mmproj → release `models-v1` | Actions → *Package models* |
| 2 | **Distill** – (a) `collect_recent.py`, (b) up to 20 CPU jobs with the teacher, (c) merge → `ml/data/rico_sft.jsonl` | Actions → *Distill* |
| 3 | **Train** LoRA on `rico_sft.jsonl` | Kaggle notebook / *Train on Kaggle* workflow / `ml/train_local_safe.ps1` |
| 4 | Export (merge → GGUF → Q4_K_M → patch → shards) and update catalog | automatic at the end of training (`--export`) |

All workflows are `workflow_dispatch` only (no schedules, nothing runs by itself). **Public repo = unlimited free minutes; private = 2000 min/month** – 20 distill jobs × 5.5 h would exhaust a private quota.

### 2.1 Package models (`.github/workflows/package-models.yml`)
Inputs: `tiers` (default all three), `release_tag` (default **`models-v2`**; `models-v1` is **frozen** - the shipped catalog/apps reference its assets by sha256 - and the workflow refuses it), `commit_catalog`, `skip_server_check`, `llama_cpp_tag` (empty = the tag in the repo-root **`LLAMA_CPP_TAG`** file, fallback `b11312`). Per tier (matrix, ubuntu, ~45 GB free after cleanup): download upstream GGUF (sha256-verified) → `ml/package_model.py patch` writes `general.name` ("Rico Lite" / "Rico" / "Rico Max"), `general.author` = "Juma Abouras", and wraps `tokenizer.chat_template` so that **a short, stable identity line (`ريكو من تطوير جمعة أبوراس`) is the default system prompt** (only when the caller sends no system message; the full, evolving persona is injected by the app, so persona edits never require re-packaging - `--persona <file>` still embeds a full persona; thinking off by default; the original template logic is untouched) → `llama-gguf-split --split-max-size 1900M` (1.9 GB < GitHub's 2 GiB asset limit) → copy `<tier>-mmproj-F16.gguf` → verify (metadata, template via jinja2, mmproj ↔ LLM hidden size, and a real `llama-server /apply-template` + vision-modality check) → `.github/scripts/upload_assets.sh` (**never overwrites or deletes** a release asset: shipped apps bundle each asset's sha256; names embed a revision `rico-lite-<rev8>-Q4_K_M-0000N-of-0000M.gguf`, `rico-lite-mmproj-<sha8>-F16.gguf`, where `rev` = hash(base file sha256 + identity line + patch version) – identical inputs give identical bytes and the upload is skipped, any change gives *new* names; old shards stay on the release for older apps) → artifact `catalog-patch-<tier>` → job `update-catalog` runs `package_model.py merge-catalog` and commits `models/catalog.json`.

### 2.2 Distill (`.github/workflows/distill.yml`)
Inputs: `collect`, `since` (2026-04-01), `shards` (≤ 20, default 20), `samples`, `qa_samples` (2), `chunk_minutes` (95; 3 chunks ≈ 5 h 15 m < the 5 h 30 m budget), `max_tokens`, `temperature`, `parallel`, teacher URL/sha, `commit_result`, `llama_cpp_tag` (empty = `LLAMA_CPP_TAG` file), **`min_distilled`** (1000) and **`merge_only_run_id`** (re-merge the shard artifacts of an earlier run without generating anything).
* **collect** – `ml/collect_recent.py` (one page per API request - TextExtracts returns the full extract for only one page per batched request, so batching silently dropped 19 of 20 pages in v1; candidates are ordered Libya-titled -> Libya-category -> other search hits) (MediaWiki API; CC BY / CC BY-SA only, license read from `siteinfo`): Arabic Wikipedia, Arabic Wikinews, English Wikipedia pages about Libya (search terms ليبيا، طرابلس، بنغازي، مصراتة، سبها، الاقتصاد الليبي، الرياضة الليبية… + `Category:Libya` trees) whose **latest revision ≥ 2026-04-01**; current text; kept only if Libya-focused (title / Libya category, or ≥ 1 Libya term per 1000 chars). Writes `ml/data/recent/articles.jsonl` and `ml/data/recent/ATTRIBUTION.md` (per-page permalink, revision date, license, history link).
* **generate** (matrix) – each job downloads the teacher (**Gemma-4-12B-it Q4_K_M**, 7.4 GB, fits the 16 GB runner), starts `llama-server -np 6` and, for its slice: (a) answers `prompts_ar.jsonl` with the Rico persona + `fewshots.json` (temp 0.7, ≤ 500 tokens); (b) reads each article chunk and writes 3–5 **grounded** Q&A pairs in Libyan dialect (JSON-schema constrained), each answer carrying the article date as context ("حسب ما نُشر في أبريل 2026…"). Three time-boxed chunks; the shard file is uploaded as an artifact after each chunk (resume = same file).
  **Runner facts (measured, 4 vCPU / 16 GB):** the 12B teacher does ~9-10 tok/s prompt processing and ~1.4 tok/s decode ≈ **0.35 items/min per job** (an item = one prompt answer or one article chunk -> 4 Q&A pairs), i.e. ~100 items per job in a 5 h run (≈ 2000 per 20-job run). The first request needs ~2 min to fill the persona prefix cache (a warm-up call does it once). **Memory:** llama-server defaults (8 GiB host prompt cache, 32 context checkpoints per slot, mmap) made the first run thrash and die with *"runner has received a shutdown signal"*; the script now uses 2 slots × 3072 ctx, q8 KV cache, flash-attn, `--load-mode none` (b11312 has no `--no-mmap`), `--cache-ram 512`, `-ctxcp 2`, plus `mem_watch.sh` (log every 20 s; SIGKILLs the server if available RAM < 400 MB so the runner survives) and `distill.py --restart-cmd` (restarts the server and retries). Measured ≈ 5 GB free RAM during generation. **Teacher download:** done once by the `teacher-cache` job (Actions cache, 7.4 GB) and restored by all jobs; fallback = staggered, retried `curl`. Faster-but-weaker alternative: `-f teacher_url=…gemma-4-E4B-it-Q4_K_M.gguf` (≈ 2× throughput, more hallucination in prompt answers).
* **merge** – `ml/distill.py merge`: filters (heuristics + `eval/score_rules.json`: foreign-dialect markers, forbidden identity strings/claims, length, broken Markdown, `<think>`/special-token leftovers, CJK leaks, repetition, language mismatch; for Q&A also *grounding*: numbers must appear in the chunk, date context required, word overlap ≥ 20 %), exact + near-duplicate removal (MinHash), caps (≤ 2 answers/prompt, ≤ 12 Q&A/article, ≤ 1800 recent Q&A), then mixes in the hand-written gold seeds: `style_examples.jsonl` **×3**, `identity.jsonl` **×1 capped at ≈ 10 %** of the final dataset (`--identity-frac 0.10`; 160+ near-identical identity answers would otherwise dominate) → `ml/data/rico_sft.jsonl` + `rico_sft.stats.json` + `rico_sft.NOTICE.md` (artifact + commit). **Guards:** every generate job fails if its shard output is empty; `merge` fails *before writing anything* when fewer than `--min-distilled` (default 1000) teacher-generated records survive (`kept_distilled` = prompt answers + recent Q&A), so a gold-only dataset can never overwrite a good one; the commit step additionally requires `kept_distilled > 0`. Records carry `source` = `distill | recent_qa | identity | style_examples`.
* Test locally without a model: `python ml/distill.py selftest`.

**Recent-knowledge caveat · تنبيه:** LoRA fine-tuning on a few thousand Q&A pairs adds *some* recent facts and the habit of hedging with dates, but it is **not reliable recall** – the model can still be wrong or out of date. The persona already tells Rico that its knowledge may be old and that it has no internet. Wikipedia/Wikinews text is community-written; the Q&A are machine-written summaries – never present them as verified news. The "date context" in the answers is the page's **last revision date** (a page revised after 2026-04-01 may still describe older events, and many revisions are small maintenance edits).

### 2.3 Fine-tuning
`ml/train_lora.py`: LoRA r=16/α=16 on all attention + MLP projections of the **language model only**, seq 1024, 2 epochs, lr 2e-4 cosine, checkpoint every 50 steps (auto-resume), **loss on assistant tokens only** (prompt masked; the model's own chat template, non-thinking mode; the Rico system prompt is prepended to 35 % of examples so the model works with and without it). Engine: Unsloth if installed, else PEFT + bitsandbytes. After training the adapter folder gets `rico_meta.json` (base repo, the HF loader class used - multimodal checkpoints load through `AutoModelForImageTextToText` - concrete class, architectures, versions) and the merge **re-uses exactly that loader/base**, then checks that every adapter module exists in the fresh base, that the merged `state_dict` has the same tensor names as the base and that `config.architectures` is unchanged (what `convert_hf_to_gguf.py` and the mmproj need). `--export`: merge on CPU → `convert_hf_to_gguf.py` (llama.cpp tag from `LLAMA_CPP_TAG`) → `llama-quantize Q4_K_M` → `package_model.py patch-existing` (metadata, identity-line template, shards, mmproj, catalog patch). Huge intermediates (merged 16-bit model, bf16 + Q4_K_M GGUF) go to `--work-dir` (Kaggle: `/tmp`) so that only `release/` lands in `/kaggle/working`. Fine-tunes publish to **`models-v2`** (`--release-tag`) with versioned names `rico-lite-<rev>-Q4_K_M-…` (`--rev ft1`; bump it for every new fine-tune - assets are never overwritten). **`--dry-run`** = data/masking check + **2 real train steps + a merge dry-run** (nothing exported, everything deleted afterwards); `--tokenizer-only` = just the data check without loading a model.

| Preset | Base | VRAM | Where |
|---|---|---|---|
| `qwen35-4b` (**rico-lite**) | Qwen/Qwen3.5-4B, 16-bit LoRA | ≥ 11 GB | Kaggle T4 (fp16) ✔, Colab ✔, **not** a 4 GB GPU |
| `qwen3-4b-2507` | Qwen3-4B-Instruct-2507, 4-bit QLoRA | ≈ 3.4 GB | Quadro T2000 4 GB (tight) ✔ – *no vision, different base from the catalog* |
| `qwen35-2b` | Qwen3.5-2B 4-bit (experimental) | ≈ 2.6 GB | small GPUs |

**Does the rico-lite base fit 4 GB QLoRA? No.** Qwen3.5-4B keeps 0.64 B embedding parameters in 16-bit (≈ 1.3 GB), weights ≈ 1.6 GB in 4-bit, plus a 248K-vocab logits buffer; Unsloth documents ~10 GB for 16-bit LoRA and advises *against* 4-bit for Qwen3.5. GitHub runners have no GPU (CPU training of a 4B model would take weeks). Therefore: **train rico-lite on Kaggle's free T4** – either run `ml/kaggle/rico-train.ipynb` by hand, or let GitHub orchestrate it with the *Train on Kaggle* workflow (`action=push` → wait 3–7 h → `action=fetch`, needs the `KAGGLE_USERNAME` and `KAGGLE_API_TOKEN` (new `KGAT_…` token, kaggle CLI ≥ 1.8; legacy `KAGGLE_KEY` also works) repo secrets; the token is never printed. The kernel is pinned to a **T4** (`machine_shape: NvidiaTeslaT4` – the API default is a P100 (sm_60) that Unsloth/Triton do not support)). The T2000 path (below) is for experiments or for the `qwen3-4b-2507` fallback.

**Safe local training (T2000, never lags / overheats):**
```powershell
powershell -ExecutionPolicy Bypass -File ml\setup_local.ps1          # once: ml\.venv + torch cu126 + Unsloth
powershell -ExecutionPolicy Bypass -File ml\train_local_safe.ps1      # train (re-run = resume)
powershell -File ml\train_local_safe.ps1 -Pause / -Resume             # or create / delete ml\work\PAUSE
powershell -File ml\train_local_safe.ps1 -Duty 0.5                    # cooler & quieter
```
Process priority *BelowNormal*, 4 CPU threads, seq 768 / batch 1 / grad-accum 16 / gradient checkpointing / 92 % VRAM cap, `nvidia-smi` watchdog every 5 s (**pause ≥ 78 °C, resume ≤ 70 °C**, checkpoint-and-stop at 85 °C), duty cycle ≈ 65 %, checkpoint every 50 steps. Status: `ml\work\status.json`, log: `ml\work\train_local.log`.

### 2.4 Vision stays compatible · الرؤية
All three bases are natively multimodal. LoRA is attached **only to the language model** (`assert_language_only` aborts if a vision/projector module would be touched) and the vision tower / projector are never exported from the fine-tune, so the original `mmproj` (same base, same hidden size) keeps working. The packaging step checks `clip.*.projection_dim == <arch>.embedding_length` and the workflow loads the projector in `llama-server` and requires the `vision` modality. The base model of the fine-tune must be **the same model whose mmproj is shipped** (Qwen3.5-4B for rico-lite) – do not fine-tune a different base and keep the old mmproj.

## 3. Licenses · التراخيص

| Item | License | Obligations |
|---|---|---|
| Qwen3.5-4B (+ mmproj) | Apache-2.0 | keep license + notices; renaming allowed |
| Gemma-4-12B-it / 26B-A4B-it (+ mmproj) | Apache-2.0 + [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy) | keep license; do not use for prohibited uses; no restriction on training with outputs found (re-read before release) |
| Teacher outputs (Gemma-4-12B-it) | same | may be used to train other models |
| Wikipedia / Wikinews text (also `ml/data/rico_sft.NOTICE.md`) | CC BY-SA 4.0 (as reported by each site's API) | attribution (`ml/data/recent/ATTRIBUTION.md`) + share-alike for derived data; legal status of model weights trained on CC BY-SA text is unsettled |
| `llama.cpp` binaries (CI only) | MIT | – |
| Rico code (repo-root `LICENSE`) | **MIT**, Copyright (c) 2026 Juma Abouras | model weights downloaded by the app keep their own licenses |
| `ml/data/recent/` (`LICENSE.md`) | CC BY-SA 4.0 (Wikipedia / Wikinews extracts) - **not** MIT | keep `ATTRIBUTION.md` next to the data; share derived Q&A (`rico_sft.NOTICE.md`) under CC BY-SA 4.0 |
| Fine-tuned weights | author's choice; must stay compatible with the licenses above | ship the base-model license texts inside the app |

## 4. Running locally without GPU · أوامر مفيدة
```bash
python ml/distill.py selftest            # distillation + filters with a mock teacher
python ml/package_model.py selftest      # GGUF metadata patch + template round-trip on a synthetic model
python ml/package_model.py list          # tiers in the catalog
python ml/collect_recent.py --max-pages-per-site 20   # try the collector
python ml/train_lora.py --tokenizer-only --preset qwen35-4b  # tokenizer-only check of the loss masking (no model)
python ml/train_lora.py --dry-run --preset qwen35-4b         # + 2 train steps + merge dry-run (needs the GPU stack)
```

## 5. Known risks · المخاطر
* Repo must be **public** for release assets (and for free CI minutes).
* Hybrid Qwen3.5 (recurrent state) may re-evaluate more of the history per turn in node-llama-cpp than a pure-transformer model; Gemma 4 uses sliding-window attention. Test multi-turn latency on `rico-lite`; fallback = Qwen3-4B-Instruct-2507 entry (edit the catalog `source`).
* `unsloth`/`transformers` versions move fast: the training scripts fall back from Unsloth to PEFT automatically, but a fp16 run of Qwen3.5 on T4 can produce NaNs → use `--preset qwen3-4b-2507`.
* Windows Application Control may block downloaded `llama-*.exe` (it did on the dev PC): run export on Kaggle/Linux.
* First `package-models` run downloads ~28 GB and uploads ~28 GB; budget ≈ 1 h per tier.

---

# العربية — ملخص

**ما الذي يفعله هذا المجلد؟** يجهّز نماذج ريكو الثلاثة (lite / rico / max): يحمّل نماذج GGUF مفتوحة الرخصة (Apache-2.0)، يختمها باسم «Rico» والمؤلف «جمعة أبوراس»، ويضع سطر هوية قصيرًا وثابتًا (ريكو من تطوير جمعة أبوراس) كرسالة نظام افتراضية داخل قالب المحادثة (الشخصية الكاملة يحقنها التطبيق نفسه)، يقسّمها إلى شرائح ≤ 1.9 جيجا ويرفعها إلى release باسم `models-v1`، ثم يضيف مُسقِط الرؤية (mmproj) لكل نموذج حتى يفهم التطبيق الصور.

**التدريب:** (١) *Package models*، (٢) *Distill*: يجمع مقالات حديثة عن ليبيا (منذ 2026-04-01) من ويكيبيديا العربية وويكي الأخبار وويكيبيديا الإنجليزية (CC BY-SA فقط) ثم يولّد المعلّم (Gemma-4-12B) أزواج أسئلة وأجوبة بالليبي مبنية على النص ومؤرَّخة، إضافةً إلى إجابات عن أسئلة `prompts_ar.jsonl`، ثم يُنقّي ويدمج مع أمثلة الهوية والأسلوب (×3) في `ml/data/rico_sft.jsonl`، (٣) تدريب LoRA على كاجل (GPU مجاني T4) لأن Qwen3.5-4B **لا يتسع** في 4 جيجا من بطاقتك، أو محليًا بالسكربت الآمن مع نموذج أصغر، (٤) التصدير إلى GGUF وتحديث الكتالوج.

**التدريب المحلي الآمن:** `ml\setup_local.ps1` مرة واحدة ثم `ml\train_local_safe.ps1`. أولوية منخفضة، 4 خيوط CPU، إيقاف مؤقت تلقائي عند 78° وإكمال عند 70°، إيقاف نهائي مع حفظ عند 85°، نسبة تشغيل ≈ 65%، حفظ كل 50 خطوة واستئناف تلقائي، وإيقاف/استئناف يدوي بملف `ml\work\PAUSE`.

**تنبيه:** التدريب يضيف *بعض* المعلومات الحديثة وعادة ذكر التاريخ والحذر، لكنه ليس ذاكرة دقيقة؛ قد يخطئ النموذج أو تكون معلوماته قديمة.

**التراخيص:** نماذج Qwen3.5 وGemma 4 بترخيص Apache-2.0 (مع سياسة الاستخدام المحظور لـ Gemma)، ونصوص ويكيبيديا CC BY-SA 4.0 مع نسب المصدر في `ml/data/recent/ATTRIBUTION.md`. يجب تضمين نصوص تراخيص النماذج الأساسية داخل التطبيق.

**Signing / Smart App Control:** see `docs/signing.md` (SignPath Foundation, disabled until `SIGNPATH_ENABLED=true`; `build-app.yml` can build llama-server from source, pinned b11321). **Merge safety:** `train_lora.py --export` loads multimodal bases with `AutoModelForImageTextToText` first, asserts every adapter module exists in the base, and checks `config.architectures` is unchanged before `convert_hf_to_gguf.py`.
