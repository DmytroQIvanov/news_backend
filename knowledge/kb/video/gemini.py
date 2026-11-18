"""Minimal Gemini REST client for the video worker, sharing the daily budget with the backend (llm_budget_days).

Budgeted models (versioned quotas.v1.json) are reserved atomically with the same rules as
src/common/llm-budget.ts (advisory lock per day+model, LLM_BUDGET_RESERVED owners). Flash-Lite calls also require reservations: KB_VIDEO_TRANSCRIBE_MODELS / KB_VIDEO_ANALYZE_MODELS.
The API key is sent in a header, never in the URL, and never logged.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from datetime import datetime, timedelta, timezone

import httpx

from .. import db

log = logging.getLogger(__name__)
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
QUOTA_CONFIG = json.loads((Path(__file__).resolve().parents[1] / "quotas.v1.json").read_text(encoding="utf-8"))
DEFAULT_LIMITS = QUOTA_CONFIG["limits"]
DEFAULT_RESERVED = QUOTA_CONFIG["reserved"]


class BudgetExhausted(Exception):
    pass


def ledger_day(now: datetime) -> str:
    """Google resets free-tier daily quotas at midnight Pacific time; the ledger day follows it (same as llm-budget.ts)."""
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat()
    except Exception:
        return (now - timedelta(hours=8)).date().isoformat()


def _pairs(raw: str) -> dict[str, str]:
    out = {}
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def budget_key(model: str) -> str | None:
    m = model.lower().replace("models/", "")
    limits = _pairs((os.environ.get("LLM_DAILY_LIMITS", "").strip() or DEFAULT_LIMITS))
    if "hydrogen" in m:
        return next((k for k in limits if "hydrogen" in k), None)
    for key in sorted(limits, key=len, reverse=True):
        if m == key or (m.startswith(f"{key}-") and not m.startswith(f"{key}-lite")):
            return key
    return None


def reserve(model: str, purpose: str) -> bool:
    key = budget_key(model)
    if not key:
        return True
    limit = int(_pairs((os.environ.get("LLM_DAILY_LIMITS", "").strip() or DEFAULT_LIMITS)).get(key, "0") or 0)
    owner = _pairs((os.environ.get("LLM_BUDGET_RESERVED", "").strip() or DEFAULT_RESERVED)).get(key)
    now = datetime.now(timezone.utc)
    day = ledger_day(now)
    try:
        with db.tx() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"llm:{day}:{key}",))
            rows = conn.execute("SELECT purpose, used FROM llm_budget_days WHERE day = %s AND model = %s", (day, key)).fetchall()
            total = sum(int(r["used"]) for r in rows)
            allowed = total < limit
            if allowed and owner and ":" in owner:
                o_purpose, o_count = owner.split(":", 1)
                if purpose not in o_purpose.split("|"):
                    owners = sum(int(r["used"]) for r in rows if r["purpose"] in o_purpose.split("|"))
                    cap = limit - owners if now.hour >= 20 else limit - int(o_count)
                    allowed = total - owners < max(0, cap)
            if allowed:
                conn.execute(
                    """INSERT INTO llm_budget_days (day, model, purpose, used) VALUES (%s, %s, %s, 1)
                       ON CONFLICT (day, model, purpose) DO UPDATE SET used = llm_budget_days.used + 1, updated_at = now()""",
                    (day, key, purpose[:40]))
        return allowed
    except Exception:  # accounting unavailable: defer, never send an uncounted call
        return False



def record_tokens(model: str, purpose: str, usage: dict) -> None:
    key = budget_key(model) or model.lower()[:80]
    db.execute(
        """INSERT INTO llm_budget_days (day, model, purpose, used, input_tokens, output_tokens) VALUES (%s, %s, %s, %s, %s, %s)
           ON CONFLICT (day, model, purpose) DO UPDATE SET input_tokens = llm_budget_days.input_tokens + EXCLUDED.input_tokens,
             output_tokens = llm_budget_days.output_tokens + EXCLUDED.output_tokens,
             used = llm_budget_days.used + EXCLUDED.used, updated_at = now()""",
        (ledger_day(datetime.now(timezone.utc)), key, purpose[:40], 0 if budget_key(model) else 1, int(usage.get("promptTokenCount") or 0),
         int(usage.get("candidatesTokenCount") or 0)))


def models(env: str, default: str) -> list[str]:
    return [m.strip() for m in os.environ.get(env, default).split(",") if m.strip()]


def generate_json(model_list: list[str], purpose: str, parts: list[dict], system: str, schema: dict | None = None,
                  timeout: float = 600.0, max_output: int = 32768) -> dict:
    """First model that has budget and answers valid JSON wins. Raises BudgetExhausted when none had budget."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise BudgetExhausted("GEMINI_API_KEY not set")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": max_output, "responseMimeType": "application/json",
                             **({"responseSchema": schema} if schema else {})},
    }
    any_budget = False
    last: Exception | None = None
    for model in model_list:
        if not reserve(model, purpose):
            continue
        any_budget = True
        try:
            resp = httpx.post(API.format(model=model), json=body, headers={"x-goog-api-key": key}, timeout=timeout)
            if resp.status_code >= 400:
                raise RuntimeError(f"{model} HTTP {resp.status_code}")
            data = resp.json()
            record_tokens(model, purpose, data.get("usageMetadata") or {})
            text = "".join(p.get("text", "") for p in ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts", []))
            return {"model": model, "json": json.loads(text)}
        except Exception as exc:  # noqa: BLE001
            last = exc
            log.warning("gemini %s for %s failed: %s", model, purpose, type(exc).__name__ if not isinstance(exc, RuntimeError) else exc)
    if not any_budget:
        raise BudgetExhausted(f"no budget for {purpose}")
    raise RuntimeError(f"all models failed for {purpose}: {last}")


def audio_part(path: str, mime: str = "audio/ogg") -> dict:
    with open(path, "rb") as fh:
        return {"inlineData": {"mimeType": mime, "data": base64.b64encode(fh.read()).decode("ascii")}}
