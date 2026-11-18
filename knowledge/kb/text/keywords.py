"""Keyword extraction with YAKE (unsupervised, statistical, language-agnostic). Falls back to frequency ranking."""
from __future__ import annotations

import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

_RES = Path(__file__).resolve().parents[1] / "resources"
_WORD = re.compile(r"[\w][\w'\-]{2,}", re.U)


@lru_cache(maxsize=8)
def stopwords(lang: str) -> frozenset[str]:
    words: set[str] = set()
    path = _RES / f"stopwords_{lang}.txt"
    if path.exists():
        words |= {w.strip().lower() for w in path.read_text(encoding="utf-8").splitlines() if w.strip() and not w.startswith("#")}
    return frozenset(words)


@lru_cache(maxsize=8)
def _extractor(lang: str):
    try:
        import yake  # type: ignore
    except Exception:
        return None
    stops = stopwords(lang)
    kwargs = {"lan": lang if lang in ("en", "de", "fr", "es", "it", "pl", "ru", "uk") else "en", "n": 3, "dedupLim": 0.8, "top": 12}
    if stops:
        kwargs["stopwords"] = set(stops)
    try:
        return yake.KeywordExtractor(**kwargs)
    except TypeError:
        kwargs.pop("stopwords", None)
        return yake.KeywordExtractor(**kwargs)


def keywords(title: str, body: str, lang: str, top: int = 10) -> list[str]:
    text = f"{title}. {title}. {body[:8000]}"
    ext = _extractor(lang)
    if ext is not None:
        try:
            pairs = ext.extract_keywords(text)
            out: list[str] = []
            for kw, _score in pairs:
                kw = kw.strip()
                if len(kw) < 3 or kw.lower() in stopwords(lang) or kw.isdigit():
                    continue
                out.append(kw)
                if len(out) >= top:
                    break
            if out:
                return out
        except Exception:
            pass
    stops = stopwords(lang)
    counts = Counter(w.lower() for w in _WORD.findall(text) if w.lower() not in stops and not w.isdigit())
    return [w for w, _ in counts.most_common(top)]
