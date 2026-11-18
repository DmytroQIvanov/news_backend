"""Main-text extraction with an explicit quality verdict.

A page that hides its text (paywall, JS rendering, bot wall, cookie wall) must not be treated as an article.
We try several cheap strategies and then say honestly what we got:

  full     >= FULL_MIN_WORDS words of article text, no paywall markers
  partial  some paragraphs, or a paywall marker was found
  teaser   only the feed title/summary (or the page text was shorter than the summary)
  blocked  HTTP 401/402/403/429/451, robots.txt disallow, or a bot wall
  failed   network/parse error

Documents that are only teasers never become articles on their own: they are attached to events as extra
evidence ("Outlet X also reports ..."), see graph/importance.py.
"""
from __future__ import annotations

import html as html_lib
import json
import re
from dataclasses import dataclass, field

from ..text.normalize import clean_text, word_count
from .http import FetchResult, fetch

FULL_MIN_WORDS = 220
PARTIAL_MIN_WORDS = 80

_PAYWALL = re.compile(
    r"subscribe to (?:continue|read)|subscribers only|to continue reading|already a subscriber|sign in to read|"
    r"this article is for subscribers|premium content|unlock this article|become a member to read|"
    r"оформіть передплату|лише для передплатників|доступно передплатникам|продовження доступне|"
    r"читайте повністю після|ця стаття доступна лише|"
    r"jetzt abonnieren|nur für abonnenten|weiterlesen mit",
    re.I,
)
_BOTWALL = re.compile(r"just a moment\.\.\.|attention required|cf-browser-verification|enable javascript and cookies|"
                      r"are you a robot|captcha", re.I)
_AMP_LINK = re.compile(r"<link[^>]+rel=[\"']amphtml[\"'][^>]*>", re.I)
_HREF = re.compile(r"href=[\"']([^\"']+)[\"']", re.I)
_LD_JSON = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.I | re.S)
_META_DESC = re.compile(r"<meta[^>]+(?:property|name)=[\"'](?:og:description|description)[\"'][^>]*content=[\"']([^\"']+)", re.I)
_TAGS = re.compile(r"<[^>]+>")


_SOCIAL = r"(?:telegram|телеграм\w*|instagram|інстаграм\w*|youtube|ютуб\w*|facebook|фейсбук\w*|tiktok|тікток\w*|viber|вайбер\w*|whatsapp|twitter|x\.com|threads|google news|linkedin)"
_CTA = re.compile(
    rf"(?:підписуй|приєднуй|стежте|слідкуйте|читайте нас|дивіться нас|долучайтес|підпишіться|follow us|subscribe to|join us|sign up for|"
    rf"newsletter|розсилк|abonnieren|folgen sie)[^\n]{{0,160}}{_SOCIAL}|{_SOCIAL}[^\n]{{0,40}}(?:канал|channel|сторінк|page)\b|"
    r"^(?:реклама|advertisement|anzeige|читайте також|read more|related:|see also|фото:|photo:|джерело:)\s*$|"
    r"якщо ви помітили помилку|if you spot an error|ctrl\s*\+\s*enter",
    re.I | re.M,
)


def strip_boilerplate(text: str, known: set[str] | None = None) -> str:
    """Removes calls to subscribe, ad markers and paragraphs learned as repeated boilerplate for this source."""
    from ..text.normalize import fingerprint_text, sha256

    out = []
    for para in text.split("\n\n"):
        p = para.strip()
        if not p:
            continue
        if len(p) < 400 and _CTA.search(p):
            continue
        if known and sha256(fingerprint_text(p))[:16] in known:
            continue
        out.append(p)
    return "\n\n".join(out)


def strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAGS.sub(" ", value)
    return clean_text(html_lib.unescape(text))


@dataclass
class Extraction:
    status: str
    method: str | None
    body: str = ""
    title: str | None = None
    author: str | None = None
    published: str | None = None
    final_url: str | None = None
    http_status: int = 0
    flags: list[str] = field(default_factory=list)


def _from_ld_json(page: str) -> tuple[str, dict]:
    best = ""
    meta: dict = {}
    for raw in _LD_JSON.findall(page):
        try:
            data = json.loads(raw.strip())
        except Exception:
            continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                if "@graph" in node and isinstance(node["@graph"], list):
                    stack.extend(node["@graph"])
                body = node.get("articleBody")
                if isinstance(body, str) and len(body) > len(best):
                    best = body
                    author = node.get("author")
                    if isinstance(author, dict):
                        meta["author"] = author.get("name")
                    elif isinstance(author, list) and author and isinstance(author[0], dict):
                        meta["author"] = author[0].get("name")
                    meta["published"] = node.get("datePublished")
            elif isinstance(node, list):
                stack.extend(node)
    return clean_text(html_lib.unescape(best)), meta


def _trafilatura(page: str, url: str, recall: bool) -> tuple[str, dict]:
    try:
        import trafilatura  # type: ignore
    except Exception:
        return "", {}
    try:
        out = trafilatura.extract(
            page,
            url=url,
            output_format="json",
            with_metadata=True,
            include_comments=False,
            include_tables=True,
            favor_recall=recall,
            favor_precision=not recall,
            deduplicate=True,
        )
    except Exception:
        return "", {}
    if not out:
        return "", {}
    try:
        data = json.loads(out)
    except Exception:
        return "", {}
    meta = {"title": data.get("title"), "author": data.get("author"), "published": data.get("date")}
    return clean_text(data.get("text") or ""), meta


def extract_from_html(page: str, url: str, feed_text: str = "") -> Extraction:
    """Pure function (no network) so it can be unit-tested with saved pages."""
    flags: list[str] = []
    if _BOTWALL.search(page[:20000]) and len(page) < 60000:
        return Extraction("blocked", "botwall", feed_text, flags=["botwall"])
    candidates: list[tuple[str, str, dict]] = []
    body, meta = _trafilatura(page, url, recall=False)
    if body:
        candidates.append(("trafilatura", body, meta))
    if word_count(body) < FULL_MIN_WORDS:
        body2, meta2 = _trafilatura(page, url, recall=True)
        if body2:
            candidates.append(("trafilatura_recall", body2, meta2))
    ld_body, ld_meta = _from_ld_json(page)
    if ld_body:
        candidates.append(("json_ld", ld_body, ld_meta))
    if feed_text:
        candidates.append(("feed_content", feed_text, {}))
    if not candidates:
        desc = _META_DESC.search(page)
        text = strip_html(desc.group(1)) if desc else ""
        return Extraction("teaser", "meta_description" if text else None, text or feed_text, flags=["no_text"])
    method, body, meta = max(candidates, key=lambda c: word_count(c[1]))
    if _PAYWALL.search(page[-200000:]) or _PAYWALL.search(body[-600:]):
        flags.append("paywall_marker")
    words = word_count(body)
    feed_words = word_count(feed_text)
    from_page = method != "feed_content"
    if "paywall_marker" in flags:
        status = "partial" if words >= PARTIAL_MIN_WORDS else "teaser"
    elif words >= FULL_MIN_WORDS:
        status = "full"
    elif words >= PARTIAL_MIN_WORDS and from_page and words >= 1.3 * max(feed_words, 40):
        # Short but complete news item (Ukrainian wires are often 100-200 words): the page gave clearly more than the feed.
        status = "full"
        flags.append("short")
    elif words >= PARTIAL_MIN_WORDS:
        status = "partial"
    else:
        status = "teaser"
    if method == "feed_content":
        flags.append("feed_only")
    return Extraction(status, method, body, meta.get("title"), meta.get("author"), meta.get("published"), flags=flags)


def amp_url(page: str) -> str | None:
    m = _AMP_LINK.search(page)
    if not m:
        return None
    href = _HREF.search(m.group(0))
    return html_lib.unescape(href.group(1)) if href else None


def extract_url(url: str, feed_text: str = "") -> Extraction:
    res: FetchResult = fetch(url, check_robots=True)
    if res.error == "robots_disallowed":
        return Extraction("blocked", "robots", feed_text, final_url=url, flags=["robots"])
    if res.error:
        return Extraction("failed", None, feed_text, final_url=url, flags=[res.error[:60]])
    if res.status in (401, 402, 403, 429, 451):
        return Extraction("blocked", f"http_{res.status}", feed_text, final_url=res.url, http_status=res.status)
    if not res.ok:
        return Extraction("failed", f"http_{res.status}", feed_text, final_url=res.url, http_status=res.status)
    page = res.text()
    ext = extract_from_html(page, res.url, feed_text)
    ext.final_url = res.url
    ext.http_status = res.status
    # Hidden text: many publishers serve the full article on their AMP page.
    if ext.status in ("partial", "teaser", "blocked"):
        amp = amp_url(page)
        if amp and amp != url:
            amp_res = fetch(amp, check_robots=True)
            if amp_res.ok:
                amp_ext = extract_from_html(amp_res.text(), amp_res.url, feed_text)
                if word_count(amp_ext.body) > word_count(ext.body):
                    amp_ext.method = f"amp:{amp_ext.method}"
                    amp_ext.final_url = res.url
                    amp_ext.http_status = res.status
                    return amp_ext
    return ext
