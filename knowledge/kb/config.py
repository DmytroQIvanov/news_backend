"""Settings from environment variables. Every knob has a safe default so `docker compose up` works as is."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _list(name: str, default: str) -> list[str]:
    raw = os.environ.get(name, default)
    return [x.strip() for x in raw.split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: os.environ.get("KB_DATABASE_URL") or os.environ.get("DATABASE_URL", ""))
    # Collector
    collector_concurrency: int = field(default_factory=lambda: _int("KB_COLLECTOR_CONCURRENCY", 8))
    fetch_timeout_s: float = field(default_factory=lambda: _float("KB_FETCH_TIMEOUT_S", 20.0))
    max_page_bytes: int = field(default_factory=lambda: _int("KB_MAX_PAGE_BYTES", 5 * 1024 * 1024))
    per_host_delay_s: float = field(default_factory=lambda: _float("KB_PER_HOST_DELAY_S", 2.0))
    max_article_age_h: int = field(default_factory=lambda: _int("KB_MAX_ARTICLE_AGE_H", 72))
    recheck_window_h: int = field(default_factory=lambda: _int("KB_RECHECK_WINDOW_H", 48))
    user_agent: str = field(
        default_factory=lambda: os.environ.get(
            "KB_USER_AGENT", "NewsKnowledgeBot/1.0 (+news knowledge base; respects robots.txt)"
        )
    )
    contact_email: str = field(default_factory=lambda: os.environ.get("CONTACT_EMAIL", "").strip())
    # NLP
    spacy_models: list[str] = field(
        default_factory=lambda: _list("KB_SPACY_MODELS", "en:en_core_web_sm,uk:uk_core_news_sm,de:de_core_news_sm,xx:xx_ent_wiki_sm")
    )
    max_body_chars: int = field(default_factory=lambda: _int("KB_MAX_BODY_CHARS", 40_000))
    nlp_batch: int = field(default_factory=lambda: _int("KB_NLP_BATCH", 16))
    embeddings: bool = field(default_factory=lambda: _bool("KB_EMBEDDINGS", True))
    embed_model: str = field(
        default_factory=lambda: os.environ.get("KB_EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    )
    model_dir: str = field(default_factory=lambda: os.environ.get("KB_MODEL_DIR", "/models"))
    # Clustering
    event_window_h: int = field(default_factory=lambda: _int("KB_EVENT_WINDOW_H", 72))
    event_join_threshold: float = field(default_factory=lambda: _float("KB_EVENT_JOIN_THRESHOLD", 0.52))
    # Editorial gates (task 1/4): what counts as article material
    ready_min_independent_sources: int = field(default_factory=lambda: _int("KB_READY_MIN_SOURCES", 2))
    deep_min_independent_sources: int = field(default_factory=lambda: _int("KB_DEEP_MIN_SOURCES", 4))
    # Wikidata enrichment
    wikidata_enabled: bool = field(default_factory=lambda: _bool("KB_WIKIDATA", True))
    wikidata_per_run: int = field(default_factory=lambda: _int("KB_WIKIDATA_PER_RUN", 40))
    candidate_min_sources: int = field(default_factory=lambda: _int("KB_CANDIDATE_MIN_SOURCES", 2))
    candidate_min_mentions: int = field(default_factory=lambda: _int("KB_CANDIDATE_MIN_MENTIONS", 3))
    # LLM budgets (tasks per day placed into kb.llm_tasks; the consumer may enforce its own limits too)
    llm_daily_lite: int = field(default_factory=lambda: _int("KB_LLM_DAILY_LITE", 300))
    llm_daily_standard: int = field(default_factory=lambda: _int("KB_LLM_DAILY_STANDARD", 60))
    llm_daily_deep: int = field(default_factory=lambda: _int("KB_LLM_DAILY_DEEP", 20))
    # Loops
    collector_idle_s: int = field(default_factory=lambda: _int("KB_COLLECTOR_IDLE_S", 30))
    nlp_idle_s: int = field(default_factory=lambda: _int("KB_NLP_IDLE_S", 10))
    maintain_interval_s: int = field(default_factory=lambda: _int("KB_MAINTAIN_INTERVAL_S", 900))
    log_level: str = field(default_factory=lambda: os.environ.get("KB_LOG_LEVEL", "INFO"))


settings = Settings()
