"""Video worker (`python -m kb video`).

The backend's YouTube radar scores new videos and, with KB_VIDEO_WORKER=true, queues the worthy ones
(youtube_videos.status = 'queued_kb') instead of sending the link to Gemini. For each queued video:

  1. text, cheapest first (media.py): uploaded subtitles -> automatic captions -> FFmpeg+VAD+speed-up audio
     transcribed by Gemini Flash-Lite with original timecodes -> whisper.cpp base as the fallback;
  2. the transcript becomes a kb.documents row (kind 'transcript', "[mm:ss] text" paragraphs): the algorithmic NLP
     pipeline (NER, linking, rule claims, facts, clustering into events) treats it like any other document;
  3. ONE Flash-Lite call reads the transcript and returns the editorial summary for the radar (title/summary/
     takeaways/timestamped quotes) and the statements with timecodes -> kb.video_claims. Never analysed twice.

At most KB_VIDEO_DAILY videos a day (default 30). Rows stuck in 'kb_processing' for 3 hours are re-queued.
"""
from __future__ import annotations

import logging
import os
import shutil
import tempfile
import time

from .. import db
from ..connectors.base import add_document, entity_by_name
from ..text.normalize import canonical_url, clean_text, word_count
from . import gemini, media

log = logging.getLogger(__name__)
DAILY = int(os.environ.get("KB_VIDEO_DAILY", "30"))
MAX_ATTEMPTS = 3
PART_S = int(os.environ.get("KB_VIDEO_PART_SECONDS", "1500"))
TRANSCRIBE_MODELS = "gemini-3.1-flash-lite,gemini-2.5-flash-lite"
ANALYZE_MODELS = "gemini-3.1-flash-lite,gemini-2.5-flash-lite"
MAX_TRANSCRIPT_CHARS = int(os.environ.get("KB_VIDEO_MAX_CHARS", "600000"))  # ~150-200k tokens, under the 250k input cap

TRANSCRIBE_SYSTEM = (
    "You transcribe audio verbatim in its original language (do not translate, do not summarise). The audio had long "
    "pauses removed and may be slightly sped up. Return JSON {\"segments\": [{\"t\": seconds from the start of THIS audio "
    "file (number), \"speaker\": short name or role if clear else \"\", \"text\": what was said}]}. One segment per "
    "sentence or short group of sentences, in order, covering the whole audio. Numbers exactly as spoken.")
TRANSCRIBE_SCHEMA = {"type": "object", "properties": {"segments": {"type": "array", "items": {"type": "object", "properties": {
    "t": {"type": "number"}, "speaker": {"type": "string"}, "text": {"type": "string"}}, "required": ["t", "text"]}}},
    "required": ["segments"]}

ANALYZE_SYSTEM = (
    "You are an analyst of a Ukrainian news service. Read the video transcript (timecodes in [mm:ss] are original video "
    "time) and return JSON. worthKeeping=false for clickbait, ads or content without verifiable substance. Ukrainian texts "
    "(titleUk, summaryUk 3-6 sentences, whyItMattersUk, keyTakeawaysUk up to 6). timestampedQuotes: up to 6 key moments "
    "{timestampSec, speaker, insightUk}. claims: up to 40 concrete statements that can be checked or tracked - facts, "
    "numbers, plans, predictions, accusations, denials - each {t: seconds, speaker: who says it (full name if known), "
    "text: the statement in Ukrainian, self-contained, quote: exact words in the original language (short), modality: "
    "fact|plan|claim|speculation|denial|question, value: number if the claim has one else null, unit}. Use only what is "
    "said in the transcript; never add outside knowledge.")
ANALYZE_SCHEMA = {
    "type": "object",
    "properties": {
        "worthKeeping": {"type": "boolean"}, "titleUk": {"type": "string"}, "summaryUk": {"type": "string"},
        "whyItMattersUk": {"type": "string"}, "keyTakeawaysUk": {"type": "array", "items": {"type": "string"}},
        "importance": {"type": "string", "enum": ["high", "medium", "low"]},
        "timestampedQuotes": {"type": "array", "items": {"type": "object", "properties": {
            "timestampSec": {"type": "number"}, "speaker": {"type": "string"}, "insightUk": {"type": "string"}}}},
        "claims": {"type": "array", "items": {"type": "object", "properties": {
            "t": {"type": "number"}, "speaker": {"type": "string"}, "text": {"type": "string"}, "quote": {"type": "string"},
            "modality": {"type": "string", "enum": ["fact", "plan", "claim", "speculation", "denial", "question"]},
            "value": {"type": "number", "nullable": True}, "unit": {"type": "string"}}, "required": ["t", "text", "modality"]}},
    },
    "required": ["worthKeeping", "titleUk", "summaryUk", "claims"],
}


def claim_next() -> dict | None:
    db.execute("""UPDATE youtube_videos SET status = 'queued_kb' WHERE status = 'kb_processing'
                  AND updated_at < now() - interval '3 hours' AND kb_attempts < %s""", (MAX_ATTEMPTS,))
    done_today = db.fetch_one("""SELECT count(*) AS n FROM youtube_videos WHERE transcript_source IS NOT NULL
                                 AND transcribed_at >= date_trunc('day', now())""")["n"]
    if done_today >= DAILY:
        return None
    with db.tx() as conn:
        row = conn.execute(
            """SELECT * FROM youtube_videos WHERE status IN ('kb_analysis_pending', 'queued_kb') AND kb_attempts < %s
               ORDER BY (status = 'kb_analysis_pending') DESC, worth_score DESC, published_at DESC
               LIMIT 1 FOR UPDATE SKIP LOCKED""", (MAX_ATTEMPTS,)).fetchone()
        if not row:
            return None
        conn.execute("""UPDATE youtube_videos SET status = 'kb_processing', kb_attempts = kb_attempts + 1, updated_at = now()
                        WHERE video_id = %s""", (row["video_id"],))
    return dict(row)


def transcribe(video: dict, workdir: str) -> tuple[list[media.Segment], str]:
    url = video["url"]
    subs = media.fetch_subtitles(url, workdir)
    if subs:
        return subs
    wav = media.download_wav(url, workdir)
    try:
        opus, tmap = media.compress_audio(wav, workdir)
        segs: list[media.Segment] = []
        for part, offset in media.split_opus(opus, workdir, PART_S):
            res = gemini.generate_json(gemini.models("KB_VIDEO_TRANSCRIBE_MODELS", TRANSCRIBE_MODELS), "kb_video_asr",
                                       [gemini.audio_part(part), {"text": "Transcribe this audio."}], TRANSCRIBE_SYSTEM,
                                       TRANSCRIBE_SCHEMA, timeout=900)
            for s in res["json"].get("segments") or []:
                text = str(s.get("text") or "").strip()
                if text:
                    who = str(s.get("speaker") or "").strip()
                    segs.append((tmap.original(offset + float(s.get("t") or 0)), f"{who}: {text}" if who else text))
        segs.sort(key=lambda x: x[0])
        if sum(len(t) for _, t in segs) < 200:
            raise RuntimeError("empty Gemini transcript")
        return media.merge_segments(segs), "gemini_audio"
    except Exception as exc:  # noqa: BLE001 - budget, API or FFmpeg trouble -> local whisper.cpp on the original audio
        log.info("video %s: Gemini path unavailable (%s), using whisper.cpp", video["video_id"], type(exc).__name__)
        return media.whisper_transcribe(wav, workdir), "whisper"


def store_document(video: dict, segs: list[media.Segment], source: str) -> int:
    body = media.transcript_body(segs)
    meta = {"video_id": video["video_id"], "channel": video["channel_name"], "transcript_source": source,
            "timecodes": True, "duration_hint": video.get("estimated_duration_sec")}
    title = f"{video['channel_name']}: {video['title']}"
    doc_id = add_document(video.get("channel_slug") or "", "transcript", video["url"], title, body,
                          published_at=video["published_at"], meta=meta)
    if doc_id:
        return doc_id
    # the page was already collected as a document (e.g. from the channel RSS): give it the transcript and re-analyse
    body = clean_text(body)
    row = db.fetch_one(
        """UPDATE kb.documents SET kind = 'transcript', body = %s, word_count = %s, extraction_status = 'full',
                  extraction_method = 'transcript', stage = 'extracted', meta = meta || %s::jsonb
           WHERE canonical_url = %s RETURNING id""",
        (body, word_count(body), db.jsonb(meta), canonical_url(video["url"])))
    return row["id"]


def analyze(video: dict, doc_id: int) -> None:
    body = db.fetch_one("SELECT body FROM kb.documents WHERE id = %s", (doc_id,))["body"] or ""
    prompt = (f"Channel: {video['channel_name']}\nTitle: {video['title']}\nPublished: {video['published_at']}\n"
              f"Description: {(video.get('description') or '')[:2000]}\n\nTRANSCRIPT\n{body[:MAX_TRANSCRIPT_CHARS]}")
    res = gemini.generate_json(gemini.models("KB_VIDEO_ANALYZE_MODELS", ANALYZE_MODELS), "kb_video_analysis",
                               [{"text": prompt}], ANALYZE_SYSTEM, ANALYZE_SCHEMA, timeout=600)
    out = res["json"]
    quotes = []
    for q in (out.get("timestampedQuotes") or [])[:6]:
        t = max(0, int(float(q.get("timestampSec") or 0)))
        if len(str(q.get("insightUk") or "")) > 5:
            quotes.append({"timestampSec": t, "timestampLabel": media.fmt_tc(t), "speaker": str(q.get("speaker") or "Спікер")[:80],
                           "insightUk": str(q["insightUk"])[:400]})
    with db.tx() as conn:
        conn.execute("DELETE FROM kb.video_claims WHERE document_id = %s", (doc_id,))
        for c in (out.get("claims") or [])[:40]:
            text = str(c.get("text") or "").strip()
            if len(text) < 8:
                continue
            speaker = str(c.get("speaker") or "").strip()[:200] or None
            conn.execute(
                """INSERT INTO kb.video_claims (document_id, t_sec, speaker, speaker_entity_id, text, quote, modality, value_num, value_unit)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (doc_id, max(0, int(float(c.get("t") or 0))), speaker,
                 entity_by_name(speaker, ["person", "organization", "government", "company"]) if speaker else None,
                 text[:1000], (str(c.get("quote") or "")[:500] or None),
                 c.get("modality") if c.get("modality") in ("fact", "plan", "claim", "speculation", "denial", "question") else "claim",
                 c.get("value") if isinstance(c.get("value"), (int, float)) else None, (str(c.get("unit") or "")[:24] or None)))
        conn.execute(
            """UPDATE youtube_videos SET status = %s, title_uk = %s, summary_uk = %s, why_it_matters_uk = %s,
                      key_takeaways_uk = %s::jsonb, timestamped_quotes = %s::jsonb, importance = %s,
                      transcription_provider = %s, kb_error = NULL, updated_at = now() WHERE video_id = %s""",
            ("transcribed" if out.get("worthKeeping", True) else "skipped_low_value", str(out.get("titleUk") or "")[:500] or None,
             out.get("summaryUk"), out.get("whyItMattersUk"), db.jsonb([str(x)[:350] for x in (out.get("keyTakeawaysUk") or [])[:6]]),
             db.jsonb(quotes), out.get("importance") if out.get("importance") in ("high", "medium", "low") else "medium",
             f"kb_{video.get('transcript_source') or 'video'}"[:40], video["video_id"]))


def process(video: dict) -> str:
    workdir = tempfile.mkdtemp(prefix="kbvideo-")
    try:
        doc_id = video.get("kb_document_id")
        if not doc_id:
            segs, source = transcribe(video, workdir)
            doc_id = store_document(video, segs, source)
            video["transcript_source"] = source
            db.execute("""UPDATE youtube_videos SET kb_document_id = %s, transcript_source = %s, transcribed_at = now(),
                          status = 'kb_analysis_pending', updated_at = now() WHERE video_id = %s""",
                       (doc_id, source, video["video_id"]))
        try:
            analyze(video, doc_id)
            return "analyzed"
        except gemini.BudgetExhausted:
            # the transcript is already in the KB; the single analysis waits for budget (no re-transcription)
            db.execute("""UPDATE youtube_videos SET status = 'kb_analysis_pending', kb_attempts = kb_attempts - 1,
                          kb_error = 'waiting for LLM budget', updated_at = now() WHERE video_id = %s""", (video["video_id"],))
            return "waiting"
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def run_forever(idle_s: int = 120) -> None:
    from ..config import settings  # noqa: F401 - validates env

    log.info("video worker started (daily cap %s)", DAILY)
    while True:
        video = claim_next()
        if not video:
            time.sleep(idle_s)
            continue
        try:
            state = process(video)
            log.info("video %s: %s", video["video_id"], state)
            if state == "waiting":
                time.sleep(idle_s * 5)
        except Exception as exc:  # noqa: BLE001
            log.warning("video %s failed: %s", video["video_id"], exc)
            db.execute("""UPDATE youtube_videos SET status = CASE WHEN kb_attempts >= %s THEN 'kb_failed' ELSE 'queued_kb' END,
                          kb_error = %s, updated_at = now() WHERE video_id = %s""",
                       (MAX_ATTEMPTS, str(exc)[:500], video["video_id"]))
