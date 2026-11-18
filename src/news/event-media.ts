import { generateJsonWithRouter } from '../common/llm-router';
import {
  buildYoutubeTimecodeUrl,
  extractChaptersFromDescription,
  extractUrlTimecodeSec,
  formatSecondsLabel,
  type VideoTimecode,
} from '../common/video-timecodes';
import type { DatabaseService } from '../database/database.service';
import type { ArticleFigure } from './article-resources';
import { extractYoutubeVideoId } from '../youtube/youtube-channels';

export interface ArticleMediaPlan {
  heroQueryEn: string;
  ambientQueryEn: string;
  commonsQueryEn: string;
  eventVideoQueryEn: string;
  mustMatchTerms: string[];
  preferSource: 'commons' | 'pexels';
  ambientMood: 'dark' | 'cool' | 'warm';
  heroCaptionUk: string;
}

const CATEGORY_FALLBACK_QUERIES: Record<string, { hero: string; ambient: string }> = {
  model: { hero: 'abstract glowing neural network dark', ambient: 'dark blue digital waves minimal' },
  api: { hero: 'server rack blue lights dark', ambient: 'abstract dark circuit board blur' },
  coding: { hero: 'programming code screen dark blur', ambient: 'dark keyboard monitor glow' },
  open_source: { hero: 'developer workspace dark terminal', ambient: 'abstract teal light lines dark' },
  research: { hero: 'modern science laboratory dark blue', ambient: 'microscopic abstract particles dark' },
  cybersecurity: { hero: 'dark server room security glow', ambient: 'abstract digital grid dark' },
  science_space: { hero: 'earth from space night lights', ambient: 'deep space stars nebula dark' },
  hardware_gaming: { hero: 'microchip circuit board macro dark', ambient: 'dark neon hardware blur' },
  robotics: { hero: 'robotic arm factory industrial dark', ambient: 'metallic abstract dark studio' },
  mobility_ev: { hero: 'electric car charging night dark', ambient: 'dark city highway light trails' },
  climate_energy: { hero: 'wind turbines sunset silhouette', ambient: 'dark sky horizon atmosphere' },
  startups_fintech: { hero: 'modern glass skyscraper night', ambient: 'dark blue financial chart blur' },
  finance: { hero: 'financial district skyscrapers night', ambient: 'dark abstract architecture blur' },
  economy: { hero: 'cargo port industrial twilight', ambient: 'dark minimal urban skyline' },
  biotech: { hero: 'biotech laboratory microscope dark', ambient: 'abstract molecular glow dark' },
  defense: { hero: 'radar screen night dark control', ambient: 'dark stormy sky horizon' },
  ai_policy: { hero: 'courthouse columns dramatic lighting', ambient: 'dark marble architecture blur' },
  law: { hero: 'courthouse architecture dramatic dark', ambient: 'dark minimal columns shadow' },
  politics: { hero: 'parliament building twilight', ambient: 'dark architectural silhouette' },
};

const planSchema = {
  type: 'object',
  properties: {
    heroQueryEn: { type: 'string' },
    ambientQueryEn: { type: 'string' },
    commonsQueryEn: { type: 'string' },
    eventVideoQueryEn: { type: 'string' },
    mustMatchTerms: { type: 'array', items: { type: 'string' } },
    preferSource: { type: 'string', enum: ['commons', 'pexels'] },
    ambientMood: { type: 'string', enum: ['dark', 'cool', 'warm'] },
    heroCaptionUk: { type: 'string' },
  },
  required: ['heroQueryEn', 'ambientQueryEn', 'commonsQueryEn', 'eventVideoQueryEn', 'mustMatchTerms', 'preferSource', 'ambientMood', 'heroCaptionUk'],
};

const STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over', 'after', 'about', 'news', 'report', 'update',
  'video', 'photo', 'launch', 'new', '2025', '2026', '2027', 'company', 'official', 'says', 'could', 'will',
]);

export function extractCoreMatchTerms(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_TERMS.has(w));
  return [...new Set(tokens)].slice(0, 6);
}

export function fallbackMediaPlan(news: { category: string; title: string; titleEn?: string | null }): ArticleMediaPlan {
  const cat = CATEGORY_FALLBACK_QUERIES[news.category] ?? {
    hero: 'modern technology abstract dark light',
    ambient: 'deep dark gradient texture minimal',
  };
  const terms = extractCoreMatchTerms(`${news.titleEn || ''} ${news.title}`);
  return {
    heroQueryEn: cat.hero,
    ambientQueryEn: cat.ambient,
    commonsQueryEn: terms.slice(0, 3).join(' '),
    eventVideoQueryEn: '',
    mustMatchTerms: terms,
    preferSource: news.category === 'science_space' || news.category === 'politics' || news.category === 'defense' ? 'commons' : 'pexels',
    ambientMood: 'dark',
    heroCaptionUk: '',
  };
}

/** Cheap AI page director: reads the article and plans hero photo, blurred ambient backdrop, Commons query, and event video query. */
export async function planArticleMediaWithAi(news: {
  category: string;
  title: string;
  titleEn?: string | null;
  summary: string;
  body: string;
}): Promise<ArticleMediaPlan> {
  const fallback = fallbackMediaPlan(news);
  const prompt = `You are the visual director of a news app. Read this article and pick clean, accurate visual search queries.

CATEGORY: ${news.category}
TITLE: ${news.title}${news.titleEn ? `\nORIGINAL TITLE: ${news.titleEn}` : ''}
SUMMARY: ${news.summary.slice(0, 1000)}
ARTICLE EXCERPT:
${(news.body || news.summary).slice(0, 4200)}

Return JSON:
1. "heroQueryEn": 2-4 concrete English words for a clean, atmospheric stock cover photo from Pixabay (priority), Openverse or Pexels (e.g. "rocket launch pad smoke night", "microchip circuit macro dark"). Never use brand names or abstract buzzwords. Stock is a generic illustration, never evidence of the specific event.
2. "ambientQueryEn": 2-4 calm, dark/minimal English words for a subtle blurred background behind text (e.g. "deep space stars dark", "dark blue light waves blur").
3. "commonsQueryEn": 2-4 factual English words for Wikimedia Commons documentary photos of the real object/place/person/rocket/organization (e.g. "ULA Vulcan Centaur rocket"). Empty string if purely abstract.
4. "eventVideoQueryEn": 3-5 English search words for YouTube ONLY if the news describes a real visual event worth footage (rocket launch/explosion, physical crash, hardware demo, keynote, press conference). Otherwise "".
5. "mustMatchTerms": 2-5 specific lowercase keywords/proper nouns (e.g. ["vulcan", "ula", "kuiper"]) that MUST appear in any documentary Commons photo or YouTube video so unrelated footage is rejected.
6. "preferSource": "commons" if real documentary photo fits best (spacecraft, real people, landmarks, specific hardware), else "pexels".
7. "ambientMood": "dark" | "cool" | "warm".
8. "heroCaptionUk": short neutral Ukrainian caption (max 120 chars).`;

  const routed = await generateJsonWithRouter<Partial<ArticleMediaPlan>>({
    task: 'classify',
    prompt,
    schema: planSchema,
    schemaName: 'article_media_plan',
    maxTokens: 450,
    temperature: 0.2,
    timeoutMs: 25_000,
  });
  if (!routed?.data) return fallback;
  const d = routed.data;
  const terms = Array.isArray(d.mustMatchTerms)
    ? d.mustMatchTerms.map((t) => String(t).toLowerCase().trim()).filter((t) => t.length >= 3).slice(0, 6)
    : fallback.mustMatchTerms;

  return {
    heroQueryEn: String(d.heroQueryEn || '').trim().slice(0, 90) || fallback.heroQueryEn,
    ambientQueryEn: String(d.ambientQueryEn || '').trim().slice(0, 90) || fallback.ambientQueryEn,
    commonsQueryEn: String(d.commonsQueryEn || '').trim().slice(0, 90),
    eventVideoQueryEn: String(d.eventVideoQueryEn || '').trim().slice(0, 100),
    mustMatchTerms: terms.length ? terms : fallback.mustMatchTerms,
    preferSource: d.preferSource === 'commons' ? 'commons' : 'pexels',
    ambientMood: d.ambientMood === 'cool' || d.ambientMood === 'warm' ? d.ambientMood : 'dark',
    heroCaptionUk: String(d.heroCaptionUk || '').trim().slice(0, 140),
  };
}

const KEY_MOMENT_RE =
  /\b(explosion|anomaly|failure|failed|crash|abort|liftoff|launch|ignition|separation|impact|breakthrough|demo|reveal|announcement|keynote|moment|incident|вибух|аномалі|запуск|старт)\b/i;

export function selectKeyVideoTimecodes(
  videoId: string,
  chapters: Array<{ timestampSec: number; timestampLabel: string; title: string }>,
  explicitUrlSec?: number | null,
): VideoTimecode[] {
  const out: VideoTimecode[] = [];
  const seen = new Set<number>();

  if (typeof explicitUrlSec === 'number' && explicitUrlSec > 0) {
    seen.add(explicitUrlSec);
    out.push({
      sec: explicitUrlSec,
      label: formatSecondsLabel(explicitUrlSec),
      title: 'Ключовий момент за посиланням статті',
      url: buildYoutubeTimecodeUrl(videoId, explicitUrlSec),
    });
  }

  const prioritized = [...chapters].sort((a, b) => {
    const aHit = KEY_MOMENT_RE.test(a.title) ? 1 : 0;
    const bHit = KEY_MOMENT_RE.test(b.title) ? 1 : 0;
    return bHit - aHit || a.timestampSec - b.timestampSec;
  });

  for (const ch of prioritized) {
    if (seen.has(ch.timestampSec)) continue;
    seen.add(ch.timestampSec);
    out.push({
      sec: ch.timestampSec,
      label: ch.timestampLabel,
      title: ch.title.slice(0, 100),
      url: buildYoutubeTimecodeUrl(videoId, ch.timestampSec),
    });
    if (out.length >= 4) break;
  }

  return out.sort((a, b) => a.sec - b.sec);
}

export function hasWholeTerm(haystack: string, rawTerm: string): boolean {
  const term = rawTerm.trim();
  if (term.length < 2) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** Verifies a candidate YouTube video actually covers the specific news event (prevents wrong-rocket / clickbait mismatches). */
export function verifyYoutubeVideoMatchesEvent(
  candidate: { title: string; description: string; channelTitle?: string },
  mustMatchTerms: string[],
): boolean {
  const uniqueTerms = [...new Set(mustMatchTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2))];
  if (uniqueTerms.length === 0) return false;
  const hay = `${candidate.title} ${candidate.description.slice(0, 1200)} ${candidate.channelTitle || ''}`;
  let hits = 0;
  for (const term of uniqueTerms) {
    if (hasWholeTerm(hay, term)) hits += 1;
  }
  const requiredHits = uniqueTerms.length >= 2 ? 2 : 1;
  return hits >= requiredHits;
}

interface YoutubeVideosApiResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      description?: string;
      channelTitle?: string;
      publishedAt?: string;
      thumbnails?: { high?: { url?: string }; medium?: { url?: string } };
    };
  }>;
}

export async function fetchYoutubeVideoDetails(
  videoIds: string[],
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, { title: string; description: string; channelTitle: string; thumbnailUrl: string | null }>> {
  const out = new Map<string, { title: string; description: string; channelTitle: string; thumbnailUrl: string | null }>();
  const unique = [...new Set(videoIds.filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, 8);
  if (!apiKey || unique.length === 0) return out;

  const params = new URLSearchParams({ part: 'snippet', id: unique.join(','), key: apiKey });
  try {
    const resp = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?${params}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return out;
    }
    const json = (await resp.json()) as YoutubeVideosApiResponse;
    for (const item of json.items ?? []) {
      if (!item.id || !item.snippet?.title) continue;
      out.set(item.id, {
        title: item.snippet.title,
        description: item.snippet.description || '',
        channelTitle: item.snippet.channelTitle || 'YouTube',
        thumbnailUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || null,
      });
    }
  } catch {
    // ignore transient lookup failures
  }
  return out;
}

export interface SearchEventVideoOptions {
  query: string;
  mustMatchTerms: string[];
  publishedAt?: string | Date | null;
  db?: DatabaseService;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Finds strictly verified event videos with real timecodes:
 *  1. Transcribed/analysed videos already in our `youtube_videos` table (with real chapters + timestamped quotes);
 *  2. Verified YouTube Data API search scoped to the event's time window and core entity terms.
 */
export async function searchVerifiedEventVideos(options: SearchEventVideoOptions): Promise<ArticleFigure[]> {
  const results: ArticleFigure[] = [];
  const seenVideoIds = new Set<string>();
  const terms = options.mustMatchTerms.map((t) => t.toLowerCase().trim()).filter((t) => t.length >= 3);
  if (terms.length === 0) return results;

  // 1) Check our curated/transcribed YouTube radar first (zero extra API quota, richest timecodes).
  if (options.db) {
    const { rows } = await options.db
      .query<{
        video_id: string;
        url: string;
        title: string;
        title_uk: string | null;
        channel_name: string;
        thumbnail_url: string | null;
        chapters: Array<{ timestampSec: number; timestampLabel: string; title: string }> | null;
        timestamped_quotes: Array<{ timestampSec: number; timestampLabel: string; insightUk: string }> | null;
      }>(
        `SELECT video_id, url, title, title_uk, channel_name, thumbnail_url, chapters, timestamped_quotes
         FROM youtube_videos
         WHERE published_at >= now() - interval '7 days'
           AND status IN ('transcribed', 'ready', 'published')
         ORDER BY worth_score DESC, published_at DESC
         LIMIT 60`,
      )
      .catch(() => ({ rows: [] }));

    for (const r of rows) {
      if (seenVideoIds.has(r.video_id)) continue;
      if (!verifyYoutubeVideoMatchesEvent({ title: `${r.title} ${r.title_uk || ''}`, description: '', channelTitle: r.channel_name }, terms)) {
        continue;
      }
      const quoteChapters = (r.timestamped_quotes ?? []).map((q) => ({
        timestampSec: q.timestampSec,
        timestampLabel: q.timestampLabel,
        title: q.insightUk,
      }));
      const mergedChapters = [...quoteChapters, ...(r.chapters ?? [])];
      const timecodes = selectKeyVideoTimecodes(r.video_id, mergedChapters);
      const bestLink = timecodes[0]?.url || r.url;
      seenVideoIds.add(r.video_id);
      results.push({
        id: '',
        kind: 'video',
        url: r.thumbnail_url || `https://i.ytimg.com/vi/${r.video_id}/hqdefault.jpg`,
        caption: r.title_uk || r.title,
        credit: `${r.channel_name} / YouTube`,
        link: bestLink,
        match: terms.slice(0, 4),
        position: 0.25,
        origin: 'youtube_search',
        verified: true,
        ...(timecodes.length ? { timecodes } : {}),
      });
      if (results.length >= 2) return results;
    }
  }

  // 2) YouTube Data API v3 event search with strict title+description verification + chapter timecodes.
  const apiKey = (options.apiKey ?? process.env.YOUTUBE_API_KEY ?? '').trim();
  const cleanQuery = options.query.replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
  if (!apiKey || cleanQuery.length < 4) return results;

  const fetchImpl = options.fetchFn ?? fetch;
  const refMs = options.publishedAt ? new Date(options.publishedAt).getTime() : Date.now();
  const safeRefMs = Number.isFinite(refMs) ? refMs : Date.now();
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    q: cleanQuery,
    maxResults: '5',
    order: 'relevance',
    publishedAfter: new Date(safeRefMs - 5 * 86_400_000).toISOString(),
    publishedBefore: new Date(safeRefMs + 3 * 86_400_000).toISOString(),
    safeSearch: 'strict',
    key: apiKey,
  });

  try {
    const resp = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${params}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return results;
    }
    const json = (await resp.json()) as {
      items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>;
    };
    const ids = (json.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => Boolean(v));
    const detailsMap = await fetchYoutubeVideoDetails(ids, apiKey, fetchImpl);

    for (const vid of ids) {
      if (seenVideoIds.has(vid)) continue;
      const d = detailsMap.get(vid);
      if (!d || !verifyYoutubeVideoMatchesEvent(d, terms)) continue;

      const chapters = extractChaptersFromDescription(d.description);
      const timecodes = selectKeyVideoTimecodes(vid, chapters);
      const bestLink = timecodes[0]?.url || buildYoutubeTimecodeUrl(vid, 0);
      seenVideoIds.add(vid);
      results.push({
        id: '',
        kind: 'video',
        url: d.thumbnailUrl || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        caption: d.title,
        credit: `${d.channelTitle} / YouTube`,
        link: bestLink,
        match: terms.slice(0, 4),
        position: 0.25,
        origin: 'youtube_search',
        verified: true,
        ...(timecodes.length ? { timecodes } : {}),
      });
      if (results.length >= 2) break;
    }
  } catch {
    // ignore transient search errors
  }

  return results;
}

export function attachUrlTimecodeToVideoFigure(
  figure: ArticleFigure,
  rawVideoUrl: string,
  description?: string,
  explicitSecOverride?: number,
): ArticleFigure {
  const vid = extractYoutubeVideoId(rawVideoUrl);
  if (!vid) return figure;
  const explicitSec = explicitSecOverride ?? extractUrlTimecodeSec(rawVideoUrl);
  const chapters = description ? extractChaptersFromDescription(description) : [];
  const timecodes = selectKeyVideoTimecodes(vid, chapters, explicitSec);
  if (timecodes.length === 0) return figure;
  const primaryUrl = explicitSec ? buildYoutubeTimecodeUrl(vid, explicitSec) : timecodes[0]?.url || figure.link;
  return {
    ...figure,
    link: primaryUrl,
    timecodes,
    verified: true,
  };
}
