"""Gemini Decision 1 client for Python KB workers (`POST /v1beta/decisions`).

Shares the daily budget in `llm_budget_days` (with `LEASE_SIZE=25` block leases matching `src/common/llm-budget.ts`)
and enforces a sliding-window limiter for the 50K TPM / 200 RPS / 10K RPD limits with 0 output tokens.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from .. import db

log = logging.getLogger(__name__)
DECISIONS_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
MODEL_NAME = "gemini-decision-1"
LEASE_SIZE = 25

QUOTA_CONFIG = json.loads((Path(__file__).resolve().parents[1] / "quotas.v1.json").read_text(encoding="utf-8"))
DEFAULT_LIMITS = QUOTA_CONFIG["limits"]
DEFAULT_RESERVED = QUOTA_CONFIG["reserved"]


def _env_int(name: str, fallback: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip() or fallback)
        return v if v > 0 else fallback
    except ValueError:
        return fallback


def _pairs(raw: str) -> dict[str, str]:
    out = {}
    for part in raw.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def _ledger_day(now: datetime) -> str:
    try:
        from zoneinfo import ZoneInfo

        return now.astimezone(ZoneInfo("America/Los_Angeles")).date().isoformat()
    except Exception:
        return (now - timedelta(hours=8)).date().isoformat()


class DecisionRateLimiter:
    """Thread-safe sliding-window rate & token limiter (45K TPM, 150 RPS, 40K max input tokens)."""

    def __init__(self, window_s: float = 60.0, rps_window_s: float = 1.0):
        self.window_s = window_s
        self.rps_window_s = rps_window_s
        self._lock = threading.Lock()
        self._events: list[list[float]] = []  # [timestamp, tokens]
        self._cooldown_until = 0.0

    def limits(self) -> dict[str, int]:
        return {
            "tpm": _env_int("DECISION_TPM", 45_000),
            "rps": _env_int("DECISION_RPS", 150),
            "rpm": _env_int("DECISION_RPM", 1500),
            "max_input_tokens": _env_int("DECISION_MAX_INPUT_TOKENS", 40_000),
        }

    def estimate_tokens(self, input_data, questions: dict) -> int:
        in_text = input_data if isinstance(input_data, str) else json.dumps(input_data, ensure_ascii=False)
        q_text = json.dumps(questions, ensure_ascii=False)
        return (len(in_text) + len(q_text) + 2) // 3

    def acquire(self, est_tokens: int, max_wait_s: float = 10.0) -> list[float] | None:
        lim = self.limits()
        if est_tokens > lim["max_input_tokens"]:
            return None
        deadline = time.monotonic() + max_wait_s
        while True:
            wait = 0.0
            now = time.monotonic()
            with self._lock:
                self._events = [e for e in self._events if e[0] + self.window_s > now]
                wait = max(wait, self._cooldown_until - now)
                if len(self._events) >= lim["rpm"]:
                    wait = max(wait, self._events[-lim["rpm"]][0] + self.window_s - now)
                rps_cutoff = now - self.rps_window_s
                recent = [e for e in self._events if e[0] > rps_cutoff]
                if len(recent) >= lim["rps"]:
                    wait = max(wait, recent[-lim["rps"]][0] + self.rps_window_s - now)
                used = sum(e[1] for e in self._events)
                capped = min(est_tokens, lim["tpm"])
                for e in self._events:
                    if used + capped <= lim["tpm"]:
                        break
                    used -= e[1]
                    wait = max(wait, e[0] + self.window_s - now)
                if wait <= 0:
                    slot = [now, float(capped)]
                    self._events.append(slot)
                    return slot
            if now + wait > deadline:
                return None
            time.sleep(min(wait, 0.25))

    def release(self, slot: list[float], actual_tokens: int) -> None:
        with self._lock:
            slot[1] = float(max(0, actual_tokens))

    def cooldown(self, seconds: float) -> None:
        with self._lock:
            self._cooldown_until = max(self._cooldown_until, time.monotonic() + seconds)

    def reset(self) -> None:
        with self._lock:
            self._events.clear()
            self._cooldown_until = 0.0


_LIMITER = DecisionRateLimiter()
_BUDGET_LOCK = threading.Lock()
_LEASES: dict[tuple[str, str], dict] = {}
_EXHAUSTED_DAY: str | None = None


def reset_for_tests() -> None:
    global _EXHAUSTED_DAY
    _LIMITER.reset()
    with _BUDGET_LOCK:
        _LEASES.clear()
        _EXHAUSTED_DAY = None


def reserve(purpose: str, now: datetime | None = None) -> bool:
    """Block-leased reservation (`LEASE_SIZE=25`) in `llm_budget_days`; fails closed when DB is unavailable."""
    now = now or datetime.now(timezone.utc)
    day = _ledger_day(now)
    with _BUDGET_LOCK:
        if _EXHAUSTED_DAY == day:
            return False
        lease = _LEASES.get((MODEL_NAME, purpose))
        if lease and lease["day"] == day and lease["left"] > 0:
            lease["left"] -= 1
            return True

    limit = int(_pairs((os.environ.get("LLM_DAILY_LIMITS", "").strip() or DEFAULT_LIMITS)).get(MODEL_NAME, "10000") or 10000)
    owner = _pairs((os.environ.get("LLM_BUDGET_RESERVED", "").strip() or DEFAULT_RESERVED)).get(MODEL_NAME)
    try:
        with db.tx() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"llm:{day}:{MODEL_NAME}",))
            rows = conn.execute(
                "SELECT purpose, used FROM llm_budget_days WHERE day = %s AND model = %s", (day, MODEL_NAME)
            ).fetchall()
            total = sum(int(r["used"]) for r in rows)
            allowed = total + LEASE_SIZE <= limit
            if allowed and owner and ":" in owner:
                o_purpose, o_count = owner.split(":", 1)
                if purpose not in o_purpose.split("|"):
                    owners = sum(int(r["used"]) for r in rows if r["purpose"] in o_purpose.split("|"))
                    cap = limit - owners if now.hour >= 20 else limit - int(o_count)
                    allowed = total - owners + LEASE_SIZE <= max(0, cap)
            if allowed:
                conn.execute(
                    """INSERT INTO llm_budget_days (day, model, purpose, used) VALUES (%s, %s, %s, %s)
                       ON CONFLICT (day, model, purpose) DO UPDATE SET used = llm_budget_days.used + EXCLUDED.used, updated_at = now()""",
                    (day, MODEL_NAME, purpose[:40], LEASE_SIZE),
                )
        if not allowed:
            return False
        with _BUDGET_LOCK:
            cur = _LEASES.get((MODEL_NAME, purpose))
            left = (cur["left"] if cur and cur["day"] == day else 0) + LEASE_SIZE - 1
            _LEASES[(MODEL_NAME, purpose)] = {"day": day, "left": left}
        return True
    except Exception:
        return False


def _refund_local(purpose: str, now: datetime | None = None) -> None:
    day = _ledger_day(now or datetime.now(timezone.utc))
    with _BUDGET_LOCK:
        lease = _LEASES.get((MODEL_NAME, purpose))
        if lease and lease["day"] == day:
            lease["left"] += 1


def _validate_answers(questions: dict, raw: object) -> dict[str, dict] | None:
    if not isinstance(raw, dict):
        return None
    ans_map = raw.get("answers") if isinstance(raw.get("answers"), dict) else raw
    if not isinstance(ans_map, dict):
        return None
    out: dict[str, dict] = {}
    for key, q in questions.items():
        item = ans_map.get(key)
        if not isinstance(item, dict):
            return None
        try:
            conf = float(item.get("confidence"))
        except (TypeError, ValueError):
            return None
        if not (0.0 <= conf <= 1.0):
            return None
        qtype = q.get("type")
        if qtype == "noul":
            raw_noul = item.get("noul")
            try:
                val = 1.0 if raw_noul is True else 0.0 if raw_noul is False else float(raw_noul)
            except (TypeError, ValueError):
                return None
            if not (0.0 <= val <= 1.0):
                return None
            out[key] = {"noul": val, "confidence": conf}
        elif qtype == "choice":
            choice = item.get("choice")
            if not isinstance(choice, str) or choice not in (q.get("criteria") or {}):
                return None
            out[key] = {"choice": choice, "confidence": conf}
        elif qtype == "score":
            try:
                score = float(item.get("score"))
            except (TypeError, ValueError):
                return None
            max_idx = max(0, len(q.get("criteria") or []) - 1)
            if not (0.0 <= score <= max_idx):
                return None
            out[key] = {"score": score, "confidence": conf}
        else:
            return None
    return out


def decide(input_text: str, questions: dict, purpose: str, timeout: float = 15.0) -> dict[str, dict] | None:
    """Calls `gemini-decision-1` and returns validated answers, or `None` on failure/budget exhaustion."""
    global _EXHAUSTED_DAY
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    est = _LIMITER.estimate_tokens(input_text, questions)
    if est > _LIMITER.limits()["max_input_tokens"]:
        return None
    if not reserve(purpose):
        return None
    slot = _LIMITER.acquire(est)
    if slot is None:
        _refund_local(purpose)
        return None
    try:
        resp = httpx.post(
            DECISIONS_URL,
            json={"model": MODEL_NAME, "input": input_text, "questions": questions},
            headers={"x-goog-api-key": key},
            timeout=timeout,
        )
        if resp.status_code >= 400:
            _LIMITER.release(slot, 0)
            _refund_local(purpose)
            if resp.status_code == 429:
                _LIMITER.cooldown(61.0)
                txt = resp.text or ""
                if ("per day" in txt.lower() or "daily" in txt.lower()) and "per minute" not in txt.lower():
                    with _BUDGET_LOCK:
                        _EXHAUSTED_DAY = _ledger_day(datetime.now(timezone.utc))
            elif resp.status_code >= 500:
                _LIMITER.cooldown(15.0)
            log.debug("gemini-decision-1 HTTP %s for %s", resp.status_code, purpose)
            return None
        data = resp.json()
        meta = data.get("usageMetadata") or {}
        actual = int(meta.get("promptTokenCount") or meta.get("totalTokenCount") or est)
        _LIMITER.release(slot, actual)
        return _validate_answers(questions, data)
    except Exception as exc:  # noqa: BLE001
        _LIMITER.release(slot, 0)
        _refund_local(purpose)
        _LIMITER.cooldown(15.0)
        log.debug("gemini-decision-1 failed for %s: %s", purpose, type(exc).__name__)
        return None


def classify_category(title: str, body: str, labels: dict[str, str], min_confidence: float = 0.75) -> tuple[str, float] | None:
    """Classifies an uncertain document across taxonomy categories (`choice`), returning `(cat, conf)` if >= threshold."""
    if not labels:
        return None
    criteria = {str(k): f"{k} ({v})" for k, v in labels.items()}
    text = f"TITLE: {title.strip()}\n\nBODY:\n{body[:2500].strip()}"
    ans = decide(
        text,
        {
            "category": {
                "type": "choice",
                "instructions": "Assign the single best primary news category for this article.",
                "criteria": criteria,
            }
        },
        purpose="kb_categorize",
    )
    if not ans:
        return None
    c = ans["category"]
    if c["confidence"] < min_confidence:
        return None
    return str(c["choice"]), float(c["confidence"])


def arbitrate_cluster(
    doc_title: str,
    doc_body: str,
    candidates: list[dict],
    min_confidence: float = 0.80,
) -> tuple[int | None, float] | None:
    """Disambiguates grey-zone event clustering (`event_<id>` vs `new_event`). Returns `(event_id_or_None, conf)`."""
    if not candidates:
        return None
    criteria: dict[str, str] = {}
    for c in candidates[:3]:
        criteria[f"event_{c['id']}"] = (
            f"Same ongoing news event: {c.get('title', '')} (category={c.get('category', '')}, {c.get('hours', 0)}h apart)"
        )[:300]
    criteria["new_event"] = "A distinct news event that should start a separate event cluster"
    text = f"NEW DOCUMENT\nTITLE: {doc_title.strip()}\nEXCERPT: {doc_body[:1200].strip()}"
    ans = decide(
        text,
        {
            "cluster": {
                "type": "choice",
                "instructions": "Does the NEW DOCUMENT report the exact same specific event as one of the candidate events, or a new separate event?",
                "criteria": criteria,
            }
        },
        purpose="kb_cluster",
    )
    if not ans:
        return None
    res = ans["cluster"]
    if res["confidence"] < min_confidence:
        return None
    choice = str(res["choice"])
    if choice == "new_event":
        return None, float(res["confidence"])
    if choice.startswith("event_"):
        try:
            return int(choice[len("event_"):]), float(res["confidence"])
        except ValueError:
            return None
    return None
