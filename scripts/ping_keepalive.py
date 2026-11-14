#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Database and Render Keepalive Ping Script.

Periodically pings the backend health endpoint (default: every 10 minutes / 600s)
to prevent the Render free web service and Neon PostgreSQL free database from
sleeping due to inactivity.

Usage:
  python scripts/ping_keepalive.py
  python scripts/ping_keepalive.py --api https://news-backend-v0jj.onrender.com --interval 600
  python scripts/ping_keepalive.py --api http://localhost:3000 --interval 300
"""

import argparse
import datetime as dt
import json
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_API = "https://news-backend-v0jj.onrender.com"
DEFAULT_INTERVAL_SECONDS = 600  # 10 minutes


def now_str() -> str:
    return dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ping(api_url: str, timeout: int = 45) -> bool:
    endpoint = f"{api_url.rstrip('/')}/health/db"
    req = Request(
        endpoint,
        headers={
            "User-Agent": "OpportunityRadar-KeepAlive/1.0",
            "Accept": "application/json",
        },
    )
    start_time = time.time()
    try:
        with urlopen(req, timeout=timeout) as response:
            latency = (time.time() - start_time) * 1000
            data = json.loads(response.read().decode("utf-8"))
            status = data.get("status")
            db = data.get("database")
            print(
                f"[{now_str()}] [OK] HTTP {response.status} ({latency:.0f}ms) -> status: {status}, database: {db}",
                flush=True,
            )
            return True
    except HTTPError as ex:
        latency = (time.time() - start_time) * 1000
        print(f"[{now_str()}] [HTTP ERROR {ex.code}] ({latency:.0f}ms) -> {ex.reason}", flush=True)
        return False
    except URLError as ex:
        latency = (time.time() - start_time) * 1000
        print(f"[{now_str()}] [CONNECT ERROR] ({latency:.0f}ms) -> {ex.reason}", flush=True)
        return False
    except Exception as ex:
        latency = (time.time() - start_time) * 1000
        print(f"[{now_str()}] [FAILED] ({latency:.0f}ms) -> {ex}", flush=True)
        return False


def main():
    parser = argparse.ArgumentParser(description="Keepalive ping for database and backend")
    parser.add_argument("--api", default=DEFAULT_API, help=f"Backend base URL (default: {DEFAULT_API})")
    parser.add_argument(
        "--interval",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help=f"Ping interval in seconds (default: {DEFAULT_INTERVAL_SECONDS} = 10 minutes)",
    )
    parser.add_argument("--once", action="store_true", help="Perform single ping and exit")
    args = parser.parse_args()

    print("=" * 60)
    print(f"Opportunity Radar - Keepalive Pinger")
    print(f"Target API: {args.api}")
    print(f"Interval:   {args.interval}s ({args.interval / 60:.1f} minutes)")
    print(f"Endpoint:   {args.api.rstrip('/')}/health/db")
    print("=" * 60, flush=True)

    if args.once:
        success = ping(args.api)
        sys.exit(0 if success else 1)

    cycle = 1
    while True:
        try:
            print(f"\n--- Цикл #{cycle} ---", flush=True)
            ping(args.api)
            cycle += 1
            time.sleep(args.interval)
        except KeyboardInterrupt:
            print(f"\n[{now_str()}] Опитування зупинено користувачем.")
            break


if __name__ == "__main__":
    main()
