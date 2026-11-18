"""Source responses and exact retrieval provenance. API secrets never enter request keys or stored URLs."""
from __future__ import annotations

import hashlib
import gzip
import json
from contextlib import contextmanager
from contextvars import ContextVar
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .. import db

_provider = ContextVar("data_provider", default=None)
_snapshots = ContextVar("data_snapshots", default=())
_SECRET = {"key", "api_key", "apikey", "token", "access_token", "api_token", "password", "secret", "auth", "authorization"}


def safe_request(url: str, params: dict | None = None) -> str:
    parsed = urlsplit(url)
    pairs = parse_qsl(parsed.query, keep_blank_values=True) + [(str(k), str(v)) for k, v in (params or {}).items()]
    clean = sorted((k, v) for k, v in pairs if k.lower() not in _SECRET and not any(s in k.lower() for s in ("password", "token", "secret", "api_key")))
    host = parsed.hostname or ""
    if parsed.port:
        host += f":{parsed.port}"
    return urlunsplit((parsed.scheme, host, parsed.path, urlencode(clean), ""))


@contextmanager
def collection_scope(provider: str):
    token = _provider.set(provider)
    snapshots = _snapshots.set(())
    try:
        yield
    finally:
        _provider.reset(token)
        _snapshots.reset(snapshots)


def begin_series() -> None:
    _snapshots.set(())


def snapshot_ids() -> tuple[int, ...]:
    return _snapshots.get()


def capture(url: str, params: dict | None, raw: bytes, content_type: str = '') -> int | None:
    provider = _provider.get()
    if not provider:
        return None
    # Keep original response bytes, including CSV/XML/binary data; JSON also remains queryable without float loss.
    payload = None
    try:
        text = raw.decode('utf-8-sig')
        json.loads(text)
        payload = text
    except (UnicodeDecodeError, ValueError):
        pass
    request = safe_request(url, params)
    row = db.fetch_one(
        """INSERT INTO kb.data_snapshots (provider, request_key, source_url, payload_hash, payload, body_gzip, content_type)
           VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s)
           ON CONFLICT (provider, request_key, payload_hash) DO UPDATE SET last_seen = clock_timestamp()
           RETURNING id""",
        (provider, hashlib.sha256(request.encode()).hexdigest(), request, hashlib.sha256(raw).hexdigest(), payload, gzip.compress(raw, mtime=0), content_type),
    )
    sid = int(row["id"])
    _snapshots.set((*_snapshots.get(), sid))
    return sid
