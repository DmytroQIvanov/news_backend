/**
 * Network side of article resources: verifies links and fills previews through official public APIs
 * (GitHub, Hugging Face, arXiv, Crossref, YouTube oEmbed) or the page's own Open Graph tags,
 * and finds freely licensed Wikimedia Commons photos for stories that have no picture at all.
 * Every request goes to a validated public host with an honest User-Agent and a short timeout.
 */
import { getHonestUserAgent, resolveAndValidatePublicUrl } from '../common/source-compliance';
import { ArticleFigure, ArticleResource, hostOf, isFreeLicense, parsePagePreview, youtubeVideoId } from './article-resources';
import { normalizeImageUrl, stripTags } from './image-extraction';

export type HtmlFetcher = (url: string) => Promise<string | null>;

const MAX_JSON_BYTES = 400_000;

export async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const safe = await resolveAndValidatePublicUrl(url).catch(() => ({ safe: false }));
  if (!safe.safe) return null;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': getHonestUserAgent(), Accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(7_000),
      redirect: 'follow',
    });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    const text = await resp.text();
    if (text.length > MAX_JSON_BYTES) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fetchText(url: string, accept: string): Promise<string | null> {
  const safe = await resolveAndValidatePublicUrl(url).catch(() => ({ safe: false }));
  if (!safe.safe) return null;
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': getHonestUserAgent(), Accept: accept }, signal: AbortSignal.timeout(7_000) });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return null;
    }
    return (await resp.text()).slice(0, MAX_JSON_BYTES);
  } catch {
    return null;
  }
}

/** HEAD (then a 1-byte GET) to check that a link still resolves. Linking needs no page content. */
export async function isReachable(url: string): Promise<boolean | null> {
  const safe = await resolveAndValidatePublicUrl(url).catch(() => ({ safe: false }));
  if (!safe.safe) return false;
  const attempt = async (method: 'HEAD' | 'GET') => {
    const resp = await fetch(url, {
      method,
      headers: { 'User-Agent': getHonestUserAgent(), ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) },
      signal: AbortSignal.timeout(6_000),
      redirect: 'follow',
    });
    await resp.body?.cancel().catch(() => undefined);
    return resp.status;
  };
  try {
    let status = await attempt('HEAD');
    if (status === 405 || status === 403 || status === 501) status = await attempt('GET');
    if (status === 404 || status === 410) return false;
    if (status >= 200 && status < 400) return true;
    return null; // 401/403/429/5xx: the link exists but the site refuses bots, so keep it unverified
  } catch {
    return null;
  }
}

function githubToken(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fills title/description/image for one resource. Returns null when the link is dead
 * (or, for identifiers found in plain text, when the API says it does not exist).
 */
export async function enrichResource(resource: ArticleResource, fetchHtml: HtmlFetcher): Promise<ArticleResource | null> {
  const now = new Date().toISOString();
  let u: URL;
  try {
    u = new URL(resource.url);
  } catch {
    return null;
  }
  const host = hostOf(resource.url);
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'github.com' && parts.length >= 2) {
    const repo = await fetchJson<{ full_name: string; description: string | null; stargazers_count: number; license?: { spdx_id?: string } | null; html_url: string; homepage?: string | null }>(
      `https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
      { Accept: 'application/vnd.github+json', ...githubToken() },
    );
    if (!repo) return resource.origin === 'identifier' ? null : { ...resource, verified_at: undefined };
    return {
      ...resource,
      url: parts.length > 2 && resource.origin !== 'identifier' ? resource.url : repo.html_url,
      title: resource.title && resource.title !== 'GitHub' && resource.origin !== 'identifier' ? resource.title : repo.full_name,
      ...(repo.description ? { description: repo.description.slice(0, 300) } : {}),
      image: `https://opengraph.githubassets.com/1/${repo.full_name}`,
      meta: { stars: repo.stargazers_count, ...(repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? { license: repo.license.spdx_id } : {}) },
      verified_at: now,
    };
  }

  if (host === 'huggingface.co' && parts.length >= 2) {
    const kind = parts[0] === 'spaces' ? 'spaces' : parts[0] === 'datasets' ? 'datasets' : 'models';
    const id = kind === 'models' ? parts.slice(0, 2).join('/') : parts.slice(1, 3).join('/');
    const info = await fetchJson<{ id: string; likes?: number; cardData?: { license?: string; title?: string; short_description?: string }; author?: string }>(
      `https://huggingface.co/api/${kind}/${id}`,
    );
    if (!info) return resource.origin === 'identifier' ? null : resource;
    return {
      ...resource,
      title: info.cardData?.title || resource.title || info.id,
      ...(info.cardData?.short_description ? { description: info.cardData.short_description.slice(0, 300) } : {}),
      meta: { ...(info.likes != null ? { likes: info.likes } : {}), ...(info.cardData?.license ? { license: String(info.cardData.license) } : {}), ...(info.author ? { author: info.author } : {}) },
      verified_at: now,
    };
  }

  const arxivId = host === 'arxiv.org' ? /(\d{4}\.\d{4,5})/.exec(u.pathname)?.[1] : undefined;
  if (arxivId) {
    const xml = await fetchText(`https://export.arxiv.org/api/query?id_list=${arxivId}`, 'application/atom+xml');
    const entry = xml ? /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1] : undefined;
    const title = entry ? stripTags(/<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] || '') : '';
    if (!title) return resource.origin === 'identifier' ? null : resource;
    const summary = stripTags(/<summary>([\s\S]*?)<\/summary>/.exec(entry!)?.[1] || '');
    const authors = [...entry!.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1].trim());
    return {
      ...resource,
      url: `https://arxiv.org/abs/${arxivId}`,
      title: title.slice(0, 200),
      ...(summary ? { description: summary.slice(0, 300) } : {}),
      meta: authors.length ? { author: authors.length > 2 ? `${authors[0]} et al.` : authors.join(', ') } : undefined,
      verified_at: now,
    };
  }

  if (host === 'doi.org') {
    const doi = decodeURIComponent(u.pathname.slice(1));
    const work = await fetchJson<{ message?: { title?: string[]; 'container-title'?: string[]; publisher?: string; author?: Array<{ family?: string }> } }>(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    );
    const title = work?.message?.title?.[0];
    if (!title) return resource.origin === 'identifier' ? null : resource;
    return {
      ...resource,
      title: stripTags(title).slice(0, 200),
      description: [work!.message!['container-title']?.[0], work!.message!.publisher].filter(Boolean).join(' · ').slice(0, 300) || undefined,
      verified_at: now,
    };
  }

  const videoId = youtubeVideoId(resource.url);
  if (videoId) {
    const o = await fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    );
    if (!o?.title) return resource.origin === 'identifier' ? null : resource;
    return {
      ...resource,
      title: o.title.slice(0, 200),
      image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      ...(o.author_name ? { meta: { author: o.author_name } } : {}),
      verified_at: now,
    };
  }

  // Everything else: the page's own preview tags (robots.txt respected inside fetchHtml), else a reachability check.
  if (!/\.(pdf|docx?|xlsx?|csv|zip)$/i.test(u.pathname)) {
    const html = await fetchHtml(resource.url).catch(() => null);
    if (html) {
      const p = parsePagePreview(html, resource.url);
      const anchorIsWeak = !resource.anchor || resource.anchor.length < 12 || resource.title === resource.site;
      return {
        ...resource,
        title: (anchorIsWeak && p.title ? p.title : resource.title).slice(0, 200),
        ...(p.description ? { description: p.description } : {}),
        ...(p.image ? { image: p.image } : {}),
        ...(p.siteName ? { site: p.siteName } : {}),
        verified_at: now,
      };
    }
  }
  const reachable = await isReachable(resource.url);
  if (reachable === false) return null;
  if (resource.origin === 'identifier' && reachable !== true) return null;
  return reachable ? { ...resource, verified_at: now } : resource;
}

interface WikiPage {
  title?: string;
  missing?: string;
  pageimage?: string;
  pageprops?: { disambiguation?: string };
}

/**
 * Lead photo of an entity's Wikipedia article, only if the file is on Commons under a free licence.
 * Used for stories with no picture of their own; the credit carries author and licence.
 */
export async function findCommonsImage(name: string, lang: 'uk' | 'en'): Promise<ArticleFigure | null> {
  const title = name.trim();
  if (title.length < 3 || title.length > 80) return null;
  const wiki = await fetchJson<{ query?: { pages?: Record<string, WikiPage> } }>(
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages%7Cpageprops&piprop=name&titles=${encodeURIComponent(title)}`,
  );
  const page = Object.values(wiki?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || page.pageprops?.disambiguation !== undefined || !page.pageimage) return null;
  const file = await fetchJson<{
    query?: {
      pages?: Record<string, {
        missing?: string;
        imageinfo?: Array<{
          thumburl?: string; thumbwidth?: number; thumbheight?: number; descriptionurl?: string; mime?: string;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }>;
    };
  }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url%7Cextmetadata%7Csize%7Cmime&iiurlwidth=1280&titles=${encodeURIComponent(`File:${page.pageimage}`)}`,
  );
  const info = Object.values(file?.query?.pages ?? {})[0]?.imageinfo?.[0];
  if (!info?.thumburl || !/^image\/(jpeg|png|webp)$/.test(info.mime || '')) return null;
  const meta = info.extmetadata ?? {};
  const license = stripTags(meta.LicenseShortName?.value || '');
  if (!isFreeLicense(license)) return null;
  const url = normalizeImageUrl(info.thumburl);
  if (!url) return null;
  const author = stripTags(meta.Artist?.value || '').slice(0, 80) || 'Wikimedia Commons';
  const description = stripTags(meta.ImageDescription?.value || '').slice(0, 200);
  return {
    id: 'c1',
    kind: 'photo',
    url,
    caption: description && description.length >= 12 ? description : page.title || title,
    credit: `${author} / Wikimedia Commons, ${license}`,
    license,
    link: info.descriptionurl,
    ...(info.thumbwidth ? { width: info.thumbwidth } : {}),
    ...(info.thumbheight ? { height: info.thumbheight } : {}),
    match: [title.toLowerCase()],
    position: 0,
    origin: 'commons',
  };
}
