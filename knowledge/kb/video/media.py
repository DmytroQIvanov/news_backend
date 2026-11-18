"""Getting text out of a video, cheapest first.

1. subtitles  yt-dlp downloads uploaded subtitles (best) or YouTube's automatic captions; no audio, no LLM.
2. audio      yt-dlp bestaudio -> FFmpeg 16 kHz mono WAV -> WebRTC VAD keeps speech, pauses longer than
              KB_VIDEO_MAX_PAUSE are removed -> FFmpeg atempo KB_VIDEO_SPEED (1.0-1.25) -> Opus 24 kbit/s.
              A TimeMap remembers where every piece of the compressed audio came from, so timecodes that the
              transcriber returns are mapped back to the ORIGINAL video time.
3. whisper    whisper.cpp (base model) on the original WAV when Gemini is unavailable or out of budget.

Everything returns segments [(start_seconds_in_original_video, text)].
"""
from __future__ import annotations

import bisect
import glob
import json
import os
import re
import subprocess
import wave
from dataclasses import dataclass

Segment = tuple[float, str]
FFMPEG = os.environ.get("KB_FFMPEG", "ffmpeg")
MAX_PAUSE = float(os.environ.get("KB_VIDEO_MAX_PAUSE", "0.8"))
SPEED = min(1.25, max(1.0, float(os.environ.get("KB_VIDEO_SPEED", "1.2"))))
SUB_LANGS = os.environ.get("KB_VIDEO_SUB_LANGS", "uk,en,ru,uk-orig,en-orig,ru-orig")


# --------------------------------------------------------------------------------------------------- subtitles --

_TS = re.compile(r"(\d+):(\d{2}):(\d{2})[.,](\d{3})|(\d{2}):(\d{2})[.,](\d{3})")
_TAG = re.compile(r"<[^>]+>")


def _ts(s: str) -> float:
    m = _TS.search(s)
    if not m:
        return 0.0
    if m.group(1):
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3)) + int(m.group(4)) / 1000
    return int(m.group(5)) * 60 + int(m.group(6)) + int(m.group(7)) / 1000


def parse_vtt(text: str) -> list[Segment]:
    """WebVTT -> segments. YouTube automatic captions repeat each line in the next cue ("rolling" captions):
    only the new words of every cue are kept."""
    out: list[Segment] = []
    seen_tail = ""
    for block in re.split(r"\n\s*\n", text.replace("\r", "")):
        lines = [l for l in block.split("\n") if l.strip()]
        idx = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if idx is None:
            continue
        start = _ts(lines[idx].split("-->")[0])
        body = " ".join(_TAG.sub("", l).strip() for l in lines[idx + 1:]).strip()
        body = re.sub(r"\s+", " ", body.replace("&nbsp;", " ").replace("&amp;", "&"))
        if not body:
            continue
        if seen_tail and body.startswith(seen_tail):
            new = body[len(seen_tail):].strip()
        elif out and body == out[-1][1]:
            new = ""
        else:
            new = body
        seen_tail = body
        if new:
            out.append((start, new))
    return merge_segments(out)


def merge_segments(segs: list[Segment], window: float = 20.0) -> list[Segment]:
    """Join short caption pieces into ~20 s paragraphs (timecode of the first piece)."""
    out: list[Segment] = []
    for t, text in segs:
        gap = t - out[-1][0] if out else None
        if gap is not None and (gap < window / 3 or (gap < window and not out[-1][1].endswith((".", "?", "!")))):
            out[-1] = (out[-1][0], f"{out[-1][1]} {text}")
        else:
            out.append((t, text))
    return out


def run(cmd: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)


def ytdlp_base() -> list[str]:
    cmd = ["yt-dlp", "--no-playlist", "--no-warnings", "--quiet", "--socket-timeout", "30"]
    if os.environ.get("KB_YTDLP_PROXY"):
        cmd += ["--proxy", os.environ["KB_YTDLP_PROXY"]]
    return cmd


def fetch_subtitles(url: str, workdir: str, lang_hint: str | None = None) -> tuple[list[Segment], str] | None:
    """Uploaded subtitles first, then automatic captions. Returns (segments, 'subtitles' | 'auto_subtitles')."""
    langs = SUB_LANGS if not lang_hint else f"{lang_hint},{SUB_LANGS}"
    for flag, kind in (("--write-subs", "subtitles"), ("--write-auto-subs", "auto_subtitles")):
        for f in glob.glob(os.path.join(workdir, "sub*.vtt")):
            os.unlink(f)
        run(ytdlp_base() + ["--skip-download", flag, "--sub-langs", langs, "--sub-format", "vtt",
                            "-o", os.path.join(workdir, "sub.%(ext)s"), url], timeout=180)
        files = glob.glob(os.path.join(workdir, "sub*.vtt"))
        if not files:
            continue
        order = [l.strip() for l in langs.split(",")]
        files.sort(key=lambda f: next((i for i, l in enumerate(order) if f.endswith(f".{l}.vtt")), 99))
        with open(files[0], encoding="utf-8", errors="replace") as fh:
            segs = parse_vtt(fh.read())
        if sum(len(t) for _, t in segs) >= 200:
            return segs, kind
    return None


# ------------------------------------------------------------------------------------------------------- audio --

def download_wav(url: str, workdir: str) -> str:
    """bestaudio -> 16 kHz mono 16-bit WAV (the format both the VAD and whisper.cpp need)."""
    tmpl = os.path.join(workdir, "audio.%(ext)s")
    r = run(ytdlp_base() + ["-f", "bestaudio/best", "-o", tmpl, url], timeout=1800)
    src = next(iter(glob.glob(os.path.join(workdir, "audio.*"))), None)
    if not src:
        raise RuntimeError(f"yt-dlp: no audio ({(r.stderr or '')[-200:].strip()})")
    wav = os.path.join(workdir, "speech16k.wav")
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", wav], timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg: {(r.stderr or '')[-200:].strip()}")
    os.unlink(src)
    return wav


def speech_regions(pcm: bytes, rate: int = 16000, aggressiveness: int = 2, frame_ms: int = 30,
                   pad: float = 0.2, max_pause: float = MAX_PAUSE) -> list[tuple[float, float]]:
    """WebRTC VAD over 30 ms frames -> speech regions (seconds), padded, joined when the pause is shorter than max_pause."""
    import webrtcvad  # type: ignore

    vad = webrtcvad.Vad(aggressiveness)
    n = int(rate * frame_ms / 1000) * 2
    flags = [vad.is_speech(pcm[i:i + n], rate) for i in range(0, len(pcm) - n + 1, n)]
    return regions_from_flags(flags, frame_ms / 1000, pad, max_pause, len(pcm) / 2 / rate)


def regions_from_flags(flags: list[bool], frame_s: float, pad: float, max_pause: float, total: float) -> list[tuple[float, float]]:
    raw: list[list[float]] = []
    for i, sp in enumerate(flags):
        if not sp:
            continue
        t = i * frame_s
        if raw and t - raw[-1][1] <= max_pause:
            raw[-1][1] = t + frame_s
        else:
            raw.append([t, t + frame_s])
    out: list[tuple[float, float]] = []
    for a, b in raw:
        a, b = max(0.0, a - pad), min(total, b + pad)
        if b - a < 0.25:
            continue
        if out and a <= out[-1][1]:
            out[-1] = (out[-1][0], b)
        else:
            out.append((a, b))
    return out


@dataclass
class TimeMap:
    """Compressed-audio time -> original-video time."""
    regions: list[tuple[float, float]]
    speed: float

    def __post_init__(self) -> None:
        self.starts: list[float] = []
        acc = 0.0
        for a, b in self.regions:
            self.starts.append(acc)
            acc += b - a
        self.total = acc

    def original(self, t: float) -> float:
        if not self.regions:
            return t
        c = max(0.0, t * self.speed)
        i = max(0, bisect.bisect_right(self.starts, c) - 1)
        a, b = self.regions[i]
        return round(min(b, a + (c - self.starts[i])), 1)


def compress_audio(wav: str, workdir: str, speed: float = SPEED) -> tuple[str, TimeMap]:
    """Speech-only Opus file plus the map back to the original timeline."""
    with wave.open(wav, "rb") as w:
        rate = w.getframerate()
        pcm = w.readframes(w.getnframes())
    regions = speech_regions(pcm, rate)
    speech = os.path.join(workdir, "speech_only.wav")
    with wave.open(speech, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        for a, b in regions:
            out.writeframes(pcm[int(a * rate) * 2:int(b * rate) * 2])
    opus = os.path.join(workdir, "speech.ogg")
    af = [] if speed <= 1.0 else ["-af", f"atempo={speed:.2f}"]
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", speech, *af, "-ac", "1", "-c:a", "libopus", "-b:a", "24k",
             "-application", "voip", opus], timeout=1800)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg opus: {(r.stderr or '')[-200:].strip()}")
    os.unlink(speech)
    return opus, TimeMap(regions, speed)


def split_opus(opus: str, workdir: str, part_s: int) -> list[tuple[str, float]]:
    """Cut the compressed audio into parts of part_s seconds (inline Gemini requests stay small). [(path, offset)]."""
    r = run([FFMPEG, "-y", "-loglevel", "error", "-i", opus, "-f", "segment", "-segment_time", str(part_s), "-c", "copy",
             os.path.join(workdir, "part%03d.ogg")], timeout=600)
    if r.returncode != 0:
        return [(opus, 0.0)]
    parts = sorted(glob.glob(os.path.join(workdir, "part*.ogg")))
    return [(p, i * part_s) for i, p in enumerate(parts)] or [(opus, 0.0)]


# ----------------------------------------------------------------------------------------------------- whisper --

def whisper_transcribe(wav: str, workdir: str, lang: str = "auto") -> list[Segment]:
    """whisper.cpp CLI on the original 16 kHz WAV: timestamps are already in original time."""
    binary = os.environ.get("KB_WHISPER_BIN", "whisper-cli")
    model = os.environ.get("KB_WHISPER_MODEL", "/opt/whisper/ggml-base.bin")
    out = os.path.join(workdir, "whisper")
    r = run([binary, "-m", model, "-f", wav, "-l", lang, "-t", os.environ.get("KB_WHISPER_THREADS", "4"), "-oj", "-of", out,
             "-np"], timeout=4 * 3600)
    if r.returncode != 0 or not os.path.exists(out + ".json"):
        raise RuntimeError(f"whisper.cpp failed: {(r.stderr or '')[-200:].strip()}")
    with open(out + ".json", encoding="utf-8", errors="replace") as fh:
        return parse_whisper_json(json.load(fh))


def parse_whisper_json(data: dict) -> list[Segment]:
    segs = [((s.get("offsets") or {}).get("from", 0) / 1000, (s.get("text") or "").strip()) for s in data.get("transcription") or []]
    return merge_segments([(t, x) for t, x in segs if x])


def fmt_tc(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60:02d}:{t % 60:02d}"


def transcript_body(segs: list[Segment]) -> str:
    return "\n\n".join(f"[{fmt_tc(t)}] {text}" for t, text in segs)
