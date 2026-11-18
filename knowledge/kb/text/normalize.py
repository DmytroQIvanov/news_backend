"""Cheap, deterministic text normalization and fingerprints (no AI).

- canonical_url: one URL per article regardless of tracking parameters, AMP paths and mobile hosts
- sha256 of normalized text: exact duplicates
- 64-bit SimHash over word shingles: near duplicates (syndicated copies, light rewrites)
- (at larger scale, MinHash LSH can replace the in-memory SimHash scan in nlp/pipeline.py)
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_TRACKING_PARAMS = re.compile(
    r"^(utm_\w+|fbclid|gclid|dclid|yclid|mc_cid|mc_eid|igshid|ref|ref_src|ref_url|cmpid|smid|ito|"
    r"guccounter|guce_\w+|_ga|_gl|ocid|cid|taid|at_\w+|wt_\w+|s_cid|soc_src|soc_trk|mbid|rss|outputType|output)$",
    re.I,
)
_WS = re.compile(r"\s+")
_ZERO_WIDTH = re.compile("[​‌‍⁠﻿­]")
_QUOTES = str.maketrans({"«": '"', "»": '"', "„": '"', "“": '"', "”": '"', "‘": "'", "’": "'", "ʼ": "'", "`": "'"})
_DASHES = str.maketrans({"–": "-", "—": "-", "−": "-", "‒": "-"})
WORD_RE = re.compile(r"[\w][\w'\-]*", re.UNICODE)


def clean_text(text: str | None) -> str:
    """NFC, no zero-width characters, unified quotes/dashes/apostrophes, collapsed whitespace."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = _ZERO_WIDTH.sub("", text)
    text = text.translate(_QUOTES).translate(_DASHES)
    # keep paragraph breaks, collapse the rest
    paragraphs = [(_WS.sub(" ", p)).strip() for p in re.split(r"\n\s*\n+", text)]
    return "\n\n".join(p for p in paragraphs if p)


def fingerprint_text(text: str) -> str:
    """Text used for exact-duplicate hashing: lowercase, letters and digits only."""
    t = clean_text(text).lower()
    return " ".join(WORD_RE.findall(t))


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    scheme = "https" if parts.scheme in ("http", "https", "") else parts.scheme
    host = (parts.hostname or "").lower()
    for prefix in ("www.", "m.", "mobile.", "amp."):
        if host.startswith(prefix) and host.count(".") >= 2:
            host = host[len(prefix):]
    port = f":{parts.port}" if parts.port and parts.port not in (80, 443) else ""
    path = re.sub(r"/+", "/", parts.path or "/")
    path = re.sub(r"/amp/?$|\.amp$|/amp\.html$", "", path)
    if len(path) > 1:
        path = path.rstrip("/")
    query = urlencode(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False) if not _TRACKING_PARAMS.match(k)))
    return urlunsplit((scheme, host + port, path, query, ""))


def host_of(url: str) -> str:
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def shingles(text: str, k: int = 3) -> list[str]:
    words = fingerprint_text(text).split()
    if len(words) < k:
        return [" ".join(words)] if words else []
    return [" ".join(words[i:i + k]) for i in range(len(words) - k + 1)]


def _h64(token: str) -> int:
    return int.from_bytes(hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest(), "big")


def simhash64(text: str, k: int = 3) -> int:
    """Charikar SimHash over word k-shingles. Returns a signed 64-bit int (fits PostgreSQL bigint)."""
    vec = [0] * 64
    for sh in shingles(text, k):
        h = _h64(sh)
        for i in range(64):
            vec[i] += 1 if (h >> i) & 1 else -1
    value = 0
    for i in range(64):
        if vec[i] > 0:
            value |= 1 << i
    return value - (1 << 64) if value >= (1 << 63) else value


def hamming64(a: int, b: int) -> int:
    return ((a & 0xFFFFFFFFFFFFFFFF) ^ (b & 0xFFFFFFFFFFFFFFFF)).bit_count()


_SENT_SPLIT = re.compile(r"(?<=[.!?…])[\"')\]]*\s+(?=[\"'(\[]?[A-ZА-ЯІЇЄҐÄÖÜ0-9])")
_ABBREV = re.compile(
    r"\b(?:Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Co|St|vs|etc|e\.g|i\.e|U\.S|U\.K|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|"
    r"див|ім|т\.зв|т\.д|т\.п|напр|млн|млрд|тис|грн|дол|р|рр|ст|вул|м|обл|р-н|проф|акад|д-р|z\.B|bzw|ca|Nr|Mio|Mrd)\.$",
    re.I,
)


def split_sentences(text: str) -> list[str]:
    """Rule-based sentence splitter used when spaCy is not loaded for a language."""
    out: list[str] = []
    for para in clean_text(text).split("\n\n"):
        buf = ""
        for piece in _SENT_SPLIT.split(para):
            buf = f"{buf} {piece}".strip() if buf else piece
            if _ABBREV.search(buf):
                continue
            out.append(buf)
            buf = ""
        if buf:
            out.append(buf)
    return [s for s in out if len(s) > 1]


def word_count(text: str) -> int:
    return len(WORD_RE.findall(text or ""))
