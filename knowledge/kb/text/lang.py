"""Language identification.

Order of preference:
1. lingua (if installed): accurate on short texts, restricted to the languages we care about;
2. a script + stop-word heuristic (always available, microseconds per call).
fastText lid.176 is an alternative with similar quality; lingua was chosen because its wheels install cleanly on
current Python versions and it needs no separate model download.
"""
from __future__ import annotations

import re
from functools import lru_cache

_UK_ONLY = re.compile(r"[ієїґІЄЇҐ]")
_RU_ONLY = re.compile(r"[ыэъёЫЭЪЁ]")
_CYR = re.compile(r"[Ѐ-ӿ]")
_LAT = re.compile(r"[A-Za-zÀ-ÿĀ-ž]")
_WORD = re.compile(r"[a-zà-ÿā-ž']+")

_STOP = {
    "en": {"the", "and", "of", "to", "in", "is", "that", "for", "on", "with", "as", "was", "by", "it", "from", "at", "said", "has"},
    "de": {"der", "die", "und", "das", "ist", "nicht", "mit", "den", "von", "zu", "auf", "für", "ein", "eine", "im", "dem", "sich", "auch"},
    "fr": {"le", "la", "les", "des", "et", "est", "une", "du", "dans", "pour", "que", "qui", "sur", "pas", "au", "avec", "il"},
    "pl": {"i", "w", "nie", "na", "się", "z", "jest", "do", "że", "to", "o", "jak", "przez", "dla", "od", "po", "oraz"},
    "es": {"el", "la", "los", "las", "y", "de", "que", "en", "un", "una", "por", "con", "para", "es", "del", "se", "al"},
    "it": {"il", "la", "di", "che", "e", "per", "un", "una", "non", "con", "del", "della", "sono", "nel", "alla", "gli"},
}

_LINGUA_CODES = {"UKRAINIAN": "uk", "RUSSIAN": "ru", "ENGLISH": "en", "GERMAN": "de", "FRENCH": "fr", "POLISH": "pl",
                 "SPANISH": "es", "ITALIAN": "it"}


@lru_cache(maxsize=1)
def _lingua():
    try:
        from lingua import Language, LanguageDetectorBuilder  # type: ignore
    except Exception:
        return None
    langs = [getattr(Language, name) for name in _LINGUA_CODES]
    return LanguageDetectorBuilder.from_languages(*langs).with_preloaded_language_models().build()


def heuristic(text: str) -> tuple[str, float]:
    sample = text[:4000]
    cyr = len(_CYR.findall(sample))
    lat = len(_LAT.findall(sample))
    if cyr == 0 and lat == 0:
        return "und", 0.0
    if cyr > lat:
        uk = len(_UK_ONLY.findall(sample))
        ru = len(_RU_ONLY.findall(sample))
        if uk == 0 and ru == 0:
            return "uk", 0.55
        return ("uk", min(0.99, 0.6 + uk / (uk + ru + 1) * 0.4)) if uk >= ru else ("ru", min(0.99, 0.6 + ru / (uk + ru + 1) * 0.4))
    words = _WORD.findall(sample.lower())
    if not words:
        return "en", 0.3
    scores = {lang: sum(1 for w in words if w in stops) for lang, stops in _STOP.items()}
    best = max(scores, key=scores.get)
    total = sum(scores.values()) or 1
    return best, round(0.4 + 0.6 * scores[best] / total, 3)


def detect(text: str) -> tuple[str, float]:
    """Returns (ISO 639-1 code or 'und', confidence 0..1)."""
    if not text or not text.strip():
        return "und", 0.0
    det = _lingua()
    if det is not None:
        try:
            values = det.compute_language_confidence_values(text[:2000])
            if values:
                top = values[0]
                code = _LINGUA_CODES.get(top.language.name)
                if code:
                    return code, round(float(top.value), 3)
        except Exception:
            pass
    return heuristic(text)
