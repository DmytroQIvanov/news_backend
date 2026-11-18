"""Training of the level-2 category classifier and level-3 category centroids.

Labels come for free:
  * public.news_items.category — assigned by the Gemini editor for every published legacy article (weak labels);
  * kb.documents with a confident rules verdict (category_method='rules', confidence >= 0.8).
No manual annotation is needed to start; manual corrections can later be added as another label source.
"""
from __future__ import annotations

import logging
import os
from collections import Counter
from pathlib import Path

import numpy as np

from . import db
from .config import settings

log = logging.getLogger(__name__)
MIN_PER_CLASS = 15


def _training_rows(limit: int = 40000) -> list[tuple[str, str]]:
    rows = db.fetch_all(
        """SELECT category, concat_ws(E'\n', original_title, original_title, title_uk, original_summary, summary_uk) AS text
           FROM public.news_items WHERE status = 'published' AND category NOT IN ('other') ORDER BY id DESC LIMIT %s""",
        (limit,),
    )
    rows += db.fetch_all(
        """SELECT category, concat_ws(E'\n', title, title, left(COALESCE(body, feed_summary, ''), 3000)) AS text
           FROM kb.documents WHERE category_method = 'rules' AND category_confidence >= 0.8 AND category <> 'other'
           ORDER BY id DESC LIMIT %s""",
        (limit,),
    )
    return [(r["category"], r["text"]) for r in rows if r["text"] and len(r["text"]) > 20]


def train_category_models() -> dict:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import train_test_split
    from sklearn.pipeline import FeatureUnion, Pipeline

    rows = _training_rows()
    counts = Counter(c for c, _ in rows)
    keep = {c for c, n in counts.items() if n >= MIN_PER_CLASS}
    rows = [(c, t) for c, t in rows if c in keep]
    if len(keep) < 3 or len(rows) < 200:
        return {"skipped": "not enough labelled data", "rows": len(rows), "classes": len(keep)}
    labels = [c for c, _ in rows]
    texts = [t for _, t in rows]
    x_train, x_test, y_train, y_test = train_test_split(texts, labels, test_size=0.15, random_state=7, stratify=labels)
    model = Pipeline([
        ("features", FeatureUnion([
            ("words", TfidfVectorizer(ngram_range=(1, 2), min_df=2, max_features=150_000, sublinear_tf=True)),
            ("chars", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3, max_features=200_000, sublinear_tf=True)),
        ])),
        ("clf", LogisticRegression(max_iter=3000, C=4.0, class_weight="balanced")),
    ])
    model.fit(x_train, y_train)
    accuracy = float(model.score(x_test, y_test))
    model.fit(texts, labels)
    out = Path(settings.model_dir)
    out.mkdir(parents=True, exist_ok=True)
    import joblib  # type: ignore

    tmp = out / "category_clf.joblib.tmp"
    joblib.dump(model, tmp)
    os.replace(tmp, out / "category_clf.joblib")
    result = {"rows": len(rows), "classes": len(keep), "holdout_accuracy": round(accuracy, 4)}
    result["centroids"] = _centroids()
    log.info("category classifier trained: %s", result)
    return result


def _centroids() -> int:
    if not db.features()["vector"]:
        return 0
    rows = db.fetch_all(
        """SELECT d.category, avg(e.embedding)::text AS c, count(*) AS n
           FROM kb.document_embeddings e JOIN kb.documents d ON d.id = e.document_id
           WHERE d.category_confidence >= 0.7 AND d.category <> 'other'
           GROUP BY d.category HAVING count(*) >= 20"""
    )
    if len(rows) < 3:
        return 0
    from .nlp.embed import from_pg

    labels = np.array([r["category"] for r in rows])
    matrix = np.stack([from_pg(r["c"]) for r in rows])
    matrix = matrix / np.linalg.norm(matrix, axis=1, keepdims=True)
    out = Path(settings.model_dir)
    tmp = out / "category_centroids.tmp.npz"
    np.savez(tmp, labels=labels, matrix=matrix.astype("float32"))
    os.replace(tmp, out / "category_centroids.npz")
    return len(rows)
