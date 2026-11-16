import type { FeedDefinition } from './company-feeds.service';

/**
 * Extra, live-verified sources (v2.2). Every URL below answered 200 with a parsable RSS/Atom/JSON payload when the catalog
 * was assembled. Dead feeds are not a problem at runtime: they surface in /api/v1/sources health and are auto-disabled
 * by the failure policy in CompanyFeedsService.
 *
 * `adapter` feeds are open-data APIs (not RSS): they are turned into the same FeedArticle shape by api-adapters.ts.
 * Everything here is free, needs no key, and is used the way the publisher documents it (headline + short summary +
 * link back, honest User-Agent, conditional requests and polite polling).
 */
export type ApiAdapterId =
  | 'hf_daily_papers'
  | 'ckan_datagov'
  | 'prozorro_tenders'
  | 'openalex_ai'
  | 'crossref_ai'
  | 'semantic_scholar_ai'
  | 'wikipedia_current_events'
  | 'gdelt_ukraine'
  | 'cisa_kev'
  | 'eurostat_indicators'
  | 'nbu_rates'
  | 'worldbank_ukraine';

type ExtraFeed = FeedDefinition & { adapter?: ApiAdapterId; upgradeHttps?: boolean };

export const EXTRA_FEED_CATALOG: ExtraFeed[] = [
  // --- AI labs & vendors requested by the user ---------------------------------------------------------------
  { slug: 'microsoft-research', name: 'Microsoft Research', domain: 'microsoft.com', allowedDomains: ['microsoft.com'], url: 'https://www.microsoft.com/en-us/research/feed/', category: 'research', providerId: 'microsoft', licenseMode: 'summary' },
  { slug: 'apple-ml-research', name: 'Apple Machine Learning Research', domain: 'machinelearning.apple.com', allowedDomains: ['machinelearning.apple.com'], url: 'https://machinelearning.apple.com/rss.xml', category: 'research', licenseMode: 'summary' },
  { slug: 'meta-ai-community-feed', name: 'Meta AI', domain: 'ai.meta.com', allowedDomains: ['ai.meta.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_meta_ai.xml', category: 'model', providerId: 'llama', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'meta-engineering', name: 'Meta Engineering', domain: 'engineering.fb.com', allowedDomains: ['engineering.fb.com'], url: 'https://engineering.fb.com/feed/', category: 'coding', licenseMode: 'headline_link' },
  { slug: 'stability-ai', name: 'Stability AI', domain: 'stability.ai', allowedDomains: ['stability.ai'], url: 'https://stability.ai/news-updates?format=rss', category: 'model', providerId: 'stability', licenseMode: 'headline_link' },
  { slug: 'cohere-community-feed', name: 'Cohere', domain: 'cohere.com', allowedDomains: ['cohere.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_cohere.xml', category: 'model', providerId: 'cohere', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'xai-community-feed', name: 'xAI', domain: 'x.ai', allowedDomains: ['x.ai'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_xainews.xml', category: 'model', providerId: 'grok', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'perplexity-community-feed', name: 'Perplexity', domain: 'perplexity.ai', allowedDomains: ['perplexity.ai'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_perplexity_hub.xml', category: 'model', providerId: 'perplexity', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'together-ai', name: 'Together AI', domain: 'together.ai', allowedDomains: ['together.ai'], url: 'https://www.together.ai/blog/rss.xml', category: 'api', licenseMode: 'headline_link' },
  { slug: 'langchain-releases', name: 'LangChain Releases', domain: 'github.com', allowedDomains: ['github.com'], url: 'https://github.com/langchain-ai/langchain/releases.atom', category: 'coding', licenseMode: 'full_text_licensed' },

  // --- More AI / ML / dev ecosystem (related) ----------------------------------------------------------------
  { slug: 'mistral-news', name: 'Mistral AI (official)', domain: 'mistral.ai', allowedDomains: ['mistral.ai'], url: 'https://mistral.ai/rss.xml', category: 'model', providerId: 'mistral', licenseMode: 'headline_link' },
  { slug: 'anthropic-research-community-feed', name: 'Anthropic Research', domain: 'anthropic.com', allowedDomains: ['anthropic.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml', category: 'research', providerId: 'claude', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'anthropic-engineering-community-feed', name: 'Anthropic Engineering', domain: 'anthropic.com', allowedDomains: ['anthropic.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml', category: 'coding', providerId: 'claude', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'openai-research-community-feed', name: 'OpenAI Research', domain: 'openai.com', allowedDomains: ['openai.com'], url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_openai_research.xml', category: 'research', providerId: 'openai', unofficial: true, licenseMode: 'headline_link' },
  { slug: 'nvidia-developer-blog', name: 'NVIDIA Developer Blog', domain: 'developer.nvidia.com', allowedDomains: ['developer.nvidia.com', 'nvidia.com'], url: 'https://developer.nvidia.com/blog/feed', category: 'hardware_gaming', licenseMode: 'summary' },
  { slug: 'nvidia-newsroom', name: 'NVIDIA Newsroom', domain: 'blogs.nvidia.com', allowedDomains: ['blogs.nvidia.com', 'nvidianews.nvidia.com'], url: 'https://nvidianews.nvidia.com/releases.xml', category: 'hardware_gaming', licenseMode: 'headline_link' },
  { slug: 'databricks-blog', name: 'Databricks Blog', domain: 'databricks.com', allowedDomains: ['databricks.com'], url: 'https://www.databricks.com/feed', category: 'api', licenseMode: 'headline_link' },
  { slug: 'allen-ai', name: 'Allen Institute for AI', domain: 'allenai.org', allowedDomains: ['allenai.org'], url: 'https://allenai.org/rss.xml', category: 'research', licenseMode: 'headline_link' },
  { slug: 'berkeley-bair', name: 'Berkeley AI Research (BAIR)', domain: 'bair.berkeley.edu', allowedDomains: ['bair.berkeley.edu'], url: 'https://bair.berkeley.edu/blog/feed.xml', category: 'research', licenseMode: 'headline_link', upgradeHttps: true },
  { slug: 'qwen-blog', name: 'Qwen Blog', domain: 'qwenlm.github.io', allowedDomains: ['qwenlm.github.io'], url: 'https://qwenlm.github.io/blog/index.xml', category: 'open_source', licenseMode: 'headline_link' },
  { slug: 'ollama-blog', name: 'Ollama Blog', domain: 'ollama.com', allowedDomains: ['ollama.com'], url: 'https://ollama.com/blog/rss.xml', category: 'open_source', licenseMode: 'headline_link' },
  { slug: 'replicate-blog', name: 'Replicate Blog', domain: 'replicate.com', allowedDomains: ['replicate.com'], url: 'https://replicate.com/blog/rss', category: 'api', licenseMode: 'headline_link' },
  { slug: 'cloudflare-ai-blog', name: 'Cloudflare AI', domain: 'blog.cloudflare.com', allowedDomains: ['blog.cloudflare.com'], url: 'https://blog.cloudflare.com/tag/ai/rss/', category: 'api', licenseMode: 'summary' },
  { slug: 'aws-whats-new', name: "AWS What's New", domain: 'aws.amazon.com', allowedDomains: ['aws.amazon.com'], url: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/', category: 'api', licenseMode: 'headline_link' },
  { slug: 'azure-blog', name: 'Microsoft Azure Blog', domain: 'azure.microsoft.com', allowedDomains: ['azure.microsoft.com', 'techcommunity.microsoft.com'], url: 'https://azure.microsoft.com/en-us/blog/feed/', category: 'api', licenseMode: 'headline_link' },
  { slug: 'vercel-changelog', name: 'Vercel Changelog', domain: 'vercel.com', allowedDomains: ['vercel.com'], url: 'https://vercel.com/atom', category: 'coding', licenseMode: 'headline_link' },
  { slug: 'supabase-blog', name: 'Supabase Blog', domain: 'supabase.com', allowedDomains: ['supabase.com'], url: 'https://supabase.com/rss.xml', category: 'coding', licenseMode: 'headline_link' },
  { slug: 'transformers-releases', name: 'Hugging Face Transformers Releases', domain: 'github.com', allowedDomains: ['github.com'], url: 'https://github.com/huggingface/transformers/releases.atom', category: 'open_source', providerId: 'huggingface', licenseMode: 'full_text_licensed' },
  { slug: 'llamacpp-releases', name: 'llama.cpp Releases', domain: 'github.com', allowedDomains: ['github.com'], url: 'https://github.com/ggml-org/llama.cpp/releases.atom', category: 'open_source', licenseMode: 'full_text_licensed' },
  { slug: 'pytorch-releases', name: 'PyTorch Releases', domain: 'github.com', allowedDomains: ['github.com'], url: 'https://github.com/pytorch/pytorch/releases.atom', category: 'open_source', licenseMode: 'full_text_licensed' },
  { slug: 'openai-node-sdk', name: 'OpenAI Node SDK', domain: 'github.com', allowedDomains: ['github.com'], url: 'https://github.com/openai/openai-node/releases.atom', category: 'api', providerId: 'openai', licenseMode: 'full_text_licensed' },

  // --- Security -----------------------------------------------------------------------------------------------
  { slug: 'google-project-zero', name: 'Google Project Zero', domain: 'projectzero.google', allowedDomains: ['projectzero.google', 'googleprojectzero.blogspot.com'], url: 'https://projectzero.google/feed.xml', category: 'cybersecurity', licenseMode: 'headline_link' },
  { slug: 'cisco-talos', name: 'Cisco Talos', domain: 'blog.talosintelligence.com', allowedDomains: ['blog.talosintelligence.com'], url: 'https://blog.talosintelligence.com/rss/', category: 'cybersecurity', licenseMode: 'headline_link' },
  { slug: 'cisa-kev', name: 'CISA Known Exploited Vulnerabilities', domain: 'cisa.gov', allowedDomains: ['cisa.gov', 'nvd.nist.gov'], url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', category: 'cybersecurity', licenseMode: 'summary', adapter: 'cisa_kev' },

  // --- Research & papers (open APIs) -------------------------------------------------------------------------
  { slug: 'arxiv-cs-ai', name: 'arXiv cs.AI', domain: 'arxiv.org', allowedDomains: ['arxiv.org'], url: 'https://rss.arxiv.org/rss/cs.AI', category: 'research', licenseMode: 'headline_link' },
  { slug: 'arxiv-cs-cl', name: 'arXiv cs.CL', domain: 'arxiv.org', allowedDomains: ['arxiv.org'], url: 'https://rss.arxiv.org/rss/cs.CL', category: 'research', licenseMode: 'headline_link' },
  { slug: 'arxiv-cs-lg', name: 'arXiv cs.LG', domain: 'arxiv.org', allowedDomains: ['arxiv.org'], url: 'https://rss.arxiv.org/rss/cs.LG', category: 'research', licenseMode: 'headline_link' },
  { slug: 'hf-daily-papers', name: 'Hugging Face Daily Papers', domain: 'huggingface.co', allowedDomains: ['huggingface.co', 'arxiv.org'], url: 'https://huggingface.co/api/daily_papers', category: 'research', providerId: 'huggingface', licenseMode: 'summary', adapter: 'hf_daily_papers' },
  { slug: 'openalex-ai', name: 'OpenAlex: нові AI-роботи', domain: 'openalex.org', allowedDomains: ['openalex.org', 'doi.org'], url: 'https://api.openalex.org/works', category: 'research', licenseMode: 'headline_link', adapter: 'openalex_ai' },
  { slug: 'crossref-ai', name: 'Crossref: AI у журналах', domain: 'doi.org', allowedDomains: ['doi.org'], url: 'https://api.crossref.org/works', category: 'research', licenseMode: 'headline_link', adapter: 'crossref_ai' },
  { slug: 'semantic-scholar-ai', name: 'Semantic Scholar: LLM-статті', domain: 'semanticscholar.org', allowedDomains: ['semanticscholar.org', 'arxiv.org'], url: 'https://api.semanticscholar.org/graph/v1/paper/search/bulk', category: 'research', licenseMode: 'headline_link', adapter: 'semantic_scholar_ai' },

  // --- World events -------------------------------------------------------------------------------------------
  { slug: 'wikipedia-current-events', name: 'Wikipedia: Current events', domain: 'en.wikipedia.org', allowedDomains: ['en.wikipedia.org'], url: 'https://en.wikipedia.org/w/api.php', category: 'politics', licenseMode: 'headline_link', adapter: 'wikipedia_current_events' },
  { slug: 'gdelt-ukraine', name: 'GDELT: Україна в світових медіа', domain: 'api.gdeltproject.org', allowedDomains: ['*'], url: 'https://api.gdeltproject.org/api/v2/doc/doc', category: 'politics', licenseMode: 'headline_link', adapter: 'gdelt_ukraine' },
  { slug: 'un-news', name: 'UN News', domain: 'news.un.org', allowedDomains: ['news.un.org'], url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'reliefweb', name: 'ReliefWeb', domain: 'reliefweb.int', allowedDomains: ['reliefweb.int'], url: 'https://reliefweb.int/updates/rss.xml', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'who-news', name: 'WHO News', domain: 'who.int', allowedDomains: ['who.int'], url: 'https://www.who.int/rss-feeds/news-english.xml', category: 'health', licenseMode: 'headline_link' },

  // --- European Union -----------------------------------------------------------------------------------------
  { slug: 'eur-lex-legislation', name: 'EUR-Lex: ухвалене законодавство ЄС', domain: 'eur-lex.europa.eu', allowedDomains: ['eur-lex.europa.eu'], url: 'https://eur-lex.europa.eu/EN/display-feed.rss?rssId=162', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'ec-press-corner', name: 'European Commission Press Corner', domain: 'ec.europa.eu', allowedDomains: ['ec.europa.eu'], url: 'https://ec.europa.eu/commission/presscorner/api/rss?language=en', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'ec-digital-strategy', name: 'EU Digital Strategy', domain: 'digital-strategy.ec.europa.eu', allowedDomains: ['digital-strategy.ec.europa.eu'], url: 'https://digital-strategy.ec.europa.eu/en/rss.xml', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'ecb-press', name: 'European Central Bank', domain: 'ecb.europa.eu', allowedDomains: ['ecb.europa.eu'], url: 'https://www.ecb.europa.eu/rss/press.html', category: 'finance', licenseMode: 'headline_link' },
  { slug: 'eurostat-indicators', name: 'Eurostat: ключові показники', domain: 'ec.europa.eu', allowedDomains: ['ec.europa.eu'], url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data', category: 'economy', licenseMode: 'summary', adapter: 'eurostat_indicators' },

  // --- Ukraine: state & open data -----------------------------------------------------------------------------
  { slug: 'rada-news', name: 'Верховна Рада України', domain: 'rada.gov.ua', allowedDomains: ['rada.gov.ua', 'www.rada.gov.ua'], url: 'https://www.rada.gov.ua/rss', category: 'politics', licenseMode: 'headline_link' },
  { slug: 'data-gov-ua', name: 'data.gov.ua: нові набори даних', domain: 'data.gov.ua', allowedDomains: ['data.gov.ua'], url: 'https://data.gov.ua/api/3/action/package_search', category: 'politics', licenseMode: 'headline_link', adapter: 'ckan_datagov' },
  { slug: 'prozorro-large-tenders', name: 'Prozorro: великі тендери', domain: 'prozorro.gov.ua', allowedDomains: ['prozorro.gov.ua', 'public.api.openprocurement.org'], url: 'https://public-api.prozorro.gov.ua/api/2.5/tenders', category: 'economy', licenseMode: 'headline_link', adapter: 'prozorro_tenders' },
  { slug: 'nbu-rates', name: 'НБУ: офіційні курси валют', domain: 'bank.gov.ua', allowedDomains: ['bank.gov.ua'], url: 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', category: 'finance', licenseMode: 'summary', adapter: 'nbu_rates' },
  { slug: 'worldbank-ukraine', name: 'World Bank: економіка України', domain: 'data.worldbank.org', allowedDomains: ['data.worldbank.org'], url: 'https://api.worldbank.org/v2/country/UKR/indicator/NY.GDP.MKTP.KD.ZG?format=json&per_page=8', category: 'economy', licenseMode: 'summary', adapter: 'worldbank_ukraine' },
  { slug: 'ukrinform', name: 'Укрінформ', domain: 'ukrinform.ua', allowedDomains: ['ukrinform.ua'], url: 'https://www.ukrinform.ua/rss/block-lastnews', category: 'politics', licenseMode: 'headline_link' },
];
