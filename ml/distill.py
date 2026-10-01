#!/usr/bin/env python3
"""Self-distillation for Rico.

A strong open teacher (Gemma-4-12B-it Q4_K_M, Apache-2.0) is served by `llama-server` (CPU) on a free GitHub
runner. Each matrix job answers its slice of ml/data/seed/prompts_ar.jsonl using the Rico persona
(app/resources/persona/system-prompt.md) + few-shots (app/resources/persona/fewshots.json). A merge job then
filters, de-duplicates and combines everything with the hand-written seed data into ml/data/rico_sft.jsonl.

Sub-commands
    generate   client for a running llama-server: answers one shard of the prompt file, resumable, time-boxed
    merge      filter + dedup + combine (+ gold up-sampling)  ->  ml/data/rico_sft.jsonl
    selftest   end-to-end test against a tiny in-process mock server (no model needed)

Typical (what .github/workflows/distill.yml does):
    llama-server -m teacher.gguf -c 18432 -np 6 -t 4 --host 127.0.0.1 --port 8080 --no-webui &
    python ml/distill.py generate --shard 3 --num-shards 20 --budget-minutes 100 --out work/shard-3.jsonl
    python ml/distill.py merge --shards-dir shards/ --out ml/data/rico_sft.jsonl
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rico_common import (  # noqa: E402
    SEED_DIR, SFT_PATH, NearDupIndex, Rules, check_grounded, dedup_key, is_gold, iter_jsonl, load_fewshots, load_persona,
    normalize_conversation, prompt_of, record_id, write_jsonl,
)

DEFAULT_PROMPTS = SEED_DIR / "prompts_ar.jsonl"
GOLD_FILES = ("identity.jsonl", "style_examples.jsonl")


def log(msg: str) -> None:
    print(f"[distill {time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# generate
# --------------------------------------------------------------------------- #


def build_messages(persona: str, fewshots: list[tuple[str, str]], prompt: str) -> list[dict]:
    msgs: list[dict] = [{"role": "system", "content": persona}]
    for u, a in fewshots:
        msgs.append({"role": "user", "content": u})
        msgs.append({"role": "assistant", "content": a})
    msgs.append({"role": "user", "content": prompt})
    return msgs


def http_json(url: str, body: dict | None = None, timeout: float = 1200) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_for_server(base: str, minutes: float) -> None:
    deadline = time.time() + minutes * 60
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/health", timeout=5) as r:
                if r.status == 200:
                    log("server is healthy")
                    return
        except Exception:
            pass
        time.sleep(5)
    raise SystemExit(f"server at {base} not healthy after {minutes} min")


def load_prompts(path: Path) -> list[tuple[str, str, dict]]:
    rows: list[tuple[str, str, dict]] = []
    seen: set[str] = set()
    for obj in iter_jsonl(path):
        p = prompt_of(obj)
        if not p:
            continue
        rid = record_id(obj, p)
        if rid in seen:
            continue
        seen.add(rid)
        rows.append((rid, p, obj))
    return rows


AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]
QA_SCHEMA = {"type": "object", "properties": {"pairs": {"type": "array", "minItems": 2, "maxItems": 5, "items": {
    "type": "object", "properties": {"question": {"type": "string"}, "answer": {"type": "string"}},
    "required": ["question", "answer"]}}}, "required": ["pairs"]}
QA_TASK = """مهمة خاصة: عندك مقتطف من مقال منشور على {project}، عنوان المقال «{title}»، وآخر تعديل عليه بتاريخ {date}.
اكتب {k} أسئلة وأجوبتها، كأن مستخدم ليبي عادي يسأل ريكو عن الموضوع.
الشروط:
1) الأجوبة بالليبي (أسلوبك المعتاد)، قصيرة وواضحة (من جملتين لخمس جمل).
2) كل جواب لازم يكون مدعوم بالنص فقط. ما تزيدش أي معلومة أو رقم أو اسم من عندك، ولو الفكرة ما هيش في النص ما تسألش عليها.
3) في كل جواب اذكر التاريخ كسياق، مثل «حسب ما نُشر في {month_year}» أو «لحد {date}»، لأن معلوماتك ممكن تكون قديمة والأمور تتغير.
4) الأسئلة طبيعية ومتنوعة (شن، وين، منو، وقتاش، علاش، كيفاش)، وما تذكرش «النص» ولا «المقال» ولا ويكيبيديا في السؤال، والسؤال يتفهم بروحه.
5) الأرقام والأسماء والتواريخ تنقلها زي ما هي بالضبط.{lang_note}
اطلع JSON بس بهالشكل: {{"pairs":[{{"question":"...","answer":"..."}}]}}

النص:
-----
{chunk}
-----"""


def chunk_article(text: str, max_chars: int, min_chars: int = 300, max_chunks: int = 6) -> list[str]:
    chunks, cur = [], ""
    for para in [p.strip() for p in text.split("\n") if p.strip()]:
        if len(cur) + len(para) + 1 > max_chars and cur:
            chunks.append(cur)
            cur = ""
        cur += ("\n" if cur else "") + para[:max_chars]
    if cur:
        chunks.append(cur)
    return [c for c in chunks if len(c) >= min_chars][:max_chunks]


def load_qa_items(path: Path, chunk_chars: int, max_chunks: int, samples: int = 1) -> list[tuple[str, str, dict]]:
    items: list[tuple[str, str, dict]] = []
    for sidx in range(max(1, samples)):          # sample 0 of every chunk first, then sample 1 ...
        for art in iter_jsonl(path):
            meta = {k: art.get(k) for k in ("id", "site", "project", "lang", "title", "url", "permalink",
                                             "timestamp", "license")}
            for n, ch in enumerate(chunk_article(art.get("text", ""), chunk_chars, max_chunks=max_chunks)):
                items.append((f"{art['id']}#c{n}" + (f"~{sidx}" if sidx else ""), ch, {"kind": "qa", "article": meta}))
    return items


def qa_user_message(art: dict, chunk: str, k: int) -> str:
    ts = (art.get("timestamp") or "")[:10]
    try:
        y, m, d = (int(x) for x in ts.split("-"))
        month_year, date = f"{AR_MONTHS[m - 1]} {y}", f"{d} {AR_MONTHS[m - 1]} {y}"
    except Exception:  # noqa: BLE001
        month_year = date = ts or "تاريخ النشر"
    note = "\n6) المقتطف بالإنجليزي: ترجمه بأمانة وجاوب بالليبي، وخلي الأسماء الأجنبية زي ما هي." if art.get("lang") == "en" else ""
    return QA_TASK.format(project=art.get("project", "ويكيبيديا"), title=art.get("title", ""), date=date,
                          month_year=month_year, k=k, lang_note=note, chunk=chunk)


def cmd_generate(a: argparse.Namespace) -> None:
    persona = load_persona(a.persona)
    fewshots = load_fewshots(a.fewshots)[: a.max_fewshots]
    from itertools import chain, zip_longest
    pr_items: list[tuple[str, str, dict]] = []
    if a.prompts and Path(a.prompts).exists():
        base_rows = load_prompts(Path(a.prompts))
        # flatten (prompt, sample) so that sample 0 of every prompt is produced before any sample 1
        pr_items = [(rid if s == 0 else f"{rid}#{s}", p, dict(obj, prompt_id=rid, sample=s, kind="prompt"))
                    for s in range(max(1, a.samples)) for rid, p, obj in base_rows]
    qa_items: list[tuple[str, str, dict]] = []
    if a.articles and Path(a.articles).exists():
        qa_items = load_qa_items(Path(a.articles), a.qa_chunk_chars, a.max_chunks_per_article, a.qa_samples)
    # interleave so that a time-boxed run covers both kinds
    rows = [x for x in chain.from_iterable(zip_longest(qa_items, pr_items)) if x is not None]
    mine = rows[a.shard::a.num_shards]
    log(f"items: {len(qa_items)} article chunks + {len(pr_items)} prompts")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    done: set[str] = set()
    for f in [out] + [Path(x) for x in (a.also_done or [])]:
        if f.exists():
            done.update(str(o.get("id")) for o in iter_jsonl(f))
    todo = [r for r in mine if r[0] not in done]
    log(f"prompts={len(rows)} shard {a.shard}/{a.num_shards}: mine={len(mine)} done={len(done)} todo={len(todo)} "
        f"fewshots={len(fewshots)} budget={a.budget_minutes} min")
    if not todo:
        log("nothing to do")
        return
    base = a.server.rstrip("/")
    wait_for_server(base, a.wait_minutes)

    t_start = time.time()
    deadline = t_start + a.budget_minutes * 60
    lock = threading.Lock()
    stats = Counter()
    fh = out.open("a", encoding="utf-8", newline="\n")

    def work(item: tuple[str, str, dict]) -> None:
        rid, prompt, obj = item
        is_qa = obj.get("kind") == "qa"
        seed = int(rid.encode("utf-8").hex()[:8] or "0", 16) % 2_000_000_000
        body = {
            "model": "teacher", "temperature": a.temperature, "top_p": 0.95, "top_k": 64, "stream": False,
            "cache_prompt": True, "seed": seed, "chat_template_kwargs": {"enable_thinking": False},
        }
        if is_qa:
            body["messages"] = [{"role": "system", "content": persona},
                                {"role": "user", "content": qa_user_message(obj["article"], prompt, a.qa_per_chunk)}]
            body["max_tokens"] = a.qa_max_tokens
            body["response_format"] = {"type": "json_object", "schema": QA_SCHEMA}
        else:
            body["messages"] = build_messages(persona, fewshots, prompt)
            body["max_tokens"] = a.max_tokens
        last_err = None
        for attempt in range(3):
            try:
                resp = http_json(base + "/v1/chat/completions", body, timeout=a.request_timeout)
                ch = resp["choices"][0]
                content = (ch["message"].get("content") or "").strip()
                common = {"id": rid, "finish_reason": ch.get("finish_reason"),
                          "completion_tokens": (resp.get("usage") or {}).get("completion_tokens"),
                          "teacher": a.teacher_name}
                if is_qa:
                    pairs = json.loads(content).get("pairs", []) if ch.get("finish_reason") != "length" else []
                    rec = dict(common, kind="qa", article=obj["article"], chunk=prompt, pairs=pairs)
                else:
                    rec = dict(common, prompt_id=obj.get("prompt_id", rid), prompt=prompt, answer=content)
                    for k in ("category", "topic", "tags"):
                        if k in obj:
                            rec[k] = obj[k]
                with lock:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    fh.flush()
                    stats["ok"] += 1
                    stats["tokens"] += rec["completion_tokens"] or 0
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError, KeyError, ValueError) as exc:
                last_err = exc
                time.sleep(5 * (attempt + 1))
        with lock:
            stats["failed"] += 1
        log(f"giving up on {rid}: {last_err}")

    last_report = time.time()
    pending: set = set()
    it = iter(todo)
    exhausted = False
    with ThreadPoolExecutor(max_workers=a.parallel) as ex:
        while True:
            while not exhausted and len(pending) < a.parallel and time.time() < deadline:
                try:
                    pending.add(ex.submit(work, next(it)))
                except StopIteration:
                    exhausted = True
            if not pending:
                break
            finished, pending = wait(pending, timeout=30, return_when=FIRST_COMPLETED)
            if time.time() > deadline and not exhausted:
                exhausted = True  # stop submitting; let in-flight requests finish
                log("time budget reached - draining in-flight requests")
            if time.time() - last_report > 60:
                last_report = time.time()
                el = time.time() - t_start
                log(f"ok={stats['ok']} failed={stats['failed']} tokens={stats['tokens']} "
                    f"({stats['tokens'] / max(el, 1):.1f} tok/s agg) elapsed={el / 60:.1f} min")
            if time.time() > deadline + a.grace_minutes * 60:
                log("grace period over - abandoning in-flight requests")
                break
    fh.close()
    log(f"finished chunk: ok={stats['ok']} failed={stats['failed']} remaining~={len(todo) - stats['ok']}")


# --------------------------------------------------------------------------- #
# merge
# --------------------------------------------------------------------------- #


def load_gold(seed_dir: Path) -> list[dict]:
    out = []
    for name in GOLD_FILES:
        p = seed_dir / name
        if not p.exists():
            log(f"[warn] gold seed file missing: {p}")
            continue
        src = p.stem
        n = 0
        for obj in iter_jsonl(p):
            conv = normalize_conversation(obj)
            if not conv:
                continue
            out.append({"id": record_id(obj, conv[0]["content"]), "messages": conv, "source": src, "gold": True})
            n += 1
        log(f"gold seed {name}: {n} examples")
    return out


def cmd_merge(a: argparse.Namespace) -> None:
    rules = Rules.load(a.rules)
    log(rules.summary())
    files = sorted(Path(a.shards_dir).rglob("*.jsonl"))
    log(f"reading {len(files)} shard file(s) from {a.shards_dir}")
    raw: list[dict] = []
    for f in files:
        raw.extend(iter_jsonl(f))
    reasons: Counter = Counter()
    kept: list[dict] = []
    per_prompt: Counter = Counter()
    seen_answer: set[str] = set()
    near = NearDupIndex(threshold=a.near_dup)
    qa_recs = [r for r in raw if r.get("kind") == "qa"]
    raw = [r for r in raw if r.get("kind") != "qa"]
    for rec in raw:
        prompt, answer = (rec.get("prompt") or "").strip(), (rec.get("answer") or "").strip()
        if not prompt or not answer:
            reasons["empty"] += 1
            continue
        why = rules.check(prompt, answer, rec.get("finish_reason"))
        if why:
            reasons[why] += 1
            continue
        pk, ak = dedup_key(prompt), dedup_key(answer)
        if per_prompt[pk] >= a.max_per_prompt:
            reasons["dup_prompt"] += 1
            continue
        if ak in seen_answer:
            reasons["dup_answer"] += 1
            continue
        if not near.add_if_new(answer):
            reasons["near_dup_answer"] += 1
            continue
        per_prompt[pk] += 1
        seen_answer.add(ak)
        kept.append({"id": rec.get("id"), "messages": [{"role": "user", "content": prompt},
                                                       {"role": "assistant", "content": answer}],
                     "source": "distill", "gold": False})
    log(f"distilled: {len(raw)} raw -> {len(kept)} kept; dropped: {dict(reasons)}")

    # ---- article-grounded Q&A (recent Libya knowledge) -------------------------------------------------------
    qa_reasons: Counter = Counter()
    qa_kept: list[dict] = []
    per_article: Counter = Counter()
    seen_q: set[str] = set()
    for rec in qa_recs:
        art = rec.get("article") or {}
        for pair in rec.get("pairs") or []:
            q = str((pair or {}).get("question", "")).strip()
            ans = str((pair or {}).get("answer", "")).strip()
            if not q or not ans:
                qa_reasons["empty"] += 1
                continue
            why = rules.check(q, ans, rec.get("finish_reason")) or check_grounded(
                ans, rec.get("chunk", ""), art.get("lang", "ar"), art.get("timestamp", ""))
            if why:
                qa_reasons[why] += 1
                continue
            qk, ak = dedup_key(q), dedup_key(ans)
            if qk in seen_q or ak in seen_answer or per_article[art.get("id")] >= a.max_qa_per_article:
                qa_reasons["dup_or_cap"] += 1
                continue
            if not near.add_if_new(ans):
                qa_reasons["near_dup_answer"] += 1
                continue
            seen_q.add(qk)
            seen_answer.add(ak)
            per_article[art.get("id")] += 1
            qa_kept.append({"id": art.get("id"),
                            "messages": [{"role": "user", "content": q}, {"role": "assistant", "content": ans}],
                            "source": "recent_qa", "gold": False, "url": art.get("permalink"),
                            "license": (art.get("license") or {}).get("name"),
                            "article_date": (art.get("timestamp") or "")[:10]})
    random.Random(a.seed).shuffle(qa_kept)
    if a.max_qa and len(qa_kept) > a.max_qa:
        qa_reasons["over_max_qa"] += len(qa_kept) - a.max_qa
        qa_kept = qa_kept[:a.max_qa]
    log(f"recent Q&A: {len(qa_recs)} chunks -> {len(qa_kept)} pairs kept; dropped: {dict(qa_reasons)}")
    kept.extend(qa_kept)

    gold = load_gold(Path(a.seed_dir))
    # report (do not drop) gold records that would fail the filters - helps Agent C spot mistakes
    for g in gold:
        why = rules.check(g["messages"][0]["content"], g["messages"][-1]["content"])
        if why in ("foreign_dialect", "leftover_tokens", "broken_markdown", "cjk_leak"):
            log(f"[warn] gold example {g['id']} ({g['source']}) would fail filter: {why}")
    final = list(kept)
    for g in gold:
        final.extend(dict(g) for _ in range(max(1, a.gold_repeat)))
    random.Random(a.seed).shuffle(final)
    n = write_jsonl(a.out, final)
    stats = {
        "raw_distilled": len(raw), "kept_distilled": len(kept) - len(qa_kept), "dropped": dict(reasons),
        "qa_chunks": len(qa_recs), "qa_kept": len(qa_kept), "qa_dropped": dict(qa_reasons),
        "gold_unique": len(gold), "gold_repeat": a.gold_repeat, "total_records": n,
        "sources": dict(Counter(r["source"] for r in final)),
    }
    stats_path = Path(a.stats_out) if a.stats_out else Path(a.out).with_suffix(".stats.json")
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"wrote {n} records -> {a.out}; stats -> {stats_path}")
    if not kept and not gold:
        raise SystemExit("no data produced - check shard artifacts and seed files")


# --------------------------------------------------------------------------- #
# selftest (mock llama-server)
# --------------------------------------------------------------------------- #


def cmd_selftest(a: argparse.Namespace) -> None:
    import tempfile
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    answers = {
        "good": "باهي! الحل بسيط: خلي المعجون يتحمّر شوية مع البصل، وزيد الماء وخليه يطيب على نار هادية. بالصحة!",
        "bad_dialect": "ازيك يا باشا، عايز تعمل ايه دلوقتي؟ كده احسن.",
        "bad_identity": "أنا Qwen من شركة Alibaba وأقدر نعاونك في أي شي تبيه.",
        "bad_md": "الحل هو **خلي المعجون يتحمّر شوية مع البصل وزيد الماء وخليه يطيب على نار هادية",
    }

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):  # silence
            pass

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            assert body["messages"][0]["role"] == "system" and body["messages"][-1]["role"] == "user"
            user = body["messages"][-1]["content"]
            if "response_format" in body:   # article-grounded Q&A task
                pairs = [
                    {"question": "وين تقع المدينة اللي تتكلم عليها الأخبار؟",
                     "answer": "حسب ما نُشر في أبريل 2026، المدينة تقع على الساحل وعدد سكانها حوالي 1200 نسمة."},
                    {"question": "قداش عدد المشاركين؟",
                     "answer": "حسب ما نُشر في أبريل 2026، شاركوا 777 شخص."},          # 777 is not in the chunk
                    {"question": "شن صار في المدينة؟",
                     "answer": "المدينة تقع على الساحل وعدد سكانها حوالي 1200 نسمة."},   # no date context
                ]
                resp = {"choices": [{"message": {"content": json.dumps({"pairs": pairs}, ensure_ascii=False)},
                                     "finish_reason": "stop"}], "usage": {"completion_tokens": 120}}
                raw = json.dumps(resp, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            key = next((k for k in answers if k in user), "good")
            txt = answers[key] + (" " + user[-10:] if key == "good" else "")
            resp = {"choices": [{"message": {"content": txt}, "finish_reason": "stop"}],
                    "usage": {"completion_tokens": 40}}
            raw = json.dumps(resp, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with tempfile.TemporaryDirectory() as td:
        td_p = Path(td)
        prompts = [{"id": f"p{i}", "prompt": f"سؤال رقم {i} عن الطبخ {'good' if i % 5 else ['bad_dialect', 'bad_identity', 'bad_md'][i % 3]}"}
                   for i in range(30)]
        write_jsonl(td_p / "prompts.jsonl", prompts)
        body_txt = "تقع المدينة على الساحل الليبي، ويبلغ عدد سكانها حوالي 1200 نسمة حسب آخر إحصاء. " * 8
        write_jsonl(td_p / "articles.jsonl", [
            {"id": f"arwiki:{i}", "site": "arwiki", "project": "Arabic Wikipedia", "lang": "ar", "title": f"مدينة {i}",
             "url": "https://ar.wikipedia.org/wiki/x", "permalink": "https://ar.wikipedia.org/w/index.php?oldid=1",
             "timestamp": "2026-04-15T10:00:00Z", "license": {"name": "CC BY-SA 4.0", "url": "x"},
             "text": body_txt + "\n\n" + body_txt} for i in range(3)])
        seed = td_p / "seed"
        seed.mkdir()
        write_jsonl(seed / "identity.jsonl", [{"messages": [{"role": "user", "content": "منو انت؟"},
                                                            {"role": "assistant", "content": "أنا ريكو، طوّرني جمعة أبوراس."}]}])
        write_jsonl(seed / "style_examples.jsonl", [{"prompt": "قداش الساعة؟", "response": "ما نعرفش، ما عنديش ساعة. شوفها في جهازك."}])
        for shard in range(2):
            ns = argparse.Namespace(
                prompts=str(td_p / "prompts.jsonl"), articles=str(td_p / "articles.jsonl"), qa_per_chunk=3,
                qa_chunk_chars=1400, max_chunks_per_article=2, qa_samples=1, qa_max_tokens=900, out=str(td_p / "shards" / f"s{shard}.jsonl"), shard=shard,
                num_shards=2, server=base, persona=None, fewshots=None, max_fewshots=5, budget_minutes=1,
                grace_minutes=1, wait_minutes=1, parallel=3, temperature=0.7, max_tokens=500, request_timeout=30,
                teacher_name="mock", also_done=None, samples=1)
            cmd_generate(ns)
            cmd_generate(ns)  # second call must resume and do nothing
        ns = argparse.Namespace(shards_dir=str(td_p / "shards"), out=str(td_p / "sft.jsonl"), seed_dir=str(seed),
                                rules=None, gold_repeat=3, near_dup=0.8, seed=1, stats_out=None, max_per_prompt=2, max_qa=100, max_qa_per_article=12)
        cmd_merge(ns)
        recs = list(iter_jsonl(td_p / "sft.jsonl"))
        stats = json.loads((td_p / "sft.stats.json").read_text(encoding="utf-8"))
        assert stats["sources"].get("identity") == 3 and stats["sources"].get("style_examples") == 3, stats
        assert stats["dropped"].get("foreign_dialect") and stats["dropped"].get("forbidden_identity") \
            and stats["dropped"].get("broken_markdown"), stats
        assert all(r["messages"][-1]["role"] == "assistant" for r in recs)
        assert stats["qa_kept"] >= 1 and stats["qa_dropped"].get("ungrounded_number") \
            and stats["qa_dropped"].get("no_date_context"), stats
        assert any(r["source"] == "recent_qa" for r in recs)
    srv.shutdown()
    log("selftest OK")


# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("generate", help="answer one shard of the prompt file via a running llama-server")
    g.set_defaults(fn=cmd_generate)
    g.add_argument("--prompts", default=str(DEFAULT_PROMPTS), help="prompts_ar.jsonl ('' to skip)")
    g.add_argument("--articles", default="", help="ml/data/recent/articles.jsonl -> grounded Q&A task ('' to skip)")
    g.add_argument("--qa-per-chunk", type=int, default=4)
    g.add_argument("--qa-chunk-chars", type=int, default=1100)
    g.add_argument("--max-chunks-per-article", type=int, default=10)
    g.add_argument("--qa-samples", type=int, default=2, help="Q&A generations per article chunk (different seeds)")
    g.add_argument("--qa-max-tokens", type=int, default=1100)
    g.add_argument("--out", required=True)
    g.add_argument("--shard", type=int, default=0)
    g.add_argument("--num-shards", type=int, default=1)
    g.add_argument("--server", default="http://127.0.0.1:8080")
    g.add_argument("--persona", default=None)
    g.add_argument("--fewshots", default=None)
    g.add_argument("--max-fewshots", type=int, default=6)
    g.add_argument("--samples", type=int, default=1, help="answers per prompt (different seeds)")
    g.add_argument("--temperature", type=float, default=0.7)
    g.add_argument("--max-tokens", type=int, default=500)
    g.add_argument("--parallel", type=int, default=6, help="should equal llama-server -np")
    g.add_argument("--budget-minutes", type=float, default=100, help="stop submitting new prompts after this")
    g.add_argument("--grace-minutes", type=float, default=12, help="how long to wait for in-flight requests")
    g.add_argument("--wait-minutes", type=float, default=20, help="how long to wait for /health")
    g.add_argument("--request-timeout", type=float, default=900)
    g.add_argument("--teacher-name", default="gemma-4-12B-it-Q4_K_M")
    g.add_argument("--also-done", nargs="*", help="extra jsonl files whose ids must be skipped")

    m = sub.add_parser("merge", help="filter + dedup + combine into the final SFT file")
    m.set_defaults(fn=cmd_merge)
    m.add_argument("--shards-dir", required=True)
    m.add_argument("--out", default=str(SFT_PATH))
    m.add_argument("--seed-dir", default=str(SEED_DIR))
    m.add_argument("--rules", default=None, help="default: eval/score_rules.json (+ built-in rules)")
    m.add_argument("--gold-repeat", type=int, default=3)
    m.add_argument("--max-qa", type=int, default=1800, help="cap on recent_qa pairs (0 = no cap)")
    m.add_argument("--max-qa-per-article", type=int, default=12)
    m.add_argument("--max-per-prompt", type=int, default=2, help="keep at most this many answers per prompt")
    m.add_argument("--near-dup", type=float, default=0.8, help="Jaccard threshold on word 3-grams")
    m.add_argument("--seed", type=int, default=1337)
    m.add_argument("--stats-out", default=None)

    s = sub.add_parser("selftest", help="run generate+merge against a mock server")
    s.set_defaults(fn=cmd_selftest)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    a.fn(a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
