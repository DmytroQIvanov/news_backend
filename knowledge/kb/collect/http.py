"""Polite HTTP: one shared client, per-host delay, robots.txt, size limits, conditional GET."""
from __future__ import annotations

import logging
import threading
import time
import urllib.robotparser
from dataclasses import dataclass

import httpx

from ..config import settings
from ..text.normalize import host_of

log = logging.getLogger(__name__)

_client: httpx.Client | None = None
_client_lock = threading.Lock()
_host_next: dict[str, float] = {}
_host_lock = threading.Lock()
_robots: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None]] = {}


def _assert_public(request: httpx.Request) -> None:
    """Runs for every request including each redirect hop: block private, loopback and link-local destinations (SSRF)."""
    import ipaddress
    import socket

    host = request.url.host
    if request.url.scheme not in ("http", "https"):
        raise httpx.UnsupportedProtocol(f"scheme {request.url.scheme} is not allowed")
    try:
        infos = socket.getaddrinfo(host, request.url.port or (443 if request.url.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return  # unresolvable: the request itself will fail
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise httpx.RequestError(f"blocked non-public address {ip} for {host}", request=request)


def client() -> httpx.Client:
    global _client
    with _client_lock:
        if _client is None:
            ua = settings.user_agent
            if settings.contact_email:
                ua = f"{ua} contact: {settings.contact_email}"
            _client = httpx.Client(
                timeout=httpx.Timeout(settings.fetch_timeout_s, connect=10.0),
                follow_redirects=True,
                event_hooks={"request": [_assert_public]},
                headers={"User-Agent": ua, "Accept-Language": "uk,en;q=0.8,de;q=0.5"},
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                http2=False,
            )
        return _client


def _wait_for_host(host: str) -> None:
    delay = settings.per_host_delay_s
    while True:
        with _host_lock:
            now = time.monotonic()
            ready_at = _host_next.get(host, 0.0)
            if now >= ready_at:
                _host_next[host] = now + delay
                return
            sleep_for = ready_at - now
        time.sleep(min(sleep_for, 5.0))


def robots_allowed(url: str) -> bool:
    host = host_of(url)
    cached = _robots.get(host)
    if cached is None or time.time() - cached[0] > 24 * 3600:
        parser: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
        try:
            resp = client().get(f"https://{host}/robots.txt", timeout=10.0)
            if resp.status_code >= 400:
                parser = None  # no robots.txt (or not readable) => allowed
            else:
                parser.parse(resp.text.splitlines())
        except Exception:
            parser = None
        _robots[host] = (time.time(), parser)
        cached = _robots[host]
    parser = cached[1]
    if parser is None:
        return True
    try:
        return parser.can_fetch(settings.user_agent.split("/")[0], url)
    except Exception:
        return True


@dataclass
class FetchResult:
    url: str
    status: int
    body: bytes
    headers: dict[str, str]
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None and 200 <= self.status < 300

    def text(self) -> str:
        enc = "utf-8"
        ctype = self.headers.get("content-type", "")
        if "charset=" in ctype:
            enc = ctype.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        try:
            return self.body.decode(enc, errors="replace")
        except LookupError:
            return self.body.decode("utf-8", errors="replace")


def fetch(url: str, *, etag: str | None = None, last_modified: str | None = None, check_robots: bool = False) -> FetchResult:
    if check_robots and not robots_allowed(url):
        return FetchResult(url, 0, b"", {}, error="robots_disallowed")
    host = host_of(url)
    _wait_for_host(host)
    headers: dict[str, str] = {}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    try:
        with client().stream("GET", url, headers=headers) as resp:
            chunks: list[bytes] = []
            size = 0
            for chunk in resp.iter_bytes():
                size += len(chunk)
                if size > settings.max_page_bytes:
                    return FetchResult(str(resp.url), resp.status_code, b"", dict(resp.headers), error="too_large")
                chunks.append(chunk)
            return FetchResult(str(resp.url), resp.status_code, b"".join(chunks), {k.lower(): v for k, v in resp.headers.items()})
    except httpx.HTTPError as exc:
        return FetchResult(url, 0, b"", {}, error=f"{type(exc).__name__}: {exc}"[:300])
