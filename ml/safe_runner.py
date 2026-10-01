#!/usr/bin/env python3
"""Run ml/train_lora.py on a small laptop GPU (e.g. Quadro T2000 4 GB) WITHOUT lagging or heating the PC.

Safety features
  * process priority BELOW_NORMAL (Windows) / nice +10 (POSIX); CPU threads limited (default 4)
  * VRAM headroom: seq 768, batch 1, grad-accum 16, gradient checkpointing, per-process memory fraction 0.92
  * thermal watchdog thread: polls `nvidia-smi` every 5 s; PAUSES training when temp >= 78 C and resumes at <= 70 C;
    hard stop (checkpoint + exit) at >= 85 C
  * duty cycle: after every micro-batch the trainer sleeps so the GPU is busy ~65 % of the time on average
  * checkpoint every 50 optimizer steps + automatic resume (re-run the same command)
  * manual pause/resume: create / delete the flag file  ml/work/PAUSE

Usage (normally via ml/train_local_safe.ps1)
    python ml/safe_runner.py [--duty 0.65 --max-temp 78 ...] -- [any train_lora.py arguments]
    python ml/safe_runner.py --selfcheck
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

WORK = ROOT / "ml" / "work"
DEFAULT_PAUSE_FILE = WORK / "PAUSE"
STATUS_FILE = WORK / "status.json"


def log(msg: str) -> None:
    print(f"[safe {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# process priority / environment
# --------------------------------------------------------------------------- #


def lower_priority() -> None:
    try:
        if os.name == "nt":
            import ctypes
            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
            kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
        log("process priority lowered (below normal)")
    except Exception as exc:  # noqa: BLE001
        log(f"could not lower priority: {exc}")


def limit_cpu_threads(n: int) -> None:
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS"):
        os.environ[var] = str(n)
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    # expandable_segments is not supported on Windows; use conservative caching-allocator knobs instead
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "garbage_collection_threshold:0.8,max_split_size_mb:128")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")


# --------------------------------------------------------------------------- #
# nvidia-smi watchdog
# --------------------------------------------------------------------------- #


def query_gpu(index: int = 0) -> dict | None:
    try:
        kw = {}
        if os.name == "nt":
            kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        r = subprocess.run(
            ["nvidia-smi", "-i", str(index), "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,name",
             "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=15, **kw)
        if r.returncode != 0:
            return None
        parts = [p.strip() for p in r.stdout.strip().splitlines()[0].split(",")]
        return {"temp": float(parts[0]), "util": float(parts[1]), "mem_used": float(parts[2]),
                "mem_total": float(parts[3]), "name": parts[4]}
    except Exception:  # noqa: BLE001
        return None


class GpuWatch(threading.Thread):
    """Polls the GPU; `hot` is set at >= max_temp and cleared at <= resume_temp (hysteresis)."""

    def __init__(self, max_temp: float, resume_temp: float, hard_temp: float, poll: float, gpu_index: int = 0):
        super().__init__(daemon=True, name="gpu-watchdog")
        self.max_temp, self.resume_temp, self.hard_temp, self.poll = max_temp, resume_temp, hard_temp, poll
        self.gpu_index = gpu_index
        self.hot = threading.Event()
        self.emergency = threading.Event()
        self.last: dict | None = None
        self.failures = 0
        self.unreadable = threading.Event()   # nvidia-smi keeps failing -> caller should be extra conservative
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        while not self._stop.is_set():
            info = query_gpu(self.gpu_index)
            if info is None:
                self.failures += 1
                if self.failures >= 3 and not self.unreadable.is_set():
                    self.unreadable.set()
                    log("WARNING: nvidia-smi unreadable - falling back to duty-cycle protection only")
            else:
                self.failures = 0
                self.unreadable.clear()
                self.last = info
                t = info["temp"]
                if t >= self.hard_temp and not self.emergency.is_set():
                    self.emergency.set()
                    log(f"EMERGENCY: GPU {t:.0f} C >= {self.hard_temp:.0f} C - saving checkpoint and stopping")
                if t >= self.max_temp and not self.hot.is_set():
                    self.hot.set()
                    log(f"GPU {t:.0f} C >= {self.max_temp:.0f} C -> pausing training until <= {self.resume_temp:.0f} C")
                elif t <= self.resume_temp and self.hot.is_set():
                    self.hot.clear()
                    log(f"GPU cooled to {t:.0f} C -> resuming")
            self._stop.wait(self.poll)


# --------------------------------------------------------------------------- #
# Trainer callback
# --------------------------------------------------------------------------- #


def make_callback(watch: GpuWatch | None, duty: float, pause_file: Path, max_sleep: float = 90.0):
    from transformers import TrainerCallback

    class SafeCallback(TrainerCallback):
        def __init__(self) -> None:
            self.t_mark = time.time()
            self.busy_total = 0.0
            self.sleep_total = 0.0
            self.last_status = 0.0
            self.state_txt = "running"

        # -- helpers ---------------------------------------------------------
        def _sync(self) -> None:
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
            except Exception:  # noqa: BLE001
                pass

        def _write_status(self, state, extra: str = "") -> None:
            now = time.time()
            if now - self.last_status < 15:
                return
            self.last_status = now
            info = watch.last if watch and watch.last else {}
            try:
                STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
                STATUS_FILE.write_text(json.dumps({
                    "time": time.strftime("%Y-%m-%d %H:%M:%S"), "step": getattr(state, "global_step", None),
                    "max_steps": getattr(state, "max_steps", None), "state": self.state_txt + extra,
                    "gpu": info, "avg_duty": round(self.busy_total / max(self.busy_total + self.sleep_total, 1e-6), 3),
                }), encoding="utf-8")
            except OSError:
                pass

        def _gate(self, state, control) -> None:
            """Block while the PAUSE flag exists or the GPU is hot."""
            announced = False
            while True:
                if watch and watch.emergency.is_set():
                    control.should_save = True
                    control.should_training_stop = True
                    return
                paused = pause_file.exists()
                hot = bool(watch and watch.hot.is_set())
                if not paused and not hot:
                    break
                if not announced:
                    self.state_txt = "paused (flag file)" if paused else "cooling down"
                    log(f"training {self.state_txt} ...")
                    announced = True
                    try:
                        import torch
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    except Exception:  # noqa: BLE001
                        pass
                self._write_status(state)
                time.sleep(2.0)
            if announced:
                log("training resumed")
            self.state_txt = "running"

        def _after_work(self, state, control) -> None:
            self._sync()
            now = time.time()
            busy = max(now - self.t_mark, 0.0)
            d = duty
            if watch and watch.unreadable.is_set():
                d = min(d, 0.5)
            self._gate(state, control)
            sleep = min(busy * (1.0 / d - 1.0), max_sleep) if 0 < d < 1 else 0.0
            if sleep > 0:
                time.sleep(sleep)
            self.busy_total += busy
            self.sleep_total += sleep
            self._write_status(state)
            self.t_mark = time.time()

        # -- Trainer hooks ---------------------------------------------------
        def on_train_begin(self, args, state, control, **kw):
            self.t_mark = time.time()

        def on_step_begin(self, args, state, control, **kw):
            self._gate(state, control)
            self.t_mark = time.time()

        def on_substep_end(self, args, state, control, **kw):
            self._after_work(state, control)

        def on_step_end(self, args, state, control, **kw):
            self._after_work(state, control)

        def on_save(self, args, state, control, **kw):
            log(f"checkpoint saved at step {state.global_step} "
                f"(avg GPU duty so far {self.busy_total / max(self.busy_total + self.sleep_total, 1e-6):.0%})")
            self.t_mark = time.time()

        def on_train_end(self, args, state, control, **kw):
            self._write_status(state, " (finished)")

    return SafeCallback()


# --------------------------------------------------------------------------- #


def selfcheck() -> int:
    ok = True
    log(f"python {sys.version.split()[0]}")
    for mod in ("torch", "transformers", "peft", "bitsandbytes", "unsloth", "datasets", "accelerate", "psutil", "gguf"):
        try:
            m = __import__(mod)
            log(f"  {mod:13s} {getattr(m, '__version__', 'ok')}")
        except Exception as exc:  # noqa: BLE001
            log(f"  {mod:13s} MISSING ({type(exc).__name__})")
            if mod in ("torch", "transformers", "peft"):
                ok = False
    try:
        import torch
        if torch.cuda.is_available():
            p = torch.cuda.get_device_properties(0)
            log(f"  CUDA OK: {p.name}, {p.total_memory / 2**30:.1f} GiB, capability {p.major}.{p.minor}, torch CUDA {torch.version.cuda}")
        else:
            log("  CUDA NOT available to torch (wrong wheel or driver too old?)")
            ok = False
    except Exception:  # noqa: BLE001
        pass
    info = query_gpu(0)
    log(f"  nvidia-smi: {info if info else 'NOT AVAILABLE'}")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
                                 allow_abbrev=False)
    ap.add_argument("--max-temp", type=float, default=78.0, help="pause at/above this GPU temperature (C)")
    ap.add_argument("--resume-temp", type=float, default=70.0, help="resume at/below this temperature (C)")
    ap.add_argument("--hard-temp", type=float, default=85.0, help="checkpoint + stop at/above this temperature (C)")
    ap.add_argument("--duty", type=float, default=0.65, help="average GPU busy fraction (0.3 .. 1.0)")
    ap.add_argument("--poll", type=float, default=5.0, help="nvidia-smi polling interval (s)")
    ap.add_argument("--threads", type=int, default=4, help="CPU threads")
    ap.add_argument("--gpu-index", type=int, default=0)
    ap.add_argument("--pause-file", default=str(DEFAULT_PAUSE_FILE))
    ap.add_argument("--allow-no-smi", action="store_true", help="continue even if nvidia-smi is unavailable")
    ap.add_argument("--force", action="store_true", help="ignore the VRAM pre-flight check")
    ap.add_argument("--selfcheck", action="store_true", help="print environment / GPU diagnostics and exit")
    args, train_args = ap.parse_known_args(argv)
    if train_args and train_args[0] == "--":
        train_args = train_args[1:]

    if args.selfcheck:
        return selfcheck()
    if not 0.2 <= args.duty <= 1.0:
        ap.error("--duty must be between 0.2 and 1.0")

    lower_priority()
    limit_cpu_threads(args.threads)

    # ---- defaults tuned for a 4 GB laptop GPU (user-provided train args win) --------------------------------
    def has(flag: str) -> bool:
        return any(a == flag or a.startswith(flag + "=") for a in train_args)

    defaults = {"--preset": "qwen3-4b-2507", "--seq-len": "768", "--batch-size": "1", "--grad-accum": "16",
                "--save-steps": "50", "--num-threads": str(args.threads), "--vram-fraction": "0.92",
                "--out": str(ROOT / "ml" / "outputs" / "rico-lite-local")}
    for k, v in defaults.items():
        if not has(k):
            train_args += [k, v]

    import train_lora
    preset_name = train_args[train_args.index("--preset") + 1] if "--preset" in train_args else "qwen3-4b-2507"
    preset = train_lora.PRESETS[preset_name]

    info = query_gpu(args.gpu_index)
    watch: GpuWatch | None = None
    if info is None:
        if not args.allow_no_smi:
            log("nvidia-smi not found / no NVIDIA GPU - refusing to start (use --allow-no-smi to override)")
            return 2
        log("WARNING: running without temperature monitoring")
    else:
        log(f"GPU: {info['name']}  {info['temp']:.0f} C  VRAM {info['mem_used']:.0f}/{info['mem_total']:.0f} MiB")
        need = preset["min_vram_gb"] * 1024
        if info["mem_total"] < need and not args.force:
            log(f"preset {preset_name} needs ~{preset['min_vram_gb']} GB VRAM but the GPU has "
                f"{info['mem_total'] / 1024:.1f} GB. Use --preset qwen3-4b-2507 / qwen35-2b / qwen3-1.7b, or --force.")
            return 2
        if info["mem_total"] - info["mem_used"] < need * 0.9 and not args.force:
            log(f"only {(info['mem_total'] - info['mem_used']) / 1024:.1f} GB VRAM free (other apps?). "
                "Close browsers/games or use --force.")
            return 2
        watch = GpuWatch(args.max_temp, args.resume_temp, args.hard_temp, args.poll, args.gpu_index)
        watch.start()

    pause_file = Path(args.pause_file)
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    log(f"pause/resume flag file: {pause_file}  (create it to pause, delete it to resume)")
    log(f"limits: pause >= {args.max_temp:.0f} C, resume <= {args.resume_temp:.0f} C, stop >= {args.hard_temp:.0f} C, "
        f"duty {args.duty:.0%}, {args.threads} CPU threads")
    log("train_lora args: " + " ".join(train_args))

    try:
        ns = train_lora.build_parser().parse_args(train_args)
        # The callback is created lazily (inside train_lora.run, after Unsloth/transformers were imported).
        rc = train_lora.run(ns, lambda: [make_callback(watch, args.duty, pause_file)])
    finally:
        if watch:
            watch.stop()
    return rc


if __name__ == "__main__":
    sys.exit(main())
