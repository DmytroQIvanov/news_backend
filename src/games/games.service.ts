import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isTransientHttpStatus, retryWithBackoff } from '../common/url-utils';
import { DatabaseService } from '../database/database.service';

export type GameOfferType = 'giveaway' | 'demo' | 'beta' | 'dlc' | 'discount';

export interface GameOfferItem {
  id: string;
  externalId: string;
  title: string;
  titleUk: string | null;
  descriptionUk: string | null;
  howToClaimUk: string | null;
  offerType: GameOfferType;
  storeName: string;
  platforms: string[];
  imageUrl: string | null;
  url: string;
  originalPrice: string | null;
  isFree: boolean;
  worthScore: number;
  expiresAt: string | null;
  status: 'active' | 'expired';
  aiEnriched: boolean;
  lastVerifiedAt: string;
}

interface RawGameCandidate {
  externalId: string;
  title: string;
  rawDescription: string;
  rawInstructions: string;
  offerType: GameOfferType;
  storeName: string;
  platforms: string[];
  imageUrl: string | null;
  url: string;
  originalPrice: string | null;
  isFree: boolean;
  worthScore: number;
  expiresAt: string | null;
}

const enrichmentSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          externalId: { type: 'string' },
          titleUk: { type: 'string' },
          descriptionUk: { type: 'string' },
          howToClaimUk: { type: 'string' },
        },
        required: ['externalId', 'titleUk', 'descriptionUk', 'howToClaimUk'],
      },
    },
  },
  required: ['items'],
};

@Injectable()
export class GamesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GamesService.name);
  private readonly geminiKey = process.env.GEMINI_API_KEY?.trim();
  private readonly geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-2.0-flash-lite';
  private timer?: NodeJS.Timeout;
  private isDestroyed = false;
  private activeSync?: Promise<{ fetched: number; written: number; enriched: number }>;

  constructor(private readonly db: DatabaseService) {}

  onModuleInit() {
    const intervalMs = 60 * 60_000; // Every 60 minutes
    const scheduleNext = () => {
      this.timer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.syncGames();
        } catch (err) {
          this.logger.warn(`Scheduled games sync failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!this.isDestroyed) scheduleNext();
        }
      }, intervalMs);
    };

    // Initial sync 20 seconds after server start
    this.timer = setTimeout(async () => {
      if (this.isDestroyed) return;
      try {
        await this.syncGames();
      } catch (err) {
        this.logger.warn(`Initial games sync failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        if (!this.isDestroyed) scheduleNext();
      }
    }, 20_000);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async list(filters?: {
    type?: string;
    store?: string;
    q?: string;
    sort?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: GameOfferItem[]; total: number; hasMore: boolean }> {
    const limit = Math.max(1, Math.min(50, filters?.limit ?? 30));
    const offset = Math.max(0, filters?.offset ?? 0);

    const typeFilter = filters?.type && filters.type !== 'all' ? filters.type : null;
    const storeFilter = filters?.store && filters.store !== 'all' ? filters.store : null;
    const qFilter = filters?.q?.trim() ? `%${filters.q.trim()}%` : null;

    let orderBy = 'last_verified_at DESC, id DESC';
    if (filters?.sort === 'expiring_soon') {
      orderBy = 'expires_at ASC NULLS LAST, worth_score DESC, id DESC';
    } else if (filters?.sort === 'worth_desc') {
      orderBy = 'worth_score DESC, last_verified_at DESC, id DESC';
    }

    try {
      await this.db.query(`UPDATE game_offers SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`).catch(() => undefined);

      const { rows } = await this.db.query<GameOfferItem>(`
        SELECT id::text,
               external_id AS "externalId",
               title,
               title_uk AS "titleUk",
               description_uk AS "descriptionUk",
               how_to_claim_uk AS "howToClaimUk",
               offer_type AS "offerType",
               store_name AS "storeName",
               platforms,
               image_url AS "imageUrl",
               url,
               original_price AS "originalPrice",
               is_free AS "isFree",
               worth_score AS "worthScore",
               expires_at AS "expiresAt",
               status,
               ai_enriched AS "aiEnriched",
               last_verified_at AS "lastVerifiedAt"
        FROM game_offers
        WHERE status = 'active'
          AND ($1::text IS NULL OR offer_type = $1)
          AND ($2::text IS NULL OR lower(store_name) LIKE '%' || lower($2) || '%')
          AND ($3::text IS NULL OR title ILIKE $3 OR COALESCE(title_uk, '') ILIKE $3 OR COALESCE(description_uk, '') ILIKE $3)
        ORDER BY ${orderBy}
        LIMIT $4 OFFSET $5
      `, [typeFilter, storeFilter, qFilter, limit + 1, offset]);

      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      return { items, total: offset + items.length, hasMore };
    } catch (error) {
      this.logger.warn(`Failed querying game_offers: ${error instanceof Error ? error.message : error}`);
      return { items: [], total: 0, hasMore: false };
    }
  }

  async syncGames(): Promise<{ fetched: number; written: number; enriched: number }> {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.executeSync().finally(() => {
      this.activeSync = undefined;
    });
    return this.activeSync;
  }

  private async executeSync(): Promise<{ fetched: number; written: number; enriched: number }> {
    const [epic, gamerPower, steam] = await Promise.all([
      this.fetchEpicFreeGames(),
      this.fetchGamerPower(),
      this.fetchSteamDemosAndDeals(),
    ]);

    const dedup = new Map<string, RawGameCandidate>();
    for (const c of [...epic, ...gamerPower, ...steam]) {
      if (!dedup.has(c.externalId)) {
        dedup.set(c.externalId, c);
      }
    }
    const candidates = [...dedup.values()];
    if (!candidates.length) return { fetched: 0, written: 0, enriched: 0 };

    // Determine which items are new or changed to avoid redundant Gemini calls
    let existingHashes = new Map<string, { hash: string; enriched: boolean }>();
    try {
      const { rows } = await this.db.query<{ external_id: string; content_hash: string; ai_enriched: boolean }>(
        `SELECT external_id, content_hash, ai_enriched FROM game_offers WHERE external_id = ANY($1::text[])`,
        [candidates.map(c => c.externalId)],
      );
      existingHashes = new Map(rows.map(r => [r.external_id, { hash: r.content_hash, enriched: r.ai_enriched }]));
    } catch {
      return { fetched: candidates.length, written: 0, enriched: 0 };
    }

    const toEnrich: RawGameCandidate[] = [];
    for (const c of candidates) {
      const prev = existingHashes.get(c.externalId);
      const hash = hashCandidate(c);
      if (!prev || prev.hash !== hash || !prev.enriched) {
        toEnrich.push(c);
      }
    }

    const enrichMap = new Map<string, { titleUk: string; descriptionUk: string; howToClaimUk: string }>();
    if (this.geminiKey && toEnrich.length > 0) {
      const batch = toEnrich.slice(0, 10);
      const enriched = await this.enrichWithGemini(batch);
      for (const item of enriched) {
        enrichMap.set(item.externalId, item);
      }
    }

    let written = 0;
    for (const c of candidates) {
      const hash = hashCandidate(c);
      const ai = enrichMap.get(c.externalId);
      const res = await this.db.query(`
        INSERT INTO game_offers (
          external_id, title, title_uk, description_uk, how_to_claim_uk,
          offer_type, store_name, platforms, image_url, url,
          original_price, is_free, worth_score, expires_at, status,
          ai_enriched, content_hash, last_verified_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, 'active', $15, $16, now(), now())
        ON CONFLICT (external_id) DO UPDATE SET
          title = EXCLUDED.title,
          title_uk = COALESCE(EXCLUDED.title_uk, game_offers.title_uk),
          description_uk = COALESCE(EXCLUDED.description_uk, game_offers.description_uk),
          how_to_claim_uk = COALESCE(EXCLUDED.how_to_claim_uk, game_offers.how_to_claim_uk),
          offer_type = EXCLUDED.offer_type,
          store_name = EXCLUDED.store_name,
          platforms = EXCLUDED.platforms,
          image_url = COALESCE(EXCLUDED.image_url, game_offers.image_url),
          url = EXCLUDED.url,
          original_price = EXCLUDED.original_price,
          is_free = EXCLUDED.is_free,
          worth_score = EXCLUDED.worth_score,
          expires_at = EXCLUDED.expires_at,
          status = 'active',
          ai_enriched = game_offers.ai_enriched OR EXCLUDED.ai_enriched,
          content_hash = EXCLUDED.content_hash,
          last_verified_at = now(),
          updated_at = now()
      `, [
        c.externalId,
        c.title,
        ai?.titleUk || c.title,
        ai?.descriptionUk || c.rawDescription || null,
        ai?.howToClaimUk || c.rawInstructions || null,
        c.offerType,
        c.storeName,
        JSON.stringify(c.platforms),
        c.imageUrl,
        c.url,
        c.originalPrice,
        c.isFree,
        c.worthScore,
        c.expiresAt,
        Boolean(ai),
        hash,
      ]).catch(() => null);
      if (res?.rowCount) written += 1;
    }

    await this.db.query(`UPDATE game_offers SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now()`).catch(() => undefined);
    this.logger.log(`Games sync complete: ${candidates.length} fetched, ${written} upserted, ${enrichMap.size} Gemini-enriched.`);
    return { fetched: candidates.length, written, enriched: enrichMap.size };
  }

  private async fetchEpicFreeGames(): Promise<RawGameCandidate[]> {
    try {
      const resp = await fetch(
        'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=uk-UA&country=UA&allowCountries=UA',
        { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'OpportunityRadar/1.0' } },
      );
      if (!resp.ok) {
        await resp.body?.cancel();
        return [];
      }
      const data = (await resp.json()) as any;
      const elements: any[] = data?.data?.Catalog?.searchStore?.elements || [];
      const results: RawGameCandidate[] = [];

      for (const el of elements) {
        const promoOffers = el?.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
        const activeFree = promoOffers.find((o: any) => o?.discountSetting?.discountPercentage === 0);
        if (!activeFree) continue;

        const slug = el.catalogNs?.mappings?.[0]?.pageSlug || el.productSlug || el.urlSlug;
        const url = slug ? `https://store.epicgames.com/uk/p/${slug}` : 'https://store.epicgames.com/uk/free-games';
        const img = (el.keyImages || []).find((k: any) => k.type === 'OfferImageWide' || k.type === 'DieselStoreFrontWide')?.url
          || el.keyImages?.[0]?.url
          || null;
        const origPrice = el.price?.totalPrice?.fmtPrice?.originalPrice || null;
        const origCents = Number(el.price?.totalPrice?.originalPrice || 0);

        results.push({
          externalId: `epic-${el.id}`,
          title: String(el.title || '').slice(0, 350),
          rawDescription: String(el.description || '').slice(0, 1500),
          rawInstructions: 'Відкрийте сторінку гри в Epic Games Store та натисніть «Отримати» (залишається назавжди).',
          offerType: 'giveaway',
          storeName: 'Epic Games',
          platforms: ['PC', 'Epic Games'],
          imageUrl: img && String(img).startsWith('https://') ? String(img) : null,
          url,
          originalPrice: origPrice && origPrice !== '0' ? origPrice : null,
          isFree: true,
          worthScore: Math.max(50, Math.round(origCents / 100) + 40),
          expiresAt: activeFree.endDate || null,
        });
      }
      return results;
    } catch (err) {
      this.logger.warn(`Epic Games fetch failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async fetchGamerPower(): Promise<RawGameCandidate[]> {
    try {
      const resp = await fetch('https://www.gamerpower.com/api/giveaways?sort-by=date', {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'OpportunityRadar/1.0' },
      });
      if (!resp.ok) {
        await resp.body?.cancel();
        return [];
      }
      const rows = (await resp.json()) as any[];
      if (!Array.isArray(rows)) return [];

      return rows.slice(0, 28).map((g): RawGameCandidate | null => {
        const url = String(g.open_giveaway_url || g.gamerpower_url || '');
        if (!url.startsWith('https://')) return null;
        const typeRaw = String(g.type || '').toLowerCase();
        const offerType: GameOfferType =
          typeRaw.includes('beta') ? 'beta'
          : typeRaw.includes('dlc') || typeRaw.includes('loot') ? 'dlc'
          : 'giveaway';
        const platformsRaw = String(g.platforms || 'PC');
        const storeName = detectStoreName(platformsRaw, url);
        const worthStr = String(g.worth || '');
        const worthNum = parseFloat(worthStr.replace(/[^0-9.]/g, '')) || 0;
        const endDate = g.end_date && g.end_date !== 'N/A' && Number.isFinite(Date.parse(g.end_date))
          ? new Date(g.end_date).toISOString()
          : null;
        const image = String(g.image || g.thumbnail || '');

        return {
          externalId: `gp-${g.id}`,
          title: String(g.title || '').slice(0, 350),
          rawDescription: String(g.description || '').slice(0, 1500),
          rawInstructions: String(g.instructions || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
          offerType,
          storeName,
          platforms: platformsRaw.split(',').map((p: string) => p.trim()).filter(Boolean).slice(0, 5),
          imageUrl: image.startsWith('https://') ? image : null,
          url,
          originalPrice: worthStr && worthStr !== 'N/A' ? worthStr : null,
          isFree: true,
          worthScore: Math.round(worthNum) + (offerType === 'giveaway' ? 30 : 10),
          expiresAt: endDate,
        };
      }).filter((x): x is RawGameCandidate => x !== null);
    } catch (err) {
      this.logger.warn(`GamerPower fetch failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async fetchSteamDemosAndDeals(): Promise<RawGameCandidate[]> {
    try {
      const resp = await fetch('https://store.steampowered.com/api/featuredcategories?cc=ua&l=ukrainian', {
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': 'OpportunityRadar/1.0' },
      });
      if (!resp.ok) {
        await resp.body?.cancel();
        return [];
      }
      const data = (await resp.json()) as any;
      const specials: any[] = data?.specials?.items || [];
      const results: RawGameCandidate[] = [];

      for (const item of specials.slice(0, 10)) {
        const discount = Number(item.discount_percent || 0);
        if (discount < 50) continue;
        const isFree = Number(item.final_price || 0) === 0 || discount === 100;
        const img = String(item.large_capsule_image || item.header_image || '');
        const url = `https://store.steampowered.com/app/${item.id}`;
        const origPrice = item.original_price ? `${(Number(item.original_price) / 100).toFixed(0)} ₴` : null;

        results.push({
          externalId: `steam-${item.id}`,
          title: String(item.name || '').slice(0, 350),
          rawDescription: isFree
            ? 'Тимчасово 100% безкоштовно у Steam.'
            : `Знижка ${discount}% у Steam.`,
          rawInstructions: 'Відкрийте сторінку гри у Steam та додайте на акаунт.',
          offerType: isFree ? 'giveaway' : 'discount',
          storeName: 'Steam',
          platforms: ['PC', 'Steam'],
          imageUrl: img.startsWith('https://') ? img : null,
          url,
          originalPrice: origPrice,
          isFree,
          worthScore: isFree ? 80 : Math.min(70, discount),
          expiresAt: item.discount_expiration ? new Date(Number(item.discount_expiration) * 1000).toISOString() : null,
        });
      }
      return results;
    } catch (err) {
      this.logger.warn(`Steam featured fetch failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }

  private async enrichWithGemini(
    batch: RawGameCandidate[],
  ): Promise<Array<{ externalId: string; titleUk: string; descriptionUk: string; howToClaimUk: string }>> {
    try {
      const prompt = `Ти редактор ігрового розділу українською мовою. Переклади та коротко адаптуй інформацію про ігрові роздачі, демки та знижки.
НЕ вигадуй фактів, яких немає в описі. Якщо назва гри — власна назва, залиш її впізнаваною.

Вхідні ігри:
${JSON.stringify(batch.map(b => ({
  externalId: b.externalId,
  title: b.title,
  store: b.storeName,
  type: b.offerType,
  description: b.rawDescription.slice(0, 400),
  instructions: b.rawInstructions.slice(0, 300),
})))}`;

      return await retryWithBackoff(
        async () => {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.geminiModel)}:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.geminiKey! },
              signal: AbortSignal.timeout(45_000),
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: {
                  responseMimeType: 'application/json',
                  responseJsonSchema: enrichmentSchema,
                  maxOutputTokens: 3000,
                },
              }),
            },
          );
          if (!resp.ok) {
            await resp.body?.cancel();
            const err = new Error(`Gemini HTTP ${resp.status}`);
            (err as Error & { status?: number }).status = resp.status;
            throw err;
          }
          const raw = (await resp.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          const text = raw.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) return [];
          const parsed = JSON.parse(text) as { items?: Array<{ externalId: string; titleUk: string; descriptionUk: string; howToClaimUk: string }> };
          return Array.isArray(parsed.items) ? parsed.items : [];
        },
        {
          maxAttempts: 2,
          baseDelayMs: 1200,
          shouldRetry: err => isTransientHttpStatus((err as { status?: number })?.status ?? 0),
        },
      );
    } catch (error) {
      this.logger.warn(`Gemini games enrichment failed: ${error instanceof Error ? error.message : error}`);
      return [];
    }
  }
}

export function detectStoreName(platforms: string, url: string): string {
  const combined = `${platforms} ${url}`.toLowerCase();
  if (combined.includes('epic')) return 'Epic Games';
  if (combined.includes('steam')) return 'Steam';
  if (combined.includes('gog')) return 'GOG';
  if (combined.includes('itch')) return 'itch.io';
  if (combined.includes('prime') || combined.includes('amazon')) return 'Prime Gaming';
  return 'Інший маркет';
}

function hashCandidate(c: RawGameCandidate): string {
  return createHash('sha256')
    .update(JSON.stringify([c.title, c.rawDescription, c.offerType, c.storeName, c.imageUrl, c.url, c.originalPrice, c.expiresAt]))
    .digest('hex');
}
