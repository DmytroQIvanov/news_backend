"""Matching keys for names and terms.

Ukrainian (and Russian) inflect names: "Зеленський / Зеленського / Зеленському", "НАТО" stays, "Києва".
For matching every Cyrillic token is reduced to its lemma (pymorphy3), or to a light stem when pymorphy3 is missing.
The same function is applied to aliases and to text, so both sides meet in the middle.
This is intentionally conservative: it only needs to be consistent, not linguistically perfect.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

_CYR = re.compile(r"[Ѐ-ӿ]")
TOKEN_RE = re.compile(r"[\w][\w'’\-\.]*[\w]|[\w]", re.UNICODE)

_ENDINGS = sorted(
    {
        # adjectives / surnames (fallback only; pymorphy3 is used when installed)
        "ого", "ому", "ими", "іми", "ему", "его", "ыми", "ой", "ий", "ій", "ая", "яя", "ее", "ые", "ая", "ую", "юю",
        "их", "іх", "ых", "им", "ім", "ым",
        # nouns
        "ами", "ями", "ові", "еві", "єві", "ою", "ею", "єю", "ях", "ах", "ів", "їв", "ей", "ам", "ям", "ом", "ем", "єм",
        "ої", "ії", "ія", "ію", "ей", "ов", "ев",
        "а", "я", "у", "ю", "і", "ї", "и", "е", "є", "о", "ь", "й", "ы",
    },
    key=len,
    reverse=True,
)
_MIN_STEM = 3


def is_cyrillic(text: str) -> bool:
    return bool(_CYR.search(text))


_RU_ONLY = re.compile(r"[ыэъё]")


@lru_cache(maxsize=4)
def _morph(lang: str):
    """pymorphy3 analyzers (installed with spaCy's Ukrainian pipeline). None when unavailable."""
    try:
        import pymorphy3  # type: ignore

        return pymorphy3.MorphAnalyzer(lang=lang)
    except Exception:
        return None


@lru_cache(maxsize=300_000)
def _cyrillic_lemma(t: str) -> str:
    morph = _morph("ru") if _RU_ONLY.search(t) else _morph("uk")
    if morph is not None:
        try:
            return morph.parse(t)[0].normal_form.replace("'", "")
        except Exception:
            pass
    for end in _ENDINGS:
        if t.endswith(end) and len(t) - len(end) >= _MIN_STEM:
            return t[: -len(end)]
    return t


def stem_token(token: str) -> str:
    t = token.lower().replace("’", "'").replace("ʼ", "'")
    if not is_cyrillic(t):
        if t.endswith("'s"):
            t = t[:-2]
        elif t.endswith("s'"):
            t = t[:-1]
        return t
    t = t.replace("'", "")
    # Abbreviations in caps (НАТО, ЗСУ, СБУ, ЄС) do not inflect in writing.
    if token.isupper() and len(token) <= 6:
        return t
    # Lemma, not stem: "Києва" -> "київ", "Зеленського" -> "зеленський", "санкцій" -> "санкція".
    return _cyrillic_lemma(t)


def tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text)
    return TOKEN_RE.findall(text)


def term_key(text: str) -> str:
    """Matching key of a name/alias/term: light-stemmed lowercase tokens joined by single spaces."""
    return " ".join(stem_token(t) for t in tokens(text) if t.strip(".-'"))


def token_spans(text: str) -> list[tuple[str, int, int]]:
    """Tokens of `text` with character offsets: (stem_key, start, end)."""
    out: list[tuple[str, int, int]] = []
    for m in TOKEN_RE.finditer(text):
        tok = m.group(0).rstrip(".")
        if not tok:
            continue
        out.append((stem_token(tok), m.start(), m.start() + len(tok)))
    return out
