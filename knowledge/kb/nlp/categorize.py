"""Three-level categorization. The cheapest level that is confident wins; an LLM is never called from here.

Level 1  rules: resources/taxonomy.yaml (strong/weak/negative terms per language, stemmed/prefix matching),
         plus priors from linked entities (NVIDIA -> hardware) and from the source's own category.
Level 2  model: TF-IDF (char + word n-grams) + LogisticRegression trained by `python -m kb train-classifier`
         on Gemini-labelled legacy news and on high-confidence rule labels. Stored in KB_MODEL_DIR.
Level 3  embedding: nearest category centroid in the multilingual embedding space (same training run).
If none is confident, the source category is used with low confidence and the document is flagged
'category_uncertain'; only if its event becomes important does the editor stage ask an LLM.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

from ..config import settings
from ..text.stem import stem_token, term_key, tokens

log = logging.getLogger(__name__)
_TAXONOMY = Path(__file__).resolve().parents[1] / "resources" / "taxonomy.yaml"

RULES_MIN_SCORE = 4.0
RULES_MIN_MARGIN = 1.6     # top / second
MODEL_MIN_PROB = 0.55
EMBED_MIN_SIM = 0.35
EMBED_MIN_GAP = 0.04


@dataclass
class CategoryResult:
    category: str
    confidence: float
    method: str
    scores: dict[str, float]
    uncertain: bool = False


@dataclass
class _Term:
    key: str
    prefix: bool
    caps: bool


class Taxonomy:
    def __init__(self, data: dict):
        self.terms: dict[str, list[tuple[_Term, float]]] = {}
        self.labels: dict[str, str] = {}
        for cat, spec in (data.get("categories") or {}).items():
            items: list[tuple[_Term, float]] = []
            for group, weight in (("strong", 3.0), ("weak", 1.0), ("negative", -2.0)):
                for _lang, words in ((spec or {}).get(group) or {}).items():
                    for w in words or []:
                        w = str(w).strip()
                        if not w:
                            continue
                        prefix = w.endswith("*")
                        raw = w.rstrip("*")
                        key = " ".join(t.lower() for t in tokens(raw)) if prefix else term_key(raw)
                        if key:
                            items.append((_Term(key, prefix, raw.isupper() and len(raw) <= 4), weight))
            self.terms[cat] = items
            self.labels[cat] = (spec or {}).get("label_uk", cat)
        # Index by first token for speed.
        self.by_first: dict[str, list[tuple[str, _Term, float]]] = {}
        self.prefix_terms: list[tuple[str, _Term, float]] = []
        for cat, items in self.terms.items():
            for term, weight in items:
                if term.prefix and " " not in term.key:
                    self.prefix_terms.append((cat, term, weight))
                else:
                    first = term.key.split(" ")[0]
                    self.by_first.setdefault(first, []).append((cat, term, weight))
        # Prefix terms bucketed by their first 3 characters: one dict lookup per token instead of a full scan.
        self.prefix_by3: dict[str, list[tuple[str, _Term, float]]] = {}
        self.prefix_short: list[tuple[str, _Term, float]] = []
        for item in self.prefix_terms:
            key = item[1].key
            if len(key) >= 3:
                self.prefix_by3.setdefault(key[:3], []).append(item)
            else:
                self.prefix_short.append(item)

    def score(self, text: str, weight: float = 1.0) -> dict[str, float]:
        raw_tokens = tokens(text)
        stems = [stem_token(t) for t in raw_tokens]
        lowers = [t.lower() for t in raw_tokens]
        scores: dict[str, float] = {}
        hits: dict[tuple[str, str], int] = {}

        def count(cat: str, key: str, w: float) -> None:
            # each term counts at most twice per text: repetition is weak evidence
            n = hits.get((cat, key), 0)
            if n < 2:
                hits[(cat, key)] = n + 1
                scores[cat] = scores.get(cat, 0.0) + w * weight

        for i, (stem, low) in enumerate(zip(stems, lowers)):
            entries = self.by_first.get(stem, [])
            if low != stem:
                entries = [*entries, *self.by_first.get(low, [])]
            for cat, term, w in entries:
                parts = term.key.split(" ")
                window_stems = stems[i:i + len(parts)]
                window_low = lowers[i:i + len(parts)]
                if term.prefix:
                    ok = len(window_low) == len(parts) and all(a == b for a, b in zip(window_low[:-1], parts[:-1])) and window_low[-1].startswith(parts[-1])
                else:
                    ok = window_stems == parts
                if not ok:
                    continue
                if term.caps and not raw_tokens[i].isupper():
                    continue
                count(cat, term.key, w)
            for cat, term, w in (*self.prefix_by3.get(low[:3], ()), *self.prefix_short):
                if low.startswith(term.key):
                    if term.caps and not raw_tokens[i].isupper():
                        continue
                    count(cat, term.key, w)
        return scores


@lru_cache(maxsize=1)
def taxonomy() -> Taxonomy:
    try:
        data = yaml.safe_load(_TAXONOMY.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        log.warning("taxonomy.yaml not found; rules level disabled")
        data = {}
    return Taxonomy(data)


class _Models:
    """Level-2/3 artefacts, reloaded when the training job writes new files."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.clf = None
        self.centroids = None  # (labels, matrix)
        self.mtime = 0.0

    def get(self):
        path = Path(settings.model_dir) / "category_clf.joblib"
        cpath = Path(settings.model_dir) / "category_centroids.npz"
        try:
            mtime = max(path.stat().st_mtime if path.exists() else 0, cpath.stat().st_mtime if cpath.exists() else 0)
        except OSError:
            mtime = 0
        if mtime and mtime != self.mtime:
            with self._lock:
                try:
                    if path.exists():
                        import joblib  # type: ignore

                        self.clf = joblib.load(path)
                    if cpath.exists():
                        import numpy as np

                        data = np.load(cpath, allow_pickle=False)
                        self.centroids = (list(data["labels"]), data["matrix"])
                    self.mtime = mtime
                    log.info("category models loaded")
                except Exception as exc:
                    log.warning("could not load category models: %s", exc)
        return self.clf, self.centroids


MODELS = _Models()


def categorize(
    title: str,
    body: str,
    entity_priors: list[tuple[dict, float]] | None = None,
    source_category: str | None = None,
    embedding=None,
) -> CategoryResult:
    tax = taxonomy()
    scores = tax.score(title, 2.0)
    for cat, v in tax.score(body[:6000], 1.0).items():
        scores[cat] = scores.get(cat, 0.0) + v
    for prior, salience in entity_priors or []:
        for cat, p in prior.items():
            scores[cat] = scores.get(cat, 0.0) + 2.5 * float(p) * float(salience)
    if source_category and source_category != "other":
        scores[source_category] = scores.get(source_category, 0.0) + 1.5
    ranked = sorted(((v, k) for k, v in scores.items() if v > 0), reverse=True)
    rounded = {k: round(v, 2) for k, v in scores.items() if v > 0}
    if ranked:
        top, second = ranked[0][0], (ranked[1][0] if len(ranked) > 1 else 0.0)
        if top >= RULES_MIN_SCORE and top >= RULES_MIN_MARGIN * max(second, 0.5):
            conf = min(0.97, 0.55 + 0.45 * (top - second) / (top + 1))
            return CategoryResult(ranked[0][1], round(conf, 3), "rules", rounded)

    clf, centroids = MODELS.get()
    if clf is not None:
        try:
            proba = clf.predict_proba([f"{title}\n{title}\n{body[:3000]}"])[0]
            best = int(proba.argmax())
            if proba[best] >= MODEL_MIN_PROB:
                return CategoryResult(str(clf.classes_[best]), round(float(proba[best]), 3), "model", rounded)
        except Exception as exc:
            log.debug("classifier failed: %s", exc)

    if centroids is not None and embedding is not None:
        import numpy as np

        labels, matrix = centroids
        vec = np.asarray(embedding, dtype="float32")
        sims = matrix @ (vec / (np.linalg.norm(vec) or 1.0))
        order = np.argsort(-sims)
        if sims[order[0]] >= EMBED_MIN_SIM and sims[order[0]] - sims[order[1]] >= EMBED_MIN_GAP:
            return CategoryResult(str(labels[order[0]]), round(float(sims[order[0]]), 3), "embedding", rounded)

    if os.environ.get("KB_DECISION_CATEGORIZE", "false").lower() in ("1", "true", "yes", "auto") and os.environ.get("GEMINI_API_KEY", "").strip():
        from ..llm import decisions

        dec = decisions.classify_category(title, body, tax.labels)
        if dec is not None and dec[1] >= 0.75:
            return CategoryResult(dec[0], round(dec[1], 3), "decision", rounded, uncertain=False)

    if ranked and ranked[0][0] >= 2.0:
        return CategoryResult(ranked[0][1], 0.4, "rules", rounded, uncertain=True)
    return CategoryResult(source_category or "other", 0.25, "source", rounded, uncertain=True)


_SPLIT = re.compile(r"\s+")
