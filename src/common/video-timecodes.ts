export interface YoutubeChapter {
  timestampSec: number;
  timestampLabel: string;
  title: string;
}

export interface VideoTimecode {
  sec: number;
  label: string;
  title: string;
  url: string;
}

export function formatSecondsLabel(totalSec: number): string {
  const safe = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function extractChaptersFromDescription(description: string): YoutubeChapter[] {
  if (!description) return [];
  const chapters: YoutubeChapter[] = [];
  const seenSec = new Set<number>();
  const lines = description.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(?:[-*•]\s*)?\[?(\d{1,2}:)?(\d{1,2}):(\d{2})\]?\s*[-–—:|]?\s*(.+)$/.exec(line);
    if (!match) continue;
    const hours = match[1] ? Number.parseInt(match[1].replace(':', ''), 10) : 0;
    const mins = Number.parseInt(match[2], 10);
    const secs = Number.parseInt(match[3], 10);
    if (!Number.isFinite(hours) || !Number.isFinite(mins) || !Number.isFinite(secs) || mins >= 60 || secs >= 60) {
      continue;
    }
    const timestampSec = hours * 3600 + mins * 60 + secs;
    const title = match[4].replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!title || seenSec.has(timestampSec)) continue;
    seenSec.add(timestampSec);
    chapters.push({
      timestampSec,
      timestampLabel: formatSecondsLabel(timestampSec),
      title,
    });
  }

  return chapters.sort((a, b) => a.timestampSec - b.timestampSec).slice(0, 40);
}

/** Parses ?t=125, ?t=2m5s, ?start=125 or #t=90 from a YouTube URL. */
export function extractUrlTimecodeSec(rawUrl: string): number | null {
  try {
    const u = new URL(rawUrl);
    const raw = u.searchParams.get('t') || u.searchParams.get('start') || u.hash.replace(/^#t=/, '');
    if (!raw) return null;
    if (/^\d+s?$/.test(raw)) {
      const sec = Number.parseInt(raw, 10);
      return Number.isFinite(sec) && sec > 0 && sec < 86_400 ? sec : null;
    }
    const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw);
    if (!hms) return null;
    const sec =
      (hms[1] ? Number.parseInt(hms[1], 10) * 3600 : 0) +
      (hms[2] ? Number.parseInt(hms[2], 10) * 60 : 0) +
      (hms[3] ? Number.parseInt(hms[3], 10) : 0);
    return sec > 0 && sec < 86_400 ? sec : null;
  } catch {
    return null;
  }
}

export function buildYoutubeTimecodeUrl(videoId: string, sec: number): string {
  const cleanSec = Math.max(0, Math.floor(sec));
  return cleanSec > 0
    ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${cleanSec}s`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}
