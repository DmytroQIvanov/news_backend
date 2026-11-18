"""NLP worker: stage 'extracted' -> 'analyzed' -> 'clustered'.

Per document, all without an LLM:
  dedupe (sha256 / title hash / SimHash)  ->  sentences + NER + parse (spaCy)  ->  dictionary + NER entity linking
  ->  keywords (YAKE)  ->  embedding (fastembed)  ->  category (rules -> model -> embedding)  ->  claims (rules over parse)
  ->  persist  ->  event clustering  ->  facts + contradictions  ->  event scores / editorial state
"""
from __future__ import annotations

import logging
import threading
import time
from collections import Counter
from dataclasses import dataclass

from .. import db
from ..collect.collector import _boilerplate_for
from ..collect.extract import strip_boilerplate
from ..config import settings
from ..graph import clustering, facts, importance
from ..text.keywords import keywords as extract_keywords
from ..text.normalize import hamming64, word_count
from . import embed as emb
from . import attribution
from .categorize import categorize
from .gazetteer import GAZETTEER
from .linker import ENTITY_INFO, link, salience
from .ner import parse
from .relations import extract_claims

log = logging.getLogger(__name__)


class SimhashCache:
    """Recent SimHashes kept in memory: near-duplicate checks without a table scan per document."""

    def __init__(self, days: int = 7):
        self.days = days
        self.items: dict[int, tuple[int, str | None]] = {}
        self.last_id = 0
        self.loaded_at = 0.0
        self._lock = threading.Lock()

    def refresh(self) -> None:
        rows = db.fetch_all(
            """SELECT id, simhash, source_id::text AS source_id FROM kb.documents
               WHERE simhash IS NOT NULL AND id > %s AND word_count >= 80 AND duplicate_of IS NULL
                 AND COALESCE(published_at, created_at) > now() - make_interval(days => %s)
               ORDER BY id""",
            (self.last_id, self.days),
        )
        with self._lock:
            for r in rows:
                self.items[r["id"]] = (r["simhash"], r["source_id"])
                self.last_id = max(self.last_id, r["id"])
            if time.time() - self.loaded_at > 3600:
                # drop old ids occasionally (cheap approximation of the time window)
                if len(self.items) > 200_000:
                    for k in sorted(self.items)[: len(self.items) - 150_000]:
                        self.items.pop(k, None)
                self.loaded_at = time.time()

    def nearest(self, doc_id: int, value: int, max_distance: int = 3) -> int | None:
        best, best_d = None, max_distance + 1
        with self._lock:
            for other_id, (h, _src) in self.items.items():
                if other_id >= doc_id:
                    continue
                d = hamming64(value, h)
                if d < best_d:
                    best, best_d = other_id, d
        return best


SIMHASHES = SimhashCache()


@dataclass
class DupVerdict:
    duplicate_of: int | None = None
    kind: str | None = None
    same_source: bool = False


def find_duplicate(doc: dict) -> DupVerdict:
    if doc.get("content_sha256") and doc.get("word_count", 0) >= 40:
        row = db.fetch_one(
            """SELECT id, source_id FROM kb.documents
               WHERE content_sha256 = %s AND id < %s AND duplicate_of IS NULL ORDER BY id LIMIT 1""",
            (doc["content_sha256"], doc["id"]),
        )
        if row:
            return DupVerdict(row["id"], "exact" if row["source_id"] == doc["source_id"] else "reprint", row["source_id"] == doc["source_id"])
    if doc.get("title_sha256") and doc.get("source_id"):
        row = db.fetch_one(
            """SELECT id FROM kb.documents
               WHERE title_sha256 = %s AND source_id = %s AND id < %s AND duplicate_of IS NULL
                 AND COALESCE(published_at, created_at) > now() - interval '3 days' ORDER BY id LIMIT 1""",
            (doc["title_sha256"], doc["source_id"], doc["id"]),
        )
        if row:
            return DupVerdict(row["id"], "exact", True)
    if doc.get("simhash") is not None and doc.get("word_count", 0) >= 80:
        other = SIMHASHES.nearest(doc["id"], doc["simhash"])
        if other:
            row = db.fetch_one("SELECT source_id FROM kb.documents WHERE id = %s", (other,))
            same = bool(row and row["source_id"] == doc["source_id"])
            return DupVerdict(other, "near" if same else "reprint", same)
    return DupVerdict()


def _source_info(source_id) -> dict:
    if not source_id:
        return {}
    return db.fetch_one(
        """SELECT s.category, p.tier, p.reliability, p.owner_group
           FROM public.sources s LEFT JOIN kb.source_profiles p ON p.source_id = s.id WHERE s.id = %s""",
        (source_id,),
    ) or {}


def analyze(doc: dict) -> dict:
    """Pure-ish analysis of one document (reads dictionaries, writes nothing). Returns everything to persist."""
    title = doc["title"].strip()
    body = (doc.get("body") or "").strip()
    if word_count(body) < word_count(doc.get("feed_summary") or ""):
        body = (doc.get("feed_summary") or "").strip()
    body = strip_boilerplate(body, _boilerplate_for(doc.get("source_id")))
    text = f"{title}\n\n{body}" if body else title
    lang = doc.get("lang") or "en"
    parsed = parse(text[: settings.max_body_chars], lang)
    mentions = link(text, len(title), parsed)
    sal = salience(mentions, len(parsed.sentences))
    kws = extract_keywords(title, body, lang)
    vec = None
    if settings.embeddings:
        vectors = emb.embed([emb.embedding_text(title, body, doc.get("feed_summary"))])
        vec = vectors[0] if vectors else None
    entity_ids = list(sal)
    priors = []
    if entity_ids:
        rows = db.fetch_all("SELECT id, category_prior FROM kb.entities WHERE id = ANY(%s)", (entity_ids,))
        prior_by_id = {r["id"]: r["category_prior"] for r in rows if r["category_prior"]}
        priors = [(prior_by_id[e], sal[e][1]) for e in entity_ids if e in prior_by_id]
    src = _source_info(doc.get("source_id"))
    cat = categorize(title, body, priors, src.get("category"), vec)
    claims = extract_claims(parsed, mentions, lang, doc.get("published_at"), ENTITY_INFO.kind)
    own = src.get("owner_group") or (str(doc["source_id"]) if doc.get("source_id") else None)
    root = attribution.document_root(title, body, own)
    roots = [attribution.sentence_root(c.sentence, root, own) for c in claims]
    return {"parsed": parsed, "mentions": mentions, "salience": sal, "keywords": kws, "vector": vec,
            "category": cat, "claims": claims, "claim_roots": roots, "source": src, "lang": lang, "evidence_root": root}


def _quality(doc: dict, analysis: dict) -> tuple[float, list[str]]:
    flags = list(doc.get("quality_flags") or [])
    status = doc.get("extraction_status")
    q = {"full": 1.0, "partial": 0.6, "teaser": 0.3, "blocked": 0.25, "failed": 0.2}.get(status, 0.3)
    if not analysis["salience"]:
        q -= 0.15
        flags.append("no_entities")
    if analysis["category"].uncertain:
        flags.append("category_uncertain")
    if status in ("teaser", "blocked", "failed"):
        flags.append("teaser_only")
    q *= 0.6 + 0.4 * float(analysis["source"].get("reliability") or 0.6)
    return round(max(0.0, min(1.0, q)), 3), sorted(set(flags))


def persist(doc: dict, analysis: dict, dup: DupVerdict) -> None:
    cat = analysis["category"]
    quality, flags = _quality(doc, analysis)
    with db.tx() as conn:
        db.check_lease(conn, doc)
        conn.execute("DELETE FROM kb.mentions WHERE document_id = %s", (doc["id"],))
        conn.execute("DELETE FROM kb.document_entities WHERE document_id = %s", (doc["id"],))
        conn.execute("DELETE FROM kb.claims WHERE document_id = %s", (doc["id"],))
        mention_rows = [
            (doc["id"], m.entity_id, m.surface[:300], m.key[:300], m.label, m.sentence_idx, m.start, m.end, m.in_title,
             m.method, m.confidence)
            for m in analysis["mentions"]
        ]
        if mention_rows:
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO kb.mentions (document_id, entity_id, surface, surface_key, label, sentence_idx,
                                                char_start, char_end, in_title, method, link_confidence)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    mention_rows,
                )
        de_rows = [(doc["id"], eid, n, s, t) for eid, (n, s, t) in analysis["salience"].items()]
        if de_rows:
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO kb.document_entities (document_id, entity_id, mentions, salience, in_title) VALUES (%s, %s, %s, %s, %s)",
                    de_rows,
                )
        # Unlinked names -> candidates (aggregated across documents and sources).
        unlinked: dict[str, tuple[str, str | None]] = {}
        for m in analysis["mentions"]:
            if not m.entity_id and m.label in ("person", "organization", "place", "product", "group", "facility", "event", "law", "other"):
                unlinked.setdefault(m.key, (m.surface, m.label))
        # Exact doc/source counts are recomputed from kb.mentions by maintain.refresh_candidates().
        for key, (surface, label) in unlinked.items():
            conn.execute(
                """INSERT INTO kb.entity_candidates (surface_key, surface, label, mention_count, doc_count, sample_document_ids)
                   VALUES (%s, %s, %s, 1, 1, ARRAY[%s]::bigint[])
                   ON CONFLICT (surface_key) DO UPDATE SET
                     mention_count = kb.entity_candidates.mention_count + 1,
                     sample_document_ids = (kb.entity_candidates.sample_document_ids || EXCLUDED.sample_document_ids)[1:10],
                     label = COALESCE(kb.entity_candidates.label, EXCLUDED.label),
                     last_seen = now(), updated_at = now()""",
                (key[:300], surface[:300], label, doc["id"]),
            )
        for c, root in zip(analysis["claims"], analysis["claim_roots"]):
            conn.execute(
                """INSERT INTO kb.claims (document_id, sentence_idx, sentence, subject_entity_id, subject_text, predicate,
                                          object_entity_id, object_text, value_num, value_unit, time_text, time_start, time_end,
                                          modality, negated, attributed_to_entity_id, confidence, extractor, evidence_root)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    doc["id"], c.sentence_idx, c.sentence[:2000],
                    c.subject.entity_id if c.subject else None, c.subject.surface[:300] if c.subject else None,
                    c.predicate,
                    c.obj.entity_id if c.obj else None, (c.obj.surface if c.obj else c.object_text or "")[:2000] or None,
                    c.value_num, c.value_unit, c.time_text, c.time_start, c.time_end,
                    c.modality, c.negated, c.attributed_to.entity_id if c.attributed_to else None,
                    c.confidence, c.extractor, root,
                ),
            )
        if analysis["vector"] is not None and db.features()["vector"]:
            conn.execute(
                """INSERT INTO kb.document_embeddings (document_id, model, embedding) VALUES (%s, %s, %s::vector)
                   ON CONFLICT (document_id) DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, created_at = now()""",
                (doc["id"], settings.embed_model[:80], emb.to_pg(analysis["vector"])),
            )
        conn.execute(
            """UPDATE kb.documents SET category = %s, category_confidence = %s, category_method = %s, category_scores = %s::jsonb,
                      keywords = %s, quality_score = %s, quality_flags = %s, duplicate_of = %s, duplicate_kind = %s,
                      analyzed_at = now(), stage = %s, stage_attempts = 0, last_error = NULL, updated_at = now(),
                      analyzer_version = %s, evidence_root = %s,
                      lease_token = CASE WHEN %s = 'ignored' THEN NULL ELSE lease_token END
               WHERE id = %s""",
            (
                cat.category, cat.confidence, cat.method, db.jsonb(cat.scores), analysis["keywords"], quality, flags,
                dup.duplicate_of, dup.kind, "ignored" if dup.same_source else "analyzed", ANALYZER_VERSION,
                analysis.get("evidence_root"), "ignored" if dup.same_source else "analyzed", doc["id"],
            ),
        )


def process_document(doc: dict) -> str:
    if doc.get("kind") == "research":
        # Background pages found for a flagship (kb.event_research): analyzed for entities and claims, but they never
        # form or join events and never count as independent confirmation.
        analysis = analyze(doc)
        persist(doc, analysis, DupVerdict())
        with db.tx() as conn:
            db.check_lease(conn, doc)
            db.release(conn, doc, "clustered")
        return "research"
    dup = find_duplicate(doc)
    if dup.same_source and dup.kind == "exact":
        with db.tx() as conn:
            db.check_lease(conn, doc)
            conn.execute(
                """UPDATE kb.documents SET duplicate_of = %s, duplicate_kind = 'exact', analyzed_at = now() WHERE id = %s""",
                (dup.duplicate_of, doc["id"]),
            )
            db.release(conn, doc, "ignored")
        return "duplicate"
    analysis = analyze(doc)
    old_facts = [r["fact_id"] for r in db.fetch_all(
        "SELECT DISTINCT fact_id FROM kb.claims WHERE document_id = %s AND fact_id IS NOT NULL", (doc["id"],))]
    persist(doc, analysis, dup)
    if dup.same_source:
        return "near_duplicate"
    doc = dict(doc, duplicate_of=dup.duplicate_of, duplicate_kind=dup.kind)
    # Clustering and fact aggregation are serialized across nlp replicas: two workers must not both decide
    # "no matching event" for the same story, or miss each other's contradicting facts.
    with db.advisory_lock(CLUSTER_LOCK):
        event_id = clustering.assign(doc, analysis)
        facts.aggregate_document(doc["id"], event_id)
        facts.reconcile(old_facts)
    importance.refresh_event(event_id)
    # 'clustered' only after every step succeeded; a crash before this point leaves the row resumable ('analyzed').
    with db.tx() as conn:
        db.check_lease(conn, doc)
        db.release(conn, doc, "clustered")
    return "clustered"


CLUSTER_LOCK = 7_311_001
# Bump when extraction logic changes materially: maintain.requeue_outdated() re-analyzes recent documents.
ANALYZER_VERSION = 2


def _event_types(claims) -> str | None:
    counts = Counter(c.event_type for c in claims if c.event_type not in ("statement", "announcement"))
    return counts.most_common(1)[0][0] if counts else None


def run_batch(limit: int | None = None) -> dict:
    GAZETTEER.refresh_if_stale()
    ENTITY_INFO.refresh_if_stale()
    SIMHASHES.refresh()
    docs = db.claim_documents(["extracted", "analyzed"], limit or settings.nlp_batch, lease_s=900)
    stats: Counter = Counter(claimed=len(docs))
    for doc in docs:
        try:
            db.renew_lease(doc, 900)
            stats[process_document(doc)] += 1
        except db.LeaseLost:
            stats["lease_lost"] += 1
        except Exception as exc:
            log.exception("analysis of document %s failed", doc["id"])
            db.fail_document(doc, f"nlp: {exc}")
            stats["error"] += 1
    return dict(stats)


def run_forever() -> None:
    log.info("nlp worker started")
    while True:
        with db.RunRecorder("nlp") as run:
            stats = run_batch()
            for k, v in stats.items():
                run.add(k, v)
        if not stats.get("claimed"):
            time.sleep(settings.nlp_idle_s)
