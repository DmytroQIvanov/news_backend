import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { canonicalizeUrl } from '../common/url-utils';
import { LicenseMode } from '../common/source-compliance';

export interface ClusterSource {
  id: string;
  title: string;
  titleUk?: string | null;
  url: string;
  canonicalUrl: string;
  sourceName: string;
  sourceSlug: string;
  publishedAt: string | null;
  unofficial?: boolean;
  licenseMode?: LicenseMode;
  summary?: string | null;
}

export interface ClusterableArticle {
  id: string;
  url: string;
  canonicalUrl?: string;
  original_title?: string;
  title?: string;
  title_uk?: string | null;
  titleUk?: string | null;
  summary?: string | null;
  summary_uk?: string | null;
  source_name?: string;
  sourceName?: string;
  source_slug?: string;
  sourceSlug?: string;
  published_at?: Date | string | null;
  publishedAt?: Date | string | null;
  category?: string;
  importance?: string;
  important?: boolean;
  hydrogen_deep_analysis?: boolean;
  source_is_unofficial?: boolean;
  unofficial?: boolean;
  license_mode?: LicenseMode;
  licenseMode?: LicenseMode;
  cluster_id?: string | null;
  cluster_sources?: ClusterSource[] | null;
  article?: unknown;
  [key: string]: unknown;
}

const CLUSTER_WINDOW_MS = 48 * 60 * 60_000;

const STOPWORDS = new Set([
  // English stopwords & generic news verbs
  'the', 'and', 'for', 'with', 'that', 'from', 'this', 'will', 'have', 'has', 'had', 'are', 'was',
  'were', 'been', 'being', 'into', 'over', 'after', 'before', 'about', 'under', 'between', 'what',
  'when', 'where', 'which', 'who', 'why', 'how', 'more', 'most', 'some', 'such', 'only', 'than',
  'then', 'them', 'they', 'their', 'there', 'here', 'just', 'like', 'also', 'even', 'very', 'much',
  'many', 'could', 'would', 'should', 'says', 'said', 'say', 'report', 'reports', 'reported',
  'according', 'new', 'news', 'latest', 'update', 'updates', 'announces', 'announced', 'launch',
  'launches', 'launched', 'release', 'releases', 'released', 'introduces', 'introduced', 'makes',
  'making', 'made', 'take', 'takes', 'taking', 'took', 'first', 'year', 'years', 'today', 'week',
  'month', 'days', 'time', 'world', 'global', 'company', 'companies', 'official', 'users', 'user',
  // Ukrainian stopwords & generic verbs
  'про', 'для', 'що', 'який', 'яка', 'яке', 'які', 'буде', 'були', 'було', 'бути', 'після', 'перед',
  'через', 'між', 'також', 'коли', 'куди', 'звідки', 'вони', 'вона', 'воно', 'його', 'її', 'їх',
  'цей', 'ця', 'це', 'ці', 'того', 'тому', 'лише', 'тільки', 'дуже', 'більш', 'менш', 'може',
  'можуть', 'повідомив', 'повідомила', 'повідомили', 'повідомляє', 'заявив', 'заявила', 'заявили',
  'розповіли', 'новий', 'нова', 'нове', 'нові', 'новини', 'світ', 'світі', 'компанія', 'компанії',
  'користувачів', 'року', 'році', 'років', 'сьогодні', 'тиждень', 'місяць', 'перший', 'перша',
  // Too generic domain tokens that must not cluster unrelated stories alone
  'tech', 'technology', 'science', 'research', 'study', 'paper', 'model', 'models', 'system',
]);

// Cross-lingual canonical concept mapping (Cyrillic stems & English synonyms -> canonical concept keys)
const CONCEPT_ALIASES: Array<[RegExp, string]> = [
  [/\b(?:artificial intelligence|ai|штучн\p{L}* інтелект\p{L}*|ші)\b/giu, 'concept_ai'],
  [/\b(?:ukraine|ukrainian|україн\p{L}*)\b/giu, 'geo_ukraine'],
  [/\b(?:united states|u\.s\.|usa|america|american|сша|америк\p{L}*)\b/giu, 'geo_us'],
  [/\b(?:european union|europe|eu|європ\p{L}*|єс|євросоюз\p{L}*)\b/giu, 'geo_eu'],
  [/\b(?:britain|british|united kingdom|uk|британ\p{L}*|великобритан\p{L}*)\b/giu, 'geo_uk'],
  [/\b(?:china|chinese|кита\p{L}*)\b/giu, 'geo_china'],
  [/\b(?:russia|russian|росі\p{L}*)\b/giu, 'geo_russia'],
  [/\b(?:microsoft|майкрософт)\b/giu, 'org_microsoft'],
  [/\b(?:google|гугл|deepmind)\b/giu, 'org_google'],
  [/\b(?:openai|опенаі)\b/giu, 'org_openai'],
  [/\b(?:anthropic|антропік)\b/giu, 'org_anthropic'],
  [/\b(?:nvidia|нвідіа)\b/giu, 'org_nvidia'],
  [/\b(?:apple|епл)\b/giu, 'org_apple'],
  [/\b(?:meta|мета)\b/giu, 'org_meta'],
  [/\b(?:amazon|амазон|aws)\b/giu, 'org_amazon'],
  [/\b(?:tesla|тесла)\b/giu, 'org_tesla'],
  [/\b(?:spacex|спейсікс)\b/giu, 'org_spacex'],
  [/\b(?:nasa|наса)\b/giu, 'org_nasa'],
  [/\b(?:cern|церн)\b/giu, 'org_cern'],
  [/\b(?:outage|blackout|crash|disruption|downtime|збій|відключен\p{L}*|блекаут\p{L}*)\b/giu, 'evt_outage'],
  [/\b(?:cyberattack|breach|hack|hacked|ransomware|кібератак\p{L}*|злам\p{L}*|витік\p{L}*)\b/giu, 'evt_cyber'],
  [/\b(?:sanctions|tariffs|санкці\p{L}*|мита|тарифи)\b/giu, 'evt_sanctions'],
  [/\b(?:vaccine|vaccination|вакцин\p{L}*)\b/giu, 'evt_vaccine'],
  [/\b(?:satellite|супутник\p{L}*)\b/giu, 'evt_satellite'],
  [/\b(?:fusion|reactor|термоядер\p{L}*|реактор\p{L}*)\b/giu, 'evt_fusion'],
  [/\b(?:quantum|квантов\p{L}*)\b/giu, 'evt_quantum'],
  [/\b(?:semiconductor|chip|chips|gpu|gpus|мікрочип\p{L}*|напівпровідник\p{L}*|чип\p{L}*)\b/giu, 'evt_chip'],
  [/\b(?:open[- ]source|open[- ]weights|відкрит\p{L}* код\p{L}*|відкрит\p{L}* ваг\p{L}*)\b/giu, 'evt_opensource'],
  [/\b(?:lawsuit|sues|sued|antitrust|позов\p{L}*|антимонополь\p{L}*)\b/giu, 'evt_lawsuit'],
  [/\b(?:acquisition|acquire|acquired|merger|купила|придба\p{L}*|поглинан\p{L}*)\b/giu, 'evt_mna'],
  [/\b(?:funding|raised|investment|інвестиц\p{L}*|раунд\p{L}*)\b/giu, 'evt_funding'],
  [/\b(?:rocket|starship|falcon|артем\p{L}*|artemis|ракет\p{L}*)\b/giu, 'evt_spaceflight'],
  [/\b(?:claude|клод)\b/giu, 'prod_claude'],
  [/\b(?:chatgpt|gpt|джпт)\b/giu, 'prod_gpt'],
  [/\b(?:gemini|джеміні)\b/giu, 'prod_gemini'],
  [/\b(?:llama|лама)\b/giu, 'prod_llama'],
  [/\b(?:deepseek|діпсік)\b/giu, 'prod_deepseek'],
  [/\b(?:mistral|містрал\p{L}*)\b/giu, 'prod_mistral'],
  [/\b(?:copilot|копайлот)\b/giu, 'prod_copilot'],
  [/\b(?:starlink|старлінк\p{L}*)\b/giu, 'prod_starlink'],
  [/\b(?:iphone|айфон\p{L}*)\b/giu, 'prod_iphone'],
  [/\b(?:android|андроїд\p{L}*)\b/giu, 'prod_android'],
  [/\b(?:intel|інтел)\b/giu, 'org_intel'],
  [/\b(?:amd|амд)\b/giu, 'org_amd'],
  [/\b(?:tsmc)\b/giu, 'org_tsmc'],
  [/\b(?:samsung|самсунг)\b/giu, 'org_samsung'],
  [/\b(?:nato|нато)\b/giu, 'org_nato'],
  [/\b(?:imf|мвф)\b/giu, 'org_imf'],
  [/\b(?:pentagon|пентагон\p{L}*)\b/giu, 'org_pentagon'],
  [/\b(?:patriot|петріот\p{L}*)\b/giu, 'def_patriot'],
  [/\b(?:f-?16|ф-?16)\b/giu, 'def_f16'],
  [/\b(?:drone|drones|uav|fpv|дрон\p{L}*|бпла|безпілот\p{L}*)\b/giu, 'evt_drone'],
  [/\b(?:missile|missiles|ракет\p{L}*|обстріл\p{L}*)\b/giu, 'evt_missile'],
  [/\b(?:ceasefire|truce|перемир\p{L}*|мирн\p{L}* угод\p{L}*)\b/giu, 'evt_ceasefire'],
  [/\b(?:interest rate|fed|ecb|nbu|нбу|обліков\p{L}* ставк\p{L}*|інфляці\p{L}*|inflation)\b/giu, 'evt_monetary'],
  [/\b(?:energy|grid|substation|енергет\p{L}*|енергосистем\p{L}*|підстанц\p{L}*)\b/giu, 'evt_energy'],
];

export interface ClusterSignature {
  tokens: Set<string>;
  entities: Set<string>;
  titleTokens: Set<string>;
}

function normalizeTokenText(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/([a-z])[-_](\d)/g, '$1$2') // gpt-5 -> gpt5, f-35 -> f35
    .replace(/(\d)[-_]([a-z])/g, '$1$2');
}

export function extractClusterSignature(title: string, summary?: string | null): ClusterSignature {
  const combinedTitle = title || '';
  const combinedAll = `${combinedTitle} ${(summary || '').slice(0, 300)}`.trim();

  const entities = new Set<string>();
  const tokens = new Set<string>();
  const titleTokens = new Set<string>();

  for (const [pattern, conceptKey] of CONCEPT_ALIASES) {
    if (pattern.test(combinedAll)) {
      entities.add(conceptKey);
      tokens.add(conceptKey);
      if (pattern.test(combinedTitle)) {
        titleTokens.add(conceptKey);
      }
    }
    pattern.lastIndex = 0;
  }

  // Extract ASCII proper/technical identifiers & versioned tokens (e.g. gpt-5, claude-4, rtx5090, h200, b200)
  const extractWords = (text: string, target: Set<string>, alsoEntities = false) => {
    const norm = normalizeTokenText(text);
    const matches = norm.match(/[\p{L}\p{N}]+(?:\.[\p{L}\p{N}]+)*/gu) || [];
    for (const m of matches) {
      if (m.length < 3) continue;
      if (/^\d{4}$/.test(m) && (m === '2024' || m === '2025' || m === '2026' || m === '2027')) {
        continue; // Years alone match too broadly
      }
      if (STOPWORDS.has(m)) continue;
      // Normalize simple English plurals / Cyrillic short inflection tails for 5+ char words
      const stem =
        /^[a-z]{5,}s$/.test(m) && !m.endsWith('ss')
          ? m.slice(0, -1)
          : /^[\u0400-\u04ff]{6,}$/.test(m)
            ? m.slice(0, 5)
            : m;
      target.add(stem);
      if (
        alsoEntities &&
        (/^[a-z]+\d+[a-z0-9.]*$/.test(m) ||
          /^\d+[a-z]+$/.test(m) ||
          /^[a-z0-9]{2,}\.[a-z0-9.]+$/.test(m))
      ) {
        entities.add(stem);
      }
    }
  };

  // Capture capitalized proper nouns from original title as entities
  const properNouns = (combinedTitle.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/g) || [])
    .map(w => normalizeTokenText(w))
    .filter(w => !STOPWORDS.has(w) && w.length >= 3);
  for (const pn of properNouns) {
    entities.add(pn);
  }

  extractWords(combinedTitle, titleTokens, true);
  extractWords(combinedAll, tokens, true);

  return { tokens, entities, titleTokens };
}

function setIntersectionCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) count += 1;
  }
  return count;
}

export function computeClusterSimilarity(
  a: { sig: ClusterSignature; publishedAt: number | null; sourceSlug: string; canonicalUrl: string },
  b: { sig: ClusterSignature; publishedAt: number | null; sourceSlug: string; canonicalUrl: string },
): { match: boolean; score: number } {
  if (a.canonicalUrl && b.canonicalUrl && a.canonicalUrl === b.canonicalUrl) {
    return { match: true, score: 1 };
  }
  if (
    a.publishedAt !== null &&
    b.publishedAt !== null &&
    Math.abs(a.publishedAt - b.publishedAt) > CLUSTER_WINDOW_MS
  ) {
    return { match: false, score: 0 };
  }

  const tokenInter = setIntersectionCount(a.sig.tokens, b.sig.tokens);
  const titleInter = setIntersectionCount(a.sig.titleTokens, b.sig.titleTokens);
  const entityInter = setIntersectionCount(a.sig.entities, b.sig.entities);

  if (tokenInter < 2 && titleInter < 2 && entityInter < 2) {
    return { match: false, score: 0 };
  }

  const tokenUnion = a.sig.tokens.size + b.sig.tokens.size - tokenInter;
  const jaccard = tokenUnion > 0 ? tokenInter / tokenUnion : 0;

  const minTitleSize = Math.min(a.sig.titleTokens.size, b.sig.titleTokens.size);
  const titleOverlap = minTitleSize > 0 ? titleInter / minTitleSize : 0;

  const sameSource = a.sourceSlug && b.sourceSlug && a.sourceSlug === b.sourceSlug;
  if (sameSource) {
    // Only merge same-source updates if headlines are nearly identical
    const match = jaccard >= 0.72 || titleOverlap >= 0.8;
    return { match, score: Math.max(jaccard, titleOverlap) };
  }

  // Strong title match
  if (titleInter >= 3 && (titleOverlap >= 0.5 || jaccard >= 0.36)) {
    return { match: true, score: Math.max(titleOverlap, jaccard) };
  }
  // High combined token similarity
  if (jaccard >= 0.4 && tokenInter >= 3) {
    return { match: true, score: jaccard };
  }
  // Cross-lingual entity + event match (e.g. EN article + UK translation with shared org + model/event)
  if (entityInter >= 2 && (titleInter >= 2 || tokenInter >= 3) && jaccard >= 0.22) {
    return { match: true, score: 0.3 + entityInter * 0.1 + jaccard };
  }

  return { match: false, score: jaccard };
}

export function buildStableClusterId(urls: string[]): string {
  const sorted = [...new Set(urls.map(u => canonicalizeUrl(u) || u).filter(Boolean))].sort();
  const digest = createHash('sha256')
    .update(sorted[0] || String(Date.now()))
    .digest('hex')
    .slice(0, 16);
  return `cls_${digest}`;
}

function getCanonicalForArticle(item: ClusterableArticle): string {
  return item.canonicalUrl || canonicalizeUrl(item.url) || item.url;
}

function getSourceSlugForArticle(item: ClusterableArticle): string {
  return item.source_slug || item.sourceSlug || '';
}

function getSourceNameForArticle(item: ClusterableArticle): string {
  return item.source_name || item.sourceName || getSourceSlugForArticle(item);
}

function getPublishedTsForArticle(item: ClusterableArticle): number | null {
  const raw = item.published_at ?? item.publishedAt ?? null;
  if (!raw) return null;
  const ts = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function scorePrimaryCandidate(item: ClusterableArticle): number {
  let score = 0;
  if (item.article) score += 40;
  if (item.title_uk || item.titleUk) score += 25;
  if (item.summary_uk) score += 15;
  if (!(item.source_is_unofficial ?? item.unofficial)) score += 12;
  if (item.importance === 'critical') score += 10;
  else if (item.importance === 'high') score += 6;
  const ts = getPublishedTsForArticle(item);
  if (ts) score += Math.min(5, ts / 1e13);
  return score;
}

export function toClusterSource(item: ClusterableArticle): ClusterSource {
  const canon = getCanonicalForArticle(item);
  const rawPub = item.published_at ?? item.publishedAt ?? null;
  const publishedAtIso =
    rawPub instanceof Date ? rawPub.toISOString() : typeof rawPub === 'string' ? rawPub : null;
  return {
    id: item.id,
    title: item.original_title || item.title || item.title_uk || item.titleUk || '',
    titleUk: item.title_uk ?? item.titleUk ?? null,
    url: item.url,
    canonicalUrl: canon,
    sourceName: getSourceNameForArticle(item),
    sourceSlug: getSourceSlugForArticle(item),
    publishedAt: publishedAtIso,
    unofficial: Boolean(item.source_is_unofficial ?? item.unofficial),
    licenseMode: item.license_mode ?? item.licenseMode,
    summary: item.summary_uk ?? item.summary ?? null,
  };
}

export function mergeClusterSources(
  lists: Array<ClusterSource[] | null | undefined>,
): ClusterSource[] {
  const byCanonical = new Map<string, ClusterSource>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const src of list) {
      if (!src?.url) continue;
      const canon = src.canonicalUrl || canonicalizeUrl(src.url) || src.url;
      const existing = byCanonical.get(canon);
      if (!existing || (!existing.titleUk && src.titleUk)) {
        byCanonical.set(canon, { ...src, canonicalUrl: canon });
      }
    }
  }
  return [...byCanonical.values()].sort((a, b) => {
    const aUnofficial = a.unofficial ? 1 : 0;
    const bUnofficial = b.unofficial ? 1 : 0;
    if (aUnofficial !== bUnofficial) return aUnofficial - bUnofficial;
    const aTs = a.publishedAt ? Date.parse(a.publishedAt) || 0 : 0;
    const bTs = b.publishedAt ? Date.parse(b.publishedAt) || 0 : 0;
    return bTs - aTs;
  });
}

export type ClusteredNewsItem<T extends ClusterableArticle> = T & {
  cluster_id: string | null;
  cluster_sources: ClusterSource[];
  source_count: number;
};

/**
 * Groups items covering the same real-world event into a single primary item
 * with `cluster_id`, deduplicated `cluster_sources`, and `source_count`.
 */
export function clusterNewsItems<T extends ClusterableArticle>(
  items: T[],
): Array<ClusteredNewsItem<T>> {
  if (items.length === 0) return [];

  const prepared = items.map((item, idx) => {
    const rawTitle = `${item.original_title || item.title || ''} ${item.title_uk || item.titleUk || ''}`.trim();
    const rawSummary = item.summary_uk || item.summary || null;
    return {
      idx,
      item,
      canonicalUrl: getCanonicalForArticle(item),
      sourceSlug: getSourceSlugForArticle(item),
      publishedAt: getPublishedTsForArticle(item),
      sig: extractClusterSignature(rawTitle, rawSummary),
    };
  });

  // Union-Find over items
  const parent = prepared.map((_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur]];
      cur = parent[cur];
    }
    return cur;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const a = prepared[i];
      const b = prepared[j];
      if (a.item.cluster_id && b.item.cluster_id && a.item.cluster_id === b.item.cluster_id) {
        union(i, j);
        continue;
      }
      const sim = computeClusterSimilarity(a, b);
      if (sim.match) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, typeof prepared>();
  for (const entry of prepared) {
    const root = find(entry.idx);
    const list = groups.get(root) || [];
    list.push(entry);
    groups.set(root, list);
  }

  const mergedResults: Array<ClusteredNewsItem<T>> = [];
  for (const group of groups.values()) {
    group.sort((a, b) => scorePrimaryCandidate(b.item) - scorePrimaryCandidate(a.item));
    const primary = group[0].item;
    const allSources = mergeClusterSources([
      ...group.map(g => g.item.cluster_sources),
      group.map(g => toClusterSource(g.item)),
    ]);
    const existingClusterId = group.find(g => g.item.cluster_id)?.item.cluster_id ?? null;
    const clusterId =
      allSources.length > 1
        ? existingClusterId || buildStableClusterId(allSources.map(s => s.canonicalUrl || s.url))
        : existingClusterId;

    mergedResults.push({
      ...primary,
      cluster_id: clusterId,
      cluster_sources: allSources,
      source_count: allSources.length,
    });
  }

  // Keep chronological ordering by primary item's published_at desc (nulls last)
  mergedResults.sort((a, b) => {
    const tsA = getPublishedTsForArticle(a) ?? 0;
    const tsB = getPublishedTsForArticle(b) ?? 0;
    return tsB - tsA;
  });

  return mergedResults;
}

@Injectable()
export class NewsClusteringService {
  clusterItems<T extends ClusterableArticle>(items: T[]): Array<ClusteredNewsItem<T>> {
    return clusterNewsItems(items);
  }

  findRelatedSourcesForArticle<T extends ClusterableArticle>(
    target: ClusterableArticle,
    candidates: T[],
  ): { clusterId: string | null; clusterSources: ClusterSource[]; matchedPeers: T[] } {
    const targetEntry = {
      canonicalUrl: getCanonicalForArticle(target),
      sourceSlug: getSourceSlugForArticle(target),
      publishedAt: getPublishedTsForArticle(target),
      sig: extractClusterSignature(
        `${target.original_title || target.title || ''} ${target.title_uk || target.titleUk || ''}`,
        target.summary_uk || target.summary || null,
      ),
    };

    const matchedPeers: T[] = [];
    for (const candidate of candidates) {
      const candidateEntry = {
        canonicalUrl: getCanonicalForArticle(candidate),
        sourceSlug: getSourceSlugForArticle(candidate),
        publishedAt: getPublishedTsForArticle(candidate),
        sig: extractClusterSignature(
          `${candidate.original_title || candidate.title || ''} ${candidate.title_uk || candidate.titleUk || ''}`,
          candidate.summary_uk || candidate.summary || null,
        ),
      };
      if (candidateEntry.canonicalUrl === targetEntry.canonicalUrl) continue;
      if (computeClusterSimilarity(targetEntry, candidateEntry).match) {
        matchedPeers.push(candidate);
      }
    }

    const clusterSources = mergeClusterSources([
      target.cluster_sources,
      [toClusterSource(target)],
      ...matchedPeers.map(p => p.cluster_sources),
      matchedPeers.map(p => toClusterSource(p)),
    ]);

    const existingClusterId =
      target.cluster_id || matchedPeers.find(p => p.cluster_id)?.cluster_id || null;
    const clusterId =
      clusterSources.length > 1
        ? existingClusterId || buildStableClusterId(clusterSources.map(s => s.canonicalUrl || s.url))
        : existingClusterId;

    return { clusterId, clusterSources, matchedPeers };
  }

  /**
   * Matches an incoming article against recent persisted DB articles (within 48h)
   * and returns the best existing cluster target plus merged cluster_sources.
   */
  matchArticleToClusterCandidates<T extends ClusterableArticle>(
    target: ClusterableArticle,
    candidates: T[],
  ): {
    matchedItem: T;
    clusterId: string;
    clusterSources: ClusterSource[];
    score: number;
  } | null {
    if (!candidates.length) return null;

    const targetCanon = getCanonicalForArticle(target);
    const targetEntry = {
      canonicalUrl: targetCanon,
      sourceSlug: getSourceSlugForArticle(target),
      publishedAt: getPublishedTsForArticle(target),
      sig: extractClusterSignature(
        `${target.original_title || target.title || ''} ${target.title_uk || target.titleUk || ''}`,
        target.summary_uk || target.summary || null,
      ),
    };

    const matches: Array<{ item: T; score: number }> = [];
    for (const candidate of candidates) {
      const candidateCanon = getCanonicalForArticle(candidate);
      if (target.cluster_id && candidate.cluster_id && target.cluster_id === candidate.cluster_id) {
        matches.push({ item: candidate, score: 1 });
        continue;
      }
      if (candidateCanon === targetCanon) {
        matches.push({ item: candidate, score: 1 });
        continue;
      }
      const candidateEntry = {
        canonicalUrl: candidateCanon,
        sourceSlug: getSourceSlugForArticle(candidate),
        publishedAt: getPublishedTsForArticle(candidate),
        sig: extractClusterSignature(
          `${candidate.original_title || candidate.title || ''} ${candidate.title_uk || candidate.titleUk || ''}`,
          candidate.summary_uk || candidate.summary || null,
        ),
      };
      const sim = computeClusterSimilarity(targetEntry, candidateEntry);
      if (sim.match) {
        matches.push({ item: candidate, score: sim.score });
      }
    }

    if (matches.length === 0) return null;

    matches.sort((a, b) => {
      const scoreDiff = scorePrimaryCandidate(b.item) - scorePrimaryCandidate(a.item);
      if (scoreDiff !== 0) return scoreDiff;
      return b.score - a.score;
    });

    const primaryMatch = matches[0];
    const clusterSources = mergeClusterSources([
      primaryMatch.item.cluster_sources,
      [toClusterSource(primaryMatch.item)],
      ...matches.map(m => m.item.cluster_sources),
      ...matches.map(m => [toClusterSource(m.item)]),
      target.cluster_sources,
      [toClusterSource(target)],
    ]);

    const existingClusterId =
      matches.find(m => m.item.cluster_id)?.item.cluster_id || target.cluster_id || null;
    const clusterId =
      existingClusterId || buildStableClusterId(clusterSources.map(s => s.canonicalUrl || s.url));

    return {
      matchedItem: primaryMatch.item,
      clusterId,
      clusterSources,
      score: primaryMatch.score,
    };
  }
}
