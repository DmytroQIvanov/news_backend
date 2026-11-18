"""Backfill: turn the existing public.news_items history into knowledge-base documents.

Old items become documents linked by legacy_news_id. Recent ones (--fetch-days) are queued for full-text extraction;
older ones are analyzed from their original title + summary (teaser quality), which is still enough to place their
entities and events on the timeline, so new articles can reference the past from day one.
"""
from __future__ import annotations

import logging

from . import db
from .text import lang as langid
from .text.normalize import canonical_url, clean_text, fingerprint_text, sha256, simhash64, word_count

log = logging.getLogger(__name__)


def backfill(fetch_days: int = 7, limit: int = 100000, batch: int = 500) -> dict:
    stats = {"inserted": 0, "queued_fetch": 0, "skipped": 0}
    last_id = 0
    while stats["inserted"] + stats["skipped"] < limit:
        rows = db.fetch_all(
            """SELECT n.id, n.source_id, n.external_id, n.url, COALESCE(n.canonical_url, n.url) AS canonical_url,
                      n.original_title, n.original_summary, n.published_at, n.created_at, n.category,
                      (COALESCE(n.published_at, n.created_at) > now() - make_interval(days => %s)) AS recent
               FROM public.news_items n
               WHERE n.id > %s AND n.status IN ('published', 'needs_review')
               ORDER BY n.id LIMIT %s""",
            (fetch_days, last_id, batch),
        )
        if not rows:
            break
        with db.tx() as conn:
            for r in rows:
                last_id = r["id"]
                canon = canonical_url(r["canonical_url"] or r["url"])
                summary = clean_text(r["original_summary"] or "")
                title = clean_text(r["original_title"])
                text = f"{title}. {summary}"
                code, conf = langid.detect(text)
                stage = "new" if r["recent"] else "extracted"
                res = conn.execute(
                    """INSERT INTO kb.documents (source_id, external_id, url, canonical_url, title, feed_summary, lang,
                                                 lang_confidence, published_at, extraction_status, extraction_method, word_count,
                                                 content_sha256, title_sha256, simhash, stage, legacy_news_id, category,
                                                 category_method, meta)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'legacy', %s, %s, %s, %s, %s, %s, %s, 'legacy', '{}'::jsonb)
                       ON CONFLICT (canonical_url) DO UPDATE SET legacy_news_id = COALESCE(kb.documents.legacy_news_id, EXCLUDED.legacy_news_id)
                       RETURNING (xmax = 0) AS inserted""",
                    (
                        r["source_id"], r["external_id"], r["url"], canon, title, summary or None, code, conf,
                        r["published_at"] or r["created_at"], "pending" if stage == "new" else "teaser",
                        word_count(summary), sha256(fingerprint_text(text)), sha256(fingerprint_text(title)),
                        simhash64(text) if summary else None, stage, r["id"], r["category"],
                    ),
                ).fetchone()
                if res and res["inserted"]:
                    stats["inserted"] += 1
                    stats["queued_fetch"] += 1 if stage == "new" else 0
                else:
                    stats["skipped"] += 1
        log.info("backfill progress: %s (last id %s)", stats, last_id)
    return stats
