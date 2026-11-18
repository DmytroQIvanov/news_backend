"""Entity linking: dictionary hits + NER spans -> mentions bound to kb.entities (or left as candidates).

Decision order (cheapest first):
 1. Unambiguous dictionary hit -> linked (confidence 0.95).
 2. NER span whose stemmed key is a known alias -> linked; several owners -> disambiguation.
 3. In-document coreference: "Pete Hegseth ... Hegseth said" -> the short form inherits the long form's entity.
 4. Ambiguous aliases are resolved by: type agreement with the NER label, co-occurrence with entities already
    linked in this document (kb.entity_relations 'cooccurrence'), and popularity. If nothing wins clearly,
    the mention stays unlinked rather than being linked wrongly.
 5. Everything else becomes an unlinked mention -> kb.entity_candidates (maintain.py resolves them via Wikidata).
"""
from __future__ import annotations

import math
import re
import threading
import time
from dataclasses import dataclass

from .. import db
from ..text.stem import term_key
from .gazetteer import GAZETTEER, GazetteerHit
from .ner import Parsed

KIND_COMPAT = {
    "person": {"person"},
    "organization": {"organization", "company", "government", "group"},
    "place": {"place", "facility"},
    "facility": {"facility", "place"},
    "product": {"product", "model", "technology", "weapon"},
    "group": {"group", "organization", "place"},
    "event": {"event"},
    "law": {"law"},
    "other": {"product", "model", "technology", "weapon", "event", "law", "organization", "company", "other"},
}

_NOISE = re.compile(
    r"^(?:\d+|[\W_]+|january|february|march|april|may|june|july|august|september|october|november|december|"
    r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|"
    r"січ\w*|лют\w*|берез\w*|квіт\w*|трав\w*|черв\w*|лип\w*|серп\w*|верес\w*|жовт\w*|листопад\w*|груд\w*|"
    r"понеділ\w*|вівтор\w*|серед\w*|четвер\w*|п'ятниц\w*|субот\w*|неділ\w*|сьогодні|вчора|"
    r"photo|getty images|reuters|ap|afp|фото|джерело|відео)$",
    re.I,
)


# "GBP 12 million", "$700m", "500 млн грн": spaCy sometimes labels amounts as ORG/MISC.
_AMOUNT = re.compile(r"^\W*(?:[A-Z]{3}|[$€£¥₴])\s*\d|\d[\d.,\s]*\s*(?:million|billion|trillion|bn|m\b|млн|млрд|трлн|тис|"
                     r"Mio|Mrd|Millionen|Milliarden|%|відсот|percent|Prozent)", re.I)
NON_NAME_POS = {"VERB", "AUX", "PRON", "DET", "ADP", "CCONJ", "SCONJ", "PART", "ADV", "NUM", "INTJ", "PUNCT"}


@dataclass
class Mention:
    surface: str
    key: str
    label: str | None
    start: int
    end: int
    sentence_idx: int
    in_title: bool
    method: str
    entity_id: int | None = None
    confidence: float | None = None


class EntityInfo:
    """Small cache of entity kind/popularity for disambiguation."""

    def __init__(self) -> None:
        self.kind: dict[int, str] = {}
        self.popularity: dict[int, int] = {}
        self.loaded_at = 0.0
        self._lock = threading.Lock()

    def refresh_if_stale(self, max_age_s: int = 600) -> None:
        if time.time() - self.loaded_at < max_age_s:
            return
        rows = db.fetch_all("SELECT id, kind, mention_count FROM kb.entities WHERE status = 'active'")
        with self._lock:
            self.kind = {r["id"]: r["kind"] for r in rows}
            self.popularity = {r["id"]: r["mention_count"] for r in rows}
            self.loaded_at = time.time()


ENTITY_INFO = EntityInfo()


def _sentence_of(offset: int, parsed: Parsed) -> int:
    for s in parsed.sentences:
        if s.start <= offset < s.end:
            return s.idx
    return parsed.sentences[-1].idx if parsed.sentences else 0


def _cooccurrence(candidates: set[int], context: set[int]) -> dict[int, float]:
    if not candidates or not context:
        return {}
    rows = db.fetch_all(
        """SELECT from_entity_id AS a, to_entity_id AS b, weight FROM kb.entity_relations
           WHERE origin = 'cooccurrence'
             AND ((from_entity_id = ANY(%s) AND to_entity_id = ANY(%s)) OR (to_entity_id = ANY(%s) AND from_entity_id = ANY(%s)))""",
        (list(candidates), list(context), list(candidates), list(context)),
    )
    score: dict[int, float] = {}
    for r in rows:
        cand = r["a"] if r["a"] in candidates else r["b"]
        score[cand] = score.get(cand, 0.0) + float(r["weight"])
    return score


def _disambiguate(entity_ids: list[int], label: str | None, context: set[int], allow_db: bool) -> tuple[int | None, float]:
    if len(set(entity_ids)) == 1:
        eid = entity_ids[0]
        if label is None:
            return None, None  # no NER support: the caller accepts it only if the entity is linked elsewhere in the text
        if label and ENTITY_INFO.kind.get(eid) and ENTITY_INFO.kind[eid] not in KIND_COMPAT.get(label, set()):
            return None, None  # spaCy says PERSON, the only candidate is a country: do not link
        return eid, 0.8
    cands = set(entity_ids)
    co = _cooccurrence(cands, context) if allow_db else {}
    scored: list[tuple[float, int]] = []
    for eid in cands:
        s = 0.0
        if label:
            s += 1.5 if ENTITY_INFO.kind.get(eid) in KIND_COMPAT.get(label, set()) else -1.0
        s += 2.0 * math.log1p(co.get(eid, 0.0))
        s += 0.3 * math.log1p(ENTITY_INFO.popularity.get(eid, 0))
        scored.append((s, eid))
    scored.sort(reverse=True)
    best, second = scored[0], scored[1]
    if best[0] - second[0] >= 1.0:
        return best[1], min(0.9, 0.55 + 0.1 * (best[0] - second[0]))
    return None, None


def link(text: str, title_len: int, parsed: Parsed, allow_db: bool = True) -> list[Mention]:
    hits: list[GazetteerHit] = GAZETTEER.find(text)
    mentions: list[Mention] = []
    covered: list[tuple[int, int]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(a < y and x < b for x, y in covered)

    # NER label for a dictionary hit, if spaCy saw the same span (helps ambiguous aliases).
    def ner_label(start: int, end: int) -> str | None:
        for e in parsed.entities:
            if e.start <= start and end <= e.end:
                return e.label
        return None

    # Part of speech by character offset: a capitalized sentence-initial "Того ж дня" / "Мали б" is a pronoun/verb.
    pos_at: dict[int, str] = {}
    for s in parsed.sentences:
        for t in s.tokens:
            pos_at[t.start] = t.pos

    pending_ambiguous: list[tuple[Mention, list[int]]] = []
    for h in hits:
        if " " not in h.key and pos_at.get(h.start) in NON_NAME_POS:
            continue
        label = ner_label(h.start, h.end)
        m = Mention(h.surface, h.key, label, h.start, h.end, _sentence_of(h.start, parsed), h.start < title_len, "gazetteer")
        ids = [e.entity_id for e in h.entries]
        if not h.ambiguous:
            m.entity_id, m.confidence = ids[0], 0.95
        elif label is None and all(e.ambiguous for e in h.entries) and len(set(ids)) == 1:
            # "Apple" capitalized but spaCy did not call it an entity: keep only if other evidence links it later.
            pending_ambiguous.append((m, ids))
            covered.append((h.start, h.end))
            mentions.append(m)
            continue
        else:
            pending_ambiguous.append((m, ids))
        covered.append((h.start, h.end))
        mentions.append(m)

    for e in parsed.entities:
        if overlaps(e.start, e.end):
            continue
        surface = e.text.strip()
        if len(surface) < 3 or _NOISE.match(surface) or surface.islower() or _AMOUNT.search(surface):
            continue
        key = term_key(surface)
        if not key:
            continue
        m = Mention(surface, key, e.label, e.start, e.end, e.sentence_idx, e.start < title_len, "ner")
        entries = GAZETTEER.index.get(key)
        if entries:
            pending_ambiguous.append((m, [x.entity_id for x in entries]))
        mentions.append(m)
        covered.append((e.start, e.end))

    context = {m.entity_id for m in mentions if m.entity_id}
    for m, ids in pending_ambiguous:
        if m.entity_id:
            continue
        eid, conf = _disambiguate(ids, m.label, context, allow_db)
        if eid is None and len(set(ids)) == 1 and m.method == "gazetteer":
            # Single-owner ambiguous alias: accept only if the entity is also mentioned unambiguously in this document.
            if ids[0] in context:
                eid, conf = ids[0], 0.85
        if eid:
            m.entity_id, m.confidence = eid, conf
            context.add(eid)

    # Drop ambiguous dictionary hits that stayed unlinked: they are most likely the common word.
    mentions = [m for m in mentions if m.entity_id or m.method != "gazetteer"]

    # In-document coreference: an unlinked short name that is the tail of a linked longer name.
    linked = [m for m in mentions if m.entity_id]
    for m in mentions:
        if m.entity_id:
            continue
        for lm in linked:
            if lm.key != m.key and (lm.key.endswith(" " + m.key) or lm.key.startswith(m.key + " ")):
                m.entity_id, m.confidence, m.method = lm.entity_id, 0.8, m.method
                break
        if not m.entity_id:
            for other in mentions:
                if other is not m and not other.entity_id and other.key.endswith(" " + m.key):
                    # same unlinked person mentioned by full name: unify the key so candidates aggregate correctly
                    m.key = other.key
                    break
    mentions.sort(key=lambda x: x.start)
    return mentions


def salience(mentions: list[Mention], n_sentences: int) -> dict[int, tuple[int, float, bool]]:
    """entity_id -> (mention count, salience 0..1, in_title)."""
    agg: dict[int, list[Mention]] = {}
    for m in mentions:
        if m.entity_id:
            agg.setdefault(m.entity_id, []).append(m)
    out: dict[int, tuple[int, float, bool]] = {}
    n = max(1, n_sentences)
    for eid, ms in agg.items():
        in_title = any(m.in_title for m in ms)
        first = min(m.sentence_idx for m in ms)
        s = 0.45 * in_title + 0.35 * min(1.0, len(ms) / 4) + 0.2 * (1 - min(first, n) / n)
        out[eid] = (len(ms), round(s, 4), in_title)
    return out
