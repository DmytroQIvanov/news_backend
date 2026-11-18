"""Multilingual sentence embeddings via fastembed (ONNX Runtime, CPU, no PyTorch).

The default model (paraphrase-multilingual-MiniLM-L12-v2, 384 dims) maps Ukrainian, English and German texts about
the same event close together, which is what cross-language clustering needs. It is used for:
  * event clustering (cosine similarity to event centroids, pgvector HNSW index),
  * level-3 categorization (nearest category centroid),
  * "related past events" retrieval for long articles (task 4).
Disabled with KB_EMBEDDINGS=false; every caller handles `None`.
"""
from __future__ import annotations

import logging
import os
import threading

import numpy as np

from ..config import settings

log = logging.getLogger(__name__)
_lock = threading.Lock()
_model = None
_failed = False


def _get():
    global _model, _failed
    if not settings.embeddings or _failed:
        return None
    with _lock:
        if _model is None:
            try:
                from fastembed import TextEmbedding  # type: ignore

                cache = os.environ.get("KB_EMBED_CACHE") or f"{settings.model_dir}/fastembed"
                _model = TextEmbedding(model_name=settings.embed_model, cache_dir=cache)
                log.info("embedding model loaded: %s", settings.embed_model)
            except Exception as exc:
                log.warning("embeddings disabled: %s", exc)
                _failed = True
                return None
    return _model


def embedding_text(title: str, body: str, summary: str | None = None) -> str:
    lead = body[:900] if body else (summary or "")
    return f"{title}\n{lead}".strip()


def embed(texts: list[str]) -> list[np.ndarray] | None:
    model = _get()
    if model is None or not texts:
        return None
    vectors = list(model.embed(texts, batch_size=16))
    out = []
    for v in vectors:
        v = np.asarray(v, dtype="float32")
        n = float(np.linalg.norm(v)) or 1.0
        out.append(v / n)
    return out


def to_pg(vec: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec.tolist()) + "]"


def from_pg(value) -> np.ndarray | None:
    if value is None:
        return None
    if isinstance(value, str):
        return np.asarray([float(x) for x in value.strip("[]").split(",")], dtype="float32")
    return np.asarray(value, dtype="float32")
