"""Offline quality evaluation of claim extraction against eval/gold_claims.yaml (`python -m kb eval`).

No database: each case gets a temporary dictionary built from its `entities`, so the measurement isolates the
extractor (roles, amounts, dates, modality, negation) from entity linking. Entity kinds come from the seed
dictionary when the name is known there, otherwise from spaCy's NER label.

Reported:
  * claim precision / recall / F1 on (predicate, subject, object);
  * attribute accuracy on matched claims: value (±2%), unit, modality, negation, date;
  * the same per tag (passive, two-actions-amounts, denial, ...), and every mismatch with the text.
A new extractor version should never lower these numbers; CI can enforce minimum thresholds.
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import yaml

from .nlp import linker
from .nlp.gazetteer import Gazetteer
from .nlp.ner import parse
from .nlp.relations import extract_claims
from .text.stem import term_key

GOLD = Path(__file__).resolve().parents[1] / "eval" / "gold_claims.yaml"
SEED = Path(__file__).resolve().parent / "resources" / "seed_entities.yaml"
NER_TO_KIND = {"person": "person", "organization": "organization", "place": "place", "facility": "facility",
               "product": "product", "group": "group", "law": "law", "event": "event"}


def _seed_kinds() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        data = yaml.safe_load(SEED.read_text(encoding="utf-8")) or {}
    except FileNotFoundError:
        return out
    for e in data.get("entities", []):
        for name in [e.get("name"), e.get("name_uk"), *(e.get("aliases") or [])]:
            if name:
                out.setdefault(term_key(str(name)), e.get("kind", "other"))
    return out


def _key(name: str | None) -> str | None:
    return term_key(name) if name else None


def _run_case(case: dict, seed_kinds: dict[str, str]) -> list[dict]:
    text = case["text"]
    lang = case.get("lang", "en")
    g = Gazetteer()
    names = [str(n) for n in case.get("entities") or []]
    for i, n in enumerate(names, start=1):
        g.add(i, n)
    parsed = parse(text, lang)
    kinds: dict[int, str] = {}
    for i, n in enumerate(names, start=1):
        kind = seed_kinds.get(term_key(n))
        if kind is None:
            for e in parsed.entities:
                if term_key(e.text) == term_key(n) or n in e.text:
                    kind = NER_TO_KIND.get(e.label)
                    break
        if kind:
            kinds[i] = kind
    saved_g, saved_kinds = linker.GAZETTEER, dict(linker.ENTITY_INFO.kind)
    linker.GAZETTEER, linker.ENTITY_INFO.kind = g, kinds
    try:
        mentions = linker.link(text, 0, parsed, allow_db=False)
        pub = case.get("published_at")
        ref = datetime.combine(pub, datetime.min.time()) if isinstance(pub, date) else datetime(2026, 11, 17)
        claims = extract_claims(parsed, mentions, lang, ref, kinds)
    finally:
        linker.GAZETTEER, linker.ENTITY_INFO.kind = saved_g, saved_kinds
    id_to_name = {i: n for i, n in enumerate(names, start=1)}

    def surface(m):
        if m is None:
            return None
        return id_to_name.get(m.entity_id, m.surface) if m.entity_id else m.surface

    return [
        {"predicate": c.predicate, "subject": surface(c.subject), "object": surface(c.obj), "value": c.value_num,
         "unit": c.value_unit, "modality": c.modality, "negated": c.negated, "time": c.time_start}
        for c in claims if c.predicate not in ("state", "deny")
    ]


def _same_entity(a: str | None, b: str | None) -> bool:
    if a is None or b is None:
        return a is None and b is None
    ka, kb_ = _key(a), _key(b)
    return ka == kb_ or ka in kb_ or kb_ in ka


def evaluate(path: Path = GOLD, verbose: bool = True) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    seed_kinds = _seed_kinds()
    tot = defaultdict(int)
    per_tag: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    failures: list[dict] = []
    for case in data["cases"]:
        gold = [g for g in case.get("claims") or [] if g.get("predicate") != "state"]
        pred = _run_case(case, seed_kinds)
        used: set[int] = set()
        matched = []
        for g in gold:
            hit = next((i for i, p in enumerate(pred) if i not in used and p["predicate"] == g["predicate"]
                        and _same_entity(p["subject"], g.get("subject")) and _same_entity(p["object"], g.get("object"))), None)
            if hit is None:
                failures.append({"id": case["id"], "missing": g, "text": case["text"], "got": pred})
                continue
            used.add(hit)
            matched.append((g, pred[hit]))
        extra = [p for i, p in enumerate(pred) if i not in used]
        for p in extra:
            failures.append({"id": case["id"], "spurious": p, "text": case["text"]})
        stats: dict[str, int] = defaultdict(int, {"gold": len(gold), "pred": len(pred), "tp": len(matched)})
        for g, p in matched:
            if g.get("value") is not None or p["value"] is not None:
                stats["value_n"] += 1
                ok = g.get("value") is not None and p["value"] is not None and abs(float(p["value"]) - float(g["value"])) <= 0.02 * abs(float(g["value"]))
                stats["value_ok"] = stats.get("value_ok", 0) + int(ok and (g.get("unit") or "") == (p["unit"] or ""))
                if not ok:
                    failures.append({"id": case["id"], "value": [g.get("value"), g.get("unit"), p["value"], p["unit"]], "text": case["text"]})
            stats["mod_n"] = stats.get("mod_n", 0) + 1
            mod_ok = g.get("modality", "fact") == p["modality"]
            stats["mod_ok"] = stats.get("mod_ok", 0) + int(mod_ok)
            if not mod_ok:
                failures.append({"id": case["id"], "modality": [g.get("modality"), p["modality"]], "text": case["text"]})
            stats["neg_ok"] = stats.get("neg_ok", 0) + int(bool(g.get("negated")) == bool(p["negated"]))
            if g.get("time"):
                stats["time_n"] = stats.get("time_n", 0) + 1
                stats["time_ok"] = stats.get("time_ok", 0) + int(str(p["time"]) == str(g["time"]))
        for k, v in stats.items():
            tot[k] += v
            for tag in case.get("tags") or ["untagged"]:
                per_tag[tag][k] += v

    def summary(s: dict) -> dict:
        p = s["tp"] / s["pred"] if s["pred"] else 1.0
        r = s["tp"] / s["gold"] if s["gold"] else 1.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(f, 3),
                "value_acc": round(s.get("value_ok", 0) / s["value_n"], 3) if s.get("value_n") else None,
                "modality_acc": round(s.get("mod_ok", 0) / s["mod_n"], 3) if s.get("mod_n") else None,
                "negation_acc": round(s.get("neg_ok", 0) / s["mod_n"], 3) if s.get("mod_n") else None,
                "date_acc": round(s.get("time_ok", 0) / s["time_n"], 3) if s.get("time_n") else None,
                "gold": s["gold"], "pred": s["pred"]}

    result = {"overall": summary(tot), "by_tag": {t: summary(s) for t, s in sorted(per_tag.items())}, "failures": failures}
    if verbose:
        print(json.dumps({"overall": result["overall"], "by_tag": result["by_tag"]}, ensure_ascii=False, indent=1))
    return result
