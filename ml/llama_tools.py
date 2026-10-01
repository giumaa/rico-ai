"""Fetch pinned llama.cpp pieces (convert_hf_to_gguf.py source tree + prebuilt binaries) for GGUF export.

Used by ml/train_lora.py and the Kaggle notebook. CI workflows download the same pinned release themselves.
Keep LLAMA_TAG in sync with `LLAMA_CPP_TAG` in .github/workflows/*.yml.
"""
from __future__ import annotations

import io
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

LLAMA_TAG = "b11312"
_REL = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}"


def _asset_name() -> tuple[str, str]:
    system, machine = platform.system(), platform.machine().lower()
    if system == "Linux" and machine in ("x86_64", "amd64"):
        return f"llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz", "tar"
    if system == "Linux" and machine in ("aarch64", "arm64"):
        return f"llama-{LLAMA_TAG}-bin-ubuntu-arm64.tar.gz", "tar"
    if system == "Windows":
        return f"llama-{LLAMA_TAG}-bin-win-cpu-x64.zip", "zip"
    if system == "Darwin":
        return (f"llama-{LLAMA_TAG}-bin-macos-arm64.tar.gz" if machine == "arm64"
                else f"llama-{LLAMA_TAG}-bin-macos-x64.tar.gz"), "tar"
    raise RuntimeError(f"unsupported platform {system}/{machine}")


def _download(url: str) -> bytes:
    print(f"[llama_tools] downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=300) as r:
        return r.read()


def ensure_llama_bin(dest: Path) -> Path:
    """Directory containing llama-quantize / llama-gguf-split / llama-server (downloads once)."""
    dest = Path(dest)
    exe = ".exe" if os.name == "nt" else ""
    for cand in [dest] + [p for p in dest.glob("*") if p.is_dir()]:
        if (cand / f"llama-quantize{exe}").exists():
            return cand
    dest.mkdir(parents=True, exist_ok=True)
    name, kind = _asset_name()
    blob = _download(f"{_REL}/{name}")
    if kind == "zip":
        zipfile.ZipFile(io.BytesIO(blob)).extractall(dest)
    else:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
            tf.extractall(dest)
    for cand in [dest] + [p for p in dest.glob("*") if p.is_dir()]:
        if (cand / f"llama-quantize{exe}").exists():
            for f in cand.glob("llama-*"):
                try:
                    f.chmod(f.stat().st_mode | 0o111)
                except OSError:
                    pass
            return cand
    raise RuntimeError(f"llama-quantize not found after extracting {name}")


def ensure_llama_src(dest: Path) -> Path:
    """Source tree at the pinned tag (needs convert_hf_to_gguf.py + conversion/ + gguf-py/)."""
    dest = Path(dest)
    if (dest / "convert_hf_to_gguf.py").exists():
        return dest
    if shutil.which("git"):
        dest.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "clone", "--depth", "1", "--branch", LLAMA_TAG,
                        "https://github.com/ggml-org/llama.cpp", str(dest)], check=True)
        return dest
    blob = _download(f"https://github.com/ggml-org/llama.cpp/archive/refs/tags/{LLAMA_TAG}.zip")
    zipfile.ZipFile(io.BytesIO(blob)).extractall(dest.parent)
    extracted = dest.parent / f"llama.cpp-{LLAMA_TAG}"
    extracted.rename(dest)
    return dest


if __name__ == "__main__":
    work = Path(sys.argv[1] if len(sys.argv) > 1 else "ml/work/llama.cpp")
    print(ensure_llama_bin(work / "bin"))
    print(ensure_llama_src(work / "src"))
