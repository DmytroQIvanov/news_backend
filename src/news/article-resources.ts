/**
 * Pure helpers that turn a news article page into:
 *  - resources: every meaningful outbound link (primary documents, reports, repos, demos, videos, posts...), classified;
 *  - figures: in-article photos and embedded media, each with hints about where it sits in the text.
 * No network access here: the worker in news-media.service.ts fetches pages and calls these helpers.
 * Nothing is ever invented: every URL comes from the page, the feed, or an exact identifier found in the text.
 */
import { attr, bestFromSrcset, decodeBasicEntities, normalizeImageUrl, stripTags, usableCaption } from './image-extraction';

export type ResourceType =
  | 'primary_source'
  | 'press_release'
  | 'report'
  | 'study'
  | 'paper'
  | 'data'
  | 'court'
  | 'video'
  | 'social'
  | 'repo'
  | 'demo'
  | 'model'
  | 'dataset'
  | 'docs'
  | 'product'
  | 'event'
  | 'map'
  | 'related_article'
  | 'website';

export interface ArticleResource {
  id: string;
  url: string;
  type: ResourceType;
  title: string;
  description?: string;
  image?: string;
  site: string;
  /** Link text in the source article. */
  anchor?: string;
  /** Phrases the app looks for in our text to place the link inline, most specific first. */
  match: string[];
  origin: 'article' | 'feed' | 'identifier';
  meta?: { stars?: number; license?: string; likes?: number; author?: string };
  verified_at?: string;
}

export interface ArticleFigure {
  id: string;
  kind: 'photo' | 'video' | 'post';
  url: string;
  caption?: string;
  credit: string;
  /** Page to open on tap: the video, the post, the Commons file page or the article. */
  link?: string;
  license?: string;
  width?: number;
  height?: number;
  /** Words from the caption and the surrounding paragraph, used to put the figure after the right paragraph. */
  match: string[];
  /** 0..1, where the figure sits in the source article; fallback placement when no words match. */
  position: number;
  origin: 'article' | 'embed' | 'commons';
}

export interface LinkCandidate {
  url: string;
  anchor: string;
  context: string;
  /** True when the link sits inside running prose (not a bare "read more" list). */
  inline: boolean;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|yclid|mc_cid|mc_eid|igshid|ref_src|ref_url|ref|cmpid|ito|at_medium|at_campaign|_ga|spm)$/i;

/** https only, no credentials, no private hosts, tracking parameters removed. */
export function cleanResourceUrl(raw: string | undefined | null, baseUrl?: string): string | null {
  if (!raw) return null;
  const value = decodeBasicEntities(raw.trim());
  if (!value || value.length > 2048 || /^(mailto|tel|javascript|data|sms|whatsapp):/i.test(value) || value.startsWith('#')) return null;
  let u: URL;
  try {
    u = baseUrl ? new URL(value.startsWith('//') ? `https:${value}` : value, baseUrl) : new URL(value);
  } catch {
    return null;
  }
  if (u.protocol === 'http:' && !u.port) u.protocol = 'https:';
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) ||
    host.startsWith('[')
  ) {
    return null;
  }
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  u.hash = '';
  // One post = one link: twitter.com and x.com, with or without query.
  if (/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname) && /\/status\/\d+/.test(u.pathname)) {
    const [, user, id] = /^\/([^/]+)\/status\/(\d+)/.exec(u.pathname) ?? [];
    if (user && id) return `https://x.com/${user}/status/${id}`;
  }
  // One video = one link, whatever the timestamp or URL shape.
  const videoId = youtubeVideoId(u.href);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return u.href;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
  } catch {
    return '';
  }
}

/** Registrable-ish domain: "news.bbc.co.uk" -> "bbc.co.uk", "blog.openai.com" -> "openai.com". */
export function baseDomain(host: string): string {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const twoLevel = /^(co|com|org|net|gov|edu|ac|in|kiev|kyiv)$/.test(sld) && parts[parts.length - 1].length === 2;
  return parts.slice(twoLevel ? -3 : -2).join('.');
}

const STRIP_BLOCKS_RE =
  /<(script|style|noscript|template|svg|nav|header|footer|aside|form|button|select|iframe)\b[\s\S]*?<\/\1>/gi;
const JUNK_CONTAINER_RE =
  /<(div|section|ul|ol|p)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:share|social|related|recommend|newsletter|subscribe|promo|advert|sponsor|banner|cookie|comments?|breadcrumbs?|tags?|author-?bio|byline|read-?more|more-?news|popular|trending|sidebar|footer|menu)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

/** The main article fragment (article > main > body), with navigation, scripts and promo blocks removed. */
export function articleFragment(html: string): string {
  if (!html) return '';
  const head = html.slice(0, 900_000);
  // Embeds live in iframes, which are stripped below; collect them from the raw fragment via extractEmbeds instead.
  const articles = [...head.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]);
  const main = /<main\b[\s\S]*?<\/main>/i.exec(head)?.[0];
  const body = /<body\b[\s\S]*<\/body>/i.exec(head)?.[0];
  // The longest <article> is the story; short ones are teaser cards.
  const fragment = articles.sort((a, b) => b.length - a.length)[0] || main || body || head;
  let out = fragment.replace(/<!--[\s\S]*?-->/g, ' ').replace(STRIP_BLOCKS_RE, ' ');
  for (let i = 0; i < 2; i += 1) out = out.replace(JUNK_CONTAINER_RE, ' ');
  return out;
}

/** Splits an HTML fragment into prose blocks (paragraphs, list items, headings, quotes) in document order. */
function proseBlocks(fragment: string): Array<{ html: string; text: string; start: number }> {
  const out: Array<{ html: string; text: string; start: number }> = [];
  const re = /<(p|li|h[2-4]|blockquote|figcaption|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) {
    const text = stripTags(m[2]);
    if (text.length >= 2) out.push({ html: m[2], text, start: m.index });
  }
  return out;
}

/**
 * Link text that does not name anything: "тут", "заявив", "доступний", "повідомили", a timestamp.
 * Such a link is still kept, but its title comes from the linked page and the text is not used for placement.
 */
export function isWeakAnchor(anchor: string | undefined): boolean {
  const a = (anchor || '').trim();
  if (a.length < 3 || GENERIC_ANCHOR_RE.test(a) || /^\d{1,2}:\d{2}/.test(a)) return true;
  // Dates as link text ('November 16, 2026', '16 листопада 2026'): typical for embedded posts.
  if (/^(\p{L}+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\p{L}+\s+\d{4}|\d{1,2}[./]\d{1,2}[./]\d{2,4})$/u.test(a)) return true;
  const words = a.split(/\s+/);
  return words.length === 1 && !/[A-ZА-ЯІЇЄҐ0-9/№]/.test(a);
}

const GENERIC_ANCHOR_RE =
  /^(here|link|this|source|more|read more|click here|see more|tap here|website|site|тут|тутечки|здесь|посилання|посиланням|за посиланням|джерело|детальніше|докладніше|більше|читайте також|читати далі|сайт|сайті|тиць|ссылка|подробнее|источник|\d+)$/i;

const SHARE_OR_NAV_RE =
  /(\/share|sharer|\/intent\/|shareArticle|\/sharing|\/login|\/signin|\/sign-in|\/signup|\/register|\/subscribe|\/subscription|\/newsletter|\/donate|\/privacy|\/terms|\/cookies?|\/contacts?\b|\/about(-us)?\/?$|\/advert|\/reklama|\/feed\/?$|\/rss|\/search|[?&](s|q|query)=|\/tag\/|\/tags\/|\/topic\/|\/category\/|\/categories\/|\/rubric|\/author\/|\/authors\/|\/page\/\d+|\/archive\/?$|\/comments?\/?$|\/wp-login|\/cdn-cgi\/|\/amp\/?$)/i;

const AD_HOST_RE =
  /(doubleclick|googlesyndication|googleadservices|adservice|taboola|outbrain|mgid|criteo|amazon-adsystem|adnxs|clickbank|awin1|shareasale|tradedoubler|admitad|linksynergy|go\.redirectingat|skimlinks|viglink|prf\.hn|pxf\.io|lnk\.to)/i;

const SOCIAL_PROFILE_HOSTS = /^(x\.com|twitter\.com|facebook\.com|fb\.com|instagram\.com|t\.me|telegram\.me|threads\.net|threads\.com|tiktok\.com|linkedin\.com|youtube\.com|bsky\.app|mastodon\.social|reddit\.com|old\.reddit\.com|vk\.com|ok\.ru|pinterest\.com)$/;
/** Shortened links hide where they lead (often ads), so they are not shown as material. */
const SHORTENER_RE = /^(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|cutt\.ly|is\.gd|buff\.ly|t\.co|rebrand\.ly|shorturl\.at|tiny\.cc|clck\.ru)$/;
const MESSENGER_INVITE_RE = /(invite\.viber\.com|viber\.click|chat\.whatsapp\.com|whatsapp\.com\/channel|^wa\.me|discord\.gg|news\.google\.com\/publications|signal\.group)/i;

function isSocialPost(url: URL, host: string): boolean {
  const path = url.pathname;
  if (host === 'x.com' || host === 'twitter.com') return /\/status(es)?\/\d+/.test(path);
  if (host === 't.me') return /^\/(s\/)?[\w_]+\/\d+/.test(path);
  if (host === 'facebook.com') return /\/(posts|videos|photos|permalink|story\.php|watch|reel)/.test(path + url.search);
  if (host === 'instagram.com') return /^\/(p|reel|tv)\//.test(path);
  if (host === 'threads.net' || host === 'threads.com') return /\/post\//.test(path);
  if (host === 'reddit.com' || host === 'old.reddit.com') return /\/comments\/\w+/.test(path);
  if (host === 'tiktok.com') return /\/video\/\d+/.test(path);
  if (host === 'linkedin.com') return /^\/(posts|feed\/update|pulse)\//.test(path);
  if (host === 'bsky.app') return /\/post\//.test(path);
  if (host === 'mastodon.social') return /\/@[\w]+\/\d+/.test(path);
  if (host === 'youtube.com') return isYoutubeVideo(url);
  return false;
}

function isYoutubeVideo(url: URL): boolean {
  const host = hostOf(url.href);
  if (host === 'youtu.be') return url.pathname.length > 3;
  return host === 'youtube.com' && (url.searchParams.has('v') || /^\/(shorts|live|embed)\/[\w-]{6,}/.test(url.pathname));
}

export function youtubeVideoId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = hostOf(u.href);
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || /^\/(?:shorts|live|embed|v)\/([\w-]{6,})/.exec(u.pathname)?.[1] || null;
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

/** Should this link be dropped (navigation, sharing, ads, profiles, same-site teasers)? */
export function isJunkLink(url: string, pageUrl: string, anchor: string, inline: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const host = hostOf(url);
  if (!host || AD_HOST_RE.test(host) || SHORTENER_RE.test(host)) return true;
  if (/\.(jpe?g|png|gif|webp|avif|svg|mp3|zip|exe|apk|dmg)(?:$|\?)/i.test(u.pathname)) return true;
  const pageHost = hostOf(pageUrl);
  const sameSite = pageHost && baseDomain(host) === baseDomain(pageHost);
  const pathNoSlash = u.pathname.replace(/\/+$/, '');
  if (SHARE_OR_NAV_RE.test(u.pathname + u.search) && !/\.pdf$/i.test(u.pathname)) return true;
  if (MESSENGER_INVITE_RE.test(host + u.pathname)) return true;
  // Profiles and channels ("follow us on Telegram") are never material; only a specific post or video is.
  if (SOCIAL_PROFILE_HOSTS.test(host) && !isSocialPost(u, host)) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(anchor.trim())) return true; // video timestamps
  if (sameSite) {
    if (!pathNoSlash || pathNoSlash === new URL(pageUrl).pathname.replace(/\/+$/, '')) return true;
    // Same-site links count only when they are part of the story text, not a teaser list.
    if (!inline) return true;
  }
  const a = anchor.trim();
  if (!inline && (a.length < 4 || GENERIC_ANCHOR_RE.test(a))) return true;
  return false;
}

/** All outbound links in the article body with the sentence around them. */
export function extractLinkCandidates(html: string, pageUrl: string, max = 60): LinkCandidate[] {
  const fragment = articleFragment(html);
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();
  for (const block of proseBlocks(fragment)) {
    const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(block.html))) {
      const tag = `<a ${m[1]}>`;
      if (/\brel\s*=\s*["'][^"']*\bsponsored\b/i.test(tag)) continue;
      const url = cleanResourceUrl(attr(tag, 'href'), pageUrl);
      if (!url) continue;
      const anchor = stripTags(m[2]).slice(0, 200);
      const inline = block.text.length >= anchor.length + 25;
      if (isJunkLink(url, pageUrl, anchor, inline)) continue;
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url, anchor, context: sentenceAround(block.text, anchor).slice(0, 400), inline });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function sentenceAround(text: string, needle: string): string {
  if (!needle) return text;
  const idx = text.indexOf(needle);
  if (idx < 0) return text;
  const before = text.lastIndexOf('. ', idx);
  const afterDot = text.slice(idx + needle.length).search(/[.!?](\s|$)/);
  const end = afterDot < 0 ? text.length : idx + needle.length + afterDot + 1;
  return text.slice(before < 0 ? 0 : before + 2, end).trim();
}

const RAW_URL_RE = /\bhttps?:\/\/[^\s<>"'«»)\]]+[^\s<>"'«».,;:!?)\]]/gi;
const GITHUB_RE = /\b(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][\w.-]{0,38})\/([\w.-]{1,100})/gi;
const HF_RE = /\b(?:https?:\/\/)?huggingface\.co\/(spaces\/|datasets\/)?([\w.-]{2,96})\/([\w.-]{1,96})/gi;
const ARXIV_RE = /\barXiv\s*[:：]?\s*(\d{4}\.\d{4,5})(v\d+)?\b|\barxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/gi;
const DOI_RE = /\b(?:doi\s*[:：]\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[^\s"<>,;]+[^\s"<>,;.)\]])/gi;

/**
 * Links that the text names exactly but does not hyperlink: bare URLs, GitHub/Hugging Face repo paths,
 * arXiv ids and DOIs. These are the only "searched" resources: an exact identifier, verified later by an API.
 */
export function extractTextIdentifiers(text: string): Array<{ url: string; anchor: string; context: string }> {
  if (!text) return [];
  const plain = stripTags(text);
  const out = new Map<string, { url: string; anchor: string; context: string }>();
  const add = (url: string | null, anchor: string) => {
    if (!url) return;
    const key = url.replace(/\/$/, '').toLowerCase();
    if (!out.has(key)) out.set(key, { url, anchor, context: sentenceAround(plain, anchor).slice(0, 400) });
  };
  for (const m of plain.matchAll(GITHUB_RE)) {
    const repo = m[2].replace(/[.-]+$/, '').replace(/\.git$/, '');
    if (/^(features|pricing|about|topics|marketplace|sponsors|orgs|settings|login)$/i.test(m[1])) continue;
    add(cleanResourceUrl(`https://github.com/${m[1]}/${repo}`), m[0]);
  }
  for (const m of plain.matchAll(HF_RE)) add(cleanResourceUrl(`https://huggingface.co/${m[1] || ''}${m[2]}/${m[3].replace(/[.-]+$/, '')}`), m[0]);
  for (const m of plain.matchAll(ARXIV_RE)) {
    const id = m[1] || m[3];
    if (id) add(`https://arxiv.org/abs/${id}`, m[0]);
  }
  for (const m of plain.matchAll(DOI_RE)) add(cleanResourceUrl(`https://doi.org/${m[1]}`), m[0]);
  for (const m of plain.matchAll(RAW_URL_RE)) add(cleanResourceUrl(m[0]), m[0]);
  return [...out.values()].slice(0, 20);
}

const PRIMARY_HOST_RE =
  /(\.gov(\.[a-z]{2})?$|\.gov\.ua$|^rada\.gov\.ua$|zakon\.rada\.gov\.ua|president\.gov\.ua|kmu\.gov\.ua|mfa\.gov\.ua|mil\.gov\.ua|\.mil$|europa\.eu$|\.europa\.eu$|un\.org$|\.un\.org$|who\.int$|nato\.int$|imf\.org$|worldbank\.org$|oecd\.org$|bank\.gov\.ua$|federalreserve\.gov$|ecb\.europa\.eu$|sec\.gov$|whitehouse\.gov$|parliament\.uk$|congress\.gov$|legislation\.gov\.uk$|eur-lex\.europa\.eu$|bundesregierung\.de$|elysee\.fr$|kremlin\.ru$)/i;
const COURT_HOST_RE = /(reyestr\.court\.gov\.ua|court\.gov\.ua|ccu\.gov\.ua|supremecourt\.gov|curia\.europa\.eu|echr\.coe\.int|hudoc|icc-cpi\.int|icj-cij\.org|courtlistener\.com|supremecourt\.uk)/i;
const DATA_HOST_RE = /(ukrstat\.gov\.ua|stat\.gov\.ua|data\.gov|eurostat|ec\.europa\.eu\/eurostat|data\.worldbank|ourworldindata\.org|statista\.com|tradingeconomics\.com|fred\.stlouisfed\.org|kaggle\.com\/datasets|data\.europa\.eu|census\.gov|bls\.gov|ons\.gov\.uk|prozorro\.gov\.ua|spending\.gov\.ua|opendatabot)/i;
const STUDY_HOST_RE = /(doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|link\.springer|wiley\.com|thelancet\.com|nejm\.org|bmj\.com|pubmed|ncbi\.nlm\.nih\.gov|plos\.org|cell\.com|jamanetwork\.com|frontiersin\.org|mdpi\.com|ssrn\.com|researchgate\.net|biorxiv\.org|medrxiv\.org|scholar\.google)/i;
const PAPER_HOST_RE = /(arxiv\.org|openreview\.net|aclanthology\.org|proceedings\.|paperswithcode\.com|semanticscholar\.org)/i;
const VIDEO_HOST_RE = /^(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|rumble\.com)$/;
const MAP_RE = /(google\.[a-z.]+\/maps|maps\.google|maps\.app\.goo\.gl|openstreetmap\.org|deepstatemap\.live|liveuamap\.com|bing\.com\/maps|maps\.apple\.com)/i;
const REPO_HOST_RE = /^(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|sourcehut\.org|git\.sr\.ht)$/;
const NEWS_HOST_RE =
  /(reuters\.com|apnews\.com|bbc\.(co\.uk|com)|nytimes\.com|theguardian\.com|washingtonpost\.com|ft\.com|bloomberg\.com|wsj\.com|cnn\.com|politico\.(com|eu)|axios\.com|theverge\.com|techcrunch\.com|wired\.com|arstechnica\.com|engadget\.com|economist\.com|dw\.com|france24\.com|aljazeera\.com|kyivindependent\.com|pravda\.com\.ua|eurointegration\.com\.ua|epravda\.com\.ua|ukrinform\.(ua|net)|suspilne\.media|unian\.(ua|net)|rbc\.ua|liga\.net|nv\.ua|zn\.ua|hromadske\.ua|censor\.net|tsn\.ua|radiosvoboda\.org|rferl\.org|dou\.ua|ain\.ua|forbes\.(com|ua)|espreso\.tv|24tv\.ua|interfax\.com\.ua|lb\.ua|babel\.ua|texty\.org\.ua|focus\.ua|meduza\.io|novayagazeta|theinsider|cnbc\.com|venturebeat\.com|zdnet\.com|9to5|macrumors|androidpolice|gsmarena|tomshardware|pcmag|variety\.com|hollywoodreporter|deadline\.com|espn\.com|skysports\.com|uefa\.com|fifa\.com|sport\.ua|football\.ua|tribuna\.com)/i;

const DEMO_WORDS = /\b(demo|playground|try it|try out|try the|live preview|sandbox|онлайн-демо|демо|демоверс|спробувати|спробуйте|потестувати|пісочниц)/i;
const DOCS_WORDS = /\b(docs?|documentation|api reference|developer guide|getting started|документаці|інструкці|посібник|керівництв)/i;
const PRESS_WORDS = /(press[- ]release|newsroom|\/press\b|\/pressroom|заяв[аиі]|повідомленн|прес-реліз|пресреліз|прес-служб|announcement|announced|оголоси|повідоми)/i;
const REPORT_WORDS = /(report|white ?paper|survey|index|outlook|review|analysis|brief|звіт|доповід|дослідженн|огляд|аналітик|рейтинг|опитуванн|індекс|прогноз)/i;
const STUDY_WORDS = /(study|paper|journal|research|preprint|науков|стаття в журналі|дослідник|дослідженн)/i;
const LAW_WORDS = /(закон|указ|постанов|розпорядженн|наказ|рішення|законопроєкт|законопроект|директив|регламент|резолюці|декрет|bill\b|act\b|decree|executive order|regulation|directive|resolution|law\b|ordinance)/i;
const EVENT_WORDS = /(conference|summit|festival|concert|match|tournament|championship|expo|forum|exhibition|конференц|саміт|фестивал|концерт|матч|турнір|чемпіонат|форум|виставк|премі[яї]|церемоні)/i;
const PRODUCT_WORDS = /(\/product|\/products\/|\/pricing|\/shop|\/store|apps\.apple\.com|play\.google\.com|store\.steampowered\.com|chromewebstore|addons\.mozilla|marketplace\.visualstudio|продукт|застосунок|додаток|app store|google play)/i;

/** Rule-based type of a link from its domain, path, link text and the sentence around it. */
export function classifyResource(url: string, anchor = '', context = '', pageUrl = ''): ResourceType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'website';
  }
  const host = hostOf(url);
  const path = u.pathname.toLowerCase();
  const words = `${anchor} ${context}`;
  const nearWords = anchor || context;

  if (MAP_RE.test(url)) return 'map';
  if (VIDEO_HOST_RE.test(host) && (isYoutubeVideo(u) || host !== 'youtube.com')) return 'video';
  if (SOCIAL_PROFILE_HOSTS.test(host) && isSocialPost(u, host)) return 'social';
  if (REPO_HOST_RE.test(host)) return 'repo';
  if (host === 'huggingface.co') {
    if (path.startsWith('/spaces/')) return 'demo';
    if (path.startsWith('/datasets/')) return 'dataset';
    if (path.startsWith('/docs')) return 'docs';
    return 'model';
  }
  if (/(colab\.research\.google\.com|replicate\.com\/.+\/.+|gradio\.live|\.hf\.space$|streamlit\.app$|codepen\.io|codesandbox\.io|stackblitz\.com|jsfiddle\.net|observablehq\.com|vercel\.app$|netlify\.app$|glitch\.me$)/i.test(host + path))
    return 'demo';
  if (PAPER_HOST_RE.test(host)) return 'paper';
  if (COURT_HOST_RE.test(host + path)) return 'court';
  if (DATA_HOST_RE.test(host + path) || /\.(csv|xlsx?|json|parquet)$/i.test(path)) return 'data';
  if (STUDY_HOST_RE.test(host)) return 'study';
  if (/^(docs?|developers?|dev|api|learn|help|support)\./.test(host) || /^\/(docs?|documentation|api|reference|guides?)(\/|$)/.test(path)) return 'docs';
  if (DEMO_WORDS.test(nearWords) || /^(demo|playground|try|chat|labs?|app)\./.test(host) || /\/(demo|playground)(\/|$)/.test(path)) return 'demo';
  if (PRIMARY_HOST_RE.test(host)) {
    if (/\.pdf$/i.test(path) && REPORT_WORDS.test(words) && !LAW_WORDS.test(words)) return 'report';
    if (PRESS_WORDS.test(path) || (PRESS_WORDS.test(nearWords) && !LAW_WORDS.test(nearWords))) return 'press_release';
    return 'primary_source';
  }
  if (/\.pdf$/i.test(path)) return LAW_WORDS.test(words) ? 'primary_source' : STUDY_WORDS.test(words) && !REPORT_WORDS.test(anchor) ? 'study' : 'report';
  if (PRODUCT_WORDS.test(url) || PRODUCT_WORDS.test(anchor)) return 'product';
  const pageHost = hostOf(pageUrl);
  if (NEWS_HOST_RE.test(host) || (pageHost && baseDomain(host) === baseDomain(pageHost))) return 'related_article';
  if (PRESS_WORDS.test(path) || /^(blog|newsroom|press)\./.test(host) || /^\/(blog|newsroom|press)\//.test(path)) return 'press_release';
  if (REPORT_WORDS.test(anchor) || /\/(reports?|research|publications?|insights)\//.test(path)) return 'report';
  if (EVENT_WORDS.test(anchor)) return 'event';
  if (LAW_WORDS.test(anchor)) return 'primary_source';
  return 'website';
}

/** Order in the "Sources & materials" block: primary documents first, coverage last. */
export const RESOURCE_PRIORITY: Record<ResourceType, number> = {
  primary_source: 0,
  court: 1,
  press_release: 2,
  report: 3,
  study: 4,
  paper: 5,
  data: 6,
  demo: 7,
  repo: 8,
  model: 9,
  dataset: 10,
  docs: 11,
  video: 12,
  social: 13,
  product: 14,
  event: 15,
  map: 16,
  website: 17,
  related_article: 18,
};

const BRAND_BY_HOST: Array<[RegExp, string]> = [
  [/github\.com$/, 'GitHub'],
  [/gitlab\.com$/, 'GitLab'],
  [/huggingface\.co$/, 'Hugging Face'],
  [/arxiv\.org$/, 'arXiv'],
  [/youtube\.com$|youtu\.be$/, 'YouTube'],
  [/vimeo\.com$/, 'Vimeo'],
  [/^(x|twitter)\.com$/, 'X'],
  [/t\.me$/, 'Telegram'],
  [/facebook\.com$/, 'Facebook'],
  [/instagram\.com$/, 'Instagram'],
  [/tiktok\.com$/, 'TikTok'],
  [/linkedin\.com$/, 'LinkedIn'],
  [/threads\.net$/, 'Threads'],
  [/rada\.gov\.ua$/, 'Верховної Ради'],
  [/president\.gov\.ua$/, 'Офісу Президента'],
  [/kmu\.gov\.ua$/, 'Кабміну'],
  [/apps\.apple\.com$/, 'App Store'],
  [/play\.google\.com$/, 'Google Play'],
  [/kaggle\.com$/, 'Kaggle'],
  [/wikipedia\.org$/, 'Wikipedia'],
];

export function siteLabel(url: string): string {
  const host = hostOf(url);
  for (const [re, name] of BRAND_BY_HOST) if (re.test(host)) return name;
  return host;
}

/** Distinctive phrases (names, repo slugs, numbers like "№ 1234-IX") that can be found again in our own text. */
export function matchTerms(url: string, anchor: string, title: string, context: string): string[] {
  const terms: string[] = [];
  const push = (value: string | undefined) => {
    const v = (value || '').replace(/\s+/g, ' ').replace(/^["'«“]+|["'»”.,:;]+$/g, '').trim();
    if (v.length < 3 || v.length > 90 || GENERIC_ANCHOR_RE.test(v)) return;
    if (!terms.some((t) => t.toLowerCase() === v.toLowerCase())) terms.push(v);
  };
  if (!isWeakAnchor(anchor)) push(anchor);
  try {
    const u = new URL(url);
    const host = hostOf(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if ((REPO_HOST_RE.test(host) || host === 'huggingface.co') && parts.length >= 2) {
      const [owner, name] = parts[0] === 'spaces' || parts[0] === 'datasets' ? parts.slice(1) : parts;
      if (owner && name) {
        push(`${owner}/${name}`);
        push(name.replace(/[-_]/g, ' '));
        push(name);
      }
    }
    const arxiv = /(\d{4}\.\d{4,5})/.exec(u.pathname)?.[1];
    if (arxiv) push(arxiv);
  } catch {
    /* ignore */
  }
  const source = `${anchor} ${title} ${context}`;
  // Legal and document numbers: "№ 1234-IX", "No. 14/2024", "Order 14110".
  for (const m of source.matchAll(/(?:№|No\.?|N)\s?\d[\d/-]*(?:-[IVXLC]+)?/g)) push(m[0]);
  // Quoted titles: «...», "...".
  for (const m of source.matchAll(/[«“"]([^»”"]{3,80})[»”"]/g)) push(m[1]);
  // Proper names: runs of capitalised words (Latin or Cyrillic), "GPT-5", "iPhone 17".
  for (const m of `${anchor} ${title}`.matchAll(/\b(?:[A-ZА-ЯІЇЄҐ][\w'’.-]*[a-zа-яіїєґ0-9][\w'’-]*|[A-Z]{2,}[\w-]*|[a-z]+[A-Z][\w-]*)(?:\s+(?:[A-ZА-ЯІЇЄҐ][\w'’-]+|[A-Z0-9][\w.-]*|\d[\w.]*))*/g)) {
    if (m[0].split(' ').length <= 6) push(m[0]);
  }
  for (const [re, brand] of BRAND_BY_HOST) if (re.test(hostOf(url))) push(brand);
  return terms.slice(0, 8);
}

export interface PagePreview {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

/** og:title / <title>, og:description, og:image and og:site_name of a linked page. */
export function parsePagePreview(html: string, pageUrl: string): PagePreview {
  if (!html) return {};
  const head = html.slice(0, 250_000);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (...keys: string[]) => {
    for (const key of keys) {
      for (const tag of metas) {
        const k = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
        if (k === key) {
          const v = attr(tag, 'content');
          if (v && v.trim()) return stripTags(v);
        }
      }
    }
    return undefined;
  };
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = (meta('og:title', 'twitter:title') || (titleTag ? stripTags(titleTag) : undefined))?.slice(0, 200);
  const description = meta('og:description', 'twitter:description', 'description')?.slice(0, 300);
  const image = normalizeImageUrl(meta('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), pageUrl) || undefined;
  const siteName = meta('og:site_name', 'application-name')?.slice(0, 80);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(siteName ? { siteName } : {}),
  };
}

/** Builds the resource list (not yet verified) from link candidates and text identifiers, best first. */
export function buildResources(
  candidates: Array<{ url: string; anchor: string; context: string; origin: ArticleResource['origin']; inline?: boolean }>,
  pageUrl: string,
  max = 14,
): ArticleResource[] {
  const pageKey = cleanResourceUrl(pageUrl)?.replace(/\/$/, '');
  const byUrl = new Map<string, ArticleResource & { score: number }>();
  candidates.forEach((c, index) => {
    const url = cleanResourceUrl(c.url);
    if (!url) return;
    const key = url.replace(/\/$/, '');
    if (key === pageKey || byUrl.has(key)) return;
    const type = classifyResource(url, c.anchor, c.context, pageUrl);
    const title = isWeakAnchor(c.anchor) ? siteLabel(url) : c.anchor;
    const score = RESOURCE_PRIORITY[type] * 10 + Math.min(index, 60) / 10 + (c.inline === false ? 5 : 0);
    byUrl.set(key, {
      id: '',
      url,
      type,
      title: title.slice(0, 200),
      site: siteLabel(url),
      ...(c.anchor ? { anchor: c.anchor.slice(0, 200) } : {}),
      match: matchTerms(url, c.anchor, title, c.context),
      origin: c.origin,
      score,
    });
  });
  const list = [...byUrl.values()].sort((a, b) => a.score - b.score);
  // Keep coverage from other outlets to a few, so primary material stays on top.
  let related = 0;
  const kept = list.filter((r) => (r.type === 'related_article' ? (related += 1) <= 3 : true)).slice(0, max);
  return kept.map(({ score: _score, ...r }, i) => ({ ...r, id: `r${i + 1}` }));
}

const STOP_WORDS = new Set(
  (
    'the a an and or of to in on for with by from at as is are was were be this that these those it its into over under after before about ' +
    'між для від про під над при без через щодо також який яка яке які його її їх цей ця це ці той та те ті він вона воно вони був була було були ' +
    'буде будуть може можуть після перед коли якщо тому тоді вже ще лише тільки дуже року році роках році понад близько photo фото getty images reuters ap afp'
  ).split(' '),
);

/** Up to 8 distinctive words (names, numbers, long words) for matching a figure to a paragraph. */
export function keywordsOf(text: string, max = 8): string[] {
  const words = (text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) {
    if (STOP_WORDS.has(w) || w.length < 4) continue;
    const stem = w.length > 6 ? w.slice(0, Math.max(5, w.length - 3)) : w; // crude stem: "президента" ~ "президент"
    counts.set(stem, (counts.get(stem) ?? 0) + 1 + (/\d/.test(w) ? 1 : 0) + (w.length > 8 ? 0.5 : 0));
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/** In-article photos in document order, each with the paragraph text around it and its relative position. */
export function extractFigures(html: string, pageUrl: string, credit: string, max = 8): ArticleFigure[] {
  const fragment = articleFragment(html);
  if (!fragment) return [];
  const total = Math.max(1, fragment.length);
  const blocks = proseBlocks(fragment).filter((b) => b.text.length >= 40);
  const out: ArticleFigure[] = [];
  const seen = new Set<string>();
  const re = /<figure\b[\s\S]*?<\/figure>|<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment)) && out.length < max) {
    const block = m[0];
    const isFigure = /^<figure/i.test(block);
    const img = isFigure ? /<img\b[^>]*>/i.exec(block)?.[0] : block;
    if (!img) continue;
    const src = bestFromSrcset(attr(img, 'srcset') || attr(img, 'data-srcset')) || attr(img, 'data-src') || attr(img, 'data-lazy-src') || attr(img, 'src');
    const url = normalizeImageUrl(src, pageUrl);
    if (!url || seen.has(url)) continue;
    const width = Number(attr(img, 'width'));
    const height = Number(attr(img, 'height'));
    if ((width > 0 && width < 200) || (height > 0 && height < 120)) continue;
    if (/\b(class|id)\s*=\s*["'][^"']*(avatar|author|logo|icon|emoji|badge|thumb-?small|ad-|sponsor)/i.test(img)) continue;
    // A picture wrapped in a link to another page is a teaser for that page, not a photo of this story.
    const lead = fragment.slice(Math.max(0, m.index - 2000), m.index) + (isFigure ? block.slice(0, block.search(/<img\b/i)) : '');
    const openA = lead.lastIndexOf('<a ');
    if (openA >= 0 && openA > lead.lastIndexOf('</a>')) {
      const href = cleanResourceUrl(attr(lead.slice(openA, lead.indexOf('>', openA) + 1), 'href'), pageUrl);
      if (href && !/\.(jpe?g|png|webp|avif|gif)(?:$|\?)/i.test(href) && href.replace(/\/$/, '') !== (cleanResourceUrl(pageUrl) || '').replace(/\/$/, '')) continue;
    }
    seen.add(url);
    const capHtml = isFigure ? /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(block)?.[1] : undefined;
    const caption = usableCaption(capHtml, url) || usableCaption(attr(img, 'alt'), url) || usableCaption(attr(img, 'title'), url);
    const before = [...blocks].reverse().find((b) => b.start < m!.index);
    const after = blocks.find((b) => b.start > m!.index);
    const photoCredit = capHtml ? /(?:фото|photo|credit|foto)\s*[:：]\s*([^|<\n]{2,80})/i.exec(stripTags(capHtml))?.[1]?.trim() : undefined;
    out.push({
      id: `f${out.length + 1}`,
      kind: 'photo',
      url,
      ...(caption ? { caption } : {}),
      credit: photoCredit || credit,
      link: pageUrl,
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
      match: keywordsOf(`${caption ?? ''} ${caption ?? ''} ${before?.text.slice(-300) ?? ''} ${after?.text.slice(0, 160) ?? ''}`),
      position: Math.min(1, Math.max(0, m.index / total)),
      origin: 'article',
    });
  }
  return out;
}

export interface ArticleEmbed {
  kind: 'video' | 'post';
  url: string;
  videoId?: string;
  context: string;
  position: number;
}

/** YouTube/Vimeo players and embedded posts (X, Telegram, Instagram) inside the article. */
export function extractEmbeds(html: string, max = 4): ArticleEmbed[] {
  if (!html) return [];
  const head = html.slice(0, 900_000);
  const articles = [...head.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((x) => x[0]);
  const fragment = articles.sort((a, b) => b.length - a.length)[0] || /<main\b[\s\S]*?<\/main>/i.exec(head)?.[0] || head;
  const total = Math.max(1, fragment.length);
  const out: ArticleEmbed[] = [];
  const seen = new Set<string>();
  const contextAt = (index: number) => stripTags(fragment.slice(Math.max(0, index - 1200), index)).slice(-300);
  const push = (e: ArticleEmbed) => {
    if (seen.has(e.url) || out.length >= max) return;
    seen.add(e.url);
    out.push(e);
  };
  for (const m of fragment.matchAll(/<iframe\b[^>]*>/gi)) {
    const src = attr(m[0], 'src') || attr(m[0], 'data-src') || '';
    const abs = src.startsWith('//') ? `https:${src}` : src;
    const id = youtubeVideoId(abs);
    if (id) push({ kind: 'video', url: `https://www.youtube.com/watch?v=${id}`, videoId: id, context: contextAt(m.index!), position: m.index! / total });
    const vimeo = /player\.vimeo\.com\/video\/(\d+)/.exec(abs)?.[1];
    if (vimeo) push({ kind: 'video', url: `https://vimeo.com/${vimeo}`, context: contextAt(m.index!), position: m.index! / total });
  }
  for (const m of fragment.matchAll(/<lite-youtube\b[^>]*videoid\s*=\s*["']([\w-]{6,20})["'][^>]*>|data-(?:youtube-id|video-id|yt-id)\s*=\s*["']([\w-]{11})["']/gi)) {
    const id = m[1] || m[2];
    push({ kind: 'video', url: `https://www.youtube.com/watch?v=${id}`, videoId: id, context: contextAt(m.index!), position: m.index! / total });
  }
  for (const m of fragment.matchAll(/<blockquote\b[^>]*class\s*=\s*["'][^"']*(twitter-tweet|instagram-media|tiktok-embed|threads)[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/gi)) {
    const links = [...m[2].matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((x) => cleanResourceUrl(x[1]));
    const post = links.find((l) => l && /\/status\/\d+|instagram\.com\/(p|reel)\/|tiktok\.com\/.+\/video\/|threads\.net\/.+\/post\//.test(l));
    if (post) push({ kind: 'post', url: post, context: contextAt(m.index!), position: m.index! / total });
  }
  for (const m of fragment.matchAll(/data-telegram-post\s*=\s*["']([\w_]+\/\d+)["']/gi)) {
    push({ kind: 'post', url: `https://t.me/${m[1]}`, context: contextAt(m.index!), position: m.index! / total });
  }
  return out;
}

/** Free licences only: Commons files under these may be shown with attribution. */
export function isFreeLicense(name: string | undefined): boolean {
  if (!name) return false;
  return /^(cc[ -]?by(-sa)?([ -]\d\.\d)?|cc0|public domain|pd|cc-pd|attribution|gfdl|no restrictions)/i.test(name.trim()) && !/\bnc\b|\bnd\b|noncommercial|noderivs/i.test(name);
}
