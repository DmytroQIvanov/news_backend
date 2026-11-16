"""Print AI usage/failure statistics from the API.

  python scripts/llm_stats.py --api https://<service>.onrender.com --key <INGEST_API_KEY> [--days 7] [--json]
The key can also come from the INGEST_API_KEY environment variable.
"""
import argparse, os, sys, urllib.request

p = argparse.ArgumentParser()
p.add_argument("--api", default=os.environ.get("API_URL", "http://127.0.0.1:3000"))
p.add_argument("--key", default=os.environ.get("INGEST_API_KEY", ""))
p.add_argument("--days", type=int, default=7)
p.add_argument("--json", action="store_true")
a = p.parse_args()
if not a.key:
    sys.exit("Set --key or INGEST_API_KEY")
url = f"{a.api.rstrip('/')}/ai/stats?days={a.days}" + ("" if a.json else "&format=text")
req = urllib.request.Request(url, headers={"x-ingest-key": a.key})
sys.stdout.reconfigure(encoding="utf-8")
print(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))
