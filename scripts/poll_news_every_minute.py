#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Automated 1-Minute News Poller for Opportunity Radar.

Polls all configured AI news feeds and release channels every 60 seconds.
Uses HTTP ETag and Last-Modified caching to prevent redundant downloads.
Detects newly published articles and writes them to local JSON and/or
ingests them directly into the NestJS backend.

Usage:
  python scripts/poll_news_every_minute.py
  python scripts/poll_news_every_minute.py --interval 60
  python scripts/poll_news_every_minute.py --once
  python scripts/poll_news_every_minute.py --api https://news-backend-v0jj.onrender.com --key <INGEST_API_KEY>
"""

import argparse
import concurrent.futures
import datetime as dt
import email.utils
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

SOURCES = [
    # Official blogs
    {"slug": "openai-news", "name": "OpenAI News", "url": "https://openai.com/news/rss.xml", "category": "model"},
    {"slug": "google-deepmind", "name": "Google DeepMind", "url": "https://deepmind.google/blog/rss.xml", "category": "model"},
    {"slug": "google-ai", "name": "Google AI", "url": "https://blog.google/innovation-and-ai/technology/ai/rss/", "category": "model"},
    {"slug": "google-research", "name": "Google Research", "url": "https://research.google/blog/rss/", "category": "research"},
    {"slug": "hugging-face", "name": "Hugging Face", "url": "https://huggingface.co/blog/feed.xml", "category": "open_source"},
    {"slug": "aws-ml", "name": "AWS Machine Learning", "url": "https://aws.amazon.com/blogs/machine-learning/feed/", "category": "api"},
    {"slug": "cloudflare-blog", "name": "Cloudflare Blog", "url": "https://blog.cloudflare.com/rss/", "category": "api"},
    # GitHub Atom release feeds
    {"slug": "claude-code-releases", "name": "Claude Code Releases", "url": "https://github.com/anthropics/claude-code/releases.atom", "category": "coding"},
    {"slug": "openai-python-sdk", "name": "OpenAI Python SDK", "url": "https://github.com/openai/openai-python/releases.atom", "category": "api"},
    {"slug": "ollama-releases", "name": "Ollama Releases", "url": "https://github.com/ollama/ollama/releases.atom", "category": "coding"},
    {"slug": "vllm-releases", "name": "vLLM Releases", "url": "https://github.com/vllm-project/vllm/releases.atom", "category": "open_source"},
    {"slug": "llama-cpp-releases", "name": "llama.cpp Releases", "url": "https://github.com/ggml-org/llama.cpp/releases.atom", "category": "open_source"},
    {"slug": "transformers-releases", "name": "Transformers Releases", "url": "https://github.com/huggingface/transformers/releases.atom", "category": "open_source"},
    {"slug": "langchain-releases", "name": "LangChain Releases", "url": "https://github.com/langchain-ai/langchain/releases.atom", "category": "coding"},
    # Community mirrors
    {"slug": "anthropic-news-community-feed", "name": "Anthropic News (mirror)", "url": "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml", "category": "model", "unofficial": True},
    {"slug": "mistral-ai-community-feed", "name": "Mistral AI (mirror)", "url": "https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_mistral.xml", "category": "model", "unofficial": True},
]

USER_AGENT = "OpportunityRadarPoller/1.0 (RSS/Atom real-time monitor; 60s cadence)"


class TextStripper(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignore = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.ignore += 1
        elif tag in ("p", "br", "div", "li"):
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self.ignore:
            self.ignore -= 1
        elif tag in ("p", "div", "li"):
            self.parts.append(" ")

    def handle_data(self, data):
        if not self.ignore:
            self.parts.append(data)


def clean_text(s: str) -> str:
    p = TextStripper()
    try:
        p.feed(html.unescape(s or ""))
        text = "".join(p.parts)
    except Exception:
        text = s or ""
    return re.sub(r"\s+", " ", text).strip()


def parse_date(date_str: str) -> str:
    if not date_str:
        return ""
    try:
        dt_val = email.utils.parsedate_to_datetime(date_str)
        if dt_val.tzinfo is None:
            dt_val = dt_val.replace(tzinfo=dt.timezone.utc)
        return dt_val.astimezone(dt.timezone.utc).isoformat()
    except Exception:
        pass
    try:
        dt_val = dt.datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt_val.tzinfo is None:
            dt_val = dt_val.replace(tzinfo=dt.timezone.utc)
        return dt_val.astimezone(dt.timezone.utc).isoformat()
    except Exception:
        return ""


def normalize_url(raw_url: str) -> str:
    p = urllib.parse.urlsplit((raw_url or "").strip())
    params = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
              if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid"}]
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/") or "/",
                                    urllib.parse.urlencode(params), ""))


def parse_feed_xml(xml_bytes: bytes, source: dict) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    articles = []
    atom_ns = "{http://www.w3.org/2005/Atom}"

    rss_items = root.findall("./channel/item")
    if not rss_items and root.tag.rsplit("}", 1)[-1] == "RDF":
        rss_items = root.findall("{http://purl.org/rss/1.0/}item")

    if rss_items:
        for item in rss_items[:30]:
            title_node = item.find("title")
            link_node = item.find("link")
            desc_node = item.find("description")
            date_find = item.find("pubDate")
            date_node = date_find if date_find is not None else item.find("{http://purl.org/dc/elements/1.1/}date")

            title = clean_text("".join(title_node.itertext()) if title_node is not None else "")
            link = clean_text("".join(link_node.itertext()) if link_node is not None else "")
            summary = clean_text("".join(desc_node.itertext()) if desc_node is not None else "")
            published = parse_date("".join(date_node.itertext()) if date_node is not None else "")

            if title and link.startswith("https://"):
                url = normalize_url(link)
                ext_id = "rss-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
                articles.append({
                    "id": ext_id,
                    "url": url,
                    "original_title": title[:350],
                    "original_summary": summary[:2500],
                    "published_at": published,
                    "source_name": source["name"],
                    "source_slug": source["slug"],
                    "category": source.get("category", "other"),
                    "source_is_unofficial": source.get("unofficial", False),
                })
    elif root.tag.rsplit("}", 1)[-1] == "feed":
        for entry in root.findall(atom_ns + "entry")[:30]:
            title_node = entry.find(atom_ns + "title")
            desc_node = entry.find(atom_ns + "summary") or entry.find(atom_ns + "content")
            date_node = entry.find(atom_ns + "published") or entry.find(atom_ns + "updated")
            link = ""
            for l in entry.findall(atom_ns + "link"):
                if l.get("rel", "alternate") == "alternate" and l.get("href"):
                    link = l.attrib["href"]
                    break

            title = clean_text("".join(title_node.itertext()) if title_node is not None else "")
            summary = clean_text("".join(desc_node.itertext()) if desc_node is not None else "")
            published = parse_date("".join(date_node.itertext()) if date_node is not None else "")

            if title and link.startswith("https://"):
                url = normalize_url(link)
                ext_id = "rss-" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
                articles.append({
                    "id": ext_id,
                    "url": url,
                    "original_title": title[:350],
                    "original_summary": summary[:2500],
                    "published_at": published,
                    "source_name": source["name"],
                    "source_slug": source["slug"],
                    "category": source.get("category", "other"),
                    "source_is_unofficial": source.get("unofficial", False),
                })
    return articles


def fetch_source(source: dict, cache: dict) -> tuple[dict, list[dict], str]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    }
    prev = cache.get(source["url"], {})
    if prev.get("etag"):
        headers["If-None-Match"] = prev["etag"]
    if prev.get("last_modified"):
        headers["If-Modified-Since"] = prev["last_modified"]

    req = urllib.request.Request(source["url"], headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            data = response.read(2_000_000)
            items = parse_feed_xml(data, source)
            new_cache = {
                "etag": response.headers.get("ETag", ""),
                "last_modified": response.headers.get("Last-Modified", ""),
                "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "status": "200 OK",
            }
            return new_cache, items, ""
    except urllib.error.HTTPError as ex:
        if ex.code == 304:
            new_cache = {**prev, "status": "304 Not Modified", "checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
            return new_cache, [], ""
        return prev, [], f"HTTP {ex.code}"
    except Exception as ex:
        return prev, [], str(ex)[:120]


def poll_cycle(sources: list[dict], state: dict) -> tuple[list[dict], int, int]:
    cache = state.setdefault("cache", {})
    known_urls = set(state.setdefault("seen_urls", []))

    new_articles = []
    success_count = 0
    not_modified_count = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        future_map = {executor.submit(fetch_source, s, cache): s for s in sources}
        for future in concurrent.futures.as_completed(future_map):
            src = future_map[future]
            try:
                new_cache, items, error = future.result()
                cache[src["url"]] = new_cache
                if error:
                    print(f"  [!] {src['name']}: {error}", flush=True)
                elif new_cache.get("status") == "304 Not Modified":
                    not_modified_count += 1
                else:
                    success_count += 1
                    for item in items:
                        if item["url"] not in known_urls:
                            known_urls.add(item["url"])
                            new_articles.append(item)
            except Exception as ex:
                print(f"  [!] {src['name']} failure: {ex}", flush=True)

    state["seen_urls"] = list(known_urls)[-10000:]
    return new_articles, success_count, not_modified_count


def ingest_to_api(api_url: str, key: str, articles: list[dict]):
    if not articles:
        return
    grouped = {}
    for a in articles:
        slug = a["source_slug"]
        if slug not in grouped:
            grouped[slug] = {
                "source": {
                    "slug": slug,
                    "name": a["source_name"],
                    "homepageUrl": f"https://{urllib.parse.urlsplit(a['url']).netloc}",
                    "unofficial": a.get("source_is_unofficial", False),
                },
                "items": [],
            }
        grouped[slug]["items"].append({
            "externalId": a["id"],
            "url": a["url"],
            "originalTitle": a["original_title"],
            "originalSummary": a["original_summary"],
            "publishedAt": a["published_at"] or None,
            "category": a.get("category", "other"),
            "importance": "unknown",
            "freeAccess": "unknown",
        })

    for slug, payload in grouped.items():
        req = urllib.request.Request(
            f"{api_url.rstrip('/')}/api/v1/ingest/news",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-ingest-key": key,
                "User-Agent": USER_AGENT,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                print(f"  [Backend Ingest] {slug}: записано {result.get('written', 0)}, без змін {result.get('unchanged', 0)}", flush=True)
        except Exception as ex:
            print(f"  [Backend Ingest ERROR] {slug}: {ex}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Automated 1-minute news poller")
    parser.add_argument("--interval", type=int, default=60, help="Polling interval in seconds (default: 60)")
    parser.add_argument("--once", action="store_true", help="Run a single poll cycle and exit")
    parser.add_argument("--api", default="", help="Backend URL to auto-ingest new articles (e.g. https://news-backend-v0jj.onrender.com)")
    parser.add_argument("--key", default="", help="Backend INGEST_API_KEY")
    args = parser.parse_args()

    api_url = args.api or os.environ.get("EXPO_PUBLIC_API_URL", "")
    api_key = args.key or os.environ.get("INGEST_API_KEY", "")

    state_path = Path(__file__).resolve().parent / "poller_state.json"
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
        except Exception:
            state = {}

    print("=" * 65)
    print("Opportunity Radar - Автоматичний опитувач новин (раз на хвилину)")
    print(f"Кількість джерел:   {len(SOURCES)}")
    print(f"Інтервал:          {args.interval} секунд (1 хвилина)")
    print(f"Авто-імпорт в API: {'Увімкнено (' + api_url + ')' if api_url and api_key else 'Вимкнено (лише збереження в JSON)'}")
    print("=" * 65, flush=True)

    cycle = 1
    while True:
        now_time = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"\n[{now_time}] Цикл #{cycle}: опитую {len(SOURCES)} сайтів…", flush=True)

        start = time.time()
        new_items, ok_count, not_mod_count = poll_cycle(SOURCES, state)
        elapsed = time.time() - start

        # Persist state
        try:
            state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass

        print(f"[{now_time}] Завершено за {elapsed:.2f}с: {ok_count} оновлено, {not_mod_count} без змін (304), виявлено {len(new_items)} нових статей", flush=True)

        if new_items:
            print("  --- НОВІ ЗНАХІДКИ ---")
            for item in new_items[:5]:
                print(f"  * [{item['source_name']}] {item['original_title']}")
                print(f"    URL: {item['url']}")
            if len(new_items) > 5:
                print(f"    ... ще {len(new_items) - 5} новин")

            # Save to raw json
            raw_path = Path(__file__).resolve().parent / "latest_news_stream.json"
            try:
                raw_path.write_text(json.dumps(new_items, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"  [Збережено] Нові статті записано у {raw_path.name}")
            except Exception as ex:
                print(f"  [Помилка запису файлу] {ex}")

            # Send to API if configured
            if api_url and api_key:
                ingest_to_api(api_url, api_key, new_items)

        if args.once:
            break

        cycle += 1
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОпитувач зупинено.")
