import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type LicenseMode = 'headline_link' | 'summary' | 'full_text_licensed';
export type SourceReviewStatus = 'approved' | 'pending_review' | 'rejected';

export function getHonestUserAgent(): string {
  const configured = (process.env.CRAWLER_USER_AGENT || '').trim();
  if (configured) return configured;
  return 'AI-News-Radar/1.8 (+mailto:support@ainewsradar.app)';
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isPrivateOrReservedIp(normalized.slice('::ffff:'.length));
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) {
    return true;
  }
  const parts = normalized.split('.');
  if (parts.length !== 4) {
    // Non-loopback non-ULA IPv6 assumed public only if explicitly valid IPv6
    return !isIP(normalized);
  }
  const nums = parts.map(p => Number(p));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // Multicast / reserved
  return false;
}

export function isSafePublicHttpUrl(
  rawUrl: string,
  options?: { allowHttp?: boolean },
): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    const allowHttp = Boolean(options?.allowHttp);
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host) return false;
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.lan') ||
      host.endsWith('.home')
    ) {
      return false;
    }
    if (isIP(host)) {
      return !isPrivateOrReservedIp(host);
    }
    if (!host.includes('.')) return false;
    return true;
  } catch {
    return false;
  }
}

export async function resolveAndValidatePublicUrl(
  rawUrl: string,
  options?: {
    allowHttp?: boolean;
    lookupFn?: (hostname: string) => Promise<Array<{ address: string }>>;
  },
): Promise<{ safe: boolean; reason?: string }> {
  if (!isSafePublicHttpUrl(rawUrl, { allowHttp: options?.allowHttp })) {
    return { safe: false, reason: 'URL failed public HTTPS syntax/host validation' };
  }
  const host = new URL(rawUrl).hostname;
  if (isIP(host)) {
    return isPrivateOrReservedIp(host)
      ? { safe: false, reason: 'Direct private/reserved IP blocked' }
      : { safe: true };
  }
  try {
    const resolver =
      options?.lookupFn ?? (h => lookup(h, { all: true, verbatim: true }));
    const records = await resolver(host);
    if (!records || records.length === 0) {
      return { safe: false, reason: 'DNS resolution returned no records' };
    }
    for (const rec of records) {
      if (isPrivateOrReservedIp(rec.address)) {
        return { safe: false, reason: `Resolved IP ${rec.address} is private or reserved` };
      }
    }
    return { safe: true };
  } catch (error) {
    return {
      safe: false,
      reason: `DNS validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySec?: number;
}

interface CachedRobotsEntry {
  fetchedAt: number;
  groups: RobotsGroup[];
  disallowAll: boolean;
}

const ROBOTS_CACHE_TTL_MS = 12 * 60 * 60_000;
const robotsCache = new Map<string, CachedRobotsEntry>();

export function clearRobotsCacheForTests(): void {
  robotsCache.clear();
}

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let currentAgents: string[] = [];
  let currentRules: RobotsRule[] = [];
  let currentDelay: number | undefined;
  let seenRuleInGroup = false;

  const flush = () => {
    if (currentAgents.length > 0) {
      groups.push({
        agents: currentAgents,
        rules: currentRules,
        crawlDelaySec: currentDelay,
      });
    }
    currentAgents = [];
    currentRules = [];
    currentDelay = undefined;
    seenRuleInGroup = false;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const cleaned = rawLine.replace(/#.*$/, '').trim();
    if (!cleaned) continue;
    const colon = cleaned.indexOf(':');
    if (colon === -1) continue;
    const field = cleaned.slice(0, colon).trim().toLowerCase();
    const value = cleaned.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (seenRuleInGroup) {
        flush();
      }
      if (value) currentAgents.push(value.toLowerCase());
    } else if (field === 'disallow') {
      seenRuleInGroup = true;
      if (value) currentRules.push({ allow: false, pattern: value });
    } else if (field === 'allow') {
      seenRuleInGroup = true;
      if (value) currentRules.push({ allow: true, pattern: value });
    } else if (field === 'crawl-delay') {
      seenRuleInGroup = true;
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) currentDelay = num;
    }
  }
  flush();
  return groups;
}

function matchesRobotsPattern(pathAndQuery: string, pattern: string): boolean {
  if (!pattern) return false;
  let regexStr = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      regexStr += '.*';
    } else if (ch === '$' && i === pattern.length - 1) {
      regexStr += '$';
    } else {
      regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(regexStr).test(pathAndQuery);
  } catch {
    return pathAndQuery.startsWith(pattern.replace(/\*.*$/, ''));
  }
}

export function evaluateRobotsGroups(
  groups: RobotsGroup[],
  pathAndQuery: string,
  userAgent: string,
): { allowed: boolean; crawlDelaySec?: number; matchedRule?: string } {
  const uaToken = (userAgent.split(/[\s/]+/)[0] || 'ai-news-radar').toLowerCase();
  const specific = groups.filter(g =>
    g.agents.some(a => a !== '*' && (uaToken.includes(a) || a.includes(uaToken))),
  );
  const wildcard = groups.filter(g => g.agents.includes('*'));
  const chosen = specific.length > 0 ? specific : wildcard;
  if (chosen.length === 0) return { allowed: true };

  let bestRule: RobotsRule | null = null;
  let crawlDelaySec: number | undefined;

  for (const group of chosen) {
    if (group.crawlDelaySec !== undefined) {
      crawlDelaySec = group.crawlDelaySec;
    }
    for (const rule of group.rules) {
      if (!matchesRobotsPattern(pathAndQuery, rule.pattern)) continue;
      if (
        !bestRule ||
        rule.pattern.length > bestRule.pattern.length ||
        (rule.pattern.length === bestRule.pattern.length && rule.allow && !bestRule.allow)
      ) {
        bestRule = rule;
      }
    }
  }

  if (!bestRule) return { allowed: true, crawlDelaySec };
  return {
    allowed: bestRule.allow,
    crawlDelaySec,
    matchedRule: `${bestRule.allow ? 'Allow' : 'Disallow'}: ${bestRule.pattern}`,
  };
}

export async function checkRobotsTxtPermission(
  targetUrl: string,
  options?: {
    userAgent?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<{ allowed: boolean; crawlDelaySec?: number; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }
  if (!isSafePublicHttpUrl(targetUrl, { allowHttp: true })) {
    return { allowed: false, reason: 'Unsafe/non-public URL blocked' };
  }

  const origin = parsed.origin;
  const userAgent = options?.userAgent || getHonestUserAgent();
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
    if (cached.disallowAll) {
      return { allowed: false, reason: 'robots.txt inaccessible (401/403 cached)' };
    }
    const evalResult = evaluateRobotsGroups(
      cached.groups,
      `${parsed.pathname}${parsed.search}`,
      userAgent,
    );
    return evalResult.allowed
      ? { allowed: true, crawlDelaySec: evalResult.crawlDelaySec }
      : { allowed: false, reason: `Blocked by robots.txt (${evalResult.matchedRule})` };
  }

  if (robotsCache.size > 500) {
    const oldest = robotsCache.keys().next().value;
    if (oldest) robotsCache.delete(oldest);
  }

  const fetchImpl = options?.fetchFn ?? fetch;
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/plain, */*',
      },
      signal: AbortSignal.timeout(options?.timeoutMs ?? 5000),
    });

    if (res.status === 401 || res.status === 403) {
      robotsCache.set(origin, { fetchedAt: Date.now(), groups: [], disallowAll: true });
      return { allowed: false, reason: `robots.txt returned HTTP ${res.status}` };
    }
    if (!res.ok) {
      // RFC 9309: 404 / 5xx unavailability of robots.txt -> allowed with caution
      robotsCache.set(origin, { fetchedAt: Date.now(), groups: [], disallowAll: false });
      return { allowed: true };
    }
    const text = (await res.text()).slice(0, 256 * 1024);
    const groups = parseRobotsTxt(text);
    robotsCache.set(origin, { fetchedAt: Date.now(), groups, disallowAll: false });
    const evalResult = evaluateRobotsGroups(
      groups,
      `${parsed.pathname}${parsed.search}`,
      userAgent,
    );
    return evalResult.allowed
      ? { allowed: true, crawlDelaySec: evalResult.crawlDelaySec }
      : { allowed: false, reason: `Blocked by robots.txt (${evalResult.matchedRule})` };
  } catch {
    // Transient network error on robots.txt — fail open unless license_mode forbids scraping
    robotsCache.set(origin, { fetchedAt: Date.now(), groups: [], disallowAll: false });
    return { allowed: true };
  }
}

export function checkHttpRobotsAndTdmHeaders(
  headers: Headers | Record<string, string | undefined>,
): { allowed: boolean; reason?: string } {
  const getHeader = (name: string): string => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) || '';
    }
    const record = headers as Record<string, string | undefined>;
    const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
    return key ? record[key] || '' : '';
  };

  const xRobots = getHeader('x-robots-tag').toLowerCase();
  if (xRobots && /\b(noai|noimageai|nosnippet|noindex)\b/.test(xRobots)) {
    return { allowed: false, reason: `Blocked by X-Robots-Tag: ${xRobots}` };
  }
  const tdm = getHeader('tdm-reservation').trim();
  if (tdm === '1' || tdm.toLowerCase() === 'true') {
    return { allowed: false, reason: 'Blocked by TDM-Reservation header' };
  }
  return { allowed: true };
}

export function checkHtmlRobotsAndTdmMeta(html: string): { allowed: boolean; reason?: string } {
  const head = html.slice(0, 32_000);
  const metaTags = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metaTags) {
    const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
    const contentMatch = tag.match(/\bcontent=["']([^"']+)["']/i);
    const name = (nameMatch?.[1] || '').trim().toLowerCase();
    const content = (contentMatch?.[1] || '').trim().toLowerCase();
    if (!name || !content) continue;
    if ((name === 'robots' || name === 'googlebot') && /\b(noai|noimageai|nosnippet)\b/.test(content)) {
      return { allowed: false, reason: `Blocked by meta ${name}: ${content}` };
    }
    if (name === 'tdm-reservation' && (content === '1' || content === 'true')) {
      return { allowed: false, reason: 'Blocked by meta tdm-reservation=1' };
    }
  }
  return { allowed: true };
}
