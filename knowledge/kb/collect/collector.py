"""Collector worker: polls feeds (RSS/Atom/JSON Feed) and extracts article text.

Two loops in one process:
  poll_due_sources()  - conditional GET of every due feed, new/changed entries -> kb.documents (stage 'new')
  extract_pending()   - fetch pages for stage 'new', extract text, fingerprint -> stage 'extracted'

Sources come from public.sources (the NestJS API seeds and discovers them); kb.source_profiles keeps the
polling state and the reliability tier used later for corroboration.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import yaml

from .. import db
from ..config import settings
from ..text import lang as langid
from ..text.normalize import canonical_url, clean_text, fingerprint_text, host_of, sha256, simhash64, word_count
from .extract import extract_url, strip_boilerplate, strip_html
from .http import fetch

log = logging.getLogger(__name__)

_TIERS_FILE = Path(__file__).resolve().parents[1] / "resources" / "source_tiers.yaml"


def _load_tiers() -> dict:
    try:
        return yaml.safe_load(_TIERS_FILE.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        return {}


def guess_tier(source: dict, tiers: dict) -> tuple[str, float, str | None]:
    """(tier, reliability, owner_group) from resources/source_tiers.yaml, then from source metadata."""
    slug = source["slug"]
    host = host_of(source.get("homepage_url") or "")
    by_slug = (tiers.get("slugs") or {}).get(slug)
    if by_slug:
        return by_slug.get("tier", "major"), float(by_slug.get("reliability", 0.7)), by_slug.get("owner_group")
    for domain, info in (tiers.get("domains") or {}).items():
        if host == domain or host.endswith("." + domain):
            return info.get("tier", "major"), float(info.get("reliability", 0.7)), info.get("owner_group")
    feed_url = source.get("feed_url") or ""
    if "github.com" in feed_url and feed_url.endswith(".atom"):
        return "primary", 0.9, None
    if source.get("unofficial"):
        return "aggregator", 0.5, None
    if source.get("provider_id"):
        return "primary", 0.85, None
    return "major", 0.65, None


def ensure_profiles() -> int:
    tiers = _load_tiers()
    rows = db.fetch_all(
        """SELECT s.id, s.slug, s.homepage_url, s.feed_url, s.unofficial, s.provider_id
           FROM public.sources s LEFT JOIN kb.source_profiles p ON p.source_id = s.id
           WHERE p.source_id IS NULL"""
    )
    for row in rows:
        tier, reliability, owner = guess_tier(row, tiers)
        db.execute(
            """INSERT INTO kb.source_profiles (source_id, tier, reliability, owner_group)
               VALUES (%s, %s, %s, %s) ON CONFLICT (source_id) DO NOTHING""",
            (row["id"], tier, reliability, owner or host_of(row.get("homepage_url") or "")),
        )
    return len(rows)


def _entry_time(entry: dict, key: str) -> datetime | None:
    parsed = entry.get(f"{key}_parsed")
    if parsed:
        try:
            return datetime(*parsed[:6], tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _entry_content(entry: dict) -> str:
    best = ""
    for block in entry.get("content") or []:
        value = strip_html(block.get("value"))
        if len(value) > len(best):
            best = value
    return best


def parse_feed(body: bytes) -> list[dict]:
    parsed = feedparser.parse(body)
    items: list[dict] = []
    for entry in parsed.entries[:100]:
        link = entry.get("link") or ""
        if not link.startswith("http"):
            continue
        title = clean_text(strip_html(entry.get("title")))
        if not title:
            continue
        items.append(
            {
                "url": link,
                "external_id": (entry.get("id") or link)[:500],
                "title": title[:1000],
                "summary": strip_html(entry.get("summary"))[:4000],
                "content": _entry_content(entry),
                "author": (entry.get("author") or None),
                "published_at": _entry_time(entry, "published") or _entry_time(entry, "updated"),
                "updated_at": _entry_time(entry, "updated"),
            }
        )
    return items


def poll_source(source: dict) -> dict:
    stats = {"new": 0, "changed": 0, "skipped_old": 0, "not_modified": 0, "error": 0}
    res = fetch(source["feed_url"], etag=source.get("etag"), last_modified=source.get("last_modified"))
    interval = int(source.get("poll_interval_s") or 600)
    if res.status == 304:
        stats["not_modified"] = 1
        db.execute(
            """UPDATE kb.source_profiles SET last_polled_at = now(), next_poll_at = now() + make_interval(secs => %s),
               consecutive_failures = 0 WHERE source_id = %s""",
            (interval, source["id"]),
        )
        return stats
    if not res.ok:
        stats["error"] = 1
        failures = int(source.get("consecutive_failures") or 0) + 1
        backoff = min(6 * 3600, interval * (2 ** min(failures, 6)))
        db.execute(
            """UPDATE kb.source_profiles SET last_polled_at = now(), next_poll_at = now() + make_interval(secs => %s),
               consecutive_failures = %s, last_error = %s WHERE source_id = %s""",
            (backoff, failures, (res.error or f"HTTP {res.status}")[:300], source["id"]),
        )
        return stats
    entries = parse_feed(res.body)
    cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.max_article_age_h)
    with db.tx() as conn:
        for item in entries:
            if item["published_at"] and item["published_at"] < cutoff:
                stats["skipped_old"] += 1
                continue
            canon = canonical_url(item["url"])
            feed_text = item["content"] if word_count(item["content"]) > word_count(item["summary"]) else ""
            existing = conn.execute(
                "SELECT id, title, feed_updated_at, published_at FROM kb.documents WHERE canonical_url = %s", (canon,)
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO kb.documents (source_id, kind, external_id, url, canonical_url, title, feed_summary,
                                                 author, published_at, feed_updated_at, meta)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                       ON CONFLICT (canonical_url) DO NOTHING""",
                    (
                        source["id"],
                        "release" if "github.com" in source["feed_url"] else ("press_release" if source.get("tier") == "primary" else "news"),
                        item["external_id"],
                        item["url"],
                        canon,
                        item["title"],
                        item["summary"] or None,
                        item["author"],
                        item["published_at"],
                        item["updated_at"],
                        db.jsonb({"feed_text": feed_text[:60000]} if feed_text else {}),
                    ),
                )
                stats["new"] += 1
                continue
            # Known URL: the publisher changed the headline or bumped <updated>. Re-extract inside the recheck window.
            changed_title = clean_text(existing["title"]) != item["title"]
            bumped = item["updated_at"] and existing["feed_updated_at"] and item["updated_at"] > existing["feed_updated_at"]
            published = existing["published_at"] or item["published_at"]
            fresh = published is None or published > datetime.now(timezone.utc) - timedelta(hours=settings.recheck_window_h)
            if (changed_title or bumped) and fresh:
                conn.execute(
                    """UPDATE kb.documents SET feed_updated_at = %s, stage = 'new', stage_attempts = 0, locked_until = NULL,
                              meta = meta || jsonb_build_object('recheck', true, 'new_title', %s::text, 'feed_text', %s::text),
                              feed_summary = COALESCE(%s, feed_summary), updated_at = now()
                       WHERE id = %s AND stage IN ('clustered', 'error')
                         AND (locked_until IS NULL OR locked_until < now())""",
                    (item["updated_at"], item["title"], feed_text[:60000], item["summary"] or None, existing["id"]),
                )
                stats["changed"] += 1
        # Adaptive cadence: busy feeds every 5 min, quiet ones up to every 2 h.
        new_interval = 300 if stats["new"] >= 5 else (600 if stats["new"] >= 1 else min(7200, int(interval * 1.5)))
        conn.execute(
            """UPDATE kb.source_profiles SET last_polled_at = now(), last_ok_at = now(), consecutive_failures = 0,
                      last_error = NULL, etag = %s, last_modified = %s, poll_interval_s = %s,
                      next_poll_at = now() + make_interval(secs => %s), updated_at = now()
               WHERE source_id = %s""",
            (res.headers.get("etag"), res.headers.get("last-modified"), new_interval, new_interval, source["id"]),
        )
    return stats


def poll_due_sources(limit: int = 200) -> dict:
    ensure_profiles()
    sources = db.fetch_all(
        """SELECT s.id, s.slug, s.feed_url, p.tier, p.etag, p.last_modified, p.poll_interval_s, p.consecutive_failures
           FROM public.sources s JOIN kb.source_profiles p ON p.source_id = s.id
           WHERE s.enabled AND s.feed_url LIKE 'http%%' AND p.next_poll_at <= now()
             AND COALESCE(s.review_status, 'approved') = 'approved'
           ORDER BY p.next_poll_at LIMIT %s""",
        (limit,),
    )
    total = {"sources": len(sources), "new": 0, "changed": 0, "error": 0, "not_modified": 0, "skipped_old": 0}
    if not sources:
        return total
    with ThreadPoolExecutor(max_workers=settings.collector_concurrency) as pool:
        for stats in pool.map(_safe_poll, sources):
            for key, value in stats.items():
                total[key] = total.get(key, 0) + value
    return total


def _safe_poll(source: dict) -> dict:
    try:
        return poll_source(source)
    except Exception as exc:  # one broken feed must not stop the others
        log.warning("feed %s failed: %s", source.get("slug"), exc)
        return {"error": 1}


_BOILERPLATE: dict[str, tuple[float, set[str]]] = {}


def _boilerplate_for(source_id) -> set[str]:
    """Paragraph hashes that repeat across many articles of this source (learned by maintain.learn_boilerplate)."""
    if not source_id:
        return set()
    key = str(source_id)
    cached = _BOILERPLATE.get(key)
    if cached and time.time() - cached[0] < 1800:
        return cached[1]
    rows = db.fetch_all("SELECT para_hash FROM kb.source_boilerplate WHERE source_id = %s AND doc_count >= 4", (source_id,))
    hashes = {r["para_hash"] for r in rows}
    _BOILERPLATE[key] = (time.time(), hashes)
    return hashes


def _extract_one(doc: dict) -> str:
    meta = doc.get("meta") or {}
    feed_text = meta.get("feed_text") or ""
    profile = db.fetch_one("SELECT fetch_full_text FROM kb.source_profiles WHERE source_id = %s", (doc["source_id"],)) if doc.get("source_id") else None
    if profile is not None and not profile["fetch_full_text"]:
        from .extract import Extraction

        ext = Extraction("teaser" if word_count(feed_text) < 80 else "partial", "feed_content", feed_text)
    else:
        ext = extract_url(doc["url"], feed_text)
    body = strip_boilerplate(clean_text(ext.body), _boilerplate_for(doc.get("source_id")))[: settings.max_body_chars]
    title = (meta.get("new_title") or doc["title"]).strip()
    analysis_text = body if word_count(body) >= word_count(doc.get("feed_summary") or "") else (doc.get("feed_summary") or "")
    lang_code, lang_conf = langid.detect(f"{title}. {analysis_text[:1500]}")
    content_hash = sha256(fingerprint_text(analysis_text)) if analysis_text else None
    with db.tx() as conn:
        db.check_lease(conn, doc)
        if meta.get("recheck") and doc.get("content_sha256") and content_hash and content_hash != doc["content_sha256"]:
            # Keep the previous version for change tracking; graph/changes.py computes the diff.
            conn.execute(
                """INSERT INTO kb.document_versions (document_id, content_sha256, title, body)
                   VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING""",
                (doc["id"], doc["content_sha256"], doc["title"], doc.get("body")),
            )
        conn.execute(
            """UPDATE kb.documents SET
                 title = %s, body = %s, lang = %s, lang_confidence = %s, author = COALESCE(author, %s),
                 extraction_status = %s, extraction_method = %s, word_count = %s,
                 content_sha256 = %s, title_sha256 = %s, simhash = %s,
                 quality_flags = %s, meta = (meta - 'feed_text' - 'recheck' - 'new_title') || %s::jsonb,
                 stage = 'extracted', locked_until = NULL, lease_token = NULL, stage_attempts = 0, last_error = NULL,
                 updated_at = now()
               WHERE id = %s""",
            (
                title,
                body or None,
                lang_code,
                lang_conf,
                ext.author,
                ext.status,
                ext.method,
                word_count(body),
                content_hash,
                sha256(fingerprint_text(title)),
                simhash64(f"{title} {analysis_text}") if analysis_text else None,
                ext.flags,
                db.jsonb({"final_url": ext.final_url, "http_status": ext.http_status, "was_recheck": bool(meta.get("recheck"))}),
                doc["id"],
            ),
        )
        if doc.get("source_id"):
            conn.execute(
                """UPDATE kb.source_profiles SET docs_total = docs_total + 1,
                          teaser_ratio = teaser_ratio * 0.95 + %s * 0.05
                   WHERE source_id = %s""",
                (1.0 if ext.status in ("teaser", "blocked") else 0.0, doc["source_id"]),
            )
    return ext.status


def extract_pending(limit: int = 40) -> dict:
    docs = db.claim_documents("new", limit, lease_s=900)
    stats: dict[str, int] = {"claimed": len(docs)}
    if not docs:
        return stats

    def run(doc: dict) -> str:
        try:
            db.renew_lease(doc, 900)
            return _extract_one(doc)
        except db.LeaseLost:
            return "lease_lost"
        except Exception as exc:
            log.warning("extract %s failed: %s", doc["id"], exc)
            db.fail_document(doc, f"extract: {exc}")
            return "error"

    with ThreadPoolExecutor(max_workers=settings.collector_concurrency) as pool:
        for status in pool.map(run, docs):
            stats[status] = stats.get(status, 0) + 1
    return stats


def run_forever() -> None:
    log.info("collector started")
    while True:
        with db.RunRecorder("collector") as run:
            polled = poll_due_sources()
            extracted = extract_pending()
            for k, v in polled.items():
                run.add(f"poll_{k}", v)
            for k, v in extracted.items():
                run.add(f"extract_{k}", v)
        busy = polled.get("sources", 0) or extracted.get("claimed", 0)
        if not busy:
            time.sleep(settings.collector_idle_s)
