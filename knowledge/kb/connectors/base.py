"""Open-data connector framework (task 3).

A connector is a small class with a schedule and a cursor. `run()` fetches what is new since the cursor and writes it
through the helpers below, so every connector stores data the same way:

  upsert_series / upsert_observations  statistics with vintages (a revised value keeps the previous one)
  upsert_record / link_record_entity   structured records (sanctions, conflict events, contracts, filings ...)
  add_document                         texts for the NLP pipeline (kind 'filing', 'official_statement', 'paper' ...)
  add_fact                             a fact stated by a registry, with confirmed status (tier 'data')
  entity_by_identifier / entity_by_name   linking to kb.entities through kb.entity_identifiers / aliases

The scheduler (`run_due`) is called by the connectors worker; connectors are independent, one failing never stops
the others, and each has exponential back-off. All HTTP goes through kb.collect.http (polite per-host delays,
honest User-Agent with the contact address when CONTACT_EMAIL is set).
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timezone
from typing import Any, Iterable

from .. import db
from ..config import settings
from ..text.normalize import canonical_url
from ..text.stem import term_key

log = logging.getLogger(__name__)

REGISTRY: dict[str, type["Connector"]] = {}


def register(cls: type["Connector"]) -> type["Connector"]:
    REGISTRY[cls.name] = cls
    return cls


class ConnectorSkipped(Exception):
    """Raised when a connector cannot run (missing API key, disabled by config); not counted as a failure."""


class Connector:
    name: str = "base"
    interval_s: int = 6 * 3600
    #: env var that must be set for the connector to run (API key), or None
    requires_env: str | None = None

    def __init__(self) -> None:
        self.stats: dict[str, Any] = {}

    def add(self, key: str, n: int = 1) -> None:
        self.stats[key] = self.stats.get(key, 0) + n

    def run(self, cursor: dict) -> dict:
        """Fetch new data since `cursor`, store it, return the new cursor."""
        raise NotImplementedError


# ---------------------------------------------------------------------------------------------- storage helpers --

ISO2_TO_ISO3: dict[str, str] = {}


def _iso_maps() -> dict[str, str]:
    if not ISO2_TO_ISO3:
        import pycountry  # type: ignore

        for c in pycountry.countries:
            ISO2_TO_ISO3[c.alpha_2] = c.alpha_3
        ISO2_TO_ISO3.update({"XK": "XKX", "EL": "GRC", "UK": "GBR", "EU": "EUU"})
    return ISO2_TO_ISO3


def iso3(code: str | None) -> str | None:
    if not code:
        return None
    code = code.strip().upper()
    if len(code) == 3:
        return code
    return _iso_maps().get(code)


def entity_by_identifier(scheme: str, value: str) -> int | None:
    row = db.fetch_one(
        """SELECT i.entity_id FROM kb.entity_identifiers i JOIN kb.entities e ON e.id = i.entity_id
           WHERE i.scheme = %s AND upper(i.value) = upper(%s) AND e.status = 'active' LIMIT 1""",
        (scheme, value),
    )
    return row["entity_id"] if row else None


def country_entity(code: str | None) -> int | None:
    """Country entity by ISO code (alpha-2 or alpha-3), via identifiers or the country attribute of seeds."""
    if not code:
        return None
    code3 = iso3(code)
    for scheme, value in (("iso3166_3", code3), ("iso3166", code.upper() if len(code) == 2 else None)):
        if value:
            eid = entity_by_identifier(scheme, value)
            if eid:
                return eid
    import pycountry
    country = pycountry.countries.get(alpha_3=code3) if code3 else None
    if country:
        # A city has the same country attribute; never promote the most-mentioned city to a country.
        names = {country.name, getattr(country, 'official_name', country.name), getattr(country, 'common_name', country.name)}
        found = {eid for name in names if (eid := entity_by_name(name, ['place'])) is not None}
        if len(found) == 1:
            eid = found.pop()
            db.execute("INSERT INTO kb.entity_identifiers(entity_id,scheme,value) VALUES(%s,'iso3166_3',%s) ON CONFLICT DO NOTHING", (eid,code3))
            return eid
    return None


def entity_by_name(name: str, kinds: Iterable[str] | None = None) -> int | None:
    key = term_key(name)
    if not key:
        return None
    rows = db.fetch_all(
        """SELECT e.id, e.kind FROM kb.entity_aliases a JOIN kb.entities e ON e.id = a.entity_id
           WHERE a.alias_key = %s AND e.status = 'active' AND NOT a.ambiguous ORDER BY e.mention_count DESC LIMIT 5""",
        (key,),
    )
    allowed = set(kinds or [])
    candidates = {r['id'] for r in rows if not allowed or r['kind'] in allowed}
    return next(iter(candidates)) if len(candidates) == 1 else None


def ensure_entity(name: str, kind: str, identifiers: dict[str, str] | None = None, country: str | None = None,
                  origin: str = "dataset") -> int:
    """Find by identifier, then by exact name; otherwise create a dataset entity (e.g. a sanctioned company)."""
    for scheme, value in (identifiers or {}).items():
        if value:
            eid = entity_by_identifier(scheme, value)
            if eid:
                return eid
    eid = entity_by_name(name, [kind] if kind else None)
    if eid is None:
        with db.tx() as conn:
            eid = conn.execute(
                "INSERT INTO kb.entities (kind, name, country, origin) VALUES (%s, %s, %s, %s) RETURNING id",
                (kind, name[:300], country, origin),
            ).fetchone()["id"]
            from ..entities import add_alias

            add_alias(conn, eid, name, None, origin)
    for scheme, value in (identifiers or {}).items():
        if value:
            db.execute("INSERT INTO kb.entity_identifiers (entity_id, scheme, value) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                       (eid, scheme, str(value)[:200]))
    return eid


def upsert_series(provider: str, code: str, title: str, frequency: str, *, unit: str | None = None, geo: str | None = None,
                  title_uk: str | None = None, categories: list[str] | None = None, keywords: list[str] | None = None,
                  source_url: str | None = None, license: str | None = None, entity_id: int | None = None) -> int:
    geo3 = iso3(geo) if geo else None
    if entity_id is None and geo3 and geo3 not in ("WLD", "EUU", "EMU", "EAR", "EA"):
        entity_id = country_entity(geo3)
    row = db.fetch_one(
        """INSERT INTO kb.series (provider, provider_code, title, title_uk, unit, frequency, geo, entity_id, categories, keywords,
                                   source_url, license)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
           ON CONFLICT (provider, provider_code) DO UPDATE SET title = EXCLUDED.title,
             title_uk = COALESCE(EXCLUDED.title_uk, kb.series.title_uk), unit = COALESCE(EXCLUDED.unit, kb.series.unit),
             entity_id = COALESCE(kb.series.entity_id, EXCLUDED.entity_id), categories = EXCLUDED.categories,
             keywords = EXCLUDED.keywords, source_url = COALESCE(EXCLUDED.source_url, kb.series.source_url), updated_at = now()
           RETURNING id""",
        (provider, code[:300], title[:500], title_uk, unit, frequency, geo3, entity_id, categories or [], keywords or [],
         source_url, license),
    )
    series_id = row["id"]
    if entity_id is not None:
        db.execute("INSERT INTO kb.series_entities (series_id, entity_id, role, origin) VALUES (%s, %s, 'subject', 'catalog') ON CONFLICT DO NOTHING",
                   (series_id, entity_id))
    publishers = {"nbu": "National Bank of Ukraine", "ecb": "European Central Bank", "fred": "Federal Reserve"}
    if provider in publishers:
        issuer = entity_by_name(publishers[provider], ["government", "organization"])
        if issuer is not None:
            db.execute("INSERT INTO kb.series_entities (series_id, entity_id, role, origin) VALUES (%s, %s, 'publisher', 'catalog') ON CONFLICT DO NOTHING",
                       (series_id, issuer))
    from .provenance import begin_series
    begin_series()
    return series_id


def period_start(period: str) -> date:
    p = period.strip()
    if len(p) == 4:
        return date(int(p), 1, 1)
    if "-Q" in p or "Q" in p[4:]:
        y, q = p.replace("-", "").split("Q")
        return date(int(y), (int(q) - 1) * 3 + 1, 1)
    if len(p) == 7 and p[4] in "-M":
        return date(int(p[:4]), int(p[5:7]), 1)
    return date.fromisoformat(p[:10])


def upsert_observations(series_id: int, rows: Iterable[tuple[str, float | None, str | None]]) -> dict:
    """rows: (period, value, status). Returns counts {'new', 'revised'}."""
    out = {"new": 0, "revised": 0}
    from decimal import Decimal
    from .provenance import snapshot_ids
    snapshots = tuple(dict.fromkeys(snapshot_ids()))
    with db.tx() as conn:
        for period, value, status in rows:
            ps = period_start(period)
            if value is not None and not Decimal(str(value)).is_finite():
                raise ValueError("Observation must be finite")
            old = conn.execute("SELECT value, status FROM kb.observations WHERE series_id = %s AND period = %s FOR UPDATE",
                               (series_id, period)).fetchone()
            r = conn.execute(
                """INSERT INTO kb.observations (series_id, period, period_start, value, status, snapshot_id)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (series_id, period) DO UPDATE SET
                     previous_value = CASE WHEN kb.observations.value IS DISTINCT FROM EXCLUDED.value THEN kb.observations.value ELSE kb.observations.previous_value END,
                     revised_at = CASE WHEN kb.observations.value IS DISTINCT FROM EXCLUDED.value THEN now() ELSE kb.observations.revised_at END,
                     value = EXCLUDED.value, status = EXCLUDED.status, snapshot_id = COALESCE(EXCLUDED.snapshot_id, kb.observations.snapshot_id)
                   RETURNING (xmax = 0) AS inserted, revised_at""",
                (series_id, period, ps, value, status, snapshots[0] if len(snapshots) == 1 else None),
            ).fetchone()
            if r["inserted"]:
                out["new"] += 1
            elif old and (old["value"] != (Decimal(str(value)) if value is not None else None) or old["status"] != status):
                out["revised"] += 1
            if snapshots:
                conn.execute("""INSERT INTO kb.observation_version_sources(version_id, snapshot_id)
                                SELECT v.id, sid FROM kb.observation_versions v CROSS JOIN unnest(%s::bigint[]) sid
                                WHERE v.series_id = %s AND v.period = %s AND v.superseded_at IS NULL
                                ON CONFLICT DO NOTHING""", (list(snapshots), series_id, period))
        # Derive the cache from storage, not the downloaded batch: old backfills cannot move it backwards.
        conn.execute("""UPDATE kb.series SET last_period = latest.period, last_value = latest.value, updated_at = now()
                        FROM (SELECT period, value FROM kb.observations WHERE series_id = %s AND value IS NOT NULL
                              ORDER BY period_start DESC LIMIT 1) latest WHERE id = %s""", (series_id, series_id))
    return out


def upsert_record(provider: str, record_type: str, external_id: str, title: str, *, revision: str = "",
                  happened_on: date | None = None, geo: str | None = None, location: str | None = None,
                  latitude: float | None = None, longitude: float | None = None, amount: float | None = None,
                  currency: str | None = None, data: dict | None = None, url: str | None = None) -> tuple[int, bool]:
    from .provenance import snapshot_ids
    data = {**(data or {}), 'snapshot_ids': list(dict.fromkeys(snapshot_ids()))}
    row = db.fetch_one(
        """INSERT INTO kb.records (provider, record_type, external_id, revision, title, happened_on, geo, location, latitude,
                                    longitude, amount, currency, data, url)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
           ON CONFLICT (provider, external_id, revision) DO UPDATE SET title = EXCLUDED.title, data = EXCLUDED.data,
             amount = EXCLUDED.amount, currency = EXCLUDED.currency, happened_on = EXCLUDED.happened_on,
             url = EXCLUDED.url, geo = EXCLUDED.geo, location = EXCLUDED.location,
             latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, updated_at = now()
           RETURNING id, (xmax = 0) AS inserted""",
        (provider, record_type, external_id[:300], revision[:100], title[:1000], happened_on, iso3(geo) if geo else None,
         location, latitude, longitude, amount, currency, db.jsonb(data or {}), url),
    )
    return row["id"], bool(row["inserted"])


def link_record_entity(record_id: int, entity_id: int | None, role: str = "subject") -> None:
    if entity_id:
        db.execute("INSERT INTO kb.record_entities (record_id, entity_id, role) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                   (record_id, entity_id, role))


def source_id(slug: str) -> str | None:
    row = db.fetch_one("SELECT id::text AS id FROM public.sources WHERE slug = %s", (slug,))
    return row["id"] if row else None


def add_document(source_slug: str, kind: str, url: str, title: str, body: str | None = None, *,
                 published_at: datetime | None = None, meta: dict | None = None) -> int | None:
    """A text for the NLP pipeline. With a body it skips extraction (stage 'extracted'); without, the collector fetches it."""
    from ..text import lang as langid
    from ..text.normalize import clean_text, fingerprint_text, sha256, simhash64, word_count

    canon = canonical_url(url)
    sid = source_id(source_slug)
    if body:
        body = clean_text(body)[: settings.max_body_chars]
        code, conf = langid.detect(f"{title}. {body[:1500]}")
        row = db.fetch_one(
            """INSERT INTO kb.documents (source_id, kind, url, canonical_url, title, body, lang, lang_confidence, published_at,
                                          extraction_status, extraction_method, word_count, content_sha256, title_sha256, simhash,
                                          stage, meta)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'full', 'api', %s, %s, %s, %s, 'extracted', %s::jsonb)
               ON CONFLICT (canonical_url) DO NOTHING RETURNING id""",
            (sid, kind, url, canon, title[:1000], body, code, conf, published_at, word_count(body),
             sha256(fingerprint_text(body)), sha256(fingerprint_text(title)), simhash64(f"{title} {body}"), db.jsonb(meta or {})),
        )
    else:
        row = db.fetch_one(
            """INSERT INTO kb.documents (source_id, kind, url, canonical_url, title, published_at, stage, meta)
               VALUES (%s, %s, %s, %s, %s, %s, 'new', %s::jsonb) ON CONFLICT (canonical_url) DO NOTHING RETURNING id""",
            (sid, kind, url, canon, title[:1000], published_at, db.jsonb(meta or {})),
        )
    return row["id"] if row else None


def add_fact(subject_id: int, predicate: str, object_id: int | None, *, valid_from: date | None = None,
             value: float | None = None, unit: str | None = None, object_text: str | None = None) -> int:
    """A fact asserted by a registry/dataset: status 'confirmed' (no NLP claim behind it)."""
    key = f"{object_id or ('t:' + term_key(object_text or '')[:80] if object_text else '')}"
    row = db.fetch_one(
        """INSERT INTO kb.facts (subject_entity_id, predicate, object_entity_id, object_key, object_text, value_num, value_unit,
                                  valid_from, status, primary_support, source_count, support_count)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'confirmed', true, 1, 1)
           ON CONFLICT (subject_entity_id, predicate, object_entity_id, object_key) DO UPDATE SET
             last_seen = now(), primary_support = true,
             status = CASE WHEN kb.facts.status IN ('single_source', 'corroborated') THEN 'confirmed' ELSE kb.facts.status END
           RETURNING id""",
        (subject_id, predicate, object_id, key, object_text, value, unit, valid_from),
    )
    return row["id"]


# ---------------------------------------------------------------------------------------------------- scheduler --

def run_due(only: str | None = None, force: bool = False) -> dict:
    import os

    from . import load_all

    load_all()
    out: dict[str, Any] = {}
    names = [only] if only else sorted(REGISTRY)
    for name in names:
        cls = REGISTRY.get(name)
        if cls is None:
            out[name] = "unknown connector"
            continue
        import zlib
        lock = db.try_advisory_lock(0x4B4200000000 + zlib.crc32(name.encode()))
        if lock is None:
            out[name] = 'running in another worker'
            continue
        with lock:
            st = db.fetch_one("SELECT * FROM kb.connector_state WHERE connector = %s", (name,))
            if st is None:
                db.execute("INSERT INTO kb.connector_state (connector) VALUES (%s) ON CONFLICT DO NOTHING", (name,))
                st = db.fetch_one("SELECT * FROM kb.connector_state WHERE connector = %s", (name,))
            if not st["enabled"] or os.environ.get(f"KB_CONNECTOR_{name.upper()}", "").lower() == "false":
                continue
            if not force and st["next_run_at"] > datetime.now(timezone.utc):
                continue
            conn = cls()
            t0 = time.time()
            try:
                if cls.requires_env and not os.environ.get(cls.requires_env):
                    raise ConnectorSkipped(f"set {cls.requires_env}")
                from .provenance import collection_scope
                with collection_scope(name):
                    cursor = conn.run(dict(st["cursor"] or {}))
                if conn.stats.get('errors', 0):
                    raise RuntimeError(f"Partial collection failure: {conn.stats['errors']} items; successful data retained, failed items will retry")
                db.execute(
                    """UPDATE kb.connector_state SET cursor = %s::jsonb, last_run_at = now(), last_ok_at = now(),
                              next_run_at = now() + make_interval(secs => %s), consecutive_failures = 0, last_error = NULL,
                              stats = %s::jsonb WHERE connector = %s""",
                    (db.jsonb(cursor), cls.interval_s, db.jsonb({**conn.stats, "seconds": round(time.time() - t0, 1)}), name),
                )
                out[name] = conn.stats
            except ConnectorSkipped as exc:
                db.execute("UPDATE kb.connector_state SET last_run_at = now(), next_run_at = now() + interval '1 day', last_error = %s WHERE connector = %s",
                           (str(exc), name))
                out[name] = f"skipped: {exc}"
            except Exception as exc:  # noqa: BLE001 - one connector must never stop the others
                log.exception("connector %s failed", name)
                fails = int(st["consecutive_failures"]) + 1
                backoff = min(24 * 3600, 600 * 2 ** min(fails, 7))
                db.execute(
                    """UPDATE kb.connector_state SET last_run_at = now(), consecutive_failures = %s, last_error = %s,
                              next_run_at = now() + make_interval(secs => %s) WHERE connector = %s""",
                    (fails, str(exc)[:500], backoff, name),
                )
                out[name] = f"error: {exc}"[:300]
    return out


# --------------------------------------------------------------------------------------------------------- http --

def get(url: str, params: dict | None = None, headers: dict | None = None, timeout: float = 60.0):
    """GET with the shared client and the per-host politeness delay. Raises on HTTP errors."""
    from ..collect.http import _wait_for_host, client
    from ..text.normalize import host_of

    _wait_for_host(host_of(url))
    import httpx
    try:
        resp = client().get(url, params=params, headers=headers or {}, timeout=timeout)
        resp.raise_for_status()
    except httpx.HTTPStatusError as exc:
        raise RuntimeError(f'HTTP {exc.response.status_code} from {host_of(url)}') from None
    except httpx.RequestError as exc:
        raise RuntimeError(f'{type(exc).__name__} from {host_of(url)}') from None
    from .provenance import capture
    capture(url, params, resp.content, resp.headers.get('content-type', ''))
    return resp


def get_json(url: str, params: dict | None = None, headers: dict | None = None, timeout: float = 60.0, *, precise: bool = False) -> Any:
    import json
    from decimal import Decimal
    response = get(url, params, {"Accept": "application/json", **(headers or {})}, timeout)
    return json.loads(response.text, parse_float=Decimal) if precise else response.json()
