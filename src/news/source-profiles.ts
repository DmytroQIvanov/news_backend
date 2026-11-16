/**
 * Source cards: who stands behind each outlet the app reads (country, ownership, funding, type) and which
 * "lens" it represents. The lens groups power blindspot detection ("only Ukrainian media cover this") and the
 * daily "other perspective" card. Ownership is filled in only where it is publicly documented; unknown stays
 * null instead of guessed. Corrections statistics come from the database, not from this file.
 */

export const SOURCE_LENSES = ['ua_media', 'intl_media', 'official', 'specialist', 'community', 'unknown'] as const;
export type SourceLens = (typeof SOURCE_LENSES)[number];

export type SourceType =
  | 'public_broadcaster'
  | 'commercial_media'
  | 'nonprofit_media'
  | 'scientific_publisher'
  | 'corporate_blog'
  | 'government'
  | 'community'
  | 'personal_blog'
  | 'unknown';

export interface SourceProfile {
  slug: string;
  name: string;
  domains: string[];
  lens: SourceLens;
  country: string | null;
  type: SourceType;
  owner: string | null;
  funding: string | null;
  /** True for outlets controlled or funded by a state with editorial control (not public broadcasters with legal independence). */
  stateAffiliated: boolean;
  /** Short, factual notes a reader should know (e.g. "republishes university press releases"). */
  noteUk: string | null;
  noteEn: string | null;
}

export const LENS_LABELS: Record<SourceLens, { uk: string; en: string }> = {
  ua_media: { uk: 'Українські медіа', en: 'Ukrainian media' },
  intl_media: { uk: 'Міжнародні медіа', en: 'International media' },
  official: { uk: 'Офіційні джерела (компанії, держоргани)', en: 'Official sources (companies, agencies)' },
  specialist: { uk: 'Профільні й наукові видання', en: 'Specialist and science outlets' },
  community: { uk: 'Спільноти й авторські блоги', en: 'Communities and personal blogs' },
  unknown: { uk: 'Профіль не заповнено', en: 'Profile not filled in' },
};

type Seed = Omit<SourceProfile, 'stateAffiliated' | 'noteUk' | 'noteEn' | 'owner' | 'funding' | 'country'> &
  Partial<Pick<SourceProfile, 'stateAffiliated' | 'noteUk' | 'noteEn' | 'owner' | 'funding' | 'country'>>;

const UP_GROUP = 'Українська правда (контрольний пакет — Dragon Capital з 2021)';
const SEEDS: Seed[] = [
  { slug: 'pravda-ua', name: 'Українська правда', domains: ['pravda.com.ua', 'life.pravda.com.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', owner: UP_GROUP, funding: 'Реклама, читацька підписка' },
  { slug: 'eurointegration-ua', name: 'Європейська правда', domains: ['eurointegration.com.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', owner: UP_GROUP, funding: 'Реклама, читацька підписка' },
  { slug: 'epravda-ua', name: 'Економічна правда', domains: ['epravda.com.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', owner: UP_GROUP, funding: 'Реклама, читацька підписка' },
  { slug: 'suspilne-news', name: 'Суспільне Новини', domains: ['suspilne.media'], lens: 'ua_media', country: 'UA', type: 'public_broadcaster', owner: 'АТ «НСТУ» (суспільний мовник)', funding: 'Державний бюджет за законом, редакційна незалежність гарантована законом', noteUk: 'Суспільний мовник, не державний: наглядова рада, а не уряд, призначає керівництво.', noteEn: 'Public, not state broadcaster: a supervisory board, not the government, appoints management.' },
  { slug: 'itc-ua', name: 'ITC.ua', domains: ['itc.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', funding: 'Реклама' },
  { slug: 'dou-ua', name: 'DOU.ua', domains: ['dou.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', funding: 'Реклама, вакансії', noteUk: 'Спільнота розробників: частина матеріалів — колонки користувачів.', noteEn: 'Developer community: part of the content is user columns.' },
  { slug: 'dev-ua', name: 'Dev.ua', domains: ['dev.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', funding: 'Реклама' },
  { slug: 'ain-ua', name: 'AIN.UA', domains: ['ain.ua'], lens: 'ua_media', country: 'UA', type: 'commercial_media', funding: 'Реклама' },
  { slug: 'mezha-media', name: 'Mezha.Media', domains: ['mezha.media'], lens: 'ua_media', country: 'UA', type: 'commercial_media', funding: 'Реклама' },

  { slug: 'bbc-world', name: 'BBC News World', domains: ['bbc.com', 'bbc.co.uk'], lens: 'intl_media', country: 'GB', type: 'public_broadcaster', owner: 'BBC (публічна корпорація)', funding: 'Ліцензійний збір; World Service частково фінансує уряд Великої Британії' },
  { slug: 'bbc-business', name: 'BBC Business', domains: [], lens: 'intl_media', country: 'GB', type: 'public_broadcaster', owner: 'BBC (публічна корпорація)', funding: 'Ліцензійний збір' },
  { slug: 'bbc-health', name: 'BBC Health', domains: [], lens: 'intl_media', country: 'GB', type: 'public_broadcaster', owner: 'BBC (публічна корпорація)', funding: 'Ліцензійний збір' },
  { slug: 'bbc-culture', name: 'BBC Culture & Arts', domains: [], lens: 'intl_media', country: 'GB', type: 'public_broadcaster', owner: 'BBC (публічна корпорація)', funding: 'Ліцензійний збір' },
  { slug: 'guardian-world', name: 'The Guardian', domains: ['theguardian.com'], lens: 'intl_media', country: 'GB', type: 'nonprofit_media', owner: 'Scott Trust (Guardian Media Group)', funding: 'Внески читачів, реклама' },
  { slug: 'guardian-culture', name: 'The Guardian Culture', domains: [], lens: 'intl_media', country: 'GB', type: 'nonprofit_media', owner: 'Scott Trust (Guardian Media Group)', funding: 'Внески читачів, реклама' },
  { slug: 'cnbc-finance', name: 'CNBC', domains: ['cnbc.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'NBCUniversal (Comcast)', funding: 'Реклама' },
  { slug: 'the-verge', name: 'The Verge', domains: ['theverge.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Vox Media', funding: 'Реклама, підписка' },
  { slug: 'wired', name: 'WIRED', domains: ['wired.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Condé Nast', funding: 'Реклама, підписка' },
  { slug: 'ars-technica', name: 'Ars Technica', domains: ['arstechnica.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Condé Nast', funding: 'Реклама, підписка' },
  { slug: 'ars-technica-science', name: 'Ars Technica Science', domains: [], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Condé Nast', funding: 'Реклама, підписка' },
  { slug: 'engadget', name: 'Engadget', domains: ['engadget.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Yahoo', funding: 'Реклама' },
  { slug: 'techcrunch-startups', name: 'TechCrunch', domains: ['techcrunch.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Yahoo', funding: 'Реклама, події' },
  { slug: 'venturebeat-ai', name: 'VentureBeat', domains: ['venturebeat.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', funding: 'Реклама, події' },
  { slug: 'deadline', name: 'Deadline', domains: ['deadline.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Penske Media', funding: 'Реклама' },
  { slug: 'polygon', name: 'Polygon', domains: ['polygon.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', funding: 'Реклама' },
  { slug: 'coindesk', name: 'CoinDesk', domains: ['coindesk.com'], lens: 'intl_media', country: 'US', type: 'commercial_media', owner: 'Bullish (криптобіржа) з 2023', funding: 'Реклама, події', noteUk: 'Власник — криптобіржа: можливий конфлікт інтересів у темах крипторинку.', noteEn: 'Owned by a crypto exchange: possible conflict of interest on crypto-market topics.' },

  { slug: 'nature-news', name: 'Nature', domains: ['nature.com'], lens: 'specialist', country: 'GB', type: 'scientific_publisher', owner: 'Springer Nature', funding: 'Підписка, публікаційні внески' },
  { slug: 'sciencedaily-science', name: 'ScienceDaily', domains: ['sciencedaily.com'], lens: 'specialist', country: 'US', type: 'commercial_media', funding: 'Реклама', noteUk: 'Переважно публікує прес-релізи університетів без незалежної перевірки.', noteEn: 'Mostly republishes university press releases without independent review.' },
  { slug: 'sciencedaily-health', name: 'ScienceDaily Health', domains: [], lens: 'specialist', country: 'US', type: 'commercial_media', funding: 'Реклама', noteUk: 'Переважно публікує прес-релізи університетів без незалежної перевірки.', noteEn: 'Mostly republishes university press releases without independent review.' },
  { slug: 'space-com', name: 'Space.com', domains: ['space.com'], lens: 'specialist', country: 'US', type: 'commercial_media', owner: 'Future plc', funding: 'Реклама' },
  { slug: 'psypost-psychology', name: 'PsyPost', domains: ['psypost.org'], lens: 'specialist', country: 'US', type: 'commercial_media', funding: 'Реклама', noteUk: 'Переказує окремі дослідження: одне дослідження ще не науковий консенсус.', noteEn: 'Summarises single studies: one study is not a scientific consensus.' },
  { slug: 'carbon-brief', name: 'Carbon Brief', domains: ['carbonbrief.org'], lens: 'specialist', country: 'GB', type: 'nonprofit_media', funding: 'Гранти, зокрема European Climate Foundation' },
  { slug: 'mit-tech-review', name: 'MIT Technology Review', domains: ['technologyreview.com'], lens: 'specialist', country: 'US', type: 'nonprofit_media', owner: 'Massachusetts Institute of Technology', funding: 'Підписка, реклама' },
  { slug: 'the-decoder', name: 'The Decoder', domains: ['the-decoder.com'], lens: 'specialist', country: 'DE', type: 'commercial_media', funding: 'Реклама, підписка' },
  { slug: 'toms-hardware', name: "Tom's Hardware", domains: ['tomshardware.com'], lens: 'specialist', country: 'US', type: 'commercial_media', owner: 'Future plc', funding: 'Реклама, партнерські посилання' },
  { slug: 'pc-gamer', name: 'PC Gamer', domains: ['pcgamer.com'], lens: 'specialist', country: 'GB', type: 'commercial_media', owner: 'Future plc', funding: 'Реклама, партнерські посилання' },
  { slug: 'eurogamer', name: 'Eurogamer', domains: ['eurogamer.net'], lens: 'specialist', country: 'GB', type: 'commercial_media', funding: 'Реклама' },
  { slug: 'electrek', name: 'Electrek', domains: ['electrek.co'], lens: 'specialist', country: 'US', type: 'commercial_media', funding: 'Реклама, партнерські посилання' },
  { slug: 'the-hacker-news', name: 'The Hacker News', domains: ['thehackernews.com'], lens: 'specialist', country: null, type: 'commercial_media', funding: 'Реклама, спонсорські матеріали' },
  { slug: 'bleepingcomputer', name: 'BleepingComputer', domains: ['bleepingcomputer.com'], lens: 'specialist', country: 'US', type: 'commercial_media', funding: 'Реклама' },

  { slug: 'nasa-breaking-news', name: 'NASA', domains: ['nasa.gov'], lens: 'official', country: 'US', type: 'government', owner: 'Уряд США', funding: 'Федеральний бюджет США', noteUk: 'Офіційне джерело: подає позицію агенції.', noteEn: 'Official source: presents the agency position.' },
  { slug: 'openai-news', name: 'OpenAI', domains: ['openai.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'OpenAI', funding: 'Власні продукти', noteUk: 'Блог компанії: заяви про власні продукти — це заяви сторони.', noteEn: 'Company blog: claims about its own products are claims of an interested party.' },
  { slug: 'anthropic-news-community-feed', name: 'Anthropic', domains: ['anthropic.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Anthropic', funding: 'Власні продукти', noteUk: 'Блог компанії (через неофіційне RSS-дзеркало).', noteEn: 'Company blog (via an unofficial RSS mirror).' },
  { slug: 'google-deepmind', name: 'Google DeepMind', domains: ['deepmind.google'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Alphabet', funding: 'Власні продукти' },
  { slug: 'google-ai-blog', name: 'Google AI Blog', domains: ['blog.google'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Alphabet', funding: 'Власні продукти' },
  { slug: 'google-research', name: 'Google Research', domains: ['research.google'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Alphabet', funding: 'Власні продукти' },
  { slug: 'mistral-ai-community-feed', name: 'Mistral AI', domains: ['mistral.ai'], lens: 'official', country: 'FR', type: 'corporate_blog', owner: 'Mistral AI', funding: 'Власні продукти' },
  { slug: 'hugging-face', name: 'Hugging Face', domains: ['huggingface.co'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Hugging Face', funding: 'Власні продукти' },
  { slug: 'aws-ml', name: 'AWS Machine Learning', domains: ['aws.amazon.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Amazon', funding: 'Власні продукти' },
  { slug: 'nvidia-blog', name: 'NVIDIA Blog', domains: ['blogs.nvidia.com', 'nvidia.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'NVIDIA', funding: 'Власні продукти' },
  { slug: 'cloudflare-blog', name: 'Cloudflare Blog', domains: ['blog.cloudflare.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Cloudflare', funding: 'Власні продукти' },
  { slug: 'github-blog', name: 'GitHub Blog', domains: ['github.blog'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Microsoft', funding: 'Власні продукти' },
  { slug: 'yc-blog', name: 'Y Combinator Blog', domains: ['ycombinator.com'], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Y Combinator', funding: 'Венчурні інвестиції', noteUk: 'Блог інвестора: пише про власні портфельні компанії.', noteEn: 'Investor blog: writes about its own portfolio companies.' },
  { slug: 'claude-code-releases', name: 'Claude Code Releases', domains: [], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'Anthropic', funding: 'Власні продукти' },
  { slug: 'openai-python-sdk', name: 'OpenAI Python SDK', domains: [], lens: 'official', country: 'US', type: 'corporate_blog', owner: 'OpenAI', funding: 'Власні продукти' },
  { slug: 'ollama-releases', name: 'Ollama Releases', domains: [], lens: 'community', country: null, type: 'community', funding: null },
  { slug: 'vllm-releases', name: 'vLLM Releases', domains: [], lens: 'community', country: null, type: 'community', funding: null },

  { slug: 'hacker-news-top', name: 'Hacker News', domains: ['news.ycombinator.com', 'hnrss.org'], lens: 'community', country: 'US', type: 'community', owner: 'Y Combinator', funding: null, noteUk: 'Агрегатор посилань із голосуванням користувачів, не редакція.', noteEn: 'User-voted link aggregator, not a newsroom.' },
  { slug: 'simon-willison', name: 'Simon Willison', domains: ['simonwillison.net'], lens: 'community', country: 'US', type: 'personal_blog', owner: 'Simon Willison', funding: null, noteUk: 'Авторський блог незалежного розробника.', noteEn: 'Personal blog of an independent developer.' },
  { slug: 'krebs-on-security', name: 'Krebs on Security', domains: ['krebsonsecurity.com'], lens: 'community', country: 'US', type: 'personal_blog', owner: 'Brian Krebs', funding: 'Реклама', noteUk: 'Авторське розслідувальне видання одного журналіста.', noteEn: 'One-journalist investigative blog.' },
];

export const SOURCE_PROFILES: SourceProfile[] = SEEDS.map((s) => ({
  stateAffiliated: false,
  noteUk: null,
  noteEn: null,
  owner: null,
  funding: null,
  country: null,
  ...s,
}));

const BY_SLUG = new Map(SOURCE_PROFILES.map((p) => [p.slug, p]));
const BY_DOMAIN = new Map<string, SourceProfile>();
for (const p of SOURCE_PROFILES) for (const d of p.domains) if (!BY_DOMAIN.has(d)) BY_DOMAIN.set(d, p);

/** Aliases used by the feed catalog (community mirrors publish under the company's slug). */
const SLUG_ALIASES: Record<string, string> = {
  'anthropic-news': 'anthropic-news-community-feed',
  'mistral-ai': 'mistral-ai-community-feed',
};

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function profileForSlug(slug: string | null | undefined): SourceProfile | null {
  if (!slug) return null;
  return BY_SLUG.get(slug) ?? BY_SLUG.get(SLUG_ALIASES[slug] ?? '') ?? null;
}

export function profileForUrl(url: string | null | undefined): SourceProfile | null {
  const host = hostOf(url);
  if (!host) return null;
  if (BY_DOMAIN.has(host)) return BY_DOMAIN.get(host)!;
  // sub.domain.tld → domain.tld
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    const candidate = parts.slice(i).join('.');
    if (BY_DOMAIN.has(candidate)) return BY_DOMAIN.get(candidate)!;
  }
  return null;
}

export function resolveProfile(slug: string | null | undefined, url?: string | null): SourceProfile | null {
  return profileForSlug(slug) ?? profileForUrl(url);
}

export function lensOf(slug: string | null | undefined, url?: string | null): SourceLens {
  return resolveProfile(slug, url)?.lens ?? 'unknown';
}

export function localizeProfile(p: SourceProfile | null, lang: 'uk' | 'en') {
  if (!p) return null;
  return {
    slug: p.slug,
    name: p.name,
    lens: p.lens,
    lensLabel: LENS_LABELS[p.lens][lang],
    country: p.country,
    type: p.type,
    owner: p.owner,
    funding: p.funding,
    stateAffiliated: p.stateAffiliated,
    note: lang === 'en' ? p.noteEn : p.noteUk,
  };
}

export interface CoverageSource {
  sourceSlug?: string | null;
  sourceName?: string | null;
  url?: string | null;
}

/**
 * Blindspot: which lenses covered a story and which important lenses are missing.
 * A story reported only by companies/agencies (no independent media) or only by one media lens is flagged.
 */
export function analyzeCoverage(sources: CoverageSource[], lang: 'uk' | 'en' = 'uk') {
  const counts: Partial<Record<SourceLens, number>> = {};
  for (const s of sources) {
    const lens = lensOf(s.sourceSlug ?? null, s.url ?? null);
    counts[lens] = (counts[lens] ?? 0) + 1;
  }
  const covered = (Object.keys(counts) as SourceLens[]).filter((l) => l !== 'unknown');
  const media = covered.filter((l) => l === 'ua_media' || l === 'intl_media');
  let blindspot: null | { kind: 'only_official' | 'only_ua' | 'only_intl' | 'single_source'; text: string } = null;
  const total = sources.length;
  const L = (uk: string, en: string) => (lang === 'en' ? en : uk);
  if (total <= 1) {
    blindspot = { kind: 'single_source', text: L('Про це поки повідомило лише одне джерело.', 'Only one source has reported this so far.') };
  } else if (covered.length > 0 && media.length === 0 && covered.includes('official')) {
    blindspot = { kind: 'only_official', text: L('Про це пишуть лише самі учасники події, незалежні медіа ще не перевіряли.', 'Only the parties involved report this; independent media have not covered it yet.') };
  } else if (media.length === 1 && media[0] === 'ua_media' && !covered.includes('intl_media')) {
    blindspot = { kind: 'only_ua', text: L('Історію висвітлюють лише українські медіа — міжнародні поки мовчать.', 'Only Ukrainian media cover this; international outlets have not yet.') };
  } else if (media.length === 1 && media[0] === 'intl_media' && !covered.includes('ua_media')) {
    blindspot = { kind: 'only_intl', text: L('Історію висвітлюють лише міжнародні медіа — українські поки мовчать.', 'Only international media cover this; Ukrainian outlets have not yet.') };
  }
  return {
    lenses: covered.map((l) => ({ lens: l, label: LENS_LABELS[l][lang], count: counts[l] ?? 0 })),
    unknownCount: counts.unknown ?? 0,
    blindspot,
  };
}
