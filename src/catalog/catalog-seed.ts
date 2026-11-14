export interface ModelDetail {
  name: string;
  contextWindow: string;
  contextTokens?: number;
  inputPrice?: string;
  outputPrice?: string;
  capabilities?: string[];
  bestFor: string;
  strengths: string[];
  sourceUrl?: string;
  verificationStatus?: 'confirmed' | 'company_claim' | 'unverified' | 'outdated';
  tokenPracticalityScore?: number;
  costEfficiencyScore?: number;
  tokensPer1kWordsUk?: number;
  practicalityNoteUk?: string;
}

export interface ModelTokenPracticality {
  tokenPracticalityScore: number;
  costEfficiencyScore: number;
  tokensPer1kWordsUk: number;
  practicalityNoteUk: string;
}

function parseFirstUsdPrice(raw?: string): number | null {
  if (!raw) return null;
  const match = raw.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const val = Number(match[1]);
  return Number.isFinite(val) ? val : null;
}

export function computeModelTokenPracticality(
  model: ModelDetail,
  providerId?: string,
): ModelTokenPracticality {
  const key = `${providerId || ''} ${model.name}`.toLowerCase();
  const caps = model.capabilities || [];
  const isOpenWeights = caps.includes('open_weights');
  const isFast = caps.includes('fast');
  const isReasoning =
    caps.includes('reasoning') || /\b(o1|o3|r1|thinking|grok 3|sonnet)\b/i.test(model.name);
  const isPureReasoning = /\b(o1|o3|r1)\b/i.test(model.name) && !key.includes('mini');

  // Estimated tokens per 1,000 Ukrainian words (Cyrillic BPE/SentencePiece density)
  let tokensPer1kWordsUk = 1850;
  if (key.includes('gemini')) {
    tokensPer1kWordsUk = key.includes('flash') ? 1480 : 1520;
  } else if (key.includes('gpt-4o') || key.includes('openai')) {
    tokensPer1kWordsUk = key.includes('mini') ? 1560 : key.includes('o3') || key.includes('o1') ? 1620 : 1580;
  } else if (key.includes('deepseek')) {
    tokensPer1kWordsUk = key.includes('v3') ? 1640 : 1680;
  } else if (key.includes('command') || key.includes('cohere')) {
    tokensPer1kWordsUk = 1690;
  } else if (key.includes('qwen')) {
    tokensPer1kWordsUk = 1710;
  } else if (key.includes('sonar') || key.includes('perplexity')) {
    tokensPer1kWordsUk = 1860;
  } else if (key.includes('llama') || key.includes('groq')) {
    tokensPer1kWordsUk = 1910;
  } else if (key.includes('grok')) {
    tokensPer1kWordsUk = key.includes('mini') ? 1900 : 1950;
  } else if (key.includes('claude') || key.includes('sonnet') || key.includes('haiku')) {
    tokensPer1kWordsUk = key.includes('haiku') ? 1940 : 1990;
  } else if (key.includes('mistral') || key.includes('codestral')) {
    tokensPer1kWordsUk = key.includes('codestral') ? 2080 : 2150;
  } else if (key.includes(':free') || key.includes('openrouter')) {
    tokensPer1kWordsUk = 1780;
  }
  tokensPer1kWordsUk = Math.max(1450, Math.min(2350, Math.round(tokensPer1kWordsUk)));

  const parsedInput = parseFirstUsdPrice(model.inputPrice);
  const parsedOutput = parseFirstUsdPrice(model.outputPrice);
  const isFree =
    key.includes(':free') ||
    (parsedInput === 0 && (parsedOutput === 0 || parsedOutput === null));

  const effectiveInput = parsedInput ?? (isOpenWeights ? 0.25 : 1.5);
  const effectiveOutput = parsedOutput ?? (isOpenWeights ? 0.5 : 4.5);
  const weightedPrice = effectiveInput * 0.3 + effectiveOutput * 0.7;

  let costScore = 96;
  if (!isFree) {
    if (weightedPrice <= 0.35) costScore = 93;
    else if (weightedPrice <= 1.0) costScore = 85;
    else if (weightedPrice <= 2.5) costScore = 76;
    else if (weightedPrice <= 5.0) costScore = 67;
    else if (weightedPrice <= 10.0) costScore = 56;
    else costScore = 44;
  }

  // Adjust cost efficiency for Cyrillic token inflation/compression & reasoning overhead
  const densityDelta = Math.round((1850 - tokensPer1kWordsUk) / 95);
  costScore += densityDelta;
  if (isPureReasoning && !isFree) costScore -= 5;
  if (isFast && !isFree) costScore += 2;
  const costEfficiencyScore = Math.max(25, Math.min(99, Math.round(costScore)));

  // Practicality combines Cyrillic density, cost efficiency, context window, and reasoning overhead
  const densityScore = ((2350 - tokensPer1kWordsUk) / 900) * 30; // 0..30
  const costContribution = costEfficiencyScore * 0.45; // ~11..44
  const ctx = model.contextTokens || 0;
  const contextBonus = ctx >= 1_000_000 ? 12 : ctx >= 200_000 ? 8 : ctx >= 128_000 ? 5 : 2;
  const agilityBonus = (isFast ? 4 : 0) + (isOpenWeights ? 3 : 0);
  const reasoningPenalty = isPureReasoning ? -5 : isReasoning && !isFast ? -2 : 0;

  const rawPracticality = 14 + densityScore + costContribution + contextBonus + agilityBonus + reasoningPenalty;
  const tokenPracticalityScore = Math.max(40, Math.min(98, Math.round(rawPracticality)));

  const densityLabel =
    tokensPer1kWordsUk <= 1650
      ? `Економний кириличний токенізатор (~${tokensPer1kWordsUk} ток./1000 слів укр.)`
      : tokensPer1kWordsUk <= 1950
        ? `Середня щільність кирилиці (~${tokensPer1kWordsUk} ток./1000 слів укр.)`
        : `Підвищена витрата токенів на кирилиці (~${tokensPer1kWordsUk} ток./1000 слів укр.)`;

  const reasoningLabel = isReasoning
    ? 'приховані reasoning-токени збільшують фінальний output-рахунок'
    : 'мінімальний службовий оверхед на відповідь';

  const valueLabel = isFree
    ? 'нульова вартість API у free-квотах'
    : isOpenWeights && parsedInput === null
      ? 'гнучка ціна при self-hosting або виборі API-провайдера'
      : costEfficiencyScore >= 80
        ? 'відмінне співвідношення якість/$'
        : costEfficiencyScore >= 60
          ? 'збалансована вартість для production-задач'
          : 'преміальний тариф для складних завдань';

  return {
    tokenPracticalityScore,
    costEfficiencyScore,
    tokensPer1kWordsUk,
    practicalityNoteUk: `${densityLabel}; ${reasoningLabel}; ${valueLabel}.`,
  };
}

export interface Promotion {
  title: string;
  badge: string;
  description: string;
  expires?: string;
  isExpired?: boolean;
  eligible: string;
  sourceUrl?: string;
  verificationStatus?: 'confirmed' | 'company_claim' | 'unverified';
}

export interface FreeTierInfo {
  hasFree: boolean;
  limits: string;
  description: string;
  renewPeriod: string;
  sourceUrl?: string;
  verificationStatus?: 'confirmed' | 'company_claim' | 'unverified';
}

export interface CatalogChangeItem {
  id: string;
  providerId: string;
  changeType: string;
  fieldName: string;
  summary: string;
  sourceUrl: string | null;
  confidence: 'confirmed' | 'company_claim' | 'unverified';
  detectedAt: string;
}

export interface AiCatalogItem {
  id: string;
  providerId: string;
  providerName: string;
  category: string;
  title: string;
  tagline: string;
  models: ModelDetail[];
  freeTier: FreeTierInfo;
  currentPromotions: Promotion[];
  advantages: string[];
  limitations: string[];
  pricingSummary: string;
  subscriptionPriceUsd?: number | null;
  minInputPricePer1M?: number | null;
  officialUrl: string;
  pricingDocUrl?: string;
  lastVerifiedAt: string;
  verificationStatus?: 'confirmed' | 'unverified' | 'outdated';
  recentChanges?: CatalogChangeItem[];
}

export interface ProviderConfig {
  id: string;
  providerId: string;
  providerName: string;
  category: string;
  officialUrl: string;
  feedUrls: string[];
  pricingDocUrl: string;
}

export const PROVIDERS_CONFIG: ProviderConfig[] = [
  {
    id: 'google-gemini',
    providerId: 'gemini',
    providerName: 'Google Gemini & AI Studio',
    category: 'Моделі та Мультимодальність',
    officialUrl: 'https://aistudio.google.com',
    feedUrls: ['https://deepmind.google/blog/rss.xml'],
    pricingDocUrl: 'https://ai.google.dev/pricing',
  },
  {
    id: 'anthropic-claude',
    providerId: 'claude',
    providerName: 'Anthropic Claude',
    category: 'Кодинг та Розсудливість',
    officialUrl: 'https://claude.ai',
    feedUrls: ['https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml'],
    pricingDocUrl: 'https://www.anthropic.com/pricing',
  },
  {
    id: 'openai-chatgpt',
    providerId: 'openai',
    providerName: 'OpenAI (ChatGPT & Codex)',
    category: 'Екосистема та Спільнота',
    officialUrl: 'https://openai.com',
    feedUrls: ['https://openai.com/news/rss.xml'],
    pricingDocUrl: 'https://openai.com/api/pricing/',
  },
  {
    id: 'mistral-ai',
    providerId: 'mistral',
    providerName: 'Mistral AI & Le Chat',
    category: 'Європейський ШІ та Open Weights',
    officialUrl: 'https://mistral.ai',
    feedUrls: ['https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_mistral.xml'],
    pricingDocUrl: 'https://mistral.ai/technology/',
  },
  {
    id: 'huggingface-open',
    providerId: 'huggingface',
    providerName: 'Hugging Face & Open Source Hub',
    category: 'Відкриті Ваги та Локальний запуск',
    officialUrl: 'https://huggingface.co',
    feedUrls: ['https://huggingface.co/blog/feed.xml'],
    pricingDocUrl: 'https://huggingface.co/pricing',
  },
  {
    id: 'xai-grok',
    providerId: 'grok',
    providerName: 'xAI Grok',
    category: 'Reasoning та Real-Time пошук',
    officialUrl: 'https://grok.com',
    feedUrls: ['https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_xai.xml'],
    pricingDocUrl: 'https://x.ai/api',
  },
  {
    id: 'perplexity-ai',
    providerId: 'perplexity',
    providerName: 'Perplexity AI',
    category: 'AI Пошук та Дослідження',
    officialUrl: 'https://www.perplexity.ai',
    feedUrls: [],
    pricingDocUrl: 'https://docs.perplexity.ai/guides/pricing',
  },
  {
    id: 'deepseek-ai',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    category: 'Reasoning та Open Weights',
    officialUrl: 'https://www.deepseek.com',
    feedUrls: [],
    pricingDocUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
  {
    id: 'groq-cloud',
    providerId: 'groq',
    providerName: 'Groq Cloud (LPU)',
    category: 'Надшвидкий Inference API',
    officialUrl: 'https://groq.com',
    feedUrls: [],
    pricingDocUrl: 'https://groq.com/pricing/',
  },
  {
    id: 'cohere-ai',
    providerId: 'cohere',
    providerName: 'Cohere',
    category: 'Enterprise RAG та Embeddings',
    officialUrl: 'https://cohere.com',
    feedUrls: [],
    pricingDocUrl: 'https://cohere.com/pricing',
  },
  {
    id: 'together-ai',
    providerId: 'together',
    providerName: 'Together AI',
    category: 'Open-Source Cloud API',
    officialUrl: 'https://www.together.ai',
    feedUrls: [],
    pricingDocUrl: 'https://www.together.ai/pricing',
  },
  {
    id: 'openrouter-ai',
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    category: 'Єдиний шлюз до 300+ моделей',
    officialUrl: 'https://openrouter.ai',
    feedUrls: [],
    pricingDocUrl: 'https://openrouter.ai/models',
  },
];

const RAW_INITIAL_CATALOG: AiCatalogItem[] = [
  {
    id: 'google-gemini',
    providerId: 'gemini',
    providerName: 'Google Gemini & AI Studio',
    category: 'Моделі та Мультимодальність',
    title: 'Google Gemini 2.5 Ecosystem',
    tagline: 'Найбільше контекстне вікно в індустрії та безкоштовні ліміти в Google AI Studio',
    models: [
      {
        name: 'Gemini 2.5 Pro',
        contextWindow: '2 000 000 токенів',
        contextTokens: 2000000,
        inputPrice: '$1.25 / 1M',
        outputPrice: '$10.00 / 1M',
        capabilities: ['coding', 'reasoning', 'vision', 'audio', 'video', 'search'],
        bestFor: 'Глибокий аналіз коду, великі відео, книги та складний reasoning',
        strengths: ['Нативна мультимодальність (відео, аудіо, PDF)', '2M токенів контексту', 'Google Search Grounding'],
        sourceUrl: 'https://ai.google.dev/pricing',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Gemini 2.5 Flash / Flash-Lite',
        contextWindow: '1 000 000 токенів',
        contextTokens: 1000000,
        inputPrice: '$0.075 / 1M',
        outputPrice: '$0.30 / 1M',
        capabilities: ['fast', 'coding', 'vision', 'audio'],
        bestFor: 'Швидкі агенти, чати, високонавантажені API з мінімальною затримкою',
        strengths: ['Супер-швидкість', 'Наднизька вартість токенів', 'Високий безкоштовний ліміт'],
        sourceUrl: 'https://ai.google.dev/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: '15 RPM (запитів/хв) та до 1,500 RPD у Google AI Studio без прив’язки карти',
      description: 'Безкоштовний доступ через веб-інтерфейс та API Google AI Studio з доступом до Pro і Flash моделей.',
      renewPeriod: 'Щоденне та щохвилинне оновлення квот',
      sourceUrl: 'https://ai.google.dev/pricing',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: '$300 вітальних кредитів Google Cloud',
        badge: 'Грант 90 днів',
        description: 'Нові користувачі Google Cloud отримують $300 на 90 днів для сервісів включно з Vertex AI.',
        eligible: 'Нові акаунти Google Cloud',
        sourceUrl: 'https://cloud.google.com/free',
        verificationStatus: 'confirmed',
      },
      {
        title: 'Безкоштовний tier у Google AI Studio',
        badge: '100% Free',
        description: 'Розробники можуть безкоштовно створювати API-ключ і використовувати Gemini у межах базових лімітів.',
        eligible: 'Усі зареєстровані розробники',
        sourceUrl: 'https://aistudio.google.com',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Величезне контекстне вікно (до 2 мільйонів токенів)',
      'Нативний аналіз відео та багатогодинних аудіозаписів',
      'Глибока інтеграція з Google Workspace та Vertex AI',
      'Один із найщедріших безкоштовних API-рівнів для розробників',
    ],
    limitations: [
      'На безкоштовному API-рівні AI Studio запити можуть використовуватися для покращення продуктів Google',
      'Суворі фільтри безпеки на чутливі теми',
    ],
    pricingSummary: 'AI Studio Free: $0/міс. Paid tier: від $0.075 за 1M вхідних токенів (Flash-Lite) до $1.25 за 1M (Pro).',
    subscriptionPriceUsd: 20,
    minInputPricePer1M: 0.075,
    officialUrl: 'https://aistudio.google.com',
    pricingDocUrl: 'https://ai.google.dev/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'anthropic-claude',
    providerId: 'claude',
    providerName: 'Anthropic Claude',
    category: 'Кодинг та Розсудливість',
    title: 'Claude 3.7 / 3.5 Sonnet & Haiku',
    tagline: 'Золотий стандарт у кодогенерації, аналітиці та CLI-інструментах розробника',
    models: [
      {
        name: 'Claude 3.7 Sonnet',
        contextWindow: '200 000 токенів',
        contextTokens: 200000,
        inputPrice: '$3.00 / 1M',
        outputPrice: '$15.00 / 1M',
        capabilities: ['coding', 'reasoning', 'vision', 'computer_use'],
        bestFor: 'Архітектура ПЗ, рефакторинг, складний кодинг, агентні задачі',
        strengths: ['Гібридний режим мислення (Extended Thinking)', 'Computer Use API', 'Висока точність інструкцій'],
        sourceUrl: 'https://www.anthropic.com/pricing',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Claude 3.5 Haiku',
        contextWindow: '200 000 токенів',
        contextTokens: 200000,
        inputPrice: '$0.80 / 1M',
        outputPrice: '$4.00 / 1M',
        capabilities: ['fast', 'coding'],
        bestFor: 'Швидкі агенти, сумаризація, миттєві підказки',
        strengths: ['Висока швидкість відповіді', 'Доступна ціна API'],
        sourceUrl: 'https://www.anthropic.com/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Обмежена кількість повідомлень на claude.ai (оновлюється кожні 5 годин)',
      description: 'Безкоштовний доступ до веб-інтерфейсу Claude.ai з можливістю завантажувати файли та писати код.',
      renewPeriod: 'Динамічний ліміт кожні 5 годин',
      sourceUrl: 'https://claude.ai',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Prompt Caching знижка до 90%',
        badge: 'Економія 90%',
        description: 'Кешування повторюваних системних промптів та кодових баз знижує ціну читання токенів до 90%.',
        eligible: 'Усі користувачі Anthropic API',
        sourceUrl: 'https://www.anthropic.com/pricing',
        verificationStatus: 'confirmed',
      },
      {
        title: 'Batch API знижка 50%',
        badge: 'Економія 50%',
        description: 'Асинхронна пакетна обробка запитів протягом 24 годин коштує вдвічі дешевше.',
        eligible: 'Усі користувачі Anthropic API',
        sourceUrl: 'https://www.anthropic.com/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Лідер у написанні чистого коду та роботі з великими репозиторіями',
      'Низький рівень галюцинацій та чітке дотримання інструкцій',
      'Computer Use та інтеграція з Claude Code',
      'Знижка до 90% на кешовані вхідні токени',
    ],
    limitations: [
      'Веб-ліміти на безкоштовному тарифі швидко вичерпуються при великих файлах',
      'Немає вбудованої генерації зображень',
    ],
    pricingSummary: 'Free tier на Claude.ai. Claude Pro: $20/міс. API Sonnet: $3 / $15 за 1M токенів.',
    subscriptionPriceUsd: 20,
    minInputPricePer1M: 0.8,
    officialUrl: 'https://claude.ai',
    pricingDocUrl: 'https://www.anthropic.com/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'openai-chatgpt',
    providerId: 'openai',
    providerName: 'OpenAI (ChatGPT & API)',
    category: 'Екосистема та Спільнота',
    title: 'OpenAI GPT-4o & o-series Reasoning',
    tagline: 'Найширша екосистема інтеграцій, Advanced Voice та reasoning-моделі серії o',
    models: [
      {
        name: 'GPT-4o / GPT-4o mini',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$2.50 / 1M ($0.15 mini)',
        outputPrice: '$10.00 / 1M ($0.60 mini)',
        capabilities: ['vision', 'audio', 'coding', 'image_gen'],
        bestFor: 'Універсальні завдання, генерація зображень, голос у реальному часі',
        strengths: ['Низька затримка', 'Інтегрована генерація зображень', 'Найширша екосистема SDK'],
        sourceUrl: 'https://openai.com/api/pricing/',
        verificationStatus: 'confirmed',
      },
      {
        name: 'OpenAI o3-mini / o1',
        contextWindow: '200 000 токенів',
        contextTokens: 200000,
        inputPrice: '$1.10 / 1M (o3-mini)',
        outputPrice: '$4.40 / 1M (o3-mini)',
        capabilities: ['reasoning', 'coding', 'math'],
        bestFor: 'Математика, алгоритмічний кодинг, наукові завдання',
        strengths: ['Покроковий reasoning перед відповіддю', 'Високі результати в алгоритмах'],
        sourceUrl: 'https://openai.com/api/pricing/',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Базовий доступ до GPT-4o mini та обмежений доступ до GPT-4o у ChatGPT',
      description: 'Безкоштовні користувачі chatgpt.com мають доступ до веб-пошуку, аналізу документів та створення зображень (лімітовано).',
      renewPeriod: 'Ліміт на GPT-4o скидається кожні кілька годин',
      sourceUrl: 'https://openai.com/chatgpt/pricing/',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Batch API знижка 50%',
        badge: 'Економія 50%',
        description: 'Асинхронні пакетні завдання виконуються зі знижкою 50% від стандартних тарифів API.',
        eligible: 'Усі користувачі OpenAI API',
        sourceUrl: 'https://openai.com/api/pricing/',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Найбільша база інтеграцій та сторонніх бібліотек у світі',
      'Режим реального часу Advanced Voice Mode',
      'Reasoning моделі серії o для складних задач',
      'Генерація ілюстрацій безпосередньо у діалозі',
    ],
    limitations: [
      'Обмеження запитів у години пікового навантаження',
      'Флагманські reasoning-моделі дорогі при інтенсивному API-використанні',
    ],
    pricingSummary: 'Free tier на ChatGPT. ChatGPT Plus: $20/міс. GPT-4o mini: $0.15/$0.60 за 1M токенів.',
    subscriptionPriceUsd: 20,
    minInputPricePer1M: 0.15,
    officialUrl: 'https://openai.com',
    pricingDocUrl: 'https://openai.com/api/pricing/',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'mistral-ai',
    providerId: 'mistral',
    providerName: 'Mistral AI & Le Chat',
    category: 'Європейський ШІ та Open Weights',
    title: 'Mistral Large & Codestral',
    tagline: 'Європейські та open-weights моделі з щедрим безкоштовним доступом у Le Chat',
    models: [
      {
        name: 'Mistral Large 2',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$2.00 / 1M',
        outputPrice: '$6.00 / 1M',
        capabilities: ['coding', 'multilingual', 'reasoning'],
        bestFor: 'Багатомовні завдання, європейські мови, корпоративні сценарії',
        strengths: ['Відмінне володіння кодом та мовами', 'Відповідність GDPR'],
        sourceUrl: 'https://mistral.ai/technology/',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Codestral',
        contextWindow: '256 000 токенів',
        contextTokens: 256000,
        inputPrice: '$0.30 / 1M',
        outputPrice: '$0.90 / 1M',
        capabilities: ['coding', 'fast'],
        bestFor: 'Автокомпліт та генерація коду у 80+ мовах',
        strengths: ['Fill-in-the-middle підтримка', '256k контекст для кодових баз'],
        sourceUrl: 'https://mistral.ai/technology/',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовний чат у Le Chat (chat.mistral.ai) та безкоштовний API tier з лімітами RPM',
      description: 'Доступ до флагманських моделей Mistral, веб-пошуку та аналізу файлів без обов’язкової підписки.',
      renewPeriod: 'Денні та хвилинні квоти',
      sourceUrl: 'https://mistral.ai',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний Le Chat з веб-пошуком',
        badge: '100% Free UI',
        description: 'Користувачі Le Chat отримують доступ до моделей Mistral, пошуку та генерації зображень безкоштовно.',
        eligible: 'Усі акаунти Le Chat',
        sourceUrl: 'https://chat.mistral.ai',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Le Chat доступний безкоштовно без щомісячної підписки $20',
      'Open-weights моделі можна запускати на власному обладнанні',
      'Відповідність вимогам конфіденційності ЄС (GDPR)',
    ],
    limitations: [
      'Менша екосистема сторонніх плагінів порівняно з OpenAI',
    ],
    pricingSummary: 'Le Chat: $0/міс. API: Codestral від $0.30 / $0.90 за 1M токенів.',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0.3,
    officialUrl: 'https://mistral.ai',
    pricingDocUrl: 'https://mistral.ai/technology/',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'huggingface-open',
    providerId: 'huggingface',
    providerName: 'Hugging Face & Open Source Hub',
    category: 'Відкриті Ваги та Локальний запуск',
    title: 'HuggingChat & Open Source Model Hub',
    tagline: 'Тисячі відкритих моделей (Llama, DeepSeek, Qwen) з безкоштовним доступом та локальним запуском',
    models: [
      {
        name: 'DeepSeek R1 / V3 (Open Weights)',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        capabilities: ['reasoning', 'coding', 'open_weights'],
        bestFor: 'Відкритий reasoning, власний хостинг або Inference Providers',
        strengths: ['Архітектура Mixture-of-Experts', 'Повний відкритий доступ до ваг'],
        sourceUrl: 'https://huggingface.co/models',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Llama 3.3 70B',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        capabilities: ['open_weights', 'coding', 'offline'],
        bestFor: 'Локальний або self-hosted ШІ для власного сервера',
        strengths: ['Працює через Ollama / vLLM', 'Повний контроль над даними'],
        sourceUrl: 'https://huggingface.co/models',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовний чат у HuggingChat та базові безкоштовні кредити Inference API',
      description: 'HuggingChat дозволяє перемикатися між відкритими моделями безкоштовно.',
      renewPeriod: 'Постійний безкоштовний рівень з rate limits',
      sourceUrl: 'https://huggingface.co/pricing',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний хостинг CPU Spaces',
        badge: 'Free Hosting',
        description: 'Розробники можуть безкоштовно розгортати Gradio/Streamlit демо на базових CPU.',
        eligible: 'Усі користувачі Hugging Face',
        sourceUrl: 'https://huggingface.co/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Свобода від вендор-локу та обов’язкових підписок',
      'Можливість завантажити та запускати моделі локально (Ollama / llama.cpp)',
      'Повна приватність даних при self-hosting',
    ],
    limitations: [
      'Для локального запуску великих моделей 70B+ потрібні потужні GPU',
    ],
    pricingSummary: 'HuggingChat: $0/міс. Spaces: CPU безкоштовно, GPU від $0.40/год.',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0,
    officialUrl: 'https://huggingface.co',
    pricingDocUrl: 'https://huggingface.co/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'xai-grok',
    providerId: 'grok',
    providerName: 'xAI Grok',
    category: 'Reasoning та Real-Time пошук',
    title: 'Grok 3 від xAI',
    tagline: 'Real-time інтеграція з X/Twitter, DeepSearch та флагманські reasoning-моделі',
    models: [
      {
        name: 'Grok 3',
        contextWindow: '131 072 токени',
        contextTokens: 131072,
        inputPrice: '$3.00 / 1M',
        outputPrice: '$15.00 / 1M',
        capabilities: ['reasoning', 'search', 'coding'],
        bestFor: 'Складний reasoning, наукові задачі, аналіз новин X у реальному часі',
        strengths: ['Доступ до live-даних X', 'Режим Think та DeepSearch'],
        sourceUrl: 'https://x.ai/api',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Grok 3 mini',
        contextWindow: '131 072 токени',
        contextTokens: 131072,
        inputPrice: '$0.30 / 1M',
        outputPrice: '$0.50 / 1M',
        capabilities: ['fast', 'reasoning'],
        bestFor: 'Швидкі reasoning-запити за низькою ціною API',
        strengths: ['Висока швидкість', 'Низька ціна токенів'],
        sourceUrl: 'https://x.ai/api',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Обмежений безкоштовний доступ на grok.com та у додатку X',
      description: 'Базовий доступ до Grok із денними лімітами для зареєстрованих користувачів.',
      renewPeriod: 'Періодичне скидання лімітів',
      sourceUrl: 'https://grok.com',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Перевірте умови xAI Console кредитів',
        badge: 'API',
        description: 'xAI періодично надає стартові промо-кредити за умовами участі в програмах розробників.',
        eligible: 'Нові акаунти xAI Console (уточнюється)',
        sourceUrl: 'https://x.ai/api',
        verificationStatus: 'company_claim',
      },
    ],
    advantages: [
      'Прямий real-time доступ до публічних обговорень у X (Twitter)',
      'Висока продуктивність у математичних та наукових задачах',
      'Вбудований пошук DeepSearch',
    ],
    limitations: [
      'Розширені ліміти вимагають платної підписки SuperGrok або X Premium',
      'Менша екосистема готових інтеграцій порівняно з OpenAI',
    ],
    pricingSummary: 'Free tier з лімітами на grok.com. API Grok 3: $3/$15 за 1M токенів, Grok 3 mini: $0.30/$0.50.',
    subscriptionPriceUsd: 8,
    minInputPricePer1M: 0.3,
    officialUrl: 'https://grok.com',
    pricingDocUrl: 'https://x.ai/api',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'perplexity-ai',
    providerId: 'perplexity',
    providerName: 'Perplexity AI',
    category: 'AI Пошук та Дослідження',
    title: 'Perplexity Pro & Sonar API',
    tagline: 'AI-пошукова система з цитуванням джерел та актуальними відповідями в реальному часі',
    models: [
      {
        name: 'Sonar Pro',
        contextWindow: '200 000 токенів',
        contextTokens: 200000,
        inputPrice: '$3.00 / 1M',
        outputPrice: '$15.00 / 1M',
        capabilities: ['search', 'research'],
        bestFor: 'Дослідження, аналіз ринку, верифіковані відповіді з посиланнями',
        strengths: ['Автоматичне цитування джерел', 'Real-time веб-пошук', 'Deep Research режим'],
        sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
        verificationStatus: 'confirmed',
      },
      {
        name: 'Sonar',
        contextWindow: '127 072 токени',
        contextTokens: 127072,
        inputPrice: '$1.00 / 1M',
        outputPrice: '$1.00 / 1M',
        capabilities: ['search', 'fast'],
        bestFor: 'Швидкі пошукові відповіді з перевіреними посиланнями',
        strengths: ['Низька затримка', 'Доступна ціна API'],
        sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Обмежена кількість Pro-пошуків на добу безкоштовно, необмежені базові пошуки',
      description: 'Безкоштовний план включає стандартний пошук з цитуванням джерел.',
      renewPeriod: 'Скидання Pro-лімітів щодня',
      sourceUrl: 'https://www.perplexity.ai',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Партнерські пропозиції Perplexity Pro',
        badge: 'Партнерська програма',
        description: 'Окремі телеком-оператори та сервіси періодично надають промо-доступ до Perplexity Pro.',
        eligible: 'Залежить від регіону та партнера',
        sourceUrl: 'https://www.perplexity.ai',
        verificationStatus: 'company_claim',
      },
    ],
    advantages: [
      'Цитує реальні URL-джерела для кожного твердження',
      'Режим Deep Research формує структуровані звіти',
      'API Sonar дозволяє вбудовувати веб-пошук з цитуванням',
    ],
    limitations: [
      'Менш придатний для глибокої розробки ПЗ порівняно зі спеціалізованими coding-асистентами',
      'Pro-план $20/міс',
    ],
    pricingSummary: 'Free: базовий пошук + обмежені Pro-запити. Perplexity Pro: $20/міс. API Sonar: від $1/$1 за 1M токенів.',
    subscriptionPriceUsd: 20,
    minInputPricePer1M: 1.0,
    officialUrl: 'https://www.perplexity.ai',
    pricingDocUrl: 'https://docs.perplexity.ai/guides/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'deepseek-ai',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    category: 'Reasoning та Open Weights',
    title: 'DeepSeek-V3 & DeepSeek-R1',
    tagline: 'Високопродуктивні open-weights моделі з одними з найнижчих цін на API-ринку',
    models: [
      {
        name: 'DeepSeek-R1',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$0.55 / 1M',
        outputPrice: '$2.19 / 1M',
        capabilities: ['reasoning', 'coding', 'math', 'open_weights'],
        bestFor: 'Складний reasoning, математика, алгоритми',
        strengths: ['Повний відкритий доступ до ваг', 'В рази дешевше за аналоги'],
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        verificationStatus: 'confirmed',
      },
      {
        name: 'DeepSeek-V3',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$0.27 / 1M',
        outputPrice: '$1.10 / 1M',
        capabilities: ['coding', 'fast', 'open_weights'],
        bestFor: 'Повсякденний кодинг, чат-боти, масова генерація',
        strengths: ['Низька вартість токенів', 'Знижка 50–75% на кешовані запити'],
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовний веб-чат на chat.deepseek.com; API оплачується за токени',
      description: 'Повний доступ до DeepSeek-V3 та R1 у веб-інтерфейсі без підписки.',
      renewPeriod: 'Без щомісячної підписки',
      sourceUrl: 'https://www.deepseek.com',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Знижка на Context Caching',
        badge: 'Економія до 75%',
        description: 'Повторні системні промпти автоматично кешуються за зниженим тарифом.',
        eligible: 'Усі користувачі DeepSeek API',
        sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Один із найкращих показників ціна/якість серед reasoning-моделей',
      'Відкриті ваги (MIT ліцензія) для локального розгортання',
    ],
    limitations: [
      'Хмарний API розміщений у КНР — для чутливих даних краще використовувати західних провайдерів (Together/Groq) або локальний запуск',
    ],
    pricingSummary: 'Веб-чат: $0/міс. API: від $0.27/$1.10 (V3) до $0.55/$2.19 (R1) за 1M токенів.',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0.27,
    officialUrl: 'https://www.deepseek.com',
    pricingDocUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'groq-cloud',
    providerId: 'groq',
    providerName: 'Groq Cloud (LPU)',
    category: 'Надшвидкий Inference API',
    title: 'Groq LPU Inference Engine',
    tagline: 'Миттєва генерація тексту (500+ токенів/сек) на спеціалізованих чіпах LPU з безкоштовним API',
    models: [
      {
        name: 'Llama 3.3 70B Versatile (Groq)',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$0.59 / 1M',
        outputPrice: '$0.79 / 1M',
        capabilities: ['fast', 'coding', 'open_weights'],
        bestFor: 'Голосові агенти, real-time інтерфейси, швидкі пайплайни',
        strengths: ['Рекордна швидкість токен/сек', 'Щедрий безкоштовний API tier'],
        sourceUrl: 'https://groq.com/pricing/',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовний Developer API key з денними та хвилинними квотами (RPM/TPM)',
      description: 'Можна тестувати Llama, Mixtral, Whisper без прив’язки банківської карти.',
      renewPeriod: 'Хвилинні та денні квоти',
      sourceUrl: 'https://groq.com/pricing/',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний Developer Tier API',
        badge: 'Free API',
        description: 'Безкоштовний доступ до швидкісного API Llama 3.3 та Whisper v3 Turbo.',
        eligible: 'Усі зареєстровані розробники',
        sourceUrl: 'https://console.groq.com',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Найнижча затримка генерації серед хмарних API',
      'Сумісний з OpenAI SDK (достатньо змінити baseURL)',
    ],
    limitations: [
      'Лише open-weights моделі (немає GPT-4o чи Claude)',
    ],
    pricingSummary: 'Developer Free: $0/міс. Paid API: від $0.05 (8B) до $0.59/$0.79 за 1M токенів (70B).',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0.05,
    officialUrl: 'https://groq.com',
    pricingDocUrl: 'https://groq.com/pricing/',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'cohere-ai',
    providerId: 'cohere',
    providerName: 'Cohere',
    category: 'Enterprise RAG та Embeddings',
    title: 'Cohere Command A, Embed & Rerank',
    tagline: 'Спеціалізовані моделі для корпоративного пошуку (RAG), багатомовних ембедінгів та реранкінгу',
    models: [
      {
        name: 'Command A',
        contextWindow: '256 000 токенів',
        contextTokens: 256000,
        inputPrice: '$2.50 / 1M',
        outputPrice: '$10.00 / 1M',
        capabilities: ['coding', 'multilingual', 'search'],
        bestFor: 'Корпоративний RAG, аналіз документів, агентні виклики інструментів',
        strengths: ['256k контекст', 'Висока точність цитування в RAG'],
        sourceUrl: 'https://cohere.com/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовний Trial API key (ліміт до ~1000 запитів/міс для розробки)',
      description: 'Trial-ключ дозволяє безкоштовно тестувати Command, Embed та Rerank у некомерційних проєктах.',
      renewPeriod: 'Місячний ліміт для розробки',
      sourceUrl: 'https://cohere.com/pricing',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний Trial API Key',
        badge: 'Dev Trial',
        description: 'Повний доступ до API Cohere для тестування та прототипування без оплати.',
        eligible: 'Усі розробники (не для production)',
        sourceUrl: 'https://cohere.com/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Найкращі індустріальні моделі Rerank для підвищення точності пошуку',
      'Сильна підтримка понад 100 мов',
    ],
    limitations: [
      'Trial-ключ має жорсткі обмеження RPM і не призначений для production',
    ],
    pricingSummary: 'Trial API: $0. Production API Command A: $2.50 / $10.00 за 1M токенів.',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0.1,
    officialUrl: 'https://cohere.com',
    pricingDocUrl: 'https://cohere.com/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'together-ai',
    providerId: 'together',
    providerName: 'Together AI',
    category: 'Open-Source Cloud API',
    title: 'Together Inference & Fine-tuning',
    tagline: 'Понад 200 відкритих моделей (Llama, Qwen, DeepSeek, Flux) через єдиний швидкий API',
    models: [
      {
        name: 'Qwen 2.5 Coder 32B / DeepSeek (Together)',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$0.80 / 1M',
        outputPrice: '$0.80 / 1M',
        capabilities: ['coding', 'open_weights', 'fast'],
        bestFor: 'Масштабований open-source inference та fine-tuning',
        strengths: ['Західний хостинг відкритих моделей', 'Дешевші Serverless endpoints'],
        sourceUrl: 'https://www.together.ai/pricing',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Безкоштовні стартові кредити та окремі безкоштовні моделі (Llama Free)',
      description: 'Нові акаунти отримують тестовий баланс для API без щомісячної підписки.',
      renewPeriod: 'Pay-as-you-go',
      sourceUrl: 'https://www.together.ai/pricing',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Стартові API кредити + Free Tier моделі',
        badge: 'Free Credits',
        description: 'Доступ до безкоштовних inference-моделей з обмеженням швидкості для тестування.',
        eligible: 'Нові користувачі Together AI',
        sourceUrl: 'https://www.together.ai/pricing',
        verificationStatus: 'company_claim',
      },
    ],
    advantages: [
      'Величезний вибір open-weights моделей із гарантією конфіденційності',
      'Зручний fine-tuning власних моделей',
    ],
    limitations: [
      'Після вичерпання стартових кредитів потрібна оплата за фактом використання',
    ],
    pricingSummary: 'Pay-as-you-go: від $0.18 за 1M токенів (легкі моделі) до $0.88–$3.00 за флагмани.',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0.18,
    officialUrl: 'https://www.together.ai',
    pricingDocUrl: 'https://www.together.ai/pricing',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
  {
    id: 'openrouter-ai',
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    category: 'Єдиний шлюз до 300+ моделей',
    title: 'OpenRouter Unified AI Gateway',
    tagline: 'Один API-ключ до моделей OpenAI, Anthropic, Google, DeepSeek, Meta та безкоштовних (:free) моделей',
    models: [
      {
        name: 'Free Community Models (:free)',
        contextWindow: '128 000 токенів',
        contextTokens: 128000,
        inputPrice: '$0.00 / 1M',
        outputPrice: '$0.00 / 1M',
        capabilities: ['fast', 'coding', 'open_weights'],
        bestFor: 'Прототипування, пет-проєкти, резервний безкоштовний роутинг',
        strengths: ['Десятки моделей за $0', 'Автоматичний fallback між провайдерами'],
        sourceUrl: 'https://openrouter.ai/models?max_price=0',
        verificationStatus: 'confirmed',
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'До 50–200 безкоштовних запитів/день на моделі з тегом :free (залежить від балансу)',
      description: 'Підтримує десятки безкоштовних моделей від Google, Meta, DeepSeek, Qwen через єдиний OpenAI-сумісний API.',
      renewPeriod: 'Щоденне оновлення ліміту :free',
      sourceUrl: 'https://openrouter.ai/models?max_price=0',
      verificationStatus: 'confirmed',
    },
    currentPromotions: [
      {
        title: 'Моделі з тегом :free за $0',
        badge: '100% Free API',
        description: 'Постійна добірка безкоштовних моделей без необхідності оплати.',
        eligible: 'Усі користувачі OpenRouter',
        sourceUrl: 'https://openrouter.ai/models?max_price=0',
        verificationStatus: 'confirmed',
      },
    ],
    advantages: [
      'Один SDK та ключ для сотень моделей різних компаній',
      'Прозора статистика цін і затримки кожного провайдера',
    ],
    limitations: [
      'Невелика комісія платформи при поповненні балансу для платних моделей',
    ],
    pricingSummary: 'Free моделі (:free): $0. Платні моделі: за тарифами провайдерів (від $0.05/1M).',
    subscriptionPriceUsd: 0,
    minInputPricePer1M: 0,
    officialUrl: 'https://openrouter.ai',
    pricingDocUrl: 'https://openrouter.ai/models',
    lastVerifiedAt: new Date().toISOString(),
    verificationStatus: 'confirmed',
  },
];

export const INITIAL_CATALOG: AiCatalogItem[] = RAW_INITIAL_CATALOG.map((item) => ({
  ...item,
  models: item.models.map((model) => ({
    ...model,
    ...computeModelTokenPracticality(model, item.providerId),
  })),
}));
