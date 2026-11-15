import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { canUseHydrogenQuota, DEFAULT_GEMINI_MODEL, DEFAULT_HYDROGEN_MODEL, postGeminiGenerateContent } from '../common/gemini-client';
import { DatabaseService } from '../database/database.service';
import { CATEGORIES, NewsCategory } from '../ingest/ingest.dto';
import { CompanyFeedsService } from './company-feeds.service';
import {
  DocumentedExpertPosition,
  EXPERT_DIRECTORY,
  ExpertPlatform,
  ExpertProfile,
  scoreExpertCompetenceForTopic,
} from './expert-directory';

export type EmbedType = 'x_oembed' | 'facebook_plugin' | 'bsky_oembed' | 'hn_card' | 'web_embed';

export interface OfficialEmbedInfo {
  type: EmbedType;
  embedUrl: string;
  htmlSnippet?: string;
  providerName: string;
  interactiveSupported: boolean;
}

export interface ExpertOpinionItem {
  expertSlug?: string;
  expertName: string;
  handle: string;
  platform: string;
  roleUk: string;
  organization?: string;
  directQuote: string;
  stanceSummaryUk: string;
  keyArgumentsUk: string[];
  contextUk: string;
  publishedAt: string;
  sourceUrl: string;
  domainCompetenceScore: number;
  credibilityWeight: number;
  potentialBiasUk: string;
  conflictOfInterestUk: string;
  verificationStatus: 'live_public_api' | 'gemini_search_grounded' | 'verified_expert_registry';
  embed: OfficialEmbedInfo;
}

export interface ConsensusSummary {
  agreementUk: string;
  disagreementUk: string;
  dominantConsensusUk: string;
  practicalTakeawayUk: string;
}

export interface ExpertOpinionsResponse {
  newsKey: string;
  articleUrl?: string | null;
  category: string;
  shouldDisplayBlock: boolean;
  valueAddScore: number;
  skipReasonUk: string | null;
  opinions: ExpertOpinionItem[];
  consensusSummary: ConsensusSummary | null;
  sourceMode: 'live_hybrid' | 'registry_fallback' | 'skipped';
  cached: boolean;
  updatedAt: string;
}

export interface GetExpertOpinionsOptions {
  refresh?: boolean;
  title?: string;
  category?: string;
  source?: string;
  summary?: string;
  skipLiveFetch?: boolean;
}

interface NewsContextRecord {
  newsKey: string;
  articleUrl: string | null;
  title: string;
  summary: string;
  category: string;
  importance: string | null;
  sourceName: string | null;
}

const MEMORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_CACHE_MAX = 500;

const ALLOWED_PUBLIC_EXPERT_HOSTS = [
  'x.com',
  'twitter.com',
  'facebook.com',
  'fb.com',
  'bsky.app',
  'github.com',
  'news.ycombinator.com',
  'simonwillison.net',
  'schneier.com',
  'krebsonsecurity.com',
  'paulgraham.com',
  'ben-evans.com',
  'vitalik.eth.limo',
  'brave1.gov.ua',
  'usf.com.ua',
  'eurogamer.net',
  'lkml.org',
  'arxiv.org',
  'huggingface.co',
  'nature.com',
  'calnewport.com',
];

function safePublicHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  const parsed = URL.parse(trimmed);
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return null;
  }
  return parsed.href;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTagsAndEntities(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildOfficialEmbedInfo(
  sourceUrl: string,
  authorHandle?: string,
  directQuote?: string,
  htmlSnippet?: string,
): OfficialEmbedInfo {
  const safeUrl = safePublicHttpsUrl(sourceUrl);
  if (!safeUrl) {
    throw new Error('Invalid HTTPS sourceUrl for embed');
  }
  const parsed = URL.parse(safeUrl)!;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const verifiedSnippet = typeof htmlSnippet === 'string' && htmlSnippet.trim() ? htmlSnippet.trim() : undefined;

  if (host === 'x.com' || host === 'twitter.com') {
    const embedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(safeUrl)}&omit_script=true&dnt=true&lang=uk`;
    return {
      type: 'x_oembed',
      embedUrl,
      htmlSnippet: verifiedSnippet,
      providerName: 'X (Twitter)',
      interactiveSupported: true,
    };
  }

  if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'fb.com') {
    const embedUrl = `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(safeUrl)}&show_text=true&width=500`;
    return {
      type: 'facebook_plugin',
      embedUrl,
      htmlSnippet: verifiedSnippet,
      providerName: 'Facebook',
      interactiveSupported: true,
    };
  }

  if (host === 'bsky.app') {
    const embedUrl = `https://embed.bsky.app/oembed?url=${encodeURIComponent(safeUrl)}`;
    return {
      type: 'bsky_oembed',
      embedUrl,
      htmlSnippet: verifiedSnippet,
      providerName: 'Bluesky',
      interactiveSupported: true,
    };
  }

  if (host === 'news.ycombinator.com') {
    return {
      type: 'hn_card',
      embedUrl: safeUrl,
      htmlSnippet: verifiedSnippet,
      providerName: 'Hacker News',
      interactiveSupported: false,
    };
  }

  return {
    type: 'web_embed',
    embedUrl: safeUrl,
    htmlSnippet: verifiedSnippet,
    providerName: host,
    interactiveSupported: false,
  };
}

export function evaluateShouldDisplayExpertBlock(input: {
  title: string;
  summary?: string | null;
  category?: string;
  importance?: string | null;
}): { shouldDisplayBlock: boolean; valueAddScore: number; skipReasonUk: string | null } {
  const title = (input.title || '').trim();
  const summary = (input.summary || '').trim();
  const combined = `${title} ${summary}`.toLowerCase();
  const importance = (input.importance || '').toLowerCase();

  const isTrivialRoutine =
    /\b(patch\s+v?\d+\.\d+|bugfix|hotfix|minor fix|typo|dependency bump|deps:|chore:|maintenance release|point release)\b|виправлено баг|дрібні виправлення|мінорне оновлення|технічні роботи/i.test(
      title,
    ) ||
    (/\bchangelog\b/i.test(title) && !/\b(major|breaking|architecture|security|cve|api)\b/i.test(combined));

  if (isTrivialRoutine && importance !== 'high' && importance !== 'critical') {
    return {
      shouldDisplayBlock: false,
      valueAddScore: 34,
      skipReasonUk: 'Рутинне мінорне оновлення або патч-ноут без потреби у зовнішній експертизі.',
    };
  }

  let score = 56;
  if (importance === 'high' || importance === 'critical') score += 26;
  if (
    /\b(release|launch|breakthrough|cve-\d+|zero-day|vulnerability|regulation|acquisition|series [a-d]|funding|drone|defense|open[- ]source|open[- ]weight|benchmark|architecture|quantum|space|nasa|fintech|election|treaty|summit|tax|tariff|inflation|central bank|currency|clinical|longevity|sleep|psychology|burnout|festival|film|premiere)\b|реліз|прорив|оборон|дрон|вразлив|регуляц|інвестиц|досліджен|запуск|закон|подат|кордон|виплат|курс|інфляц|валют|депозит|політик|безпек|сон|здоров|стрес|вигоран|кіно|серіал|фестивал/i.test(
      combined,
    )
  ) {
    score += 22;
  }
  if (summary.length >= 60) score += 8;
  if (title.length < 18 && summary.length < 20) score -= 22;

  score = Math.max(15, Math.min(98, score));
  if (score < 60) {
    return {
      shouldDisplayBlock: false,
      valueAddScore: score,
      skipReasonUk: 'Недостатньо матеріальних фактів або суспільно-технологічної ваги для добірки експертів.',
    };
  }

  return {
    shouldDisplayBlock: true,
    valueAddScore: score,
    skipReasonUk: null,
  };
}

export function validateExpertOpinionItem(raw: unknown): ExpertOpinionItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expert opinion must be an object');
  }
  const obj = raw as Record<string, unknown>;

  const sourceUrl = safePublicHttpsUrl(obj.sourceUrl);
  if (!sourceUrl) {
    throw new Error('Invalid or non-HTTPS expert sourceUrl');
  }

  const reqString = (key: string, minLen = 2, maxLen = 1200): string => {
    const val = obj[key];
    if (typeof val !== 'string') throw new Error(`Missing ${key}`);
    const cleaned = val.replace(/\s+/g, ' ').trim();
    if (cleaned.length < minLen || cleaned.length > maxLen) {
      throw new Error(`Invalid length for ${key}`);
    }
    return cleaned;
  };

  const expertName = reqString('expertName', 2, 160);
  const handle = reqString('handle', 2, 120);
  const platform = reqString('platform', 1, 40);
  const roleUk = reqString('roleUk', 3, 240);
  const directQuote = reqString('directQuote', 8, 1200);
  const stanceSummaryUk = reqString('stanceSummaryUk', 8, 900);
  const contextUk = reqString('contextUk', 6, 900);
  const potentialBiasUk = reqString('potentialBiasUk', 6, 900);
  const conflictOfInterestUk = reqString('conflictOfInterestUk', 6, 900);

  if (!Array.isArray(obj.keyArgumentsUk) || obj.keyArgumentsUk.length === 0) {
    throw new Error('keyArgumentsUk must be a non-empty array');
  }
  const keyArgumentsUk = obj.keyArgumentsUk
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.replace(/\s+/g, ' ').trim().slice(0, 400))
    .slice(0, 6);
  if (keyArgumentsUk.length === 0) {
    throw new Error('keyArgumentsUk has no valid items');
  }

  const publishedAtRaw = typeof obj.publishedAt === 'string' ? obj.publishedAt.trim() : '';
  const publishedMs = Date.parse(publishedAtRaw);
  if (!Number.isFinite(publishedMs)) {
    throw new Error('Invalid publishedAt timestamp');
  }
  const publishedAt = new Date(publishedMs).toISOString();

  const domainScoreRaw = Number(obj.domainCompetenceScore);
  if (!Number.isFinite(domainScoreRaw) || domainScoreRaw < 0 || domainScoreRaw > 100) {
    throw new Error('domainCompetenceScore must be in [0, 100]');
  }
  const domainCompetenceScore = Math.round(domainScoreRaw);

  const credibilityRaw = obj.credibilityWeight === undefined ? 85 : Number(obj.credibilityWeight);
  if (!Number.isFinite(credibilityRaw) || credibilityRaw < 0 || credibilityRaw > 100) {
    throw new Error('credibilityWeight must be in [0, 100]');
  }
  const credibilityWeight = Math.round(credibilityRaw);

  const verificationStatusRaw = obj.verificationStatus;
  const verificationStatus =
    verificationStatusRaw === 'live_public_api' ||
    verificationStatusRaw === 'gemini_search_grounded' ||
    verificationStatusRaw === 'verified_expert_registry'
      ? verificationStatusRaw
      : 'verified_expert_registry';

  const rawEmbed = obj.embed;
  if (!rawEmbed || typeof rawEmbed !== 'object' || Array.isArray(rawEmbed)) {
    throw new Error('Missing embed metadata');
  }
  const embedObj = rawEmbed as Record<string, unknown>;
  const validEmbedTypes: EmbedType[] = ['x_oembed', 'facebook_plugin', 'bsky_oembed', 'hn_card', 'web_embed'];
  const embedType = validEmbedTypes.find((t) => t === embedObj.type);
  const embedUrl = safePublicHttpsUrl(embedObj.embedUrl);
  const providerName = typeof embedObj.providerName === 'string' ? embedObj.providerName.trim() : '';
  if (!embedType || !embedUrl || !providerName) {
    throw new Error('Invalid embed object');
  }

  return {
    ...(typeof obj.expertSlug === 'string' && obj.expertSlug.trim() ? { expertSlug: obj.expertSlug.trim() } : {}),
    expertName,
    handle,
    platform,
    roleUk,
    ...(typeof obj.organization === 'string' && obj.organization.trim()
      ? { organization: obj.organization.trim().slice(0, 180) }
      : {}),
    directQuote,
    stanceSummaryUk,
    keyArgumentsUk,
    contextUk,
    publishedAt,
    sourceUrl,
    domainCompetenceScore,
    credibilityWeight,
    potentialBiasUk,
    conflictOfInterestUk,
    verificationStatus,
    embed: {
      type: embedType,
      embedUrl,
      ...(typeof embedObj.htmlSnippet === 'string' && embedObj.htmlSnippet.trim()
        ? { htmlSnippet: embedObj.htmlSnippet.trim().slice(0, 4000) }
        : {}),
      providerName: providerName.slice(0, 80),
      interactiveSupported: Boolean(embedObj.interactiveSupported),
    },
  };
}

export interface ManagedExpertProfile extends ExpertProfile {
  sourceMode?: 'seed' | 'ai_discovered' | 'ai_enriched';
  lastAiReviewedAt?: string | null;
}

const DIRECTORY_CACHE_TTL_MS = 60_000;

@Injectable()
export class ExpertOpinionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpertOpinionsService.name);
  private readonly memoryCache = new Map<string, { expiresAt: number; payload: ExpertOpinionsResponse }>();
  private readonly key = process.env.GEMINI_API_KEY?.trim();
  private directoryCache: { expiresAt: number; items: ManagedExpertProfile[] } | null = null;
  private curateTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeCuration?: Promise<{ added: number; updated: number; rejected: number }>;

  constructor(
    @Optional() private readonly db?: DatabaseService,
    @Optional() private readonly companyFeeds?: CompanyFeedsService,
  ) {}

  private get activeKey(): string | undefined {
    return this.key || process.env.GEMINI_API_KEY?.trim();
  }

  async onModuleInit(): Promise<void> {
    await this.seedExpertDirectory().catch(() => undefined);
    if (this.activeKey && process.env.NODE_ENV !== 'test') {
      const intervalMs = 24 * 60 * 60_000;
      const scheduleNext = () => {
        this.curateTimer = setTimeout(async () => {
          if (this.isDestroyed) return;
          try {
            await this.curateExpertsWithGemini();
          } catch (err) {
            this.logger.warn(`Scheduled expert curation failed: ${err instanceof Error ? err.message : err}`);
          } finally {
            if (!this.isDestroyed) scheduleNext();
          }
        }, intervalMs);
      };
      this.curateTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.curateExpertsWithGemini();
        } catch (err) {
          this.logger.warn(`Initial expert curation failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, 120_000);
    }
  }

  onModuleDestroy(): void {
    this.isDestroyed = true;
    if (this.curateTimer) clearTimeout(this.curateTimer);
  }

  clearCacheForTests(): void {
    this.memoryCache.clear();
    this.directoryCache = null;
  }

  async seedExpertDirectory(): Promise<void> {
    if (!this.db) return;
    try {
      for (const expert of EXPERT_DIRECTORY) {
        try {
          await this.db.query(
            `INSERT INTO expert_profiles (
               slug, full_name, handle, platform, role_uk, organization,
               primary_domains, specializations, profile_url, public_feed_url,
               known_affiliations_uk, credibility_weight,
               bias_keywords, conflict_disclosure_uk, documented_positions, source_mode, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13::text[],$14,$15::jsonb,'seed',now())
             ON CONFLICT (slug) DO UPDATE SET
               full_name = EXCLUDED.full_name,
               handle = EXCLUDED.handle,
               platform = EXCLUDED.platform,
               role_uk = EXCLUDED.role_uk,
               organization = EXCLUDED.organization,
               primary_domains = EXCLUDED.primary_domains,
               specializations = EXCLUDED.specializations,
               profile_url = EXCLUDED.profile_url,
               public_feed_url = EXCLUDED.public_feed_url,
               known_affiliations_uk = EXCLUDED.known_affiliations_uk,
               credibility_weight = EXCLUDED.credibility_weight,
               bias_keywords = EXCLUDED.bias_keywords,
               conflict_disclosure_uk = EXCLUDED.conflict_disclosure_uk,
               documented_positions = CASE
                 WHEN jsonb_array_length(COALESCE(expert_profiles.documented_positions, '[]'::jsonb)) = 0
                 THEN EXCLUDED.documented_positions
                 ELSE expert_profiles.documented_positions
               END,
               updated_at = now()
             WHERE expert_profiles.source_mode = 'seed' AND expert_profiles.last_ai_reviewed_at IS NULL`,
            [
              expert.slug,
              expert.fullName,
              expert.handle,
              expert.platform,
              expert.roleUk,
              expert.organization,
              expert.primaryDomains,
              expert.specializations,
              expert.profileUrl,
              expert.publicFeedUrl ?? null,
              expert.knownAffiliationsUk,
              expert.credibilityWeight,
              expert.biasKeywords ?? [],
              expert.conflictDisclosureUk ?? null,
              JSON.stringify(expert.documentedPositions),
            ],
          );
        } catch {
          await this.db.query(
            `INSERT INTO expert_profiles (
               slug, full_name, handle, platform, role_uk, organization,
               primary_domains, specializations, profile_url, public_feed_url,
               known_affiliations_uk, credibility_weight, updated_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,now())
             ON CONFLICT (slug) DO NOTHING`,
            [
              expert.slug,
              expert.fullName,
              expert.handle,
              expert.platform,
              expert.roleUk,
              expert.organization,
              expert.primaryDomains,
              expert.specializations,
              expert.profileUrl,
              expert.publicFeedUrl ?? null,
              expert.knownAffiliationsUk,
              expert.credibilityWeight,
            ],
          );
        }
      }
      this.directoryCache = null;
    } catch (error) {
      this.logger.debug(
        `Skipped seeding expert_profiles (migration 010 may not be applied yet): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async loadExpertProfilesFromDb(): Promise<ManagedExpertProfile[]> {
    if (this.directoryCache && this.directoryCache.expiresAt > Date.now()) {
      return this.directoryCache.items;
    }
    if (!this.db) {
      return EXPERT_DIRECTORY.map((e) => ({ ...e, sourceMode: 'seed', lastAiReviewedAt: null }));
    }

    const seedBySlug = new Map(EXPERT_DIRECTORY.map((e) => [e.slug, e]));

    try {
      const { rows } = await this.db.query<{
        slug: string;
        full_name: string;
        handle: string;
        platform: string;
        role_uk: string;
        organization: string | null;
        primary_domains: string[] | null;
        specializations: string[] | null;
        profile_url: string;
        public_feed_url: string | null;
        known_affiliations_uk: string | null;
        credibility_weight: number;
        bias_keywords?: string[] | null;
        conflict_disclosure_uk?: string | null;
        documented_positions?: unknown;
        source_mode?: string | null;
        last_ai_reviewed_at?: string | Date | null;
      }>(
        `SELECT slug, full_name, handle, platform, role_uk, organization,
                primary_domains, specializations, profile_url, public_feed_url,
                known_affiliations_uk, credibility_weight,
                bias_keywords, conflict_disclosure_uk, documented_positions,
                source_mode, last_ai_reviewed_at
         FROM expert_profiles
         ORDER BY credibility_weight DESC, slug ASC`,
      );

      if (rows.length > 0) {
        const mapped: ManagedExpertProfile[] = rows.map((row) => {
          const seed = seedBySlug.get(row.slug);
          const dbPositions = normalizeDocumentedPositions(row.documented_positions);
          return {
            slug: row.slug,
            fullName: row.full_name,
            handle: row.handle,
            platform: normalizePlatform(row.platform),
            roleUk: row.role_uk,
            organization: row.organization || seed?.organization || 'Незалежний експерт',
            primaryDomains: normalizeDomains(row.primary_domains, seed?.primaryDomains),
            specializations: Array.isArray(row.specializations) && row.specializations.length > 0
              ? row.specializations
              : seed?.specializations ?? [],
            profileUrl: row.profile_url,
            publicFeedUrl: row.public_feed_url ?? seed?.publicFeedUrl,
            knownAffiliationsUk: row.known_affiliations_uk || seed?.knownAffiliationsUk || 'Незалежна публічна діяльність.',
            biasKeywords: Array.isArray(row.bias_keywords) && row.bias_keywords.length > 0
              ? row.bias_keywords
              : seed?.biasKeywords,
            conflictDisclosureUk: row.conflict_disclosure_uk ?? seed?.conflictDisclosureUk,
            credibilityWeight: Number(row.credibility_weight) || seed?.credibilityWeight || 80,
            documentedPositions: dbPositions.length > 0 ? dbPositions : (seed?.documentedPositions ?? []),
            sourceMode: normalizeSourceMode(row.source_mode),
            lastAiReviewedAt: row.last_ai_reviewed_at
              ? new Date(row.last_ai_reviewed_at).toISOString()
              : null,
          };
        });
        this.directoryCache = { expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS, items: mapped };
        return mapped;
      }
    } catch {
      try {
        const { rows } = await this.db.query<{
          slug: string;
          full_name: string;
          handle: string;
          platform: string;
          role_uk: string;
          organization: string | null;
          primary_domains: string[] | null;
          specializations: string[] | null;
          profile_url: string;
          public_feed_url: string | null;
          known_affiliations_uk: string | null;
          credibility_weight: number;
        }>(
          `SELECT slug, full_name, handle, platform, role_uk, organization,
                  primary_domains, specializations, profile_url, public_feed_url,
                  known_affiliations_uk, credibility_weight
           FROM expert_profiles
           ORDER BY credibility_weight DESC, slug ASC`,
        );
        if (rows.length > 0) {
          const mapped: ManagedExpertProfile[] = rows.map((row) => {
            const seed = seedBySlug.get(row.slug);
            return {
              slug: row.slug,
              fullName: row.full_name,
              handle: row.handle,
              platform: normalizePlatform(row.platform),
              roleUk: row.role_uk,
              organization: row.organization || seed?.organization || 'Незалежний експерт',
              primaryDomains: normalizeDomains(row.primary_domains, seed?.primaryDomains),
              specializations: Array.isArray(row.specializations) && row.specializations.length > 0
                ? row.specializations
                : seed?.specializations ?? [],
              profileUrl: row.profile_url,
              publicFeedUrl: row.public_feed_url ?? seed?.publicFeedUrl,
              knownAffiliationsUk: row.known_affiliations_uk || seed?.knownAffiliationsUk || 'Незалежна публічна діяльність.',
              biasKeywords: seed?.biasKeywords,
              conflictDisclosureUk: seed?.conflictDisclosureUk,
              credibilityWeight: Number(row.credibility_weight) || seed?.credibilityWeight || 80,
              documentedPositions: seed?.documentedPositions ?? [],
              sourceMode: 'seed',
              lastAiReviewedAt: null,
            };
          });
          this.directoryCache = { expiresAt: Date.now() + DIRECTORY_CACHE_TTL_MS, items: mapped };
          return mapped;
        }
      } catch {
        // Table may not exist in test/bootstrap mode; fall back to seed list cleanly
      }
    }

    return EXPERT_DIRECTORY.map((e) => ({ ...e, sourceMode: 'seed', lastAiReviewedAt: null }));
  }

  async listDirectory(domain?: string, targetCategories: string[] = []) {
    const cleanDomain = domain?.trim().toLowerCase() || '';
    const effectiveCategories = targetCategories.length > 0
      ? targetCategories
      : cleanDomain
        ? [cleanDomain]
        : [];
    const experts = await this.loadExpertProfilesFromDb();

    const filtered = cleanDomain
      ? experts.filter(
          (expert) =>
            expert.primaryDomains.some((d) => effectiveCategories.includes(d)) ||
            expert.specializations.some((spec) => spec.toLowerCase().includes(cleanDomain)),
        )
      : experts;

    const sorted = [...filtered].sort((a, b) => b.credibilityWeight - a.credibilityWeight);
    const items = sorted.map((expert) => ({
      slug: expert.slug,
      fullName: expert.fullName,
      handle: expert.handle,
      platform: expert.platform,
      roleUk: expert.roleUk,
      organization: expert.organization,
      primaryDomains: expert.primaryDomains,
      specializations: expert.specializations,
      profileUrl: expert.profileUrl,
      publicFeedUrl: expert.publicFeedUrl ?? null,
      knownAffiliationsUk: expert.knownAffiliationsUk,
      conflictDisclosureUk: expert.conflictDisclosureUk ?? null,
      credibilityWeight: expert.credibilityWeight,
      documentedPositionsCount: expert.documentedPositions.length,
      sourceMode: expert.sourceMode ?? 'seed',
      lastAiReviewedAt: expert.lastAiReviewedAt ?? null,
    }));

    return {
      domain: cleanDomain || 'all',
      total: items.length,
      items,
    };
  }

  async getOpinionsForNews(id: string, options: GetExpertOpinionsOptions = {}): Promise<ExpertOpinionsResponse> {
    const trimmedId = (id || '').trim();
    if (!trimmedId) {
      throw new NotFoundException('Article not found');
    }

    const context = await this.resolveNewsContext(trimmedId, options);
    const cacheKey = context.newsKey;

    if (!options.refresh) {
      const memHit = this.readMemoryCache(cacheKey);
      if (memHit) {
        return { ...memHit, cached: true };
      }

      const dbHit = await this.readDbCache(cacheKey);
      if (dbHit) {
        this.writeMemoryCache(cacheKey, dbHit);
        return { ...dbHit, cached: true };
      }
    }

    const gate = evaluateShouldDisplayExpertBlock({
      title: context.title,
      summary: context.summary,
      category: context.category,
      importance: context.importance,
    });

    if (!gate.shouldDisplayBlock) {
      const skippedPayload: ExpertOpinionsResponse = {
        newsKey: cacheKey,
        articleUrl: context.articleUrl,
        category: context.category,
        shouldDisplayBlock: false,
        valueAddScore: gate.valueAddScore,
        skipReasonUk: gate.skipReasonUk,
        opinions: [],
        consensusSummary: null,
        sourceMode: 'skipped',
        cached: false,
        updatedAt: new Date().toISOString(),
      };
      this.writeMemoryCache(cacheKey, skippedPayload);
      await this.writeDbCache(skippedPayload);
      return skippedPayload;
    }

    const experts = await this.loadExpertProfilesFromDb();
    let collected: ExpertOpinionItem[] = [];
    let hasLiveHits = false;

    if (!options.skipLiveFetch) {
      const searchQuery = extractSearchTerms(context.title);
      const [hnResult, bskyResult] = await Promise.allSettled([
        this.fetchHackerNewsOpinions(searchQuery, context, experts),
        this.fetchBlueskyOpinions(searchQuery, context, experts),
      ]);

      if (hnResult.status === 'fulfilled') collected.push(...hnResult.value);
      if (bskyResult.status === 'fulfilled') collected.push(...bskyResult.value);

      if (collected.length > 0) {
        hasLiveHits = true;
      }

      if (
        process.env.GEMINI_EXPERT_SEARCH_GROUNDING === 'true' &&
        collected.length < 2 &&
        this.activeKey &&
        process.env.NODE_ENV !== 'test'
      ) {
        const geminiFound = await this.discoverExpertOpinionsWithGemini(context, experts).catch(() => []);
        if (geminiFound.length > 0) {
          hasLiveHits = true;
          collected.push(...geminiFound);
        }
      }
    }

    const registryOpinions = this.buildRegistryExpertOpinions(
      experts,
      context.category,
      context.title,
      context.summary,
      gate.valueAddScore,
    );

    const merged = deduplicateOpinions([...collected, ...registryOpinions]).slice(0, 4);

    if (merged.length === 0) {
      const noExpertsPayload: ExpertOpinionsResponse = {
        newsKey: cacheKey,
        articleUrl: context.articleUrl,
        category: context.category,
        shouldDisplayBlock: false,
        valueAddScore: Math.min(58, gate.valueAddScore),
        skipReasonUk: 'Не знайдено релевантних верифікованих експертів із достатньою компетентністю для цієї новини.',
        opinions: [],
        consensusSummary: null,
        sourceMode: 'skipped',
        cached: false,
        updatedAt: new Date().toISOString(),
      };
      this.writeMemoryCache(cacheKey, noExpertsPayload);
      await this.writeDbCache(noExpertsPayload);
      return noExpertsPayload;
    }

    const consensusSummary = await this.buildConsensusSummary(context, merged);
    const responsePayload: ExpertOpinionsResponse = {
      newsKey: cacheKey,
      articleUrl: context.articleUrl,
      category: context.category,
      shouldDisplayBlock: true,
      valueAddScore: gate.valueAddScore,
      skipReasonUk: null,
      opinions: merged,
      consensusSummary,
      sourceMode: hasLiveHits ? 'live_hybrid' : 'registry_fallback',
      cached: false,
      updatedAt: new Date().toISOString(),
    };

    this.writeMemoryCache(cacheKey, responsePayload);
    await this.writeDbCache(responsePayload);
    return responsePayload;
  }

  private async resolveNewsContext(id: string, options: GetExpertOpinionsOptions): Promise<NewsContextRecord> {
    if (this.db) {
      try {
        const { rows } = await this.db.query<{
          id: string;
          external_id: string;
          url: string;
          title_uk: string | null;
          original_title: string;
          summary_uk: string | null;
          original_summary: string | null;
          category: string;
          importance: string | null;
          source_name: string | null;
        }>(
          `SELECT n.id::text, n.external_id, n.url, n.title_uk, n.original_title,
                  n.summary_uk, n.original_summary, n.category, n.importance, s.name AS source_name
           FROM news_items n
           JOIN sources s ON s.id = n.source_id
           WHERE (n.external_id = $1 OR n.id::text = $1) AND n.status = 'published'
           LIMIT 1`,
          [id],
        );
        const row = rows[0];
        if (row) {
          return {
            newsKey: String(row.external_id || row.id || id),
            articleUrl: row.url,
            title: row.title_uk || row.original_title,
            summary: row.summary_uk || row.original_summary || '',
            category: row.category || 'other',
            importance: row.importance,
            sourceName: row.source_name,
          };
        }
      } catch {
        // Fallback smoothly to RSS feed or query context when DB table/connection unavailable
      }
    }

    if (/^rss-[a-f0-9]{24}$/.test(id) && this.companyFeeds) {
      try {
        const feeds = await this.companyFeeds.list(options.source ? [options.source] : []);
        const rssItem = feeds.items.find((entry) => entry.id === id);
        if (rssItem) {
          return {
            newsKey: rssItem.id,
            articleUrl: rssItem.url,
            title: rssItem.original_title,
            summary: rssItem.original_summary || '',
            category: rssItem.category || options.category || 'other',
            importance: null,
            sourceName: rssItem.source_name,
          };
        }
      } catch {
        // Continue to query-based fallback
      }
    }

    if (options.title && options.title.trim()) {
      return {
        newsKey: id,
        articleUrl: null,
        title: options.title.trim().slice(0, 350),
        summary: (options.summary || '').trim().slice(0, 2000),
        category: (options.category || 'other').trim().toLowerCase(),
        importance: null,
        sourceName: options.source || null,
      };
    }

    throw new NotFoundException('Article not found');
  }

  private readMemoryCache(key: string): ExpertOpinionsResponse | null {
    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    this.memoryCache.delete(key);
    this.memoryCache.set(key, entry);
    return entry.payload;
  }

  private writeMemoryCache(key: string, payload: ExpertOpinionsResponse): void {
    if (this.memoryCache.has(key)) {
      this.memoryCache.delete(key);
    } else if (this.memoryCache.size >= MEMORY_CACHE_MAX) {
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.memoryCache.delete(oldestKey);
      }
    }
    this.memoryCache.set(key, {
      expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
      payload,
    });
  }

  private async readDbCache(newsKey: string): Promise<ExpertOpinionsResponse | null> {
    if (!this.db) return null;
    try {
      const { rows } = await this.db.query<{ payload: ExpertOpinionsResponse }>(
        `SELECT payload
         FROM news_expert_opinions_cache
         WHERE news_key = $1 AND expires_at > now()
         LIMIT 1`,
        [newsKey],
      );
      const cachedPayload = rows[0]?.payload;
      if (cachedPayload && typeof cachedPayload === 'object' && Array.isArray(cachedPayload.opinions)) {
        return cachedPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async writeDbCache(payload: ExpertOpinionsResponse): Promise<void> {
    if (!this.db) return;
    try {
      const expiresAt = new Date(Date.now() + MEMORY_CACHE_TTL_MS).toISOString();
      await this.db.query(
        `INSERT INTO news_expert_opinions_cache (
           news_key, article_url, category, should_display_block,
           value_add_score, skip_reason_uk, payload, source_mode, created_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now(),$9::timestamptz)
         ON CONFLICT (news_key) DO UPDATE SET
           article_url = EXCLUDED.article_url,
           category = EXCLUDED.category,
           should_display_block = EXCLUDED.should_display_block,
           value_add_score = EXCLUDED.value_add_score,
           skip_reason_uk = EXCLUDED.skip_reason_uk,
           payload = EXCLUDED.payload,
           source_mode = EXCLUDED.source_mode,
           created_at = now(),
           expires_at = EXCLUDED.expires_at`,
        [
          payload.newsKey,
          payload.articleUrl ?? null,
          payload.category,
          payload.shouldDisplayBlock,
          payload.valueAddScore,
          payload.skipReasonUk,
          JSON.stringify(payload),
          payload.sourceMode,
          expiresAt,
        ],
      );
    } catch {
      // Gracefully skip if migration 010 is not yet applied
    }
  }

  private async fetchHackerNewsOpinions(
    query: string,
    context: NewsContextRecord,
    experts: ExpertProfile[] = EXPERT_DIRECTORY,
  ): Promise<ExpertOpinionItem[]> {
    if (!query) return [];
    try {
      const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=6`;
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'OpportunityRadar/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(3_500),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as {
        hits?: Array<{
          objectID?: string;
          author?: string;
          comment_text?: string;
          story_text?: string;
          title?: string;
          created_at?: string;
          points?: number;
        }>;
      };
      const out: ExpertOpinionItem[] = [];
      for (const hit of data.hits ?? []) {
        const objectId = hit.objectID?.trim();
        const rawText = stripTagsAndEntities(hit.comment_text || hit.story_text || hit.title || '');
        if (!objectId || !hit.author || rawText.length < 30) continue;

        const hnUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(objectId)}`;
        const matchedExpert = findExpertByAuthor(experts, hit.author);
        const quote = rawText.slice(0, 380);
        const competenceScore = matchedExpert
          ? scoreExpertCompetenceForTopic(matchedExpert, context.category, context.title, context.summary).score
          : Math.min(82, 66 + (Number(hit.points) > 20 ? 10 : 0));

        try {
          out.push(
            validateExpertOpinionItem({
              expertSlug: matchedExpert?.slug,
              expertName: matchedExpert?.fullName || hit.author,
              handle: matchedExpert?.handle || `@${hit.author}`,
              platform: 'hacker_news',
              roleUk: matchedExpert?.roleUk || 'Учасник інженерної дискусії на Hacker News',
              organization: matchedExpert?.organization || 'Hacker News Community',
              directQuote: quote,
              stanceSummaryUk: `Обговорення на Hacker News щодо «${context.title.slice(0, 120)}».`,
              keyArgumentsUk: [quote.slice(0, 200)],
              contextUk: `Публічний коментар / обговорення у гілці Hacker News (${context.category}).`,
              publishedAt: hit.created_at || new Date().toISOString(),
              sourceUrl: hnUrl,
              domainCompetenceScore: competenceScore,
              credibilityWeight: matchedExpert?.credibilityWeight ?? 74,
              potentialBiasUk: matchedExpert?.knownAffiliationsUk || 'Коментар інженерної спільноти Hacker News.',
              conflictOfInterestUk: matchedExpert?.conflictDisclosureUk || 'Прямий корпоративний конфлікт інтересів не підтверджено (публічний нікнейм).',
              verificationStatus: 'live_public_api',
              embed: buildOfficialEmbedInfo(hnUrl, hit.author, quote),
            }),
          );
        } catch {
          // Skip invalid entries
        }
      }
      return out.slice(0, 2);
    } catch {
      return [];
    }
  }

  private async fetchBlueskyOpinions(
    query: string,
    context: NewsContextRecord,
    experts: ExpertProfile[] = EXPERT_DIRECTORY,
  ): Promise<ExpertOpinionItem[]> {
    if (!query) return [];
    try {
      const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=6`;
      const resp = await fetch(apiUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'OpportunityRadar/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(3_500),
      });
      if (!resp.ok) return [];
      const data = (await resp.json()) as {
        posts?: Array<{
          uri?: string;
          indexedAt?: string;
          author?: { handle?: string; displayName?: string };
          record?: { text?: string; createdAt?: string };
        }>;
      };

      const out: ExpertOpinionItem[] = [];
      for (const post of data.posts ?? []) {
        const handle = post.author?.handle?.trim();
        const text = (post.record?.text || '').replace(/\s+/g, ' ').trim();
        const rkey = post.uri?.split('/').pop();
        if (!handle || !rkey || text.length < 30) continue;

        const postUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`;
        const matchedExpert = findExpertByAuthor(experts, handle, post.author?.displayName);
        if (!matchedExpert && text.length < 60) continue;

        let oembedHtml: string | undefined;
        try {
          const oeResp = await fetch(`https://embed.bsky.app/oembed?url=${encodeURIComponent(postUrl)}`, {
            signal: AbortSignal.timeout(2_500),
          });
          if (oeResp.ok) {
            const oeJson = (await oeResp.json()) as { html?: string };
            if (typeof oeJson.html === 'string') oembedHtml = oeJson.html;
          }
        } catch {
          // Fallback HTML snippet handles render cleanly
        }

        const competenceScore = matchedExpert
          ? scoreExpertCompetenceForTopic(matchedExpert, context.category, context.title, context.summary).score
          : 72;

        try {
          out.push(
            validateExpertOpinionItem({
              expertSlug: matchedExpert?.slug,
              expertName: matchedExpert?.fullName || post.author?.displayName || handle,
              handle: matchedExpert?.handle || `@${handle}`,
              platform: 'bluesky',
              roleUk: matchedExpert?.roleUk || 'Експерт / автор публічної дискусії у Bluesky',
              organization: matchedExpert?.organization || 'Bluesky',
              directQuote: text.slice(0, 380),
              stanceSummaryUk: `Публічний коментар у Bluesky про «${context.title.slice(0, 120)}».`,
              keyArgumentsUk: [text.slice(0, 220)],
              contextUk: `Верифікований публічний пост у мережі Bluesky.`,
              publishedAt: post.record?.createdAt || post.indexedAt || new Date().toISOString(),
              sourceUrl: postUrl,
              domainCompetenceScore: competenceScore,
              credibilityWeight: matchedExpert?.credibilityWeight ?? 76,
              potentialBiasUk: matchedExpert?.knownAffiliationsUk || 'Публічна позиція автора у Bluesky.',
              conflictOfInterestUk: matchedExpert?.conflictDisclosureUk || 'Необхідна стандартна перевірка афіліації автора.',
              verificationStatus: 'live_public_api',
              embed: buildOfficialEmbedInfo(postUrl, handle, text, oembedHtml),
            }),
          );
        } catch {
          // Skip invalid entries
        }
      }
      return out.slice(0, 2);
    } catch {
      return [];
    }
  }

  private async discoverExpertOpinionsWithGemini(
    context: NewsContextRecord,
    experts: ManagedExpertProfile[] = [],
  ): Promise<ExpertOpinionItem[]> {
    if (!this.activeKey) return [];
    const pool = experts.length > 0 ? experts : await this.loadExpertProfilesFromDb();
    const allowedExpertsHint = pool
      .filter((e) => e.primaryDomains.includes(context.category as never))
      .slice(0, 8)
      .map((e) => `${e.fullName} (${e.handle}, ${e.profileUrl})`)
      .join('; ');

    const { data } = await postGeminiGenerateContent({
      apiKey: this.activeKey,
      preferredModel: DEFAULT_GEMINI_MODEL,
      timeoutMs: 35_000,
      body: {
        systemInstruction: {
          parts: [
            {
              text: 'Find REAL, publicly verified statements from reputable domain experts (either from relevant_experts_reference or other authoritative real experts) on X, Facebook, Bluesky, GitHub, or official blogs about the news item. Return strict JSON under { "opinions": [...] } with fields: expertName, handle, platform, roleUk, organization, directQuote, stanceSummaryUk, keyArgumentsUk (string[]), contextUk, publishedAt, sourceUrl, profileUrl (optional), specializations (string[], optional). NEVER fabricate quotes or URLs; cite only URLs returned by search grounding.',
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify({
                  title: context.title,
                  summary: context.summary.slice(0, 800),
                  category: context.category,
                  relevant_experts_reference: allowedExpertsHint,
                }),
              },
            ],
          },
        ],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 3500 },
      },
    });

    const parsedData = data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
      }>;
    };
    const groundedUrls = new Set(
      (parsedData.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => safePublicHttpsUrl(c.web?.uri))
        .filter((u): u is string => Boolean(u)),
    );
    const rawText = parsedData.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsedJson = JSON.parse(jsonMatch[0]) as { opinions?: Array<Record<string, unknown>> };
    const validated: ExpertOpinionItem[] = [];

    for (const candidate of Array.isArray(parsedJson.opinions) ? parsedJson.opinions : []) {
      const safeUrl = safePublicHttpsUrl(candidate.sourceUrl);
      if (!safeUrl) continue;
      // Strict Grounding Rule: require exact URL presence in Gemini googleSearch groundingChunks
      if (!groundedUrls.has(safeUrl)) continue;
      const host = URL.parse(safeUrl)?.hostname.toLowerCase().replace(/^www\./, '') || '';

      let htmlSnippet: string | undefined;
      if (host === 'x.com' || host === 'twitter.com') {
        try {
          const oe = await fetch(
            `https://publish.twitter.com/oembed?url=${encodeURIComponent(safeUrl)}&omit_script=true&dnt=true&lang=uk`,
            { signal: AbortSignal.timeout(2_500) },
          );
          if (oe.ok) {
            const j = (await oe.json()) as { html?: string };
            if (typeof j.html === 'string') htmlSnippet = j.html;
          }
        } catch {
          // Do not synthesize fake blockquote HTML
        }
      }

      // Skip x.com / twitter.com URLs that failed oEmbed verification
      if ((host === 'x.com' || host === 'twitter.com') && !htmlSnippet) {
        continue;
      }

      try {
        const item = validateExpertOpinionItem({
          ...candidate,
          verificationStatus: 'gemini_search_grounded',
          embed: buildOfficialEmbedInfo(
            safeUrl,
            typeof candidate.handle === 'string' ? candidate.handle : undefined,
            typeof candidate.directQuote === 'string' ? candidate.directQuote : undefined,
            htmlSnippet,
          ),
        });
        validated.push(item);

        // Automatically persist newly discovered experts or enrich existing ones in PostgreSQL
        const profileUrl = safePublicHttpsUrl(candidate.profileUrl) ?? undefined;
        const specializations = Array.isArray(candidate.specializations)
          ? candidate.specializations.filter((s): s is string => typeof s === 'string' && s.trim().length > 1).slice(0, 10)
          : [];
        await this.persistDiscoveredExpertFromOpinion(item, context.category, profileUrl, specializations).catch(() => undefined);
      } catch {
        // Reject ungrounded or incomplete Gemini items
      }
    }
    return validated;
  }

  async curateExpertsWithGemini(options: { category?: string } = {}): Promise<{
    added: number;
    updated: number;
    rejected: number;
  }> {
    if (this.activeCuration) return this.activeCuration;
    this.activeCuration = this.runExpertCurationWithGemini(options).finally(() => {
      this.activeCuration = undefined;
    });
    return this.activeCuration;
  }

  private async runExpertCurationWithGemini(options: { category?: string } = {}): Promise<{
    added: number;
    updated: number;
    rejected: number;
  }> {
    if (!this.activeKey || !this.db) {
      return { added: 0, updated: 0, rejected: 0 };
    }

    const existing = await this.loadExpertProfilesFromDb();
    const categoryCounts = new Map<string, number>();
    for (const cat of CATEGORIES) {
      categoryCounts.set(cat, 0);
    }
    for (const exp of existing) {
      for (const dom of exp.primaryDomains) {
        categoryCounts.set(dom, (categoryCounts.get(dom) ?? 0) + 1);
      }
    }

    const focusCategories = options.category && CATEGORIES.includes(options.category as NewsCategory)
      ? [options.category]
      : [...categoryCounts.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, 4)
          .map(([cat]) => cat);

    const staleExperts = existing
      .filter((e) => !e.lastAiReviewedAt || Date.now() - Date.parse(e.lastAiReviewedAt) > 14 * 24 * 60 * 60_000)
      .slice(0, 4)
      .map((e) => ({
        slug: e.slug,
        fullName: e.fullName,
        handle: e.handle,
        roleUk: e.roleUk,
        organization: e.organization,
        primaryDomains: e.primaryDomains,
      }));

    let data: unknown;
    try {
      const res = await postGeminiGenerateContent({
        apiKey: this.activeKey,
        preferredModel: DEFAULT_GEMINI_MODEL,
        timeoutMs: 40_000,
        body: {
          systemInstruction: {
            parts: [
              {
                text: 'You curate a verified database of real-world domain experts for a Ukrainian news app. Using Google Search grounding, propose: (1) 1-3 NEW real, publicly active experts for the focus_categories who are NOT already in existing_handles; and (2) updates/fresh positions for stale_experts if their role, organization, or recent public position should be updated. Return strict JSON: { "addExperts": [...], "updateExperts": [...] }. Each item MUST have real, verifiable https URLs returned by search grounding. Never invent people, handles, or URLs.',
              },
            ],
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: JSON.stringify({
                    focus_categories: focusCategories,
                    allowed_categories: [...CATEGORIES],
                    existing_handles: existing.map((e) => e.handle),
                    stale_experts: staleExperts,
                  }),
                },
              ],
            },
          ],
          tools: [{ googleSearch: {} }],
          generationConfig: { maxOutputTokens: 3500 },
        },
      });
      data = res.data;
    } catch (err) {
      this.logger.warn(`Gemini expert curation call failed: ${err instanceof Error ? err.message : err}`);
      return { added: 0, updated: 0, rejected: 0 };
    }

    const parsedData = data as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string } }> };
      }>;
    };
    const groundedUrls = new Set(
      (parsedData.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
        .map((c) => safePublicHttpsUrl(c.web?.uri))
        .filter((u): u is string => Boolean(u)),
    );
    const rawText = parsedData.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { added: 0, updated: 0, rejected: 0 };

    let parsedJson: {
      addExperts?: Array<Record<string, unknown>>;
      updateExperts?: Array<Record<string, unknown>>;
    };
    try {
      parsedJson = JSON.parse(jsonMatch[0]) as typeof parsedJson;
    } catch {
      return { added: 0, updated: 0, rejected: 0 };
    }

    let added = 0;
    let updated = 0;
    let rejected = 0;

    for (const candidate of Array.isArray(parsedJson.addExperts) ? parsedJson.addExperts : []) {
      const result = await this.upsertAiManagedExpert(candidate, 'ai_discovered', groundedUrls);
      if (result === 'added') added++;
      else if (result === 'updated') updated++;
      else rejected++;
    }

    for (const candidate of Array.isArray(parsedJson.updateExperts) ? parsedJson.updateExperts : []) {
      const result = await this.upsertAiManagedExpert(candidate, 'ai_enriched', groundedUrls);
      if (result === 'updated') updated++;
      else if (result === 'added') added++;
      else rejected++;
    }

    if (added > 0 || updated > 0) {
      this.directoryCache = null;
    }
    return { added, updated, rejected };
  }

  private async persistDiscoveredExpertFromOpinion(
    item: ExpertOpinionItem,
    category: string,
    profileUrlOverride?: string,
    extraSpecializations: string[] = [],
  ): Promise<void> {
    if (!this.db) return;
    const experts = await this.loadExpertProfilesFromDb();
    const matched = findExpertByAuthor(experts, item.handle, item.expertName);
    const validCat = CATEGORIES.includes(category as NewsCategory) ? (category as NewsCategory) : 'other';
    const newPosition: DocumentedExpertPosition = {
      topicKeywords: [
        validCat,
        ...extractSearchTerms(item.stanceSummaryUk).toLowerCase().split(/\s+/).filter((w) => w.length >= 3),
        ...extraSpecializations.map((s) => s.toLowerCase()),
      ].slice(0, 8),
      thesisUk: item.stanceSummaryUk,
      quoteUk: item.directQuote,
      keyArgumentsUk: item.keyArgumentsUk.slice(0, 4),
      url: item.sourceUrl,
      publishedAt: item.publishedAt,
    };

    if (matched) {
      const mergedPositions = mergeDocumentedPositions(matched.documentedPositions, [newPosition]);
      const mergedDomains = Array.from(new Set([...matched.primaryDomains, validCat]));
      const mergedSpecs = Array.from(new Set([...matched.specializations, ...extraSpecializations])).slice(0, 16);
      const nextMode = matched.sourceMode === 'ai_discovered' ? 'ai_discovered' : 'ai_enriched';
      await this.db.query(
        `UPDATE expert_profiles
         SET primary_domains = $2::text[],
             specializations = $3::text[],
             documented_positions = $4::jsonb,
             source_mode = $5,
             last_ai_reviewed_at = now(),
             updated_at = now()
         WHERE slug = $1`,
        [matched.slug, mergedDomains, mergedSpecs, JSON.stringify(mergedPositions), nextMode],
      );
      this.directoryCache = null;
      return;
    }

    const slug = slugifyExpertName(item.expertSlug || item.expertName || item.handle);
    if (!slug) return;
    const derivedProfileUrl = profileUrlOverride || deriveProfileUrl(item.sourceUrl, item.handle, item.platform);
    await this.db.query(
      `INSERT INTO expert_profiles (
         slug, full_name, handle, platform, role_uk, organization,
         primary_domains, specializations, profile_url,
         known_affiliations_uk, credibility_weight,
         conflict_disclosure_uk, documented_positions, source_mode, last_ai_reviewed_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13::jsonb,'ai_discovered',now(),now())
       ON CONFLICT (slug) DO UPDATE SET
         primary_domains = EXCLUDED.primary_domains,
         specializations = EXCLUDED.specializations,
         documented_positions = EXCLUDED.documented_positions,
         last_ai_reviewed_at = now(),
         updated_at = now()`,
      [
        slug,
        item.expertName.slice(0, 155),
        item.handle.slice(0, 115),
        normalizePlatform(item.platform),
        item.roleUk.slice(0, 195),
        (item.organization || 'Незалежний експерт').slice(0, 175),
        [validCat],
        extraSpecializations.length > 0 ? extraSpecializations : [validCat],
        derivedProfileUrl,
        item.potentialBiasUk.slice(0, 500),
        Math.max(60, Math.min(95, Math.round(item.credibilityWeight))),
        item.conflictOfInterestUk.slice(0, 500),
        JSON.stringify([newPosition]),
      ],
    );
    this.directoryCache = null;
  }

  private async upsertAiManagedExpert(
    raw: Record<string, unknown>,
    mode: 'ai_discovered' | 'ai_enriched',
    groundedUrls: Set<string>,
  ): Promise<'added' | 'updated' | 'rejected'> {
    if (!this.db) return 'rejected';
    const fullName = typeof raw.fullName === 'string' ? raw.fullName.trim() : '';
    const handle = typeof raw.handle === 'string' ? raw.handle.trim() : '';
    const roleUk = typeof raw.roleUk === 'string' ? raw.roleUk.trim() : '';
    const profileUrl = safePublicHttpsUrl(raw.profileUrl);
    if (!fullName || !handle || !roleUk || !profileUrl) return 'rejected';

    const existingList = await this.loadExpertProfilesFromDb();
    const rawSlug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
    const existing =
      existingList.find((e) => e.slug === rawSlug) ||
      findExpertByAuthor(existingList, handle, fullName);

    const slug = existing?.slug || slugifyExpertName(rawSlug || fullName || handle);
    if (!slug) return 'rejected';

    const candidatePositions: DocumentedExpertPosition[] = [];
    const rawPositions = Array.isArray(raw.documentedPositions)
      ? raw.documentedPositions
      : raw.documentedPosition && typeof raw.documentedPosition === 'object'
        ? [raw.documentedPosition]
        : [];

    for (const p of rawPositions) {
      if (!p || typeof p !== 'object') continue;
      const posObj = p as Record<string, unknown>;
      const posUrl = safePublicHttpsUrl(posObj.url);
      if (!posUrl) continue;
      // Enforce presence in googleSearch groundingChunks rather than blindly trusting domain match
      const isGrounded = groundedUrls.size > 0 && groundedUrls.has(posUrl);
      if (!isGrounded) continue;
      const thesisUk = typeof posObj.thesisUk === 'string' ? posObj.thesisUk.trim() : '';
      const quoteUk = typeof posObj.quoteUk === 'string' ? posObj.quoteUk.trim() : '';
      if (thesisUk.length < 15 || quoteUk.length < 15) continue;
      candidatePositions.push({
        topicKeywords: Array.isArray(posObj.topicKeywords)
          ? posObj.topicKeywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 1).slice(0, 8)
          : ['analysis'],
        thesisUk: thesisUk.slice(0, 400),
        quoteUk: quoteUk.slice(0, 400),
        keyArgumentsUk: Array.isArray(posObj.keyArgumentsUk)
          ? posObj.keyArgumentsUk.filter((a): a is string => typeof a === 'string' && a.trim().length > 3).slice(0, 4)
          : [thesisUk.slice(0, 200)],
        url: posUrl,
        publishedAt: typeof posObj.publishedAt === 'string' && !Number.isNaN(Date.parse(posObj.publishedAt))
          ? posObj.publishedAt
          : new Date().toISOString(),
      });
    }

    if (!existing && candidatePositions.length === 0) {
      return 'rejected';
    }

    const domains = normalizeDomains(
      Array.isArray(raw.primaryDomains) ? raw.primaryDomains.map(String) : null,
      existing?.primaryDomains ?? ['other'],
    );
    const specs = Array.isArray(raw.specializations)
      ? Array.from(
          new Set([
            ...(existing?.specializations ?? []),
            ...raw.specializations.filter((s): s is string => typeof s === 'string' && s.trim().length > 1),
          ]),
        ).slice(0, 16)
      : (existing?.specializations ?? domains);

    const organization =
      (typeof raw.organization === 'string' && raw.organization.trim()) ||
      existing?.organization ||
      'Незалежний експерт';
    const knownAffiliationsUk =
      (typeof raw.knownAffiliationsUk === 'string' && raw.knownAffiliationsUk.trim()) ||
      existing?.knownAffiliationsUk ||
      'Публічна професійна діяльність.';
    const conflictDisclosureUk =
      (typeof raw.conflictDisclosureUk === 'string' && raw.conflictDisclosureUk.trim()) ||
      existing?.conflictDisclosureUk ||
      null;
    const credibilityWeight = Math.max(
      60,
      Math.min(97, Number(raw.credibilityWeight) || existing?.credibilityWeight || 82),
    );
    const mergedPositions = mergeDocumentedPositions(existing?.documentedPositions ?? [], candidatePositions);

    await this.db.query(
      `INSERT INTO expert_profiles (
         slug, full_name, handle, platform, role_uk, organization,
         primary_domains, specializations, profile_url,
         known_affiliations_uk, credibility_weight,
         conflict_disclosure_uk, documented_positions, source_mode,
         ai_notes, last_ai_reviewed_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8::text[],$9,$10,$11,$12,$13::jsonb,$14,$15,now(),now())
       ON CONFLICT (slug) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         handle = EXCLUDED.handle,
         platform = EXCLUDED.platform,
         role_uk = EXCLUDED.role_uk,
         organization = EXCLUDED.organization,
         primary_domains = EXCLUDED.primary_domains,
         specializations = EXCLUDED.specializations,
         profile_url = EXCLUDED.profile_url,
         known_affiliations_uk = EXCLUDED.known_affiliations_uk,
         credibility_weight = EXCLUDED.credibility_weight,
         conflict_disclosure_uk = COALESCE(EXCLUDED.conflict_disclosure_uk, expert_profiles.conflict_disclosure_uk),
         documented_positions = EXCLUDED.documented_positions,
         source_mode = CASE
           WHEN expert_profiles.source_mode = 'ai_discovered' THEN 'ai_discovered'
           ELSE 'ai_enriched'
         END,
         ai_notes = EXCLUDED.ai_notes,
         last_ai_reviewed_at = now(),
         updated_at = now()`,
      [
        slug,
        fullName.slice(0, 155),
        handle.slice(0, 115),
        normalizePlatform(typeof raw.platform === 'string' ? raw.platform : existing?.platform || 'web'),
        roleUk.slice(0, 195),
        organization.slice(0, 175),
        domains,
        specs,
        profileUrl,
        knownAffiliationsUk.slice(0, 500),
        credibilityWeight,
        conflictDisclosureUk,
        JSON.stringify(mergedPositions),
        existing ? 'ai_enriched' : mode,
        typeof raw.aiNotes === 'string' ? raw.aiNotes.slice(0, 500) : null,
      ],
    );

    return existing ? 'updated' : 'added';
  }

  private buildRegistryExpertOpinions(
    experts: ManagedExpertProfile[],
    articleCategory: string,
    articleTitle: string,
    articleSummary: string,
    valueAddScore: number,
  ): ExpertOpinionItem[] {
    if (valueAddScore < 68) {
      return [];
    }

    const scored = experts
      .map((expert) => ({
        expert,
        assessment: scoreExpertCompetenceForTopic(expert, articleCategory, articleTitle, articleSummary),
      }))
      .filter((entry) => entry.assessment.score >= 75)
      .sort((a, b) => b.assessment.score * 100 + b.expert.credibilityWeight - (a.assessment.score * 100 + a.expert.credibilityWeight))
      .slice(0, 4);

    const out: ExpertOpinionItem[] = [];
    for (const { expert, assessment } of scored) {
      const position = pickBestDocumentedPosition(expert, articleTitle, articleSummary);
      if (!position) continue;
      // Never attribute verbatim quotes to profile homepage roots (e.g. https://x.com/karpathy)
      const parsedPos = URL.parse(position.url);
      if (!parsedPos) continue;
      const posHost = parsedPos.hostname.toLowerCase().replace(/^www\./, '');
      const posPath = parsedPos.pathname.replace(/\/+$/, '');
      const isProfileRootOnly =
        ((posHost === 'x.com' || posHost === 'twitter.com' || posHost === 'github.com') &&
          /^\/[^/]+$/.test(posPath)) ||
        (posHost === 'bsky.app' && /^\/profile\/[^/]+$/.test(posPath)) ||
        (posHost === 'linkedin.com' && /^\/in\/[^/]+$/.test(posPath));
      if (isProfileRootOnly) continue;

      try {
        out.push(
          validateExpertOpinionItem({
            expertSlug: expert.slug,
            expertName: expert.fullName,
            handle: expert.handle,
            platform: expert.platform,
            roleUk: expert.roleUk,
            organization: expert.organization,
            directQuote: position.quoteUk,
            stanceSummaryUk: position.thesisUk,
            keyArgumentsUk: position.keyArgumentsUk,
            contextUk: `${assessment.rationaleUk} Підтверджена публічна позиція експерта.`,
            publishedAt: position.publishedAt,
            sourceUrl: position.url,
            domainCompetenceScore: assessment.score,
            credibilityWeight: expert.credibilityWeight,
            potentialBiasUk: expert.knownAffiliationsUk || 'Публічна позиція задекларована у першоджерелі.',
            conflictOfInterestUk: expert.conflictDisclosureUk || 'Фактичні афіліації зазначено в профілі автора.',
            verificationStatus: 'verified_expert_registry',
            embed: buildOfficialEmbedInfo(position.url, expert.handle, position.quoteUk),
          }),
        );
      } catch {
        // Keep validation strict
      }
    }
    return out;
  }

  private async buildConsensusSummary(
    context: NewsContextRecord,
    opinions: ExpertOpinionItem[],
  ): Promise<ConsensusSummary> {
    if (this.activeKey && canUseHydrogenQuota() && process.env.NODE_ENV !== 'test') {
      try {
        const res = await postGeminiGenerateContent({
          apiKey: this.activeKey,
          preferredModel: DEFAULT_HYDROGEN_MODEL,
          candidateModels: [DEFAULT_HYDROGEN_MODEL, DEFAULT_GEMINI_MODEL],
          timeoutMs: 25_000,
          body: {
            systemInstruction: {
              parts: [
                {
                  text: 'Синтезуй чесний консенсус експертів українською у суворому JSON. Не створюй штучний баланс 50/50 і не вигадуй нових фактів.',
                },
              ],
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: JSON.stringify({
                      title: context.title,
                      category: context.category,
                      opinions: opinions.map((o) => ({
                        name: o.expertName,
                        score: o.domainCompetenceScore,
                        stance: o.stanceSummaryUk,
                        arguments: o.keyArgumentsUk,
                        bias: o.potentialBiasUk,
                      })),
                    }),
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
              responseJsonSchema: {
                type: 'object',
                properties: {
                  agreementUk: { type: 'string' },
                  disagreementUk: { type: 'string' },
                  dominantConsensusUk: { type: 'string' },
                  practicalTakeawayUk: { type: 'string' },
                },
                required: ['agreementUk', 'disagreementUk', 'dominantConsensusUk', 'practicalTakeawayUk'],
              },
              maxOutputTokens: 1200,
            },
          },
        });
        const text = (
          res.data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
        )?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text ?? '')
          .join('');
        if (text) {
          const parsed = JSON.parse(text) as Partial<ConsensusSummary>;
          if (
            parsed.agreementUk &&
            parsed.disagreementUk &&
            parsed.dominantConsensusUk &&
            parsed.practicalTakeawayUk
          ) {
            return {
              agreementUk: parsed.agreementUk.slice(0, 600),
              disagreementUk: parsed.disagreementUk.slice(0, 600),
              dominantConsensusUk: parsed.dominantConsensusUk.slice(0, 600),
              practicalTakeawayUk: parsed.practicalTakeawayUk.slice(0, 600),
            };
          }
        }
      } catch {
        // Fallback to deterministic synthesis cleanly
      }
    }

    const lead = opinions[0];
    const secondary = opinions[1];
    return {
      agreementUk: opinions.length > 1
        ? `Фахівці сходяться на необхідності незалежної перевірки практичного впливу події (${lead.expertName}, ${secondary.expertName}).`
        : `${lead.expertName} акцентує увагу на практичній реалізації та системній верифікації події.`,
      disagreementUk: opinions.some((o) => /meta|nvidia|vercel|yc|brave1/i.test(o.potentialBiasUk))
        ? 'Оцінки різняться залежно від інституційної ролі: практики фокусуються на обмеженнях впровадження, а екосистемні гравці — на швидкості масштабування.'
        : 'Головні розбіжності стосуються темпів реального впровадження та співвідношення витрат і надійності.',
      dominantConsensusUk: lead.stanceSummaryUk,
      practicalTakeawayUk: lead.keyArgumentsUk[0] || 'Варто перевірити ключові метрики та ризики перед прийняттям інженерних чи інвестиційних рішень.',
    };
  }
}

function extractSearchTerms(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 5)
    .join(' ');
}

function findExpertByAuthor(
  experts: ManagedExpertProfile[],
  handle: string,
  displayName?: string,
): ManagedExpertProfile | undefined {
  const cleanHandle = handle.toLowerCase().replace(/^@/, '');
  const cleanName = (displayName || '').toLowerCase();
  return experts.find((expert) => {
    const expHandle = expert.handle.toLowerCase().replace(/^@/, '');
    return (
      expHandle === cleanHandle ||
      expert.slug === cleanHandle ||
      (cleanName && expert.fullName.toLowerCase() === cleanName)
    );
  });
}

function normalizePlatform(raw: string): ExpertPlatform {
  const clean = (raw || '').trim().toLowerCase();
  if (clean === 'x' || clean === 'twitter') return 'x';
  if (clean === 'facebook') return 'facebook';
  if (clean === 'bluesky' || clean === 'bsky') return 'bluesky';
  if (clean === 'github') return 'github';
  return 'web';
}

function normalizeSourceMode(raw: string | null | undefined): 'seed' | 'ai_discovered' | 'ai_enriched' {
  if (raw === 'ai_discovered' || raw === 'ai_enriched') return raw;
  return 'seed';
}

function normalizeDomains(raw: string[] | null | undefined, fallback: NewsCategory[] = ['other']): NewsCategory[] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const valid = raw.filter((d): d is NewsCategory => CATEGORIES.includes(d as NewsCategory));
  return valid.length > 0 ? Array.from(new Set(valid)) : fallback;
}

function normalizeDocumentedPositions(raw: unknown): DocumentedExpertPosition[] {
  if (!Array.isArray(raw)) return [];
  const out: DocumentedExpertPosition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const url = safePublicHttpsUrl(obj.url);
    const thesisUk = typeof obj.thesisUk === 'string' ? obj.thesisUk.trim() : '';
    const quoteUk = typeof obj.quoteUk === 'string' ? obj.quoteUk.trim() : '';
    if (!url || !thesisUk || !quoteUk) continue;
    out.push({
      topicKeywords: Array.isArray(obj.topicKeywords)
        ? obj.topicKeywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
        : ['analysis'],
      thesisUk,
      quoteUk,
      keyArgumentsUk: Array.isArray(obj.keyArgumentsUk)
        ? obj.keyArgumentsUk.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        : [thesisUk],
      url,
      publishedAt: typeof obj.publishedAt === 'string' ? obj.publishedAt : new Date().toISOString(),
    });
  }
  return out;
}

function mergeDocumentedPositions(
  existing: DocumentedExpertPosition[],
  incoming: DocumentedExpertPosition[],
): DocumentedExpertPosition[] {
  const byUrl = new Map<string, DocumentedExpertPosition>();
  for (const pos of [...incoming, ...existing]) {
    const key = pos.url.toLowerCase();
    if (!byUrl.has(key)) byUrl.set(key, pos);
  }
  return Array.from(byUrl.values()).slice(0, 12);
}

function slugifyExpertName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 75);
}

function deriveProfileUrl(sourceUrl: string, handle: string, platform: string): string {
  const cleanHandle = handle.replace(/^@/, '').trim();
  const norm = normalizePlatform(platform);
  if (norm === 'x' && cleanHandle) return `https://x.com/${encodeURIComponent(cleanHandle)}`;
  if (norm === 'bluesky' && cleanHandle) return `https://bsky.app/profile/${encodeURIComponent(cleanHandle)}`;
  if (norm === 'github' && cleanHandle) return `https://github.com/${encodeURIComponent(cleanHandle)}`;
  const parsed = URL.parse(sourceUrl);
  return parsed ? `${parsed.protocol}//${parsed.hostname}` : sourceUrl;
}

function pickBestDocumentedPosition(expert: ExpertProfile, title: string, summary: string) {
  const haystack = `${title} ${summary}`.toLowerCase();
  let best = expert.documentedPositions[0];
  let bestHits = -1;
  for (const pos of expert.documentedPositions) {
    const hits = pos.topicKeywords.filter((kw) => haystack.includes(kw.toLowerCase())).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = pos;
    }
  }
  return best;
}

function deduplicateOpinions(items: ExpertOpinionItem[]): ExpertOpinionItem[] {
  const seenUrls = new Set<string>();
  const seenExperts = new Set<string>();
  const unique: ExpertOpinionItem[] = [];
  for (const item of items) {
    const urlKey = item.sourceUrl.toLowerCase();
    const expertKey = (item.expertSlug || item.expertName).toLowerCase();
    if (seenUrls.has(urlKey) || seenExperts.has(expertKey)) continue;
    seenUrls.add(urlKey);
    seenExperts.add(expertKey);
    unique.push(item);
  }
  return unique;
}
