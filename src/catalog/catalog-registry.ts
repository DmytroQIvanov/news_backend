import { isSafePublicHttpUrl } from '../common/source-compliance';
import { ProviderConfig, PROVIDERS_CONFIG } from './catalog-seed';

/** Bootstrap feed adapters enrich registry rows; they never restrict which providers can refresh. */
export function catalogRegistryTargets(rows: Array<Record<string, any>>): ProviderConfig[] {
  if (!rows.length) return PROVIDERS_CONFIG;
  return rows.filter(r => typeof r.id==='string' && typeof r.providerId==='string' && typeof r.providerName==='string'
    && typeof r.officialUrl==='string' && isSafePublicHttpUrl(r.officialUrl))
    .map(r => ({ id: r.id,providerId: r.providerId,providerName: r.providerName,category: r.category || '',officialUrl: r.officialUrl,
      pricingDocUrl: typeof r.pricingDocUrl==='string' && isSafePublicHttpUrl(r.pricingDocUrl) ? r.pricingDocUrl : r.officialUrl,
      feedUrls: PROVIDERS_CONFIG.find(p => p.providerId===r.providerId)?.feedUrls || [] }));
}
