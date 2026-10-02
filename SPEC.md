# Rico (ريكو) — Project Spec (source of truth for all agents)

Rico is a **fully offline** desktop AI assistant. Users download it, pick a model once, and then chat with **no internet, no login, no telemetry, no analytics, no crash reporting, no auto-update pings**. Chats never leave the device.

## Identity (non-negotiable)
- Name: **Rico / ريكو**. Developed and trained by **جمعة أبوراس (Juma Abouras)**.
- Default language: when the user writes Arabic, Rico answers in **fluent Libyan dialect (اللهجة الليبية)**. English in → English out. Switches to Modern Standard Arabic (فصحى) only when asked.
- Purpose: general assistant — questions, explanations, advice, writing, translation, everyday help. (Not a coding/design-focused product, but may answer such questions.)
- Never claims to be Qwen/Gemma/ChatGPT/Claude or made by Alibaba/Google/OpenAI/Anthropic.

## Repo layout (each agent owns its folders — do not edit other agents' folders; propose changes in your final report instead)
```
app/                      Electron desktop app (TypeScript, Vite, React)
  src/shared/             IPC contract + shared types          (owner: orchestrator; Agent A may extend, must keep backward compatible)
  src/main/               main process, LLM engine, model manager, storage, privacy   (Agent A)
  src/preload/            contextBridge exposing window.rico    (Agent A)
  src/renderer/           UI                                     (Agent B)
  resources/fonts/        bundled woff2 fonts (offline)          (Agent B)
  resources/icons/        app icon / logo                        (Agent B)
  resources/persona/      system prompt + few-shots + glossary   (Agent C)
models/catalog.json       model tiers + download URLs + sha256   (Agent D)
ml/                       data + distillation + fine-tuning + GGUF packaging (Agent D; data content by Agent C in ml/data/seed/)
eval/                     Libyan-dialect & identity eval prompts (Agent C)
.github/workflows/        CI: build installers, package models, distill, release   (Agent D)
docs/                     user + developer docs (Arabic first)   (any agent, own file)
```

## Tech decisions
- Electron (latest stable) + electron-vite (or Vite) + TypeScript strict + React 19. Package with electron-builder: Windows NSIS (x64), macOS dmg (arm64 + x64), Linux AppImage + deb.
- LLM runtime: the **llama-server sidecar** (official llama.cpp release binary, pinned in `LLAMA_CPP_TAG`; Vulkan/Metal/CPU builds) is the primary engine and the only one with **vision** (mmproj). **node-llama-cpp v3** (in an Electron **utilityProcess**) probes the hardware and is the **text-only fallback** when the sidecar is missing or blocked by the OS (e.g. Windows Smart App Control). Inference runs outside the UI process at **below-normal OS priority**, so the user's PC never freezes.
- Default "Eco" performance mode: threads = max(2, physicalCores − 2), batch modest; "Max" mode available in settings.
- Model files: GGUF. Hosted as GitHub Release assets (repo `rico-ai`, release tag `models-v1`), split with `llama-gguf-split` into ≤1.9 GB shards (GitHub 2 GiB asset limit); llama.cpp loads split GGUF by first shard. Fallback URL: original Hugging Face GGUF. Downloads: resumable, sha256-verified, progress events. Also **"Import model file"** (fully offline install from USB).
- The only network access in the entire app: model download that the user explicitly starts. Everything else blocked (CSP, `will-navigate`/`setWindowOpenHandler` deny, `session.webRequest` blocks all non-file requests except the model download in main).
- Storage: chats + settings as JSON in `app.getPath('userData')`. No cloud.

## Model tiers (Agent D verifies newest/best Apache-2.0-or-permissive models as of today and real URLs/sizes)
| id | target RAM | default candidate |
|----|-----------|-------------------|
| `rico-lite` | 8 GB | Qwen3-4B-Instruct-2507 Q4_K_M (~2.5 GB) |
| `rico` | 16 GB | best ~8–14B Arabic-strong open model Q4_K_M |
| `rico-max` | 32 GB+ | Qwen3-30B-A3B-Instruct-2507 Q4_K_M (MoE, fast on CPU) |
App recommends a tier from total RAM + VRAM; user may choose any.

## Design system (Agent B)
- Modern, calm, premium — the feel of ChatGPT/Claude, but its own identity. RTL-first (Arabic), perfect bidi for mixed text; LTR when UI language is English.
- **No purple, no blue.** Palette "Libyan desert night" — ink black + saffron gold + ember, with date-palm green as a rare accent.
  - Dark: bg `#0F0D0B`, surface `#1A1714`, surface-2 `#24201C`, border `#2E2924`, text `#F3ECE2`, muted `#A89C8C`, accent (saffron) `#F2B33D`, accent-strong (ember) `#E8742C`, success/green `#7FA650`, danger `#E5484D`.
  - Light: bg `#F7F1E6` (parchment), surface `#FFFBF4`, surface-2 `#EFE6D6`, border `#E2D6C2`, text `#1C1714`, muted `#6E6254`, accent `#C9821F`, accent-strong `#C2541A`, green `#4F6B2F`, danger `#C93C3F`.
  - Theme: System / Dark / Light toggle.
- Fonts (bundled locally as woff2, SIL OFL): Arabic **Aref Ruqaa** (خط الرقعة) — sized/spaced for clarity (base 18–19px, line-height ≥1.9). English/Latin **Merienda** (calligraphic, Ruqaa-like spirit yet readable). Code: a bundled monospace (e.g. JetBrains Mono). Include OFL license files.
- Logo: calligraphic "ريكو" mark + simple glyph; app icon for win (.ico), mac (.icns), linux (png).

## Privacy promises (shown in-app, must be literally true)
لا إنترنت بعد تحميل النموذج • لا تسجيل دخول • لا تتبع ولا إحصائيات • محادثاتك على جهازك فقط.
