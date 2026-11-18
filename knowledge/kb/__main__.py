"""Command line entry point: `python -m kb <command>`.

Long-running workers (one container each, same image):
  collector      poll feeds + extract article text
  nlp            analyze documents, cluster into events, aggregate facts
  maintain       entity resolution (Wikidata), graph statistics, event linking, daily training
One-off commands:
  seed           load resources/seed_entities.yaml and the legacy kg_entities dictionary
  backfill       import public.news_items history  [--fetch-days N] [--limit N]
  train          train the category classifier now
  once           one collector + nlp + maintain pass (for testing)
  stats          print queue and graph counters
  connectors     open-data connectors (statistics, sanctions, SEC, GDELT, contracts, science, ACLED) [--forever]
  import-sipri   import a SIPRI arms-transfers CSV
  eval           measure claim extraction against eval/gold_claims.yaml  [--failures]
  analyze-text   run the NLP stack on stdin text without a database write (debugging)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from .config import settings


def _setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


def cmd_stats() -> dict:
    from . import db

    out = {}
    out["documents_by_stage"] = {r["stage"]: r["n"] for r in db.fetch_all("SELECT stage, count(*) AS n FROM kb.documents GROUP BY stage")}
    out["extraction"] = {r["extraction_status"]: r["n"] for r in db.fetch_all(
        "SELECT extraction_status, count(*) AS n FROM kb.documents GROUP BY extraction_status")}
    out["events_by_state"] = {r["editorial_state"]: r["n"] for r in db.fetch_all(
        "SELECT editorial_state, count(*) AS n FROM kb.events WHERE status <> 'merged' GROUP BY editorial_state")}
    for table in ("entities", "entity_aliases", "mentions", "entity_candidates", "claims", "facts", "contradictions",
                  "entity_relations", "event_links", "storylines", "llm_tasks"):
        out[table] = db.fetch_one(f"SELECT count(*) AS n FROM kb.{table}")["n"]
    out["features"] = db.features()
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kb")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("collector", "nlp", "maintain", "seed", "train", "once", "stats", "analyze-text"):
        sub.add_parser(name)
    cn = sub.add_parser("connectors", help="open-data connectors: run due ones once (or loop with --forever)")
    cn.add_argument("--only")
    cn.add_argument("--force", action="store_true")
    cn.add_argument("--forever", action="store_true")
    vd = sub.add_parser("video", help="video worker: transcripts of queued videos (loop; --once for one video)")
    vd.add_argument("--once", action="store_true")
    sp = sub.add_parser("import-sipri", help="import a SIPRI trade register CSV")
    sp.add_argument("path")
    ev = sub.add_parser("eval")
    ev.add_argument("--failures", action="store_true", help="print every mismatch")
    bf = sub.add_parser("backfill")
    bf.add_argument("--fetch-days", type=int, default=7)
    bf.add_argument("--limit", type=int, default=100000)
    args = parser.parse_args(argv)
    _setup_logging()

    if args.cmd == "collector":
        from .collect.collector import run_forever

        run_forever()
    elif args.cmd == "nlp":
        from .nlp.pipeline import run_forever

        run_forever()
    elif args.cmd == "maintain":
        from .maintain import run_forever

        run_forever()
    elif args.cmd == "seed":
        from .entities import import_legacy_kg, seed_from_yaml

        print(json.dumps({"seed": seed_from_yaml(), "legacy": import_legacy_kg()}))
    elif args.cmd == "backfill":
        from .legacy import backfill

        print(json.dumps(backfill(args.fetch_days, args.limit)))
    elif args.cmd == "train":
        from .train import train_category_models

        print(json.dumps(train_category_models(), ensure_ascii=False))
    elif args.cmd == "once":
        from .collect.collector import extract_pending, poll_due_sources
        from .maintain import run_once
        from .nlp.pipeline import run_batch

        out = {"poll": poll_due_sources(), "extract": extract_pending(100)}
        nlp_total: dict = {}
        while True:
            stats = run_batch(50)
            for k, v in stats.items():
                nlp_total[k] = nlp_total.get(k, 0) + v
            if not stats.get("claimed"):
                break
        out["nlp"] = nlp_total
        out["maintain"] = run_once()
        print(json.dumps(out, ensure_ascii=False, default=str, indent=2))
    elif args.cmd == "connectors":
        import time as _time

        from .connectors.base import run_due

        while True:
            print(json.dumps(run_due(args.only, args.force), ensure_ascii=False, default=str), flush=True)
            if not args.forever:
                break
            _time.sleep(300)
    elif args.cmd == "video":
        from .video import worker

        if args.once:
            video = worker.claim_next()
            print(json.dumps({"video": video and video["video_id"], "state": worker.process(video) if video else "queue empty"}), flush=True)
        else:
            worker.run_forever()
    elif args.cmd == "import-sipri":
        from .connectors.conflict import import_sipri

        print(json.dumps(import_sipri(args.path)))
    elif args.cmd == "eval":
        from .evaluate import evaluate

        result = evaluate()
        if args.failures:
            for f in result["failures"]:
                print(json.dumps(f, ensure_ascii=False, default=str))
    elif args.cmd == "stats":
        print(json.dumps(cmd_stats(), ensure_ascii=False, indent=2))
    elif args.cmd == "analyze-text":
        from .nlp.categorize import categorize
        from .nlp.linker import link
        from .nlp.ner import parse
        from .nlp.relations import extract_claims
        from .text import lang as langid
        from .text.keywords import keywords

        text = sys.stdin.read()
        title, _, body = text.partition("\n")
        code, conf = langid.detect(text)
        parsed = parse(text, code)
        mentions = link(text, len(title), parsed, allow_db=False)
        claims = extract_claims(parsed, mentions, code, None)
        cat = categorize(title, body)
        print(json.dumps({
            "lang": [code, conf],
            "category": cat.__dict__,
            "keywords": keywords(title, body, code),
            "entities": [(m.surface, m.label, m.entity_id) for m in mentions],
            "claims": [{"predicate": c.predicate, "subject": c.subject.surface if c.subject else None,
                        "object": c.obj.surface if c.obj else None, "value": c.value_num, "unit": c.value_unit,
                        "modality": c.modality, "negated": c.negated, "confidence": c.confidence, "extractor": c.extractor}
                       for c in claims],
        }, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
