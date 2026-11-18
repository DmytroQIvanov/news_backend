"""In-memory alias index for fast dictionary matching of known entities.

Matching works on stemmed token keys (text/stem.py), longest match first, so
"Володимира Зеленського" and "Volodymyr Zelensky's" both hit the same entity.
Guards against false positives:
  * short all-caps aliases (AMD, ЗСУ, ЄС) must be all caps in the text too;
  * ambiguous aliases (Apple, Meta, Мир) are returned with ambiguous=True and need context (linker.py);
  * single-token aliases shorter than 3 characters are ignored.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

from .. import db
from ..text.stem import term_key, token_spans

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class AliasEntry:
    entity_id: int
    alias: str
    ambiguous: bool
    weight: float
    caps_only: bool


@dataclass(frozen=True)
class GazetteerHit:
    start: int
    end: int
    surface: str
    key: str
    entries: tuple[AliasEntry, ...]

    @property
    def ambiguous(self) -> bool:
        return len({e.entity_id for e in self.entries}) > 1 or all(e.ambiguous for e in self.entries)


class Gazetteer:
    def __init__(self) -> None:
        self.index: dict[str, list[AliasEntry]] = {}
        self.max_len: dict[str, int] = {}
        self.loaded_at = 0.0
        self._lock = threading.Lock()

    def add(self, entity_id: int, alias: str, ambiguous: bool = False, weight: float = 1.0) -> None:
        key = term_key(alias)
        if not key:
            return
        parts = key.split(" ")
        if len(parts) == 1 and len(key) < 3 and not alias.isupper():
            return
        caps_only = alias.isupper() and len(alias.replace(" ", "")) <= 5
        if len(alias.replace(" ", "")) <= 2:
            ambiguous = True  # "X", "EU" in other senses, roman numerals ...
        entry = AliasEntry(entity_id, alias, ambiguous, weight, caps_only)
        bucket = self.index.setdefault(key, [])
        if any(e.entity_id == entity_id for e in bucket):
            return
        bucket.append(entry)
        first = parts[0]
        self.max_len[first] = max(self.max_len.get(first, 1), len(parts))

    def load_from_db(self) -> int:
        rows = db.fetch_all(
            """SELECT a.entity_id, a.alias, a.ambiguous, a.weight
               FROM kb.entity_aliases a JOIN kb.entities e ON e.id = a.entity_id
               WHERE e.status = 'active'"""
        )
        fresh = Gazetteer()
        for r in rows:
            fresh.add(r["entity_id"], r["alias"], r["ambiguous"], r["weight"])
        with self._lock:
            self.index, self.max_len, self.loaded_at = fresh.index, fresh.max_len, time.time()
        log.info("gazetteer loaded: %d keys", len(self.index))
        return len(self.index)

    def refresh_if_stale(self, max_age_s: int = 600) -> None:
        if time.time() - self.loaded_at > max_age_s:
            self.load_from_db()

    def find(self, text: str) -> list[GazetteerHit]:
        spans = token_spans(text)
        hits: list[GazetteerHit] = []
        i = 0
        n = len(spans)
        while i < n:
            first = spans[i][0]
            longest = self.max_len.get(first)
            matched = False
            if longest:
                for length in range(min(longest, n - i), 0, -1):
                    key = " ".join(s[0] for s in spans[i:i + length])
                    entries = self.index.get(key)
                    if not entries:
                        continue
                    start, end = spans[i][1], spans[i + length - 1][2]
                    surface = text[start:end]
                    # Names are written with a capital letter: "мали"/"того"/"дія" are words, "Малі"/"Того"/"Дія" may be names.
                    usable = tuple(
                        e for e in entries
                        if (not e.caps_only or surface.replace(" ", "").isupper())
                        and not (e.alias[:1].isupper() and surface[:1].islower())
                    )
                    if not usable:
                        continue
                    # Lowercase occurrences of ambiguous aliases are almost always the common word ("apple", "мир").
                    if all(e.ambiguous for e in usable) and surface[:1].islower():
                        continue
                    hits.append(GazetteerHit(start, end, surface, key, usable))
                    i += length
                    matched = True
                    break
            if not matched:
                i += 1
        return hits


GAZETTEER = Gazetteer()
