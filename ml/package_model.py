#!/usr/bin/env python3
"""Package a Rico model for distribution.

Pipeline (one tier at a time; see .github/workflows/package-models.yml):

    download base GGUF (Hugging Face, sha256-verified)
      -> patch GGUF metadata  (general.name / author / description + persona-aware chat template)
      -> split with llama-gguf-split into <=1900 MB shards (GitHub release assets are limited to 2 GiB)
      -> sha256 + sizes -> catalog patch JSON
      -> (workflow) gh release upload, then `merge-catalog` + commit models/catalog.json

Sub-commands
    list            tiers known to models/catalog.json
    download        fetch the upstream GGUF of a tier
    patch           rewrite metadata of a single-file GGUF
    split           llama-gguf-split --split
    describe        sha256/sizes of shards -> catalog patch JSON
    run             download + patch + split + verify + describe  (what CI calls)
    patch-existing  patch + split + describe a local GGUF (used after fine-tuning)
    merge-catalog   apply catalog patch JSON files to models/catalog.json
    check-template  render a chat template (from a GGUF / file) with jinja2 and assert persona behaviour
    server-check    start llama-server on the first shard and call /apply-template (real engine check)

Dependencies: python>=3.10, `gguf` and `jinja2` (pip install gguf jinja2). curl for downloads.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rico_common import (  # noqa: E402
    AUTHOR, CATALOG_PATH, REPO_ROOT, SYSTEM_PROMPT_PATH, load_persona, sha256_file,
)

DEFAULT_REPO = "giumaa/rico-ai"
RELEASE_TAG = "models-v1"
SPLIT_MAX = "1900M"                 # llama-gguf-split: M = 1,000,000 bytes -> 1.9e9 < 2 GiB (GitHub asset limit)
MAX_SHARD_BYTES = 2_000_000_000
GENERAL_NAMES = {"rico-lite": "Rico Lite", "rico": "Rico", "rico-max": "Rico Max"}
RICO_MARK = "{#- rico:default-persona -#}"


# --------------------------------------------------------------------------- #
# catalog helpers
# --------------------------------------------------------------------------- #


def load_catalog(path: Path | str = CATALOG_PATH) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save_catalog(cat: dict, path: Path | str = CATALOG_PATH) -> None:
    Path(path).write_text(json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def get_model(cat: dict, tier: str) -> dict:
    for m in cat["models"]:
        if m["id"] == tier:
            return m
    raise SystemExit(f"unknown tier {tier!r}; known: {[m['id'] for m in cat['models']]}")


def log(msg: str) -> None:
    print(f"[package_model] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# chat template patching
# --------------------------------------------------------------------------- #


def jinja_string_literal(text: str) -> str:
    """Double-quoted Jinja string literal using only the escapes every engine supports."""
    out = []
    for ch in text:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def patch_chat_template(original: str, persona: str) -> str:
    """Wrap the model's own chat template so that

    * when the caller supplies NO system message, the Rico persona is used as the default system prompt;
    * thinking is OFF by default (`enable_thinking` defaults to false) - Rico answers directly.

    The original template logic is left byte-for-byte intact below the prologue.
    """
    if RICO_MARK in original:
        return original
    prologue = (
        RICO_MARK + "\n"
        "{%- if enable_thinking is not defined -%}{%- set enable_thinking = false -%}{%- endif -%}\n"
        "{%- if messages and messages[0]['role'] not in ['system', 'developer'] -%}\n"
        "{%- set messages = [{'role': 'system', 'content': " + jinja_string_literal(persona) + "}] + messages -%}\n"
        "{%- endif -%}\n"
    )
    return prologue + original


# --------------------------------------------------------------------------- #
# GGUF metadata patch
# --------------------------------------------------------------------------- #


def patch_gguf(src: Path, dst: Path, *, name: str, description: str, persona: str,
               license_id: str | None = None, base_model: str | None = None,
               extra_template_patch: bool = True) -> dict:
    """Copy `src` -> `dst` with Rico metadata. Returns a small report dict."""
    import gguf
    from gguf.scripts.gguf_new_metadata import MetadataDetails, copy_with_new_metadata, get_field_data

    reader = gguf.GGUFReader(str(src), "r")
    arch = get_field_data(reader, gguf.Keys.General.ARCHITECTURE)
    old_name = get_field_data(reader, gguf.Keys.General.NAME)
    old_template = get_field_data(reader, gguf.Keys.Tokenizer.CHAT_TEMPLATE)
    if not isinstance(old_template, str) or not old_template.strip():
        raise SystemExit(f"{src.name}: no tokenizer.chat_template in the source GGUF - refusing to guess one")

    S = gguf.GGUFValueType.STRING
    new_meta: dict = {
        gguf.Keys.General.NAME: MetadataDetails(S, name),
        gguf.Keys.General.AUTHOR: MetadataDetails(S, AUTHOR),
        gguf.Keys.General.DESCRIPTION: MetadataDetails(S, description),
        gguf.Keys.General.FINETUNE: MetadataDetails(S, "rico"),
        gguf.Keys.Tokenizer.CHAT_TEMPLATE: MetadataDetails(
            S, patch_chat_template(old_template, persona) if extra_template_patch else old_template),
    }
    if license_id and get_field_data(reader, gguf.Keys.General.LICENSE) is None:
        new_meta[gguf.Keys.General.LICENSE] = MetadataDetails(S, license_id)
    if base_model:
        new_meta["general.base_model.count"] = MetadataDetails(gguf.GGUFValueType.UINT32, 1)
        new_meta["general.base_model.0.name"] = MetadataDetails(S, base_model)

    dst.parent.mkdir(parents=True, exist_ok=True)
    writer = gguf.GGUFWriter(str(dst), arch=arch, endianess=reader.endianess)
    alignment = get_field_data(reader, gguf.Keys.General.ALIGNMENT)
    if alignment is not None:
        writer.data_alignment = alignment
    copy_with_new_metadata(reader, writer, new_meta, [])
    del reader
    return {"arch": arch, "old_name": old_name, "new_name": name, "template_chars": len(old_template)}


# --------------------------------------------------------------------------- #
# split / hash
# --------------------------------------------------------------------------- #


def llama_env(llama_bin: Path) -> dict:
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(llama_bin) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    return env


def split_gguf(src: Path, out_dir: Path, prefix: str, llama_bin: Path, max_size: str = SPLIT_MAX) -> list[Path]:
    exe = llama_bin / ("llama-gguf-split.exe" if os.name == "nt" else "llama-gguf-split")
    if not exe.exists():
        raise SystemExit(f"llama-gguf-split not found in {llama_bin}")
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob(f"{prefix}-*-of-*.gguf"):
        old.unlink()
    cmd = [str(exe), "--split", "--split-max-size", max_size, str(src), str(out_dir / prefix)]
    log("running: " + " ".join(cmd))
    subprocess.run(cmd, check=True, env=llama_env(llama_bin))
    shards = sorted(out_dir.glob(f"{prefix}-*-of-*.gguf"))
    if not shards:
        raise SystemExit("llama-gguf-split produced no shards")
    m = re.search(r"-of-(\d+)\.gguf$", shards[0].name)
    if not m or int(m.group(1)) != len(shards):
        raise SystemExit(f"unexpected shard set: {[s.name for s in shards]}")
    for s in shards:
        if s.stat().st_size > MAX_SHARD_BYTES:
            raise SystemExit(f"{s.name} is {s.stat().st_size} bytes (> {MAX_SHARD_BYTES}); lower --split-max-size")
    return shards


def describe_shards(shards: list[Path], threads: int = 4) -> list[dict]:
    with ThreadPoolExecutor(max_workers=threads) as ex:
        hashes = list(ex.map(sha256_file, shards))
    return [{"name": s.name, "sizeBytes": s.stat().st_size, "sha256": h} for s, h in zip(shards, hashes)]


# --------------------------------------------------------------------------- #
# download
# --------------------------------------------------------------------------- #


def download(url: str, dst: Path, expect_sha256: str | None, expect_size: int | None) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and expect_size and dst.stat().st_size == expect_size and expect_sha256 \
            and sha256_file(dst) == expect_sha256:
        log(f"{dst.name} already present and verified")
        return
    curl = shutil.which("curl")
    if not curl:
        raise SystemExit("curl is required for downloads")
    cmd = [curl, "-fL", "--retry", "8", "--retry-delay", "5", "--retry-all-errors", "-C", "-",
           "--connect-timeout", "30", "-o", str(dst), url]
    log(f"downloading {url}")
    t0 = time.time()
    subprocess.run(cmd, check=True)
    log(f"downloaded {dst.stat().st_size / 1e9:.2f} GB in {time.time() - t0:.0f}s")
    if expect_size and dst.stat().st_size != expect_size:
        raise SystemExit(f"size mismatch: got {dst.stat().st_size}, expected {expect_size}")
    if expect_sha256:
        got = sha256_file(dst)
        if got != expect_sha256:
            raise SystemExit(f"sha256 mismatch for {dst.name}: got {got}, expected {expect_sha256}")
        log("sha256 verified")


# --------------------------------------------------------------------------- #
# verification of the patched / split result
# --------------------------------------------------------------------------- #


def verify_first_shard(first: Path, name: str, persona: str, n_shards: int) -> None:
    import gguf
    from gguf.scripts.gguf_new_metadata import get_field_data
    r = gguf.GGUFReader(str(first), "r")
    got_name = get_field_data(r, gguf.Keys.General.NAME)
    got_author = get_field_data(r, gguf.Keys.General.AUTHOR)
    tmpl = get_field_data(r, gguf.Keys.Tokenizer.CHAT_TEMPLATE)
    cnt = get_field_data(r, "split.count")
    problems = []
    if got_name != name:
        problems.append(f"general.name={got_name!r}, expected {name!r}")
    if got_author != AUTHOR:
        problems.append(f"general.author={got_author!r}")
    if not isinstance(tmpl, str) or RICO_MARK not in tmpl or jinja_string_literal(persona) not in tmpl:
        problems.append("chat template does not contain the Rico persona prologue")
    if n_shards > 1 and cnt != n_shards:
        problems.append(f"split.count={cnt}, expected {n_shards}")
    if problems:
        raise SystemExit("verification failed: " + "; ".join(problems))
    log(f"verified {first.name}: name={got_name!r} author={got_author!r} split.count={cnt}")
    check_template_text(tmpl, persona)


# --------------------------------------------------------------------------- #
# template rendering check (jinja2, HF-style environment)
# --------------------------------------------------------------------------- #


def render_template(template: str, messages: list[dict], **kwargs) -> str:
    import jinja2
    from jinja2.sandbox import ImmutableSandboxedEnvironment

    def raise_exception(msg: str):
        raise jinja2.exceptions.TemplateError(msg)

    env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True,
                                        extensions=["jinja2.ext.loopcontrols"])
    env.filters["tojson"] = lambda x, indent=None, ensure_ascii=False, **k: json.dumps(
        x, ensure_ascii=ensure_ascii, indent=indent)
    env.globals["raise_exception"] = raise_exception
    env.globals["strftime_now"] = lambda fmt: dt.datetime.now().strftime(fmt)
    tpl = env.from_string(template)
    return tpl.render(messages=messages, bos_token="<bos>", eos_token="<eos>", **kwargs)


def check_template_text(template: str, persona: str) -> None:
    probe = persona.strip().splitlines()[0][:30]
    u = [{"role": "user", "content": "مرحبا"}]
    out1 = render_template(template, u, add_generation_prompt=True)
    if probe not in out1:
        raise SystemExit("check-template: persona missing when no system message was supplied")
    s = [{"role": "system", "content": "CUSTOM-SYSTEM-XYZ"}] + u
    out2 = render_template(template, s, add_generation_prompt=True)
    if "CUSTOM-SYSTEM-XYZ" not in out2 or probe in out2:
        raise SystemExit("check-template: caller-supplied system message must replace the default persona")
    multi = u + [{"role": "assistant", "content": "اهلا"}, {"role": "user", "content": "شن اسمك؟"}]
    out3 = render_template(template, multi, add_generation_prompt=True)
    if out3.count(probe) != 1:
        raise SystemExit("check-template: persona must appear exactly once in multi-turn prompts")
    for tail in ("<think>\n", "<|channel>thought\n"):
        if out1.rstrip(" ").endswith(tail):
            raise SystemExit(f"check-template: generation prompt ends with an open thinking block ({tail!r})")
    log("template check OK (default persona injected, explicit system respected, thinking off by default)")


def cmd_check_template(a: argparse.Namespace) -> None:
    persona = load_persona(a.persona)
    if a.template_file:
        tmpl = Path(a.template_file).read_text(encoding="utf-8")
        if RICO_MARK not in tmpl:
            tmpl = patch_chat_template(tmpl, persona)
    else:
        import gguf
        from gguf.scripts.gguf_new_metadata import get_field_data
        tmpl = get_field_data(gguf.GGUFReader(a.gguf, "r"), gguf.Keys.Tokenizer.CHAT_TEMPLATE)
    check_template_text(tmpl, persona)
    if a.show:
        print(render_template(tmpl, [{"role": "user", "content": "منو انت؟"}], add_generation_prompt=True))


# --------------------------------------------------------------------------- #
# llama-server /apply-template check (real llama.cpp jinja engine)
# --------------------------------------------------------------------------- #


def cmd_server_check(a: argparse.Namespace) -> None:
    persona = load_persona(a.persona)
    probe = persona.strip().splitlines()[0][:30]
    exe = Path(a.llama_bin) / ("llama-server.exe" if os.name == "nt" else "llama-server")
    port = a.port
    cmd = [str(exe), "-m", a.gguf, "-c", "512", "-ngl", "0", "-t", "2", "--no-warmup", "--no-webui",
           "--host", "127.0.0.1", "--port", str(port), "--jinja"]
    if a.mmproj:
        cmd += ["--mmproj", a.mmproj]
    log("starting " + " ".join(cmd))
    proc = subprocess.Popen(cmd, env=llama_env(Path(a.llama_bin)), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        base = f"http://127.0.0.1:{port}"
        deadline = time.time() + a.timeout
        while time.time() < deadline:
            if proc.poll() is not None:
                raise SystemExit(f"llama-server exited early with code {proc.returncode}")
            try:
                with urllib.request.urlopen(base + "/health", timeout=5) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(3)
        else:
            raise SystemExit("llama-server did not become healthy in time")

        def apply(msgs):
            req = urllib.request.Request(base + "/apply-template", data=json.dumps({"messages": msgs}).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())["prompt"]

        p1 = apply([{"role": "user", "content": "مرحبا"}])
        p2 = apply([{"role": "system", "content": "CUSTOM-SYSTEM-XYZ"}, {"role": "user", "content": "مرحبا"}])
        if probe not in p1:
            raise SystemExit("server-check: persona missing from default prompt:\n" + p1[:800])
        if "CUSTOM-SYSTEM-XYZ" not in p2 or probe in p2:
            raise SystemExit("server-check: explicit system message not respected:\n" + p2[:800])
        if a.mmproj:
            with urllib.request.urlopen(base + "/props", timeout=30) as r:
                mods = json.loads(r.read()).get("modalities") or {}
            if not mods.get("vision"):
                raise SystemExit(f"server-check: mmproj loaded but vision modality not reported: {mods}")
            log("vision modality reported by llama-server (mmproj matches the model)")
        log("server-check OK (llama.cpp jinja engine renders the patched template correctly)")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            proc.kill()


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #


def tier_description(tier: str, base_model: str) -> str:
    return (f"{GENERAL_NAMES.get(tier, tier)} - Arabic-first assistant (Libyan dialect by default) "
            f"developed and trained by {AUTHOR}. Based on {base_model}.")


def fetch_mmproj(model: dict, out_dir: Path, tier: str) -> dict | None:
    """Copy the (unmodified) upstream vision projector next to the shards as <tier>-mmproj-F16.gguf."""
    src = (model.get("source") or {}).get("mmproj")
    if not src:
        return None
    dst = out_dir / f"{tier}-mmproj-F16.gguf"
    download(src["url"], dst, src["sha256"], src["sizeBytes"])
    return {"name": dst.name, "sizeBytes": dst.stat().st_size, "sha256": src["sha256"], "source": src}


def check_mmproj_compat(first_shard: Path, mmproj: Path) -> None:
    """The projector must output vectors of the LLM's hidden size (clip.*.projection_dim == <arch>.embedding_length)."""
    import gguf
    from gguf.scripts.gguf_new_metadata import get_field_data
    llm = gguf.GGUFReader(str(first_shard), "r")
    arch = get_field_data(llm, gguf.Keys.General.ARCHITECTURE)
    emb = get_field_data(llm, f"{arch}.embedding_length")
    mm = gguf.GGUFReader(str(mmproj), "r")
    dims = {k: get_field_data(mm, k) for k in mm.fields if k.endswith("projection_dim")}
    if emb is None or not dims:
        log(f"WARNING: cannot compare mmproj and LLM dimensions (llm {arch}.embedding_length={emb}, mmproj {dims})")
        return
    bad = {k: v for k, v in dims.items() if v != emb}
    if bad:
        raise SystemExit(f"mmproj/LLM mismatch: LLM hidden size {emb} but mmproj reports {bad}")
    log(f"mmproj compatible with {arch}: projection_dim == embedding_length == {emb}")


def build_patch_json(tier: str, model: dict, described: list[dict], a: argparse.Namespace, base_model: str,
                     source: dict | None, extra: dict | None = None, mmproj: dict | None = None) -> dict:
    total = sum(d["sizeBytes"] for d in described)
    download_total = total + (mmproj["sizeBytes"] if mmproj else 0)   # what the user downloads (text + projector)
    return {
        "tier": tier,
        "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "repo": a.repo,
        "releaseTag": a.release_tag,
        "baseModel": base_model,
        "source": source,
        "totalBytes": total,
        "sizeGB": round(download_total / 1e9, 1),
        "files": described,
        "mmproj": mmproj,
        "extra": extra or {},
    }


def cmd_selftest(a: argparse.Namespace) -> None:
    """Build a tiny synthetic GGUF, run patch_gguf on it and verify metadata, tensors and template behaviour."""
    import tempfile

    import gguf
    import numpy as np
    from gguf.scripts.gguf_new_metadata import get_field_data

    tmpl = ("{%- for m in messages %}{{ '<|im_start|>' + m['role'] + '\n' + m['content'] + '<|im_end|>\n' }}"
            "{%- endfor %}{%- if add_generation_prompt %}{{ '<|im_start|>assistant\n' }}{%- endif %}")
    persona = load_persona(a.persona)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
        src, dst = Path(td) / "src.gguf", Path(td) / "dst.gguf"
        w = gguf.GGUFWriter(str(src), arch="llama")
        w.add_name("Original")
        w.add_chat_template(tmpl)
        rng = np.random.default_rng(0)
        w.add_tensor("t.f32", rng.standard_normal((8, 32)).astype(np.float32))
        w.add_tensor("t.f16", rng.standard_normal((8, 32)).astype(np.float16))
        w.write_header_to_file()
        w.write_kv_data_to_file()
        w.write_tensors_to_file()
        w.close()
        patch_gguf(src, dst, name="Rico Lite", description="selftest", persona=persona, license_id="apache-2.0",
                   base_model="x/y")
        r0, r1 = gguf.GGUFReader(str(src)), gguf.GGUFReader(str(dst))
        assert get_field_data(r1, "general.name") == "Rico Lite"
        assert get_field_data(r1, "general.author") == AUTHOR
        for t0, t1 in zip(r0.tensors, r1.tensors):
            assert t0.name == t1.name and t0.data.tobytes() == t1.data.tobytes(), t0.name
        verify_first_shard(dst, "Rico Lite", persona, 1)
    log("selftest OK")


def cmd_list(a: argparse.Namespace) -> None:
    for m in load_catalog(a.catalog)["models"]:
        src = m.get("source", {})
        print(f"{m['id']:10s} packaged={m.get('packaged')}  {src.get('repo')}/{src.get('file')}  {m['sizeGB']} GB")


def cmd_download(a: argparse.Namespace) -> None:
    m = get_model(load_catalog(a.catalog), a.tier)
    s = m["source"]
    download(s["url"], Path(a.out), s["sha256"], s["sizeBytes"])


def cmd_patch(a: argparse.Namespace) -> None:
    persona = load_persona(a.persona)
    rep = patch_gguf(Path(a.inp), Path(a.out), name=a.name, description=a.description or a.name, persona=persona)
    log(f"patched -> {a.out}: {rep}")


def cmd_split(a: argparse.Namespace) -> None:
    shards = split_gguf(Path(a.inp), Path(a.out_dir), a.prefix, Path(a.llama_bin), a.max_size)
    for s in shards:
        print(s.name, s.stat().st_size)


def cmd_describe(a: argparse.Namespace) -> None:
    shards = sorted(Path(a.out_dir).glob(f"{a.prefix}-*-of-*.gguf"))
    described = describe_shards(shards)
    cat = load_catalog(a.catalog)
    model = get_model(cat, a.tier)
    patch = build_patch_json(a.tier, model, described, a, a.base_model or model["baseModel"], model.get("source"))
    Path(a.out).write_text(json.dumps(patch, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"wrote {a.out}")


def _run_common(a: argparse.Namespace, patched: Path, tier: str, model: dict, base_model: str,
                source: dict | None, extra: dict | None) -> None:
    persona = load_persona(a.persona)
    out_dir = Path(a.out_dir)
    prefix = f"{tier}-Q4_K_M"
    shards = split_gguf(patched, out_dir, prefix, Path(a.llama_bin), a.max_size)
    if not a.keep_work:
        patched.unlink(missing_ok=True)
    verify_first_shard(shards[0], GENERAL_NAMES.get(tier, tier), persona, len(shards))
    described = describe_shards(shards)
    mm = None if getattr(a, "no_mmproj", False) else fetch_mmproj(model, out_dir, tier)
    if mm:
        check_mmproj_compat(shards[0], out_dir / mm["name"])
    patch = build_patch_json(tier, model, described, a, base_model, source, extra, mm)
    out_json = out_dir / f"catalog-patch-{tier}.json"
    out_json.write_text(json.dumps(patch, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"done: {len(shards)} shard(s), {patch['totalBytes'] / 1e9:.2f} GB, patch -> {out_json}")
    for d in described:
        log(f"  {d['name']}  {d['sizeBytes']}  {d['sha256']}")


def cmd_run(a: argparse.Namespace) -> None:
    cat = load_catalog(a.catalog)
    model = get_model(cat, a.tier)
    src = model["source"]
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    base_file = work / src["file"]
    download(src["url"], base_file, src["sha256"], src["sizeBytes"])
    persona = load_persona(a.persona)
    patched = work / f"{a.tier}-patched.gguf"
    log("patching metadata ...")
    rep = patch_gguf(base_file, patched, name=GENERAL_NAMES.get(a.tier, a.tier),
                     description=tier_description(a.tier, model["baseModel"]), persona=persona,
                     license_id=model.get("license"), base_model=model["baseModel"])
    log(f"patched: {rep}")
    base_file.unlink(missing_ok=True)  # free disk before splitting (runner has limited space)
    _run_common(a, patched, a.tier, model, model["baseModel"], src, None)


def cmd_patch_existing(a: argparse.Namespace) -> None:
    """Patch + split + describe a locally produced GGUF (e.g. the fine-tuned model)."""
    cat = load_catalog(a.catalog)
    model = get_model(cat, a.tier)
    persona = load_persona(a.persona)
    work = Path(a.work)
    work.mkdir(parents=True, exist_ok=True)
    patched = work / f"{a.tier}-patched.gguf"
    base_model = a.base_model or model["baseModel"]
    rep = patch_gguf(Path(a.inp), patched, name=GENERAL_NAMES.get(a.tier, a.tier),
                     description=tier_description(a.tier, base_model) + " Fine-tuned on the Rico SFT dataset.",
                     persona=persona, license_id=model.get("license"), base_model=base_model)
    log(f"patched: {rep}")
    _run_common(a, patched, a.tier, model, base_model, model.get("source"), {"finetuned": True})


def cmd_merge_catalog(a: argparse.Namespace) -> None:
    cat = load_catalog(a.catalog)
    patches = sorted(Path(a.patch_dir).rglob("catalog-patch-*.json"))
    if not patches:
        raise SystemExit(f"no catalog-patch-*.json under {a.patch_dir}")
    for pf in patches:
        p = json.loads(pf.read_text(encoding="utf-8"))
        model = get_model(cat, p["tier"])
        src = p.get("source") or model.get("source") or {}
        base_url = f"https://github.com/{p['repo']}/releases/download/{p['releaseTag']}/"
        files = []
        for i, f in enumerate(p["files"]):
            entry = {"url": base_url + f["name"], "fallbackUrl": None, "sha256": f["sha256"],
                     "sizeBytes": f["sizeBytes"]}
            if i == 0 and src.get("url"):
                # Convention (docs/ml.md): only the FIRST entry carries the single-file HF fallback.
                entry["fallbackUrl"] = src["url"]
                entry["fallbackSha256"] = src["sha256"]
                entry["fallbackSizeBytes"] = src["sizeBytes"]
            files.append(entry)
        model["files"] = files
        mm = p.get("mmproj")
        if mm:
            model["mmproj"] = {"url": base_url + mm["name"], "fallbackUrl": mm["source"]["url"],
                               "sha256": mm["sha256"], "sizeBytes": mm["sizeBytes"]}
            model["vision"] = True
        model["sizeGB"] = p["sizeGB"]
        model["packaged"] = True
        model["packagedAt"] = p["builtAt"]
        model["baseModel"] = p.get("baseModel", model["baseModel"])
        model.update(p.get("extra") or {})
        cat["releaseTag"] = p["releaseTag"]
        log(f"{p['tier']}: {len(files)} shard(s), {p['sizeGB']} GB")
    save_catalog(cat, a.catalog)
    log(f"updated {a.catalog}")


# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", default=str(CATALOG_PATH))
    ap.add_argument("--persona", default=None, help=f"default: {SYSTEM_PROMPT_PATH.relative_to(REPO_ROOT)}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, **kw):
        p = sub.add_parser(name, **kw)
        p.set_defaults(fn=fn)
        return p

    add("list", cmd_list)
    add("selftest", cmd_selftest, help="synthetic GGUF patch + template round-trip (no downloads)")
    p = add("download", cmd_download)
    p.add_argument("--tier", required=True)
    p.add_argument("--out", required=True)

    p = add("patch", cmd_patch)
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--description", default=None)

    p = add("split", cmd_split)
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--prefix", required=True)
    p.add_argument("--llama-bin", required=True)
    p.add_argument("--max-size", default=SPLIT_MAX)

    p = add("describe", cmd_describe)
    p.add_argument("--tier", required=True)
    p.add_argument("--out-dir", required=True)
    p.add_argument("--prefix", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--base-model", default=None)
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPO))
    p.add_argument("--release-tag", default=RELEASE_TAG)

    for name, fn, helptxt in (("run", cmd_run, "download + patch + split + verify + describe"),
                              ("patch-existing", cmd_patch_existing, "patch/split/describe a local GGUF")):
        p = add(name, fn, help=helptxt)
        p.add_argument("--tier", required=True)
        p.add_argument("--work", required=True, help="scratch dir (needs ~2x model size free)")
        p.add_argument("--out-dir", required=True, help="where shards + catalog-patch-<tier>.json go")
        p.add_argument("--llama-bin", required=True, help="dir containing llama-gguf-split")
        p.add_argument("--max-size", default=SPLIT_MAX)
        p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPO))
        p.add_argument("--release-tag", default=RELEASE_TAG)
        p.add_argument("--keep-work", action="store_true")
        p.add_argument("--no-mmproj", action="store_true", help="do not fetch the vision projector")
        if name == "patch-existing":
            p.add_argument("--in", dest="inp", required=True, help="fine-tuned Q4_K_M GGUF")
            p.add_argument("--base-model", default=None)

    p = add("merge-catalog", cmd_merge_catalog)
    p.add_argument("--patch-dir", required=True)

    p = add("check-template", cmd_check_template)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--gguf")
    g.add_argument("--template-file")
    p.add_argument("--show", action="store_true", help="print the rendered prompt")

    p = add("server-check", cmd_server_check)
    p.add_argument("--gguf", required=True, help="first shard (or single file)")
    p.add_argument("--mmproj", default=None, help="also load this projector and require the vision modality")
    p.add_argument("--llama-bin", required=True)
    p.add_argument("--port", type=int, default=8099)
    p.add_argument("--timeout", type=int, default=900)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    a.fn(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
