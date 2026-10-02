#!/usr/bin/env python3
"""LoRA / QLoRA supervised fine-tuning of the Rico base model + export to GGUF.

    python ml/train_lora.py --preset qwen35-4b --data ml/data/rico_sft.jsonl --out ml/outputs/rico-lite --export

What it does
  1. reads ml/data/rico_sft.jsonl  ({"messages":[user,assistant,...], "source", "gold"})
  2. renders every assistant turn with the model's OWN chat template (non-thinking mode); the loss is computed on
     the assistant tokens ONLY (prompt tokens are masked with -100). With probability --system-prob the Rico persona
     is prepended as system prompt so the model works both with and without it.
  3. trains LoRA r=16 (all attention + MLP projections), seq 1024, 2 epochs, checkpoint every 50 steps, auto-resume.
     Engine: Unsloth when installed (faster, less VRAM), otherwise plain PEFT (+ bitsandbytes 4-bit when the preset
     asks for QLoRA).
  4. --export: merges the adapter into the 16-bit base on CPU, converts with llama.cpp convert_hf_to_gguf.py,
     quantizes to Q4_K_M and runs ml/package_model.py patch-existing (Rico metadata + persona template + shards +
     catalog patch).

--dry-run  = tokenizer/masking check + 2 real train steps + a merge dry-run (adapter keys vs. a freshly loaded base,
             architectures unchanged, nothing exported). `--tokenizer-only` = just the data/masking check (no model).
The adapter dir gets `rico_meta.json` (base repo + HF loader class used for training); the merge re-uses exactly those.
Heavy imports (torch / transformers / peft) are lazy so `--tokenizer-only` works on a machine without a GPU stack.
`main(argv, callbacks=[...])` lets ml/safe_runner.py plug in its thermal / duty-cycle callback.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rico_common import REPO_ROOT, SFT_PATH, is_gold, iter_jsonl, load_persona, normalize_conversation  # noqa: E402

# --------------------------------------------------------------------------- #
# presets
# --------------------------------------------------------------------------- #
# base        : full-precision HF repo (used for PEFT training, merging and the tokenizer/chat template)
# train_base  : what Unsloth loads (pre-quantised repos start faster and download less)
# qlora       : True -> 4-bit NF4 base weights during training (low VRAM); False -> 16-bit LoRA
PRESETS: dict[str, dict[str, Any]] = {
    "qwen35-4b": dict(
        tier="rico-lite", base="Qwen/Qwen3.5-4B", train_base="unsloth/Qwen3.5-4B", qlora=False, min_vram_gb=11,
        seq_len=1024, batch_size=2, grad_accum=8,
        note="catalog base of rico-lite. 16-bit LoRA needs ~10-11 GB VRAM -> Kaggle T4 (fp16) / Colab / any >=12 GB GPU. "
             "Unsloth advises against 4-bit QLoRA for Qwen3.5. Needs transformers v5.",
    ),
    "qwen3-4b-2507": dict(
        tier="rico-lite", base="Qwen/Qwen3-4B-Instruct-2507", train_base="unsloth/Qwen3-4B-Instruct-2507-bnb-4bit",
        qlora=True, min_vram_gb=3.4, seq_len=1024, batch_size=1, grad_accum=16,
        note="plain-transformer fallback (spec's original default); the only 4B preset that fits a 4 GB GPU (QLoRA).",
    ),
    "qwen35-2b": dict(
        tier="rico-lite", base="Qwen/Qwen3.5-2B", train_base="unsloth/Qwen3.5-2B", qlora=True, min_vram_gb=2.6,
        seq_len=1024, batch_size=1, grad_accum=16,
        note="EXPERIMENTAL 4-bit run of the 2B Qwen3.5 for tiny GPUs (4-bit is discouraged for Qwen3.5).",
    ),
    "qwen3-1.7b": dict(
        tier="rico-lite", base="Qwen/Qwen3-1.7B", train_base="unsloth/Qwen3-1.7B-bnb-4bit", qlora=True,
        min_vram_gb=2.0, seq_len=1024, batch_size=1, grad_accum=16,
        note="smoke-test / very small GPUs. Not a shipping tier.",
    ),
}

LORA_LEAVES = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj",
               "in_proj_qkv", "in_proj_z", "out_proj")  # last three: Qwen3.5 Gated-DeltaNet layers (if present)
SKIP_PATH_PARTS = ("visual", "vision", "audio", "image", "mm_projector", "multi_modal", "vit.")


def log(msg: str) -> None:
    print(f"[train {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# args
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", default="qwen35-4b", choices=sorted(PRESETS))
    ap.add_argument("--base", default=None, help="override the HF repo of the full-precision base")
    ap.add_argument("--train-base", default=None, help="override what Unsloth loads")
    ap.add_argument("--data", default=str(SFT_PATH))
    ap.add_argument("--out", default=str(REPO_ROOT / "ml" / "outputs" / "rico-lite"))
    ap.add_argument("--seq-len", type=int, default=None, help="default: preset (1024)")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--max-steps", type=int, default=-1, help="overrides --epochs when > 0")
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=16)
    ap.add_argument("--lora-dropout", type=float, default=0.0)
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--grad-accum", type=int, default=None)
    ap.add_argument("--warmup-ratio", type=float, default=0.03)
    ap.add_argument("--weight-decay", type=float, default=0.01)
    ap.add_argument("--system-prob", type=float, default=0.35,
                    help="probability of prepending the Rico system prompt to a training example")
    ap.add_argument("--dev-fraction", type=float, default=0.02)
    ap.add_argument("--eval-samples", type=int, default=48)
    ap.add_argument("--max-samples", type=int, default=0, help="cap on training examples (0 = all)")
    ap.add_argument("--save-steps", type=int, default=50)
    ap.add_argument("--logging-steps", type=int, default=5)
    ap.add_argument("--seed", type=int, default=3407)
    ap.add_argument("--engine", choices=("auto", "unsloth", "peft"), default="auto")
    ap.add_argument("--no-resume", action="store_true", help="ignore existing checkpoints")
    ap.add_argument("--num-threads", type=int, default=0, help="torch CPU threads (0 = leave default)")
    ap.add_argument("--dry-run", action="store_true",
                    help="data check + 2 train steps + merge dry-run (no export, nothing kept). Falls back to "
                         "--tokenizer-only when torch/transformers/peft are not installed")
    ap.add_argument("--tokenizer-only", action="store_true", help="only build + inspect the dataset (no model load)")
    ap.add_argument("--skip-train", action="store_true", help="skip training (use with --export on an existing adapter)")
    ap.add_argument("--export", action="store_true", help="merge -> GGUF -> Q4_K_M -> Rico metadata + shards")
    ap.add_argument("--tier", default=None, help="catalog tier for --export (default: preset tier)")
    ap.add_argument("--llama-work", default=str(REPO_ROOT / "ml" / "work" / "llama.cpp"))
    ap.add_argument("--keep-merged", action="store_true")
    ap.add_argument("--work-dir", default=None,
                    help="scratch dir for the HUGE intermediates (merged 16-bit model, bf16 + Q4_K_M GGUF, packaging work). "
                         "Default: --out. On Kaggle use /tmp so that only release/ lands in /kaggle/working")
    ap.add_argument("--release-tag", default="models-v2",
                    help="release the shards will be uploaded to (goes into the catalog patch URLs; models-v1 is frozen)")
    ap.add_argument("--rev", default=None,
                    help="revision label in the shard names, e.g. ft1 -> rico-lite-ft1-Q4_K_M-... (default ft<sha8>); "
                         "assets are never overwritten, so bump it for every new fine-tune")
    ap.add_argument("--vram-fraction", type=float, default=0.0,
                    help="cap this process' GPU memory (0 = no cap); safe_runner sets 0.92")
    return ap


def resolve(args: argparse.Namespace) -> argparse.Namespace:
    p = PRESETS[args.preset]
    args.base = args.base or p["base"]
    args.train_base = args.train_base or p["train_base"]
    args.qlora = bool(p["qlora"])
    args.seq_len = args.seq_len or p["seq_len"]
    args.batch_size = args.batch_size or p["batch_size"]
    args.grad_accum = args.grad_accum or p["grad_accum"]
    args.tier = args.tier or p["tier"]
    args.out = str(Path(args.out))
    return args


# --------------------------------------------------------------------------- #
# data
# --------------------------------------------------------------------------- #


@dataclass
class Example:
    prompt_msgs: list[dict]   # everything before the supervised assistant turn
    completion: str           # the supervised assistant turn
    gold: bool
    group: str                # id used for the deterministic dev split


def _h(s: str) -> int:
    return int(hashlib.sha1(s.encode("utf-8")).hexdigest()[:8], 16)


def load_examples(path: str, system_prob: float, persona: str, seed: int, dev_fraction: float,
                  max_samples: int) -> tuple[list[Example], list[Example]]:
    rng = random.Random(seed)
    train: list[Example] = []
    dev: list[Example] = []
    for obj in iter_jsonl(path):
        conv = normalize_conversation(obj)
        if not conv:
            continue
        gold = is_gold(obj)
        group = str(obj.get("id") or conv[0]["content"][:64])
        is_dev = (not gold) and (_h(group) % 10_000) < dev_fraction * 10_000
        # one example per assistant turn (full history as prompt)
        for i in range(1, len(conv), 2):
            hist = conv[:i]
            if rng.random() < system_prob:
                hist = [{"role": "system", "content": persona}] + hist
            ex = Example(hist, conv[i]["content"], gold, group)
            (dev if is_dev else train).append(ex)
    rng.shuffle(train)
    if max_samples and len(train) > max_samples:
        train = train[:max_samples]
    return train, dev


TEMPLATE_KWARGS = {"enable_thinking": False}


def detect_eot(tok) -> str:
    """The end-of-assistant-turn marker emitted by the model's chat template (e.g. <|im_end|>, <turn|>)."""
    marker = "ZZ_RICO_PROBE_ZZ"
    full = tok.apply_chat_template([{"role": "user", "content": "hi"}, {"role": "assistant", "content": marker}],
                                   tokenize=False, add_generation_prompt=False, **TEMPLATE_KWARGS)
    idx = full.find(marker)
    if idx < 0:
        return tok.eos_token or ""
    after = full[idx + len(marker):]
    eot = after.split("\n", 1)[0].strip()
    return eot or (tok.eos_token or "")


def encode_examples(tok, examples: list[Example], seq_len: int, persona: str, eot: str) -> tuple[list[dict], dict]:
    stats = {"kept": 0, "dropped_long": 0, "system_dropped_for_length": 0, "tokens": 0, "supervised_tokens": 0}
    out: list[dict] = []

    def enc(prompt_msgs: list[dict], completion: str):
        prompt_text = tok.apply_chat_template(prompt_msgs, tokenize=False, add_generation_prompt=True,
                                              **TEMPLATE_KWARGS)
        p_ids = tok(prompt_text, add_special_tokens=False)["input_ids"]
        c_ids = tok(completion.strip() + eot, add_special_tokens=False)["input_ids"]
        return p_ids, c_ids

    for ex in examples:
        p_ids, c_ids = enc(ex.prompt_msgs, ex.completion)
        if len(p_ids) + len(c_ids) > seq_len and ex.prompt_msgs[0]["role"] == "system":
            p_ids, c_ids = enc(ex.prompt_msgs[1:], ex.completion)       # retry without the long system prompt
            stats["system_dropped_for_length"] += 1
        if len(p_ids) + len(c_ids) > seq_len:
            stats["dropped_long"] += 1
            continue
        ids = p_ids + c_ids
        out.append({"input_ids": ids, "labels": [-100] * len(p_ids) + c_ids, "gold": ex.gold})
        stats["kept"] += 1
        stats["tokens"] += len(ids)
        stats["supervised_tokens"] += len(c_ids)
    return out, stats


class ListDataset:
    def __init__(self, rows: list[dict]):
        self.rows = rows

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i: int) -> dict:
        r = self.rows[i]
        return {"input_ids": r["input_ids"], "labels": r["labels"]}


def make_collator(pad_id: int):
    import torch

    def collate(batch: list[dict]) -> dict:
        n = max(len(b["input_ids"]) for b in batch)
        ids = torch.full((len(batch), n), pad_id, dtype=torch.long)
        lab = torch.full((len(batch), n), -100, dtype=torch.long)
        att = torch.zeros((len(batch), n), dtype=torch.long)
        for i, b in enumerate(batch):
            k = len(b["input_ids"])
            ids[i, :k] = torch.tensor(b["input_ids"])
            lab[i, :k] = torch.tensor(b["labels"])
            att[i, :k] = 1
        return {"input_ids": ids, "labels": lab, "attention_mask": att}

    return collate


# --------------------------------------------------------------------------- #
# model loading
# --------------------------------------------------------------------------- #


def _dtype_kw(dtype) -> dict:
    import transformers
    major, minor = (int(x) for x in transformers.__version__.split(".")[:2])
    return {"dtype": dtype} if (major, minor) >= (4, 56) else {"torch_dtype": dtype}


def compute_dtype():
    import torch
    if torch.cuda.is_available() and torch.cuda.get_device_capability()[0] >= 8:
        return torch.bfloat16
    return torch.float16


def is_multimodal(repo: str) -> bool:
    """True for vision-language checkpoints (Qwen3.5, Gemma 4 ...): config has a vision tower."""
    try:
        from transformers import AutoConfig
        cfg = AutoConfig.from_pretrained(repo)
        archs = " ".join(getattr(cfg, "architectures", None) or [])
        return hasattr(cfg, "vision_config") or "ConditionalGeneration" in archs
    except Exception:  # noqa: BLE001
        return False


LOADERS = ("AutoModelForImageTextToText", "AutoModelForCausalLM")


def infer_loader(model) -> str:
    """HF Auto class that corresponds to an already loaded (possibly PEFT/Unsloth-wrapped) model."""
    base = model.get_base_model() if hasattr(model, "get_base_model") else model
    name = base.__class__.__name__
    cfg = getattr(base, "config", None)
    if "ConditionalGeneration" in name or hasattr(cfg, "vision_config"):
        return "AutoModelForImageTextToText"
    return "AutoModelForCausalLM"


def load_hf_model(repo: str, dtype, quant_cfg=None, device_map=None, loader: str | None = None):
    """Load with the class that matches the checkpoint: multimodal checkpoints go through
    AutoModelForImageTextToText FIRST (keeps the original architecture + module names, so LoRA keys, the merged
    config and the llama.cpp converter all agree); plain LMs use AutoModelForCausalLM.
    `loader` (from adapter/rico_meta.json) pins the exact class used during training - no guessing, no fallback."""
    import transformers
    if loader:
        order = (loader,)
    else:
        order = LOADERS if is_multimodal(repo) else LOADERS[::-1]
    errors = []
    for cls_name in order:
        cls = getattr(transformers, cls_name, None)
        if cls is None:
            errors.append(f"{cls_name}: not available in transformers {transformers.__version__}")
            continue
        try:
            kw: dict[str, Any] = dict(**_dtype_kw(dtype), trust_remote_code=False)
            if quant_cfg is not None:
                kw["quantization_config"] = quant_cfg
            if device_map is not None:
                kw["device_map"] = device_map
            model = cls.from_pretrained(repo, **kw)
            model._rico_loader = cls_name
            log(f"loaded {repo} with {cls_name} ({model.__class__.__name__})")
            return model
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{cls_name}: {exc}")
    raise RuntimeError("could not load " + repo + ":
  " + "
  ".join(errors))


META_NAME = "rico_meta.json"


def write_adapter_meta(adapter: Path, args: argparse.Namespace, model, engine: str) -> dict:
    """adapter/rico_meta.json: what the merge needs to rebuild EXACTLY the model the adapter was trained on."""
    import peft
    import transformers
    base_model = model.get_base_model() if hasattr(model, "get_base_model") else model
    meta = {
        "base": args.base, "train_base": args.train_base, "preset": args.preset, "engine": engine,
        "loader": getattr(base_model, "_rico_loader", None) or infer_loader(model),
        "base_class": base_model.__class__.__name__,
        "architectures": list(getattr(getattr(base_model, "config", None), "architectures", None) or []),
        "lora_modules": len(adapter_module_names(adapter)), "lora_r": args.lora_r, "lora_alpha": args.lora_alpha,
        "transformers": transformers.__version__, "peft": peft.__version__,
    }
    (adapter / META_NAME).write_text(json.dumps(meta, indent=2) + "
", encoding="utf-8")
    log(f"wrote {adapter / META_NAME}: loader={meta['loader']} base_class={meta['base_class']} base={meta['base']}")
    return meta


def read_adapter_meta(adapter: Path) -> dict:
    f = adapter / META_NAME
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}


def adapter_module_names(adapter: Path) -> list[str]:
    """Module names an adapter was trained on (from its safetensors keys)."""
    f = adapter / "adapter_model.safetensors"
    if not f.exists():
        return []
    from safetensors import safe_open
    names = set()
    with safe_open(str(f), framework="pt") as sf:
        for k in sf.keys():
            if ".lora_A" in k:
                names.add(k.split(".lora_A")[0].removeprefix("base_model.model."))
    return sorted(names)


def find_lora_targets(model) -> list[str]:
    import torch
    names = []
    for name, mod in model.named_modules():
        leaf = name.rsplit(".", 1)[-1]
        if leaf not in LORA_LEAVES or any(s in name for s in SKIP_PATH_PARTS):
            continue
        if isinstance(mod, torch.nn.Linear) or mod.__class__.__name__ in ("Linear4bit", "Linear8bitLt"):
            names.append(name)
    if not names:
        raise RuntimeError("no LoRA target modules found - check LORA_LEAVES for this architecture")
    from collections import Counter
    log("LoRA targets: " + ", ".join(f"{k} x{v}" for k, v in Counter(n.rsplit('.', 1)[-1] for n in names).items()))
    return names


def assert_language_only(model) -> None:
    """The vision tower / projector must stay untouched so the shipped mmproj keeps working with the tuned model."""
    bad = [n for n, m in model.named_modules() if hasattr(m, "lora_A") and any(x in n for x in SKIP_PATH_PARTS)]
    if bad:
        raise RuntimeError(f"LoRA attached to non-language modules (would break the mmproj match): {bad[:3]}")
    n = sum(1 for _, m in model.named_modules() if hasattr(m, "lora_A"))
    log(f"LoRA attached to {n} language-model modules; vision tower + projector untouched")


def setup_model(args: argparse.Namespace):
    """Returns (model, engine_name). Model is PEFT-wrapped and ready for training."""
    import torch
    if args.vram_fraction and torch.cuda.is_available():
        torch.cuda.set_per_process_memory_fraction(args.vram_fraction)
    dtype = compute_dtype()
    log(f"compute dtype: {dtype}; qlora={args.qlora}; cuda={torch.cuda.is_available()}")

    if args.engine in ("auto", "unsloth"):
        try:
            return _setup_unsloth(args, dtype), "unsloth"
        except Exception as exc:  # noqa: BLE001
            if args.engine == "unsloth":
                raise
            log(f"Unsloth unavailable ({type(exc).__name__}: {str(exc)[:200]}) -> falling back to PEFT")
    return _setup_peft(args, dtype), "peft"


def _setup_unsloth(args: argparse.Namespace, dtype):
    from unsloth import FastLanguageModel  # must be imported before transformers/peft
    last = None
    for loader in ("FastLanguageModel", "FastModel"):
        try:
            import unsloth
            cls = getattr(unsloth, loader)
            model, _tok = cls.from_pretrained(model_name=args.train_base, max_seq_length=args.seq_len, dtype=None,
                                              load_in_4bit=args.qlora)
            kw = dict(r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=args.lora_dropout, bias="none",
                      use_gradient_checkpointing="unsloth", random_state=args.seed)
            try:   # explicit module names => language model only (vision tower / projector stay frozen)
                peft_model = cls.get_peft_model(model, target_modules=find_lora_targets(model), **kw)
            except Exception as exc:  # noqa: BLE001
                log(f"explicit LoRA targets rejected by Unsloth ({str(exc)[:120]}); using the standard 7 names")
                peft_model = cls.get_peft_model(
                    model, target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
                    **kw)
            assert_language_only(peft_model)
            return peft_model
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise RuntimeError(f"unsloth loaders failed: {last}")


def _setup_peft(args: argparse.Namespace, dtype):
    import torch
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    quant = None
    if args.qlora:
        from transformers import BitsAndBytesConfig
        quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True,
                                   bnb_4bit_compute_dtype=dtype)
    model = load_hf_model(args.base, dtype, quant_cfg=quant, device_map={"": 0} if torch.cuda.is_available() else None)
    if args.qlora:
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
                                                gradient_checkpointing_kwargs={"use_reentrant": False})
    else:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        if hasattr(model, "enable_input_require_grads"):
            model.enable_input_require_grads()
    model.config.use_cache = False
    cfg = LoraConfig(r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=args.lora_dropout, bias="none",
                     task_type="CAUSAL_LM", target_modules=find_lora_targets(model))
    model = get_peft_model(model, cfg)
    assert_language_only(model)
    model.print_trainable_parameters()
    return model


# --------------------------------------------------------------------------- #
# training
# --------------------------------------------------------------------------- #


def train(args: argparse.Namespace, tok, train_rows: list[dict], dev_rows: list[dict], callbacks=None) -> Path:
    import torch
    from transformers import Trainer, TrainingArguments
    from transformers.trainer_utils import get_last_checkpoint

    if args.num_threads:
        torch.set_num_threads(args.num_threads)
    model, engine = setup_model(args)
    use_bf16 = compute_dtype() == torch.bfloat16
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    try:
        import bitsandbytes  # noqa: F401
        optim = "paged_adamw_8bit" if args.qlora else "adamw_8bit"
    except Exception:  # noqa: BLE001
        optim = "adamw_torch"
    kw: dict[str, Any] = dict(
        output_dir=str(out), per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=1, gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs, max_steps=args.max_steps, learning_rate=args.lr,
        lr_scheduler_type="cosine", warmup_ratio=args.warmup_ratio, weight_decay=args.weight_decay,
        max_grad_norm=1.0, logging_steps=args.logging_steps, save_strategy="steps", save_steps=args.save_steps,
        save_total_limit=3, bf16=use_bf16, fp16=not use_bf16, optim=optim,
        gradient_checkpointing=(engine != "unsloth"),
        gradient_checkpointing_kwargs={"use_reentrant": False} if engine != "unsloth" else None,
        dataloader_num_workers=0, report_to="none", remove_unused_columns=False, seed=args.seed,
        group_by_length=False,
    )
    if dev_rows:
        kw.update(eval_strategy="steps", eval_steps=args.save_steps)
    try:
        targs = TrainingArguments(**kw)
    except TypeError:  # older transformers: evaluation_strategy
        if "eval_strategy" in kw:
            kw["evaluation_strategy"] = kw.pop("eval_strategy")
        targs = TrainingArguments(**kw)

    trainer = Trainer(model=model, args=targs, train_dataset=ListDataset(train_rows),
                      eval_dataset=ListDataset(dev_rows) if dev_rows else None,
                      data_collator=make_collator(tok.pad_token_id), callbacks=(callbacks() if callable(callbacks) else list(callbacks or [])))
    resume = None if args.no_resume else get_last_checkpoint(str(out))
    if resume:
        log(f"resuming from {resume}")
    log(f"training: {len(train_rows)} examples, eff. batch {args.batch_size * args.grad_accum}, "
        f"epochs={args.epochs}, engine={engine}, optim={optim}")
    trainer.train(resume_from_checkpoint=resume)
    args.training_finished = trainer.state.max_steps > 0 and trainer.state.global_step >= trainer.state.max_steps
    adapter = out / "adapter"
    trainer.model.save_pretrained(str(adapter))
    tok.save_pretrained(str(adapter))
    write_adapter_meta(adapter, args, trainer.model, engine)
    log(f"adapter saved -> {adapter}")
    return adapter


# --------------------------------------------------------------------------- #
# merge + export
# --------------------------------------------------------------------------- #


def merge_adapter(args: argparse.Namespace, adapter: Path, merged: Path) -> None:
    import torch
    from peft import PeftModel
    from transformers import AutoTokenizer
    log("merging LoRA into the 16-bit base on CPU (needs ~2x model size in RAM) ...")
    base = load_hf_model(args.base, torch.bfloat16, device_map={"": "cpu"})
    # every adapter module must exist in the freshly loaded base (otherwise merge would silently skip weights)
    base_names = {n for n, _ in base.named_modules()}
    wanted = adapter_module_names(adapter)
    missing = [n for n in wanted if n not in base_names]
    if missing:
        raise RuntimeError(f"{len(missing)}/{len(wanted)} adapter modules are not in the base model {args.base} "
                           f"(e.g. {missing[:3]}). Train and export with the same --engine/--base "
                           f"(multimodal checkpoints must be loaded with AutoModelForImageTextToText).")
    log(f"adapter keys match the base: {len(wanted)} LoRA modules")
    model = PeftModel.from_pretrained(base, str(adapter))
    n_wrapped = sum(1 for m in model.modules() if hasattr(m, "lora_A") and len(getattr(m, "lora_A", {})) > 0)
    n_saved = 0
    for fn in ("adapter_model.safetensors", "adapter_model.bin"):
        f = adapter / fn
        if f.exists() and fn.endswith(".safetensors"):
            from safetensors import safe_open
            with safe_open(str(f), framework="pt") as sf:
                n_saved = sum(1 for k in sf.keys() if "lora_A" in k)
            break
    if n_saved and n_wrapped != n_saved:
        raise RuntimeError(f"adapter/base mismatch: adapter has {n_saved} LoRA modules but only {n_wrapped} attached "
                           f"to the base loaded from {args.base}. Train and export with the same --engine/--base.")
    merged_model = model.merge_and_unload()
    merged.mkdir(parents=True, exist_ok=True)
    merged_model.save_pretrained(str(merged), safe_serialization=True, max_shard_size="4GB")
    AutoTokenizer.from_pretrained(args.base).save_pretrained(str(merged))
    # the converter picks its code path from config.architectures - it must not change vs. the shipped base
    import json as _json
    from transformers import AutoConfig
    base_archs = list(getattr(AutoConfig.from_pretrained(args.base), "architectures", None) or [])
    merged_archs = _json.loads((merged / "config.json").read_text(encoding="utf-8")).get("architectures") or []
    if base_archs and merged_archs != base_archs:
        raise RuntimeError(f"merged config.architectures {merged_archs} != base {base_archs}; "
                           "convert_hf_to_gguf would build a different graph (and the mmproj would not match)")
    log(f"merged model -> {merged} ({n_wrapped} LoRA modules merged; architectures {merged_archs} unchanged)")


def export_gguf(args: argparse.Namespace, merged: Path) -> None:
    from llama_tools import ensure_llama_bin, ensure_llama_src
    work = Path(args.llama_work)
    src = ensure_llama_src(work / "src")
    binary = ensure_llama_bin(work / "bin")
    exe = ".exe" if os.name == "nt" else ""
    out = Path(args.out)
    bf16 = out / f"{args.tier}-bf16.gguf"
    q4 = out / f"{args.tier}-Q4_K_M.gguf"
    log("converting HF -> GGUF (bf16) ...")
    subprocess.run([sys.executable, str(src / "convert_hf_to_gguf.py"), str(merged), "--outfile", str(bf16),
                    "--outtype", "bf16"], check=True)
    log("quantizing to Q4_K_M ...")
    env = dict(os.environ, LD_LIBRARY_PATH=str(binary) + os.pathsep + os.environ.get("LD_LIBRARY_PATH", ""))
    subprocess.run([str(binary / f"llama-quantize{exe}"), str(bf16), str(q4), "Q4_K_M"], check=True, env=env)
    bf16.unlink(missing_ok=True)
    log("patching metadata + splitting into <=1900 MB shards (ml/package_model.py patch-existing) ...")
    subprocess.run([sys.executable, str(REPO_ROOT / "ml" / "package_model.py"), "patch-existing", "--tier", args.tier,
                    "--in", str(q4), "--work", str(out / "work"), "--out-dir", str(out / "release"),
                    "--llama-bin", str(binary), "--base-model", args.base], check=True)
    log(f"DONE. Upload {out / 'release'}/*.gguf to the models-v1 release, then merge the catalog patch "
        f"({out / 'release' / ('catalog-patch-' + args.tier + '.json')}) with `package_model.py merge-catalog`.")


# --------------------------------------------------------------------------- #


def _maybe_import_unsloth(args: argparse.Namespace) -> None:
    """Unsloth must be imported BEFORE transformers/peft so its patches apply."""
    if args.engine in ("auto", "unsloth") and not args.dry_run:
        try:
            import unsloth  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            if args.engine == "unsloth":
                raise
            log(f"unsloth not importable ({type(exc).__name__}); will use PEFT")


def run(args: argparse.Namespace, callbacks=None) -> int:
    args = resolve(args)
    _maybe_import_unsloth(args)
    persona = load_persona()
    log(f"preset={args.preset} base={args.base} qlora={args.qlora} seq={args.seq_len} "
        f"batch={args.batch_size}x{args.grad_accum} out={args.out}")
    if not Path(args.data).exists() and not args.skip_train:
        raise SystemExit(f"training data not found: {args.data} (run the distill workflow first)")

    adapter = Path(args.out) / "adapter"
    if not args.skip_train:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(args.base)
        if tok.pad_token_id is None:
            tok.pad_token = tok.eos_token
        eot = detect_eot(tok)
        train_ex, dev_ex = load_examples(args.data, args.system_prob, persona, args.seed, args.dev_fraction,
                                         args.max_samples)
        train_rows, st = encode_examples(tok, train_ex, args.seq_len, persona, eot)
        dev_rows, _ = encode_examples(tok, dev_ex[: args.eval_samples], args.seq_len, persona, eot)
        log(f"eot={eot!r} train={st} dev={len(dev_rows)}")
        if not train_rows:
            raise SystemExit("no usable training examples")
        if args.dry_run:
            ex = train_rows[0]
            sup = [t for t, l in zip(ex["input_ids"], ex["labels"]) if l != -100]
            log("--- prompt (masked) ---\n" + tok.decode([t for t, l in zip(ex["input_ids"], ex["labels"]) if l == -100]))
            log("--- supervised ---\n" + tok.decode(sup))
            return 0
        adapter = train(args, tok, train_rows, dev_rows, callbacks)
    elif not adapter.exists():
        raise SystemExit(f"--skip-train but no adapter at {adapter}")

    if args.export and not getattr(args, "training_finished", True):
        log("training stopped early (thermal stop / interrupt) - NOT exporting. Re-run the same command to resume.")
        return 3
    if args.export:
        merged = Path(args.out) / "merged"
        merge_adapter(args, adapter, merged)
        export_gguf(args, merged)
        if not args.keep_merged:
            import shutil
            shutil.rmtree(merged, ignore_errors=True)
    return 0


def main(argv: list[str] | None = None, callbacks=None) -> int:
    return run(build_parser().parse_args(argv), callbacks)


if __name__ == "__main__":
    sys.exit(main())
