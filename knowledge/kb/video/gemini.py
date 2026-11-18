"""Minimal Gemini REST client for the video worker, sharing the daily budget with the backend (llm_budget_days).

Budgeted models (LLM_DAILY_LIMITS, e.g. 3.8/3.6/2.5 Flash = 20 a day) are reserved atomically with the same rules as
src/common/llm-budget.ts (advisory lock per day+model, LLM_BUDGET_RESERVED owners). Flash-Lite models are not in the
limits, so the worker uses them by default: KB_VIDEO_TRANSCRIBE_MODELS / KB_VIDEO_ANALYZE_MODELS.
The API key is sent in a header, never in the URL, and never logged.
"""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone

import httpx

from .. import db

log = logging.getLogger(__name__)
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_LIMITS = "gemini-3.8-flash=20,gemini-3.6-flash=20,gemini-2.5-flash=20,gemini-4-hydrogen=20"


class BudgetExhausted(Exception):
    pass


def _pairs(raw: str) -> dict[str, str]:
    out = {}
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def budget_key(model: str) -> str | None:
    m = model.lower().replace("models/", "")
    for key in _pairs(os.environ.get("LLM_DAILY_LIMITS", DEFAULT_LIMITS)):
        if m == key or (m.startswith(f"{key}-") and not m.startswith(f"{key}-lite")):
            return key
    return None


def reserve(model: str, purpose: str) -> bool:
    key = budget_key(model)
    if not key:
        return True
    limit = int(_pairs(os.environ.get("LLM_DAILY_LIMITS", DEFAULT_LIMITS)).get(key, "0") or 0)
    owner = _pairs(os.environ.get("LLM_BUDGET_RESERVED", "")).get(key)
    now = datetime.now(timezone.utc)
    day = now.date().isoformat()
    with db.tx() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"llm:{day}:{key}",))
        rows = conn.execute("SELECT purpose, used FROM llm_budget_days WHERE day = %s AND model = %s", (day, key)).fetchall()
        total = sum(int(r["used"]) for r in rows)
        allowed = total < limit
        if allowed and owner and ":" in owner:
            o_purpose, o_count = owner.split(":", 1)
            if purpose != o_purpose:
                owners = sum(int(r["used"]) for r in rows if r["purpose"] == o_purpose)
                cap = limit - owners if now.hour >= 20 else limit - int(o_count)
                allowed = total - owners < max(0, cap)
        if allowed:
            conn.execute(
                """INSERT INTO llm_budget_days (day, model, purpose, used) VALUES (%s, %s, %s, 1)
                   ON CONFLICT (day, model, purpose) DO UPDATE SET used = llm_budget_days.used + 1, updated_at = now()""",
                (day, key, purpose[:40]))
    return allowed


def record_tokens(model: str, purpose: str, usage: dict) -> None:
    key = budget_key(model) or model.lower()[:80]
    db.execute(
        """INSERT INTO llm_budget_days (day, model, purpose, used, input_tokens, output_tokens) VALUES (current_date, %s, %s, %s, %s, %s)
           ON CONFLICT (day, model, purpose) DO UPDATE SET input_tokens = llm_budget_days.input_tokens + EXCLUDED.input_tokens,
             output_tokens = llm_budget_days.output_tokens + EXCLUDED.output_tokens,
             used = llm_budget_days.used + EXCLUDED.used, updated_at = now()""",
        (key, purpose[:40], 0 if budget_key(model) else 1, int(usage.get("promptTokenCount") or 0),
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
