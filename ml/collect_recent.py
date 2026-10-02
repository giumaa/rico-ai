#!/usr/bin/env python3
"""Collect RECENT, openly licensed text about Libya via the public MediaWiki APIs.

Sources (current text of pages whose latest revision is >= --since, default 2026-04-01):
  * Arabic Wikipedia  (ar.wikipedia.org)   - CC BY-SA 4.0
  * Arabic Wikinews   (ar.wikinews.org)    - CC BY-SA 4.0 (the license each site reports is what counts)
  * English Wikipedia (en.wikipedia.org)   - CC BY-SA 4.0
The license of every site is read from the API (meta=siteinfo&siprop=rightsinfo) and anything that is not
"Attribution" / "Attribution-ShareAlike" (or that is NonCommercial / NoDerivatives) is refused.

Discovery: (1) full-text search per Libya-related term sorted by last edit (stops paging once older than --since),
           (2) members of Libya categories (depth 2), then (3) revision timestamps filter + relevance filter.

Output (ml/data/recent/):
  articles.jsonl   one article per line: id, site, lang, title, url, permalink, revid, timestamp, license, text
  ATTRIBUTION.md   sources, licenses, per-page permalinks + history links (CC BY-SA attribution)

Only the standard library is used. Be polite: descriptive User-Agent, maxlag, small delay between requests.
Usage:  python ml/collect_recent.py [--since 2026-04-01] [--max-pages-per-site 400]
"""
from __future__ import annotations

import argparse
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "ml" / "data" / "recent"
UA = "RicoAI-DataCollector/1.0 (https://github.com/giumaa/rico-ai; offline-assistant research; polite, maxlag=5)"

SITES = {
    "arwiki": dict(
        api="https://ar.wikipedia.org/w/api.php", base="https://ar.wikipedia.org", lang="ar",
        project="Arabic Wikipedia",
        terms=["ليبيا", "طرابلس", "بنغازي", "مصراتة", "سبها", "الزاوية", "سرت", "طبرق", "درنة", "الاقتصاد الليبي",
               "الرياضة الليبية", "المصرف المركزي الليبي", "النفط في ليبيا", "حكومة الوحدة الوطنية الليبية",
               "مجلس النواب الليبي", "الدوري الليبي", "المنتخب الليبي", "الثقافة الليبية", "المطبخ الليبي"],
        categories=["تصنيف:ليبيا", "تصنيف:اقتصاد ليبيا", "تصنيف:رياضة في ليبيا", "تصنيف:مدن ليبيا",
                    "تصنيف:سياسة ليبيا", "تصنيف:ثقافة ليبيا", "تصنيف:تاريخ ليبيا"]),
    "arwikinews": dict(
        api="https://ar.wikinews.org/w/api.php", base="https://ar.wikinews.org", lang="ar",
        project="Arabic Wikinews",
        terms=["ليبيا", "طرابلس", "بنغازي", "مصراتة", "سبها", "ليبي", "الاقتصاد الليبي", "الرياضة الليبية"],
        categories=["تصنيف:ليبيا"]),
    "enwiki": dict(
        api="https://en.wikipedia.org/w/api.php", base="https://en.wikipedia.org", lang="en",
        project="English Wikipedia",
        terms=["Libya", "Tripoli Libya", "Benghazi", "Misrata", "Sabha Libya", "Economy of Libya", "Libyan",
               "Sport in Libya", "Libyan Premier League", "Government of National Unity Libya",
               "House of Representatives Libya", "Central Bank of Libya", "Libyan oil"],
        categories=["Category:Libya", "Category:Economy of Libya", "Category:Sport in Libya",
                    "Category:Politics of Libya", "Category:Libyan culture", "Category:History of Libya"]),
}
LIBYA_RE = re.compile(r"(ليبيا|ليبي|ليبية|طرابلس|بنغازي|مصراتة|Libya|Libyan|Tripoli|Benghazi|Misrata)", re.IGNORECASE)
ALLOWED_LICENSE = re.compile(r"attribution", re.IGNORECASE)
REFUSED_LICENSE = re.compile(r"non-?commercial|no-?deriv", re.IGNORECASE)


def log(msg: str) -> None:
    print(f"[collect {time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Api:
    def __init__(self, url: str, delay: float):
        self.url, self.delay = url, delay

    def get(self, **params) -> dict:
        params.update({"format": "json", "formatversion": "2", "maxlag": "5"})
        form = urllib.parse.urlencode(params).encode("utf-8")   # POST: long Arabic title lists overflow GET URLs
        for attempt in range(6):
            try:
                req = urllib.request.Request(self.url, data=form, method="POST",
                                             headers={"User-Agent": UA, "Accept-Encoding": "identity"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = json.loads(r.read().decode("utf-8"))
                time.sleep(self.delay)
                if "error" in data and data["error"].get("code") == "maxlag":
                    time.sleep(5)
                    continue
                return data
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as exc:
                wait = 3 * (attempt + 1)
                log(f"  request failed ({exc}); retry in {wait}s")
                time.sleep(wait)
        return {}


def check_license(api: Api) -> dict:
    d = api.get(action="query", meta="siteinfo", siprop="rightsinfo")
    ri = (d.get("query") or {}).get("rightsinfo") or {}
    name, url = ri.get("text", ""), ri.get("url", "")
    if not ALLOWED_LICENSE.search(name) or REFUSED_LICENSE.search(name):
        raise SystemExit(f"refusing site with license {name!r} ({url}) - only CC BY / CC BY-SA are accepted")
    return {"name": name, "url": url}


def search_titles(api: Api, term: str, since: str, max_titles: int) -> dict[str, str]:
    """title -> last edit timestamp, newest edits first, stops when older than `since`."""
    found: dict[str, str] = {}
    offset = 0
    while len(found) < max_titles and offset < 2000:
        d = api.get(action="query", list="search", srsearch=term, srnamespace=0, srlimit=50, sroffset=offset,
                    srsort="last_edit_desc", srprop="timestamp")
        res = (d.get("query") or {}).get("search") or []
        if not res:
            break
        stop = False
        for r in res:
            ts = r.get("timestamp", "")
            if ts and ts < since:
                stop = True
                break
            found[r["title"]] = ts
        if stop or "continue" not in d:
            break
        offset = d["continue"].get("sroffset", offset + 50)
    return found


def category_titles(api: Api, cat: str, depth: int, budget: int = 60, page_cap: int = 1500) -> set[str]:
    titles: set[str] = set()
    queue, seen = [(cat, 0)], set()
    while queue and len(seen) < budget and len(titles) < page_cap:
        c, dpt = queue.pop(0)
        if c in seen:
            continue
        seen.add(c)
        cont = {}
        while True:
            d = api.get(action="query", list="categorymembers", cmtitle=c, cmlimit=500, cmtype="page|subcat", **cont)
            for m in (d.get("query") or {}).get("categorymembers") or []:
                if m.get("ns") == 14 and dpt < depth:
                    queue.append((m["title"], dpt + 1))
                elif m.get("ns") == 0:
                    titles.add(m["title"])
            if "continue" in d:
                cont = {"cmcontinue": d["continue"]["cmcontinue"]}
            else:
                break
    return titles


def page_info(api: Api, titles: list[str], since: str, min_bytes: int) -> list[dict]:
    """Cheap metadata pass, 50 titles per call: latest revision (id + timestamp), size, canonical URL,
    disambiguation flag. Keeps pages revised on/after `since`, not disambiguation pages, not tiny stubs."""
    keep: list[dict] = []
    seen: set[int] = set()
    for i in range(0, len(titles), 50):
        d = api.get(action="query", titles="|".join(titles[i:i + 50]), prop="info|revisions|pageprops",
                    rvprop="ids|timestamp", rvslots="main", inprop="url", ppprop="disambiguation", redirects=1)
        for p in (d.get("query") or {}).get("pages") or []:
            revs = p.get("revisions") or []
            if (p.get("missing") or not revs or p.get("pageprops", {}).get("disambiguation") is not None
                    or revs[0]["timestamp"] < since or p.get("length", 0) < min_bytes or p["pageid"] in seen):
                continue
            seen.add(p["pageid"])
            keep.append({"pageid": p["pageid"], "title": p["title"], "url": p.get("fullurl"),
                         "revid": revs[0]["revid"], "timestamp": revs[0]["timestamp"]})
    return keep


def fetch_extract(api: Api, title: str) -> str:
    """Plain-text extract of ONE page. (TextExtracts returns the *full* extract for only one page per request
    when exintro is not set, so batching titles silently drops the rest - hence one request per page.)"""
    d = api.get(action="query", titles=title, prop="extracts", explaintext=1, exsectionformat="wiki", exlimit=1,
                redirects=1)
    for p in (d.get("query") or {}).get("pages") or []:
        if p.get("extract"):
            return p["extract"]
    return ""


def clean_text(t: str) -> str:
    t = re.sub(r"^=+\s*(.*?)\s*=+\s*$", r"\1:", t, flags=re.MULTILINE)   # "== Heading ==" -> "Heading:"
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def write_attribution(path: Path, since: str, sites_info: dict, articles: list[dict]) -> None:
    today = dt.date.today().isoformat()
    lines = [
        "# Attribution - recent Libya texts used for Rico's training data",
        "",
        f"Collected on **{today}** via the public MediaWiki APIs by `ml/collect_recent.py`; only pages whose latest "
        f"revision is dated **{since}** or later were kept (the *current* text of each page, plain-text extract).",
        "",
        "## Licenses",
        "",
    ]
    for key, info in sites_info.items():
        lines.append(f"* **{SITES[key]['project']}** ({SITES[key]['base']}): {info['license']['name']} - {info['license']['url']}")
    lines += [
        "",
        "Text is available under the licenses above (see each site's *Terms of Use*). Authors are credited through the "
        "page-history links below. Question/answer pairs derived from these pages (records with `\"source\": \"recent_qa\"` "
        "in `ml/data/rico_sft.jsonl`) are adaptations: keep this attribution file with the data and, for CC BY-SA "
        "sources, share the data under the same license. These are summaries of third-party community text; they can "
        "be wrong or outdated - Rico must never present them as verified news.",
        "",
        "## Pages",
        "",
        "| Site | Page (permalink) | Last revision (UTC) | License | History (authors) |",
        "|---|---|---|---|---|",
    ]
    for a in sorted(articles, key=lambda x: (x["site"], x["title"])):
        title = a["title"].replace("|", "\\|")
        hist = f"{SITES[a['site']]['base']}/w/index.php?title={urllib.parse.quote(a['title'].replace(' ', '_'))}&action=history"
        lines.append(f"| {SITES[a['site']]['project']} | [{title}]({a['permalink']}) | {a['timestamp']} | "
                     f"{sites_info[a['site']]['license']['name']} | [history]({hist}) |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", default="2026-04-01", help="keep pages whose latest revision is on/after this date")
    ap.add_argument("--out-dir", default=str(OUT_DIR))
    ap.add_argument("--sites", default=",".join(SITES))
    ap.add_argument("--max-pages-per-site", type=int, default=600)
    ap.add_argument("--max-titles-per-term", type=int, default=250)
    ap.add_argument("--min-chars", type=int, default=450)
    ap.add_argument("--max-chars", type=int, default=40000, help="truncate very long articles")
    ap.add_argument("--min-libya-mentions", type=int, default=2)
    ap.add_argument("--min-libya-density", type=float, default=1.0,
                    help="Libya terms per 1000 chars required for pages that are not in a Libya category / titled with Libya")
    ap.add_argument("--category-depth", type=int, default=1, help="sub-category levels to follow")
    ap.add_argument("--delay", type=float, default=0.3)
    ap.add_argument("--workers", type=int, default=3, help="parallel page fetches (be polite)")
    a = ap.parse_args(argv)

    since_iso = a.since + "T00:00:00Z"
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    articles: list[dict] = []
    sites_info: dict = {}
    for key in [s.strip() for s in a.sites.split(",") if s.strip()]:
        cfg = SITES[key]
        api = Api(cfg["api"], a.delay)
        lic = check_license(api)
        sites_info[key] = {"license": lic}
        log(f"{cfg['project']}: license {lic['name']}")
        cand: dict[str, str] = {}
        for term in cfg["terms"]:
            got = search_titles(api, term, since_iso, a.max_titles_per_term)
            log(f"  search {term!r}: {len(got)} recently edited")
            cand.update(got)
        cat_titles: set[str] = set()
        for cat in cfg["categories"]:
            t = category_titles(api, cat, depth=a.category_depth)
            log(f"  category {cat}: {len(t)} pages")
            cat_titles |= t
        # search hits first (most relevant + newest edits), then category pages
        by_time = sorted(cand, key=cand.get, reverse=True)
        titled = [t for t in by_time if LIBYA_RE.search(t)]                      # Libya in the title
        cats = sorted(t for t in cat_titles if t not in cand or not LIBYA_RE.search(t))  # members of Libya categories
        rest = [t for t in by_time if t not in set(titled)]                      # other search hits (need density check)
        titles = list(dict.fromkeys(titled + cats + rest))
        infos = page_info(api, titles, since_iso, a.min_chars)
        by_title = {i["title"]: i for i in infos}
        order = {t: n for n, t in enumerate(titles)}
        infos.sort(key=lambda i: order.get(i["title"], 10 ** 9))
        log(f"  {len(titles)} candidates -> {len(infos)} revised since {a.since} (non-stub, non-disambiguation); "
            f"fetching text one page per request ...")
        kept = 0
        base = cfg["base"]
        pool = ThreadPoolExecutor(max_workers=a.workers)
        for start in range(0, len(infos), 3 * a.workers):
            batch = infos[start:start + 3 * a.workers]
            for info, raw in zip(batch, pool.map(lambda i: fetch_extract(api, i["title"]), batch)):
                text = clean_text(raw)
                if len(text) < a.min_chars:
                    continue
                mentions = len(LIBYA_RE.findall(text))
                focused = bool(LIBYA_RE.search(info["title"])) or info["title"] in cat_titles
                density = mentions / max(len(text), 1) * 1000
                if mentions < a.min_libya_mentions or (not focused and density < a.min_libya_density):
                    continue   # off-topic page that merely mentions Libya
                q = urllib.parse.quote(info["title"].replace(" ", "_"))
                articles.append({
                    "id": f"{key}:{info['pageid']}", "site": key, "project": cfg["project"], "lang": cfg["lang"],
                    "title": info["title"], "url": info["url"] or f"{base}/wiki/{q}",
                    "permalink": f"{base}/w/index.php?title={q}&oldid={info['revid']}",
                    "revid": info["revid"], "timestamp": info["timestamp"], "license": lic,
                    "text": text[:a.max_chars],
                })
                kept += 1
                if kept >= a.max_pages_per_site:
                    break
            if kept >= a.max_pages_per_site:
                break
            if (start // (3 * a.workers)) % 10 == 0:
                log(f"    ... {start + len(batch)}/{len(infos)} fetched, {kept} kept")
        pool.shutdown(wait=False)
        log(f"  kept {kept} pages for {cfg['project']}")

    if not articles:
        log("no recent articles found (is the date range / network OK?)")
    with (out_dir / "articles.jsonl").open("w", encoding="utf-8", newline="\n") as fh:
        for art in articles:
            fh.write(json.dumps(art, ensure_ascii=False) + "\n")
    write_attribution(out_dir / "ATTRIBUTION.md", a.since, sites_info, articles)
    log(f"wrote {len(articles)} articles -> {out_dir / 'articles.jsonl'} (+ ATTRIBUTION.md)")
    return 0 if articles else 1


if __name__ == "__main__":
    sys.exit(main())
