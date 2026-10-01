"""Shared helpers for the Rico ML pipeline (stdlib only, no heavy dependencies).

Used by:
  * ml/distill.py       - teacher generation + filtering/merging into ml/data/rico_sft.jsonl
  * ml/train_lora.py    - fine-tuning
  * ml/package_model.py - embedding the persona into the GGUF chat template

Everything here is deliberately tolerant about input shapes because the seed data
(ml/data/seed/**) and the eval rules (eval/score_rules.json) are written by other agents.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator

REPO_ROOT = Path(__file__).resolve().parents[1]
PERSONA_DIR = REPO_ROOT / "app" / "resources" / "persona"
SYSTEM_PROMPT_PATH = PERSONA_DIR / "system-prompt.md"
FEWSHOTS_PATH = PERSONA_DIR / "fewshots.json"
SEED_DIR = REPO_ROOT / "ml" / "data" / "seed"
SFT_PATH = REPO_ROOT / "ml" / "data" / "rico_sft.jsonl"
EVAL_RULES_PATH = REPO_ROOT / "eval" / "score_rules.json"
CATALOG_PATH = REPO_ROOT / "models" / "catalog.json"

AUTHOR = "Juma Abouras"

# --------------------------------------------------------------------------- #
# IO helpers
# --------------------------------------------------------------------------- #


def read_text(path: Path | str) -> str:
    return Path(path).read_text(encoding="utf-8-sig")


def iter_jsonl(path: Path | str) -> Iterator[dict]:
    """Yield JSON objects from a .jsonl file; malformed lines are skipped (with a warning)."""
    p = Path(path)
    with p.open("r", encoding="utf-8-sig") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as exc:
                print(f"[warn] {p.name}:{n}: bad JSON ({exc}); skipped")
                continue
            if isinstance(obj, dict):
                yield obj


def write_jsonl(path: Path | str, records: Iterable[dict]) -> int:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with p.open("w", encoding="utf-8", newline="\n") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    return n


def sha256_file(path: Path | str, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


# --------------------------------------------------------------------------- #
# Persona
# --------------------------------------------------------------------------- #


def load_persona(path: Path | str | None = None) -> str:
    """Rico system prompt (app/resources/persona/system-prompt.md), read at run time."""
    p = Path(path) if path else SYSTEM_PROMPT_PATH
    if not p.exists():
        raise FileNotFoundError(f"persona system prompt not found: {p}")
    text = read_text(p).strip()
    if not text:
        raise ValueError(f"persona system prompt is empty: {p}")
    return text


def load_fewshots(path: Path | str | None = None) -> list[tuple[str, str]]:
    """Few-shot (user, assistant) pairs from app/resources/persona/fewshots.json."""
    p = Path(path) if path else FEWSHOTS_PATH
    if not p.exists():
        return []
    data = json.loads(read_text(p))
    if isinstance(data, dict):
        for key in ("fewshots", "examples", "shots", "items", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
    pairs: list[tuple[str, str]] = []
    if not isinstance(data, list):
        return pairs
    for item in data:
        conv = normalize_conversation(item) if isinstance(item, dict) else None
        if conv and len(conv) >= 2:
            # few-shots are used single-turn: first user -> first assistant
            pairs.append((conv[0]["content"], conv[1]["content"]))
    return pairs


# --------------------------------------------------------------------------- #
# Record normalisation
# --------------------------------------------------------------------------- #

_ROLE_MAP = {
    "user": "user", "human": "user", "prompt": "user", "question": "user",
    "assistant": "assistant", "gpt": "assistant", "model": "assistant", "bot": "assistant",
    "ai": "assistant", "answer": "assistant", "response": "assistant",
    "system": "system",
}
_USER_KEYS = ("user", "prompt", "question", "instruction", "query", "input", "text", "q")
_ASSISTANT_KEYS = ("assistant", "response", "answer", "output", "completion", "reply", "a", "target")


def _as_text(v: Any) -> str:
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, list):  # OpenAI style content parts
        parts = []
        for part in v:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts).strip()
    return ""


def normalize_conversation(obj: dict) -> list[dict] | None:
    """Return [{'role','content'}, ...] (system messages dropped) or None if unusable.

    Accepted shapes: {"messages":[...]}, {"conversations":[{"from","value"}...]},
    {"prompt":..,"response":..} and the usual synonyms (user/assistant, question/answer, ...).
    """
    msgs: list[dict] = []
    raw = obj.get("messages") if isinstance(obj.get("messages"), list) else obj.get("conversations")
    if isinstance(raw, list):
        for m in raw:
            if not isinstance(m, dict):
                continue
            role = _ROLE_MAP.get(str(m.get("role", m.get("from", ""))).lower())
            content = _as_text(m.get("content", m.get("value", "")))
            if role and content:
                msgs.append({"role": role, "content": content})
    else:
        u = next((_as_text(obj[k]) for k in _USER_KEYS if k in obj and _as_text(obj[k])), "")
        a = next((_as_text(obj[k]) for k in _ASSISTANT_KEYS if k in obj and _as_text(obj[k])), "")
        if u and a:
            msgs = [{"role": "user", "content": u}, {"role": "assistant", "content": a}]
    msgs = [m for m in msgs if m["role"] != "system"]
    if len(msgs) < 2:
        return None
    # Must alternate user/assistant, start with user, end with assistant.
    for i, m in enumerate(msgs):
        if m["role"] != ("user" if i % 2 == 0 else "assistant"):
            return None
    if msgs[-1]["role"] != "assistant":
        return None
    return msgs


def prompt_of(obj: dict) -> str | None:
    """User prompt of a prompts_ar.jsonl row."""
    for k in ("prompt", "question", "instruction", "query", "input", "text", "user", "q"):
        v = obj.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    msgs = obj.get("messages")
    if isinstance(msgs, list):
        for m in reversed(msgs):
            if isinstance(m, dict) and str(m.get("role", "")).lower() == "user":
                t = _as_text(m.get("content"))
                if t:
                    return t
    return None


def record_id(obj: dict, prompt: str) -> str:
    rid = obj.get("id")
    if rid is not None and str(rid).strip():
        return str(rid)
    return hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:12]


def is_gold(obj: dict) -> bool:
    for k in ("gold", "is_gold"):
        if obj.get(k) in (True, 1, "true", "True", "yes"):
            return True
    for k in ("quality", "tier", "label", "source", "tag"):
        if str(obj.get(k, "")).lower() == "gold":
            return True
    tags = obj.get("tags")
    return isinstance(tags, list) and any(str(t).lower() == "gold" for t in tags)


# --------------------------------------------------------------------------- #
# Arabic text normalisation / detection
# --------------------------------------------------------------------------- #

_AR_RE = re.compile(r"[؀-ۿݐ-ݿࢠ-ࣿ]")
_LATIN_RE = re.compile(r"[A-Za-z]")
_CJK_RE = re.compile(r"[぀-ヿ㐀-䶿一-鿿가-힯]")
_DIACRITICS_RE = re.compile(r"[ً-ٰٟۖ-ۭ]")
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize_ar(text: str) -> str:
    """Aggressive normalisation for matching / dedup (NOT for training text)."""
    t = unicodedata.normalize("NFKC", text)
    t = _DIACRITICS_RE.sub("", t).replace("ـ", "")
    t = re.sub("[أإآٱ]", "ا", t)  # alef variants -> ا
    t = t.replace("ى", "ي").replace("ة", "ه")  # ى->ي ة->ه
    t = t.replace("ک", "ك").replace("ی", "ي")  # Persian kaf/yeh
    return re.sub(r"\s+", " ", t.lower()).strip()


def arabic_ratio(text: str) -> float:
    ar = len(_AR_RE.findall(text))
    lat = len(_LATIN_RE.findall(text))
    tot = ar + lat
    return ar / tot if tot else 0.0


def dedup_key(text: str) -> str:
    t = _PUNCT_RE.sub(" ", normalize_ar(text))
    return re.sub(r"\s+", " ", t).strip()


# --------------------------------------------------------------------------- #
# Quality rules (defaults + eval/score_rules.json)
# --------------------------------------------------------------------------- #

# Colloquial markers that are NOT Libyan (persona forbids several of them explicitly).
DEFAULT_FOREIGN_DIALECT = [
    # persona's explicit "forbidden" list (app/resources/persona/system-prompt.md)
    "ازيك", "عايز", "دلوقتي", "كده", "شو", "ليش", "هيك", "كتير", "بدي", "وايد", "ابغى", "عشان", "برشا",
    # a few unambiguous extras (eval/score_rules.json -> foreign_dialect_markers adds the full lists)
    "ازاي", "عايزه", "عاوز", "دلوقت", "كدا", "كدة", "علشان", "بدك", "بدنا", "هلق", "منيح", "شلونك", "بزاف", "ديال",
]
DEFAULT_FORBIDDEN_IDENTITY = [
    # Latin (case-insensitive, word-ish match)
    "Qwen", "Alibaba", "Tongyi", "ChatGPT", "OpenAI", "GPT-4", "GPT-3", "Gemma", "Gemini", "DeepMind",
    "Google", "Anthropic", "Claude", "Llama", "Meta AI", "Mistral", "DeepSeek", "Copilot", "Falcon", "Jais",
    "Microsoft", "Bard",
    # Arabic transliterations
    "علي بابا", "على بابا", "اوبن اي اي", "جوجل", "قوقل", "غوغل", "ديب مايند", "انثروبيك", "كلود",
    "جيما", "جيمّا", "جيميني", "شات جي بي تي", "تشات جي بي تي", "كوين",
]
LEFTOVER_PATTERNS = [
    r"</?think>", r"<\|channel>", r"<channel\|>", r"<\|think\|>", r"<\|turn>", r"<turn\|>", r"<\|im_start\|>",
    r"<\|im_end\|>", r"<start_of_turn>", r"<end_of_turn>", r"<bos>", r"<eos>", r"\[INST\]", r"<\|assistant\|>",
    r"<\|endoftext\|>", r"<unused\d+>",
]
# When the user's prompt itself asks for another dialect / language we do not apply the dialect filter.
_OTHER_DIALECT_REQUEST = re.compile(
    r"(مصري|مصرية|شامي|شامية|سوري|لبناني|خليجي|خليجية|سعودي|عراقي|مغربي|تونسي|جزائري|"
    r"egypt|levant|gulf|moroccan|tunisian|algerian|iraqi|saudi)", re.IGNORECASE)
_WANTS_ENGLISH = re.compile(r"(english|انجليزي|إنجليزي|بالانجليزي|بالإنجليزي|translate|ترجم)", re.IGNORECASE)
_WANTS_ARABIC = re.compile(r"(arabic|بالعربي|عربي|بالعربية|بالفصحى|فصحى|translate|ترجم)", re.IGNORECASE)

_EN_STOP = {"the", "is", "are", "what", "how", "can", "you", "please", "explain", "why", "write", "does", "do",
            "a", "an", "of", "to", "and", "in", "for", "with", "my", "me", "i", "it", "this", "that", "give", "tell"}


def _looks_english(text: str) -> bool:
    words = re.findall(r"[a-z']+", text.lower())
    return sum(1 for w in words if w in _EN_STOP) >= 2


_NUMERIC_KEYS = {
    "min_chars": ("min_chars", "min_length", "minchars", "min_len"),
    "max_chars": ("max_chars", "max_length", "maxchars", "max_len"),
}


@dataclass
class Rules:
    foreign_dialect: list[str] = field(default_factory=lambda: list(DEFAULT_FOREIGN_DIALECT))
    forbidden_identity: list[str] = field(default_factory=lambda: list(DEFAULT_FORBIDDEN_IDENTITY))
    min_chars: int = 12
    max_chars: int = 3800
    claim_regexes: list[str] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
    _dialect_re: re.Pattern | None = None
    _ident_re: re.Pattern | None = None
    _ident_ar_re: re.Pattern | None = None

    # -- loading ------------------------------------------------------------ #
    @classmethod
    def load(cls, path: Path | str | None = None) -> "Rules":
        rules = cls()
        p = Path(path) if path else EVAL_RULES_PATH
        if p.exists():
            try:
                rules._merge(json.loads(read_text(p)))
                rules.sources.append(str(p))
            except Exception as exc:  # pragma: no cover - defensive
                print(f"[warn] could not parse {p}: {exc}; using built-in rules only")
        rules._compile()
        return rules

    def _merge(self, node: Any, path: str = "") -> None:
        """Harvest string lists / numbers from eval/score_rules.json (schema owned by Agent C) by key path."""
        p = path.lower()
        leaf = p.rsplit("/", 1)[-1]
        if isinstance(node, dict):
            for ck, cv in node.items():
                self._merge(cv, f"{path}/{ck}")
        elif isinstance(node, list) and node and all(isinstance(x, str) for x in node):
            if leaf in ("weak", "applies_to_categories", "chars"):
                return
            if "claims" in p and leaf == "regex":
                self.claim_regexes += [x for x in node if x not in self.claim_regexes]
            elif any(s in p for s in ("foreign", "dialect", "egypt", "levant", "gulf", "maghreb", "non_libyan",
                                      "banned_word", "forbidden_word", "bad_word")):
                self.foreign_dialect += [x for x in node if x not in self.foreign_dialect]
            elif any(s in p for s in ("identity", "brand", "model_name", "creator", "forbidden", "banned")):
                self.forbidden_identity += [x for x in node if x not in self.forbidden_identity]
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            for attr, names in _NUMERIC_KEYS.items():
                if leaf in names:
                    setattr(self, attr, int(node))

    def _compile(self) -> None:
        def mk(words: list[str], arabic: bool) -> re.Pattern | None:
            alts = []
            for w in words:
                if w.startswith("re:"):
                    alts.append(w[3:])
                else:
                    alts.append(re.escape(normalize_ar(w) if arabic else w))
            if not alts:
                return None
            if arabic:
                return re.compile(r"(?<![؀-ۿ\w])(?:" + "|".join(alts) + r")(?![؀-ۿ\w])")
            return re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(alts) + r")(?![A-Za-z0-9])", re.IGNORECASE)

        self._dialect_re = mk(self.foreign_dialect, arabic=True)
        latin = [w for w in self.forbidden_identity if not _AR_RE.search(w)]
        self._ident_re = mk(latin, arabic=False)
        ar = [re.escape(normalize_ar(w)) for w in self.forbidden_identity if _AR_RE.search(w)]
        self._ident_ar_re = re.compile(r"(?<![؀-ۿ])(?:[وفبلك])?(?:" + "|".join(ar) + r")(?![؀-ۿ])") if ar else None

    # -- checking ----------------------------------------------------------- #
    def check(self, prompt: str, answer: str, finish_reason: str | None = None) -> str | None:
        """Return a drop-reason string, or None when the answer is acceptable."""
        text = answer.strip()
        if finish_reason == "length":
            return "truncated"
        if len(text) < self.min_chars:
            return "too_short"
        if len(text) > self.max_chars:
            return "too_long"
        for pat in LEFTOVER_PATTERNS:
            if re.search(pat, text):
                return "leftover_tokens"
        if re.search(r"(?im)^\s*(thinking process|thought process|reasoning)\s*:", text):
            return "leftover_thinking"
        if _CJK_RE.search(text) and not _CJK_RE.search(prompt):
            return "cjk_leak"

        pn, an = normalize_ar(prompt), normalize_ar(text)
        # identity strings: allowed only if the user's prompt already mentioned them
        if self._ident_re:
            for m in self._ident_re.finditer(text):
                if m.group(0).lower() not in prompt.lower():
                    return "forbidden_identity"
        if self._ident_ar_re:
            for m in self._ident_ar_re.finditer(an):
                if m.group(0).lstrip("وفبلك") not in pn and m.group(0) not in pn:
                    return "forbidden_identity"
        for rx in self.claim_regexes:
            try:
                if re.search(rx, text, re.IGNORECASE) or re.search(rx, an, re.IGNORECASE):
                    return "identity_claim"
            except re.error:
                continue
        # foreign dialect markers
        if self._dialect_re and _AR_RE.search(text) and not _OTHER_DIALECT_REQUEST.search(prompt):
            if self._dialect_re.search(an):
                return "foreign_dialect"
        # language consistency
        p_ar, a_ar = arabic_ratio(prompt), arabic_ratio(text)
        if p_ar >= 0.7 and a_ar < 0.35 and not _WANTS_ENGLISH.search(prompt):
            return "wrong_language"
        if p_ar <= 0.1 and a_ar > 0.5 and _looks_english(prompt) and not _WANTS_ARABIC.search(prompt):
            return "wrong_language"
        # markdown sanity
        if text.count("```") % 2 == 1:
            return "broken_markdown"
        if text.count("**") % 2 == 1:
            return "broken_markdown"
        # degenerate repetition
        lines = [ln.strip() for ln in text.splitlines() if len(ln.strip()) > 12]
        if lines and max(lines.count(ln) for ln in set(lines)) >= 3:
            return "repetition"
        words = an.split()
        if len(words) >= 40:
            grams: dict[tuple, int] = {}
            for i in range(len(words) - 3):
                g = tuple(words[i:i + 4])
                grams[g] = grams.get(g, 0) + 1
            if max(grams.values()) >= 5:
                return "repetition"
        return None

    def summary(self) -> str:
        return (f"rules: {len(self.foreign_dialect)} dialect markers, {len(self.forbidden_identity)} identity strings, "
                f"len {self.min_chars}-{self.max_chars}; extra sources: {self.sources or 'none (built-in only)'}")


# --------------------------------------------------------------------------- #
# Near-duplicate detection (MinHash LSH, pure python)
# --------------------------------------------------------------------------- #


class NearDupIndex:
    """Cheap near-duplicate detector on word 3-gram shingles (MinHash + banding)."""

    def __init__(self, num_perm: int = 64, bands: int = 16, threshold: float = 0.8):
        assert num_perm % bands == 0
        self.num_perm, self.bands, self.rows = num_perm, bands, num_perm // bands
        self.threshold = threshold
        self._buckets: dict[tuple, list[int]] = {}
        self._sets: list[frozenset] = []
        self._mod = (1 << 61) - 1
        self._coef = [((i * 0x9E3779B97F4A7C15 + 0x1234567) % self._mod | 1,
                       (i * 0xC2B2AE3D27D4EB4F + 0x7654321) % self._mod) for i in range(1, num_perm + 1)]

    @staticmethod
    def _shingles(text: str) -> frozenset:
        w = dedup_key(text).split()
        if len(w) < 3:
            return frozenset([" ".join(w)])
        return frozenset(" ".join(w[i:i + 3]) for i in range(len(w) - 2))

    def _signature(self, sh: frozenset) -> list[int]:
        hs = [int.from_bytes(hashlib.blake2b(s.encode("utf-8"), digest_size=8).digest(), "big") for s in sh]
        return [min((a * h + b) % self._mod for h in hs) for a, b in self._coef]

    def add_if_new(self, text: str) -> bool:
        """True if `text` is new (and gets indexed); False if a near-duplicate already exists."""
        sh = self._shingles(text)
        sig = self._signature(sh)
        keys = [(b, tuple(sig[b * self.rows:(b + 1) * self.rows])) for b in range(self.bands)]
        cand: set[int] = set()
        for k in keys:
            cand.update(self._buckets.get(k, ()))
        for idx in cand:
            other = self._sets[idx]
            inter = len(sh & other)
            union = len(sh | other)
            if union and inter / union >= self.threshold:
                return False
        idx = len(self._sets)
        self._sets.append(sh)
        for k in keys:
            self._buckets.setdefault(k, []).append(idx)
        return True


# --------------------------------------------------------------------------- #
# Grounding check for article-based Q&A
# --------------------------------------------------------------------------- #

_AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_NUM_RE = re.compile(r"\d[\d,.\u060C\u066C]*\d|\d")
_DATE_CONTEXT_RE = re.compile(r"(20\d\d|حسب|بحسب|على حسب|لحد|لحدّ|حتى|وقت النشر|تاريخ|نُشر|نشر)")


def _digits(s: str) -> list[str]:
    s = s.translate(_AR_DIGITS)
    return [re.sub(r"\D", "", m) for m in _NUM_RE.findall(s)]


def check_grounded(answer: str, chunk: str, lang: str, article_ts: str) -> str | None:
    """Heuristic: every number in the answer must occur in the source chunk (or be a date part), the answer must
    carry a date context, and (Arabic sources) share enough content words with the chunk."""
    if not _DATE_CONTEXT_RE.search(answer):
        return "no_date_context"
    allowed = set(_digits(chunk)) | set(_digits(article_ts)) | {"2025", "2026"}
    for n in _digits(answer):
        if n and n not in allowed and not any(n in a for a in allowed if len(a) >= len(n) >= 2):
            return "ungrounded_number"
    if lang == "ar":
        cw = {w for w in dedup_key(chunk).split() if len(w) >= 4}
        aw = [w for w in dedup_key(answer).split() if len(w) >= 4]
        if aw and cw:
            overlap = sum(1 for w in aw if w in cw) / len(aw)
            if overlap < 0.2:
                return "ungrounded_text"
    return None
