"""Evidence roots: where a piece of information originally comes from.

"Kyiv Post, citing Reuters, reports X" and "УП з посиланням на Reuters: X" are ONE confirmation (Reuters), not two.
A document's root is the outlet it cites in its title or lead, otherwise its own owner group; a claim's root is
the outlet cited in its own sentence, otherwise the document's root. Facts count distinct roots, never outlets.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

from .gazetteer import Gazetteer

_FILE = Path(__file__).resolve().parents[1] / "resources" / "outlets.yaml"

# A citation cue right before or right after the outlet's name.
_CUE_BEFORE = re.compile(
    r"(?:according to|as reported by|reported by|citing|cited by|told|in an interview with|"
    r"за даними|за інформацією|за словами (?:джерел|співрозмовників)?|з посиланням на|повідомляє|повідомило|повідомила|"
    r"як пише|як повідомляє|як повідомило|пише|передає|розповіли|розповів|"
    r"по данным|со ссылкой на|сообщает|пишет|передает|"
    r"laut|berichtet|berichtete|zufolge|wie|[–—]|\s-)\s*[\"«]?\s*(?:the\s+)?$",   # "... – Reuters" in titles
    re.I,
)
_CUE_AFTER = re.compile(
    r"^[\"»]?\s*(?::|(?:,\s*)?(?:reported|reports|first reported|said|wrote|has learned|learned|"   # "Reuters: ..."
    r"повідомляє|повідомило|повідомила|пише|написало|передає|з'ясувало|з’ясувало|дізналося|дізнався|"
    r"сообщает|пишет|berichtet|berichtete|zufolge)\b)",
    re.I,
)


@dataclass(frozen=True)
class Citation:
    group: str
    start: int
    end: int


@lru_cache(maxsize=1)
def _outlets() -> tuple[Gazetteer, dict[int, str]]:
    data = yaml.safe_load(_FILE.read_text(encoding="utf-8")) or {}
    g = Gazetteer()
    groups: dict[int, str] = {}
    for i, (group, names) in enumerate((data.get("outlets") or {}).items(), start=1):
        groups[i] = group
        for name in names or []:
            g.add(i, str(name))
    return g, groups


def citations(text: str) -> list[Citation]:
    g, groups = _outlets()
    out: list[Citation] = []
    for hit in g.find(text):
        before = text[max(0, hit.start - 45): hit.start]
        after = text[hit.end: hit.end + 30]
        if _CUE_BEFORE.search(before) or _CUE_AFTER.search(after):
            out.append(Citation(groups[hit.entries[0].entity_id], hit.start, hit.end))
    return out


def document_root(title: str, lead: str, own_group: str | None) -> str | None:
    """Cited outlet in the title or the first two sentences, otherwise the document's own owner group."""
    for c in citations(f"{title}\n{lead[:600]}"):
        if c.group != own_group:
            return c.group
    return own_group


def sentence_root(sentence: str, doc_root: str | None, own_group: str | None) -> str | None:
    for c in citations(sentence):
        if c.group != own_group:
            return c.group
    return doc_root
