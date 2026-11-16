/**
 * Pure helpers to find news photos in feed HTML and article pages.
 * Images are only ever referenced (hotlinked) with a credit line, never downloaded and re-hosted.
 */

export interface ExtractedImage {
  url: string;
  caption?: string;
  width?: number;
  height?: number;
}

const JUNK_URL_RE =
  /(pixel|tracking|tracker|spacer|blank\.|1x1|favicon|sprite|avatar|gravatar|emoji|badge|doubleclick|feedburner|feeds\.feedburner|\/ads?\/|[?&]ad=|\/logo|logo[-_.]|\.svg(?:[?#]|$)|\.gif(?:[?#]|$)|data:image|share[-_]?(?:button|icon)|subscribe|newsletter[-_]?(?:banner|promo))/i;

export function decodeBasicEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => {
      const c = Number(d);
      return Number.isInteger(c) && c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : m;
    });
}

export function stripTags(input: string): string {
  return decodeBasicEntities(input.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Returns an absolute, credential-free https URL, or null for anything unsafe or obviously not a photo. */
export function normalizeImageUrl(raw: string | null | undefined, baseUrl?: string): string | null {
  if (!raw) return null;
  let candidate = decodeBasicEntities(raw.trim());
  if (!candidate || candidate.length > 2048) return null;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  let parsed: URL | null = null;
  try {
    parsed = baseUrl ? new URL(candidate, baseUrl) : new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' && !parsed.port) parsed.protocol = 'https:';
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host === '[::1]'
  ) {
    return null;
  }
  parsed.hash = '';
  const out = parsed.href;
  if (JUNK_URL_RE.test(out)) return null;
  return out;
}

export function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

export function bestFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  const parts = srcset
    .split(',')
    .map((p) => p.trim().split(/\s+/))
    .filter((p) => p[0]);
  let best: { url: string; w: number } | null = null;
  for (const [url, size] of parts) {
    const w = size?.endsWith('w') ? Number(size.slice(0, -1)) : size?.endsWith('x') ? Number(size.slice(0, -1)) * 800 : 0;
    if (!best || w > best.w) best = { url, w };
  }
  return best?.url;
}

export function usableCaption(text: string | undefined, imageUrl: string): string | undefined {
  if (!text) return undefined;
  const cleaned = stripTags(text).slice(0, 280);
  if (cleaned.length < 12) return undefined;
  // alt text that is just a file name is not a caption
  if (/^[\w\-. ]+\.(jpe?g|png|webp|avif)$/i.test(cleaned) || imageUrl.includes(cleaned.replace(/\s+/g, '-').toLowerCase())) return undefined;
  return cleaned;
}

/** Finds up to `max` content images in an HTML fragment, preferring <figure> blocks that carry a <figcaption>. */
export function extractArticleImages(html: string, opts: { baseUrl?: string; max?: number } = {}): ExtractedImage[] {
  if (!html) return [];
  const max = opts.max ?? 4;
  const found: ExtractedImage[] = [];
  const seen = new Set<string>();

  const push = (imgTag: string, captionHtml?: string) => {
    const srcRaw = bestFromSrcset(attr(imgTag, 'srcset') || attr(imgTag, 'data-srcset')) || attr(imgTag, 'data-src') || attr(imgTag, 'data-lazy-src') || attr(imgTag, 'src');
    const url = normalizeImageUrl(srcRaw, opts.baseUrl);
    if (!url || seen.has(url)) return;
    const width = Number(attr(imgTag, 'width'));
    const height = Number(attr(imgTag, 'height'));
    if ((Number.isFinite(width) && width > 0 && width < 120) || (Number.isFinite(height) && height > 0 && height < 80)) return;
    seen.add(url);
    const caption = usableCaption(captionHtml, url) || usableCaption(attr(imgTag, 'alt'), url) || usableCaption(attr(imgTag, 'title'), url);
    found.push({
      url,
      ...(caption ? { caption } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    });
  };

  const figureRe = /<figure\b[\s\S]*?<\/figure>/gi;
  const withoutFigures = html.replace(figureRe, (block) => {
    const img = /<img\b[^>]*>/i.exec(block)?.[0];
    const cap = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(block)?.[1];
    if (img) push(img, cap);
    return ' ';
  });
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(withoutFigures)) && found.length < max * 2) push(m[0]);
  return found.slice(0, max);
}

/** Open Graph / Twitter card / first article <figure> images from a full article page. */
export function extractPageImages(html: string, pageUrl: string, max = 4): ExtractedImage[] {
  if (!html) return [];
  const head = html.slice(0, 400_000);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (key: string) => {
    for (const tag of metas) {
      const k = attr(tag, 'property') || attr(tag, 'name');
      if (k && k.toLowerCase() === key) return attr(tag, 'content');
    }
    return undefined;
  };
  const out: ExtractedImage[] = [];
  const seen = new Set<string>();
  const ogUrl = normalizeImageUrl(meta('og:image:secure_url') || meta('og:image') || meta('twitter:image') || meta('twitter:image:src'), pageUrl);
  if (ogUrl) {
    seen.add(ogUrl);
    const alt = usableCaption(meta('og:image:alt') || meta('twitter:image:alt'), ogUrl);
    const w = Number(meta('og:image:width'));
    const h = Number(meta('og:image:height'));
    out.push({ url: ogUrl, ...(alt ? { caption: alt } : {}), ...(w > 0 ? { width: w } : {}), ...(h > 0 ? { height: h } : {}) });
  }
  const articleHtml = /<article\b[\s\S]*?<\/article>/i.exec(head)?.[0] || /<main\b[\s\S]*?<\/main>/i.exec(head)?.[0] || '';
  for (const img of extractArticleImages(articleHtml, { baseUrl: pageUrl, max: max + 1 })) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** First usable paragraph-like description from page meta, used as a last-resort photo caption. */
export function extractPageDescription(html: string): string | undefined {
  const m = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:description|description)["'][^>]*>/i.exec(html.slice(0, 200_000));
  const content = m ? attr(m[0], 'content') : undefined;
  return content ? stripTags(content).slice(0, 240) : undefined;
}
