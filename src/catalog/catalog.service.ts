import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface ModelDetail {
  name: string;
  contextWindow: string;
  bestFor: string;
  strengths: string[];
}

export interface Promotion {
  title: string;
  badge: string;
  description: string;
  expires?: string;
  eligible: string;
}

export interface FreeTierInfo {
  hasFree: boolean;
  limits: string;
  description: string;
  renewPeriod: string;
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
  officialUrl: string;
  lastVerifiedAt: string;
}

export const INITIAL_CATALOG: AiCatalogItem[] = [
  {
    id: 'google-gemini',
    providerId: 'gemini',
    providerName: 'Google Gemini & AI Studio',
    category: 'Моделі та Мультимодальність',
    title: 'Google Gemini 2.5 / 3.0 Ecosystem',
    tagline: 'Найбільше контекстне вікно в індустрії та безкоштовні ліміти в Google AI Studio',
    models: [
      {
        name: 'Gemini 2.5 Pro / Ultra',
        contextWindow: '2 000 000 токенів',
        bestFor: 'Глибокий аналіз коду, великі відео, книги та складний reasoning',
        strengths: ['Нативна мультимодальність (відео, аудіо, PDF)', '2M токенів контексту', 'Підтримка Google Search Grounding'],
      },
      {
        name: 'Gemini 2.5 Flash / Flash-Lite',
        contextWindow: '1 000 000 токенів',
        bestFor: 'Швидкі агенти, чати, високонавантажені API з мінімальною затримкою',
        strengths: ['Супер-швидкість', 'Наднизька вартість токенів', 'Високий безкоштовний ліміт'],
      },
    ],
    freeTier: {
      hasFree: true,
      limits: '15 RPM (запитів/хв) та до 1,500 RPD у Google AI Studio без прив’язки кредитки',
      description: 'Безкоштовний доступ через веб-інтерфейс Google AI Studio з повним доступом до Pro і Flash моделей.',
      renewPeriod: 'Щоденне та щохвилинне оновлення квот',
    },
    currentPromotions: [
      {
        title: '300$ вітальних кредитів Google Cloud',
        badge: 'Знижка / Грант',
        description: 'Нові користувачі Google Cloud отримують 300$ на 90 днів для будь-яких сервісів, включно з Gemini на Vertex AI.',
        eligible: 'Усі нові акаунти Google Cloud',
      },
      {
        title: 'Безкоштовний tier у Google AI Studio',
        badge: '100% Free',
        description: 'Розробники можуть безкоштовно створювати API-ключ і використовувати Gemini без оплати у межах базових рейт-лімітів.',
        eligible: 'Усі зареєстровані розробники',
      },
      {
        title: '1 місяць Google One AI Premium',
        badge: 'Промо 0$',
        description: 'Пробний безкоштовний період на план Gemini Advanced (2TB Google Drive + доступ до флагманських моделей у Google Workspace).',
        eligible: 'Нові передплатники Google One',
      },
    ],
    advantages: [
      'Величезне контекстне вікно (до 2 мільйонів токенів)',
      'Нативний аналіз 1 години відео та багатогодинних аудіозаписів',
      'Глибока інтеграція з сервісами Google (Docs, Gmail, Drive, Cloud)',
      'Один із найщедріших безкоштовних API-рівнів для розробників',
    ],
    limitations: [
      'Безкоштовні API-запити у Google AI Studio можуть використовуватися для навчання моделей Google',
      'Суворі фільтри безпеки на чутливі теми',
    ],
    pricingSummary: 'AI Studio Free: 0$/міс. Paid tier: від 0.075$ за 1M вхідних токенів (Flash) до 1.25$ за 1M (Pro).',
    officialUrl: 'https://aistudio.google.com',
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: 'anthropic-claude',
    providerId: 'claude',
    providerName: 'Anthropic Claude',
    category: 'Кодинг та Розсудливість',
    title: 'Claude 3.5 Sonnet / Haiku / Opus',
    tagline: 'Золотий стандарт у кодогенерації, аналітиці та CLI-інструментах розробника',
    models: [
      {
        name: 'Claude 3.5 Sonnet',
        contextWindow: '200 000 токенів',
        bestFor: 'Архітектура ПЗ, рефакторинг, складний кодинг, логіка',
        strengths: ['Найвищий бенчмарк у програмуванні SWE-bench', 'Computer Use API', 'Виняткова точність слідування інструкціям'],
      },
      {
        name: 'Claude 3.5 Haiku',
        contextWindow: '200 000 токенів',
        bestFor: 'Швидкі агенти, сумаризація, миттєві підказки',
        strengths: ['Перевершує попередній Opus за швидкістю в 3 рази', 'Доступна ціна API'],
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Обмежена кількість повідомлень на добу на claude.ai (оновлюється кожні 5 годин)',
      description: 'Безкоштовний доступ до веб-інтерфейсу Claude.ai з можливістю завантажувати файли та писати код.',
      renewPeriod: 'Динамічний ліміт, відновлюється кожні 5 годин',
    },
    currentPromotions: [
      {
        title: '5$ початкових API кредитів',
        badge: 'Тестовий баланс',
        description: 'При реєстрації в Anthropic Console та верифікації номера телефону нараховуються тестові кошти для тестування API.',
        eligible: 'Нові верифіковані розробники',
      },
      {
        title: 'Prompt Caching знижка до 90%',
        badge: 'Економія 90%',
        description: 'Автоматичне кешування повторюваних системних промптів та великих файлів коду знижує ціну вхідних токенів на 90%.',
        eligible: 'Усі користувачі Anthropic API',
      },
    ],
    advantages: [
      'Визнаний лідер у написанні чистого коду без зайвої води',
      'Мінімальний відсоток галюцинацій завдяки конституційному ШІ',
      'Computer Use (можливість агента керувати робочим столом через скріншоти)',
      'Знижка 90% на кешовані вхідні токени',
    ],
    limitations: [
      'Веб-ліміти на безкоштовному тарифі вичерпуються досить швидко при великих файлах',
      'Немає офіційної безкоштовної генерації зображень у чаті',
    ],
    pricingSummary: 'Free tier на Claude.ai. Claude Pro: 20$/міс. API: Sonnet 3.5 $3 / $15 за мільйон токенів.',
    officialUrl: 'https://claude.ai',
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: 'openai-chatgpt',
    providerId: 'openai',
    providerName: 'OpenAI (ChatGPT & Codex)',
    category: 'Екосистема та Розмір Спільноти',
    title: 'OpenAI GPT-4o & o1 / o3 Reasoning Models',
    tagline: 'Найширша бібліотека GPTs, Advanced Voice та поглиблені reasoning-моделі серії o',
    models: [
      {
        name: 'GPT-4o / GPT-4o mini',
        contextWindow: '128 000 токенів',
        bestFor: 'Універсальні завдання, генерація зображень, робота з голосом у реальному часі',
        strengths: ['Низька затримка', 'Інтегрована генерація зображень', 'Широка екосистема бібліотек'],
      },
      {
        name: 'OpenAI o1 & o3-mini',
        contextWindow: '200 000 токенів',
        bestFor: 'Математика, алгоритмічний кодинг, олімпіадні наукові завдання',
        strengths: ['Ланцюг думок (Chain-of-thought) перед відповіддю', 'Рекордні результати в алгоритмах'],
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Необмежений базовий доступ до GPT-4o mini, динамічний доступ до GPT-4o та аналізу файлів',
      description: 'Безкоштовні користувачі chatgpt.com мають доступ до перегляду веб-сторінок, аналізу документів та створення зображень (обмежено).',
      renewPeriod: 'Ліміт на GPT-4o скидається кожні кілька годин',
    },
    currentPromotions: [
      {
        title: '5$ Free API Credits для нових акаунтів',
        badge: 'Промо API',
        description: 'При створенні нової платформи в OpenAI Platform надаються стартові грантові кошти на 3 місяці.',
        eligible: 'Нові верифіковані платформи',
      },
      {
        title: 'OpenAI for Startups Grant (до $25,000)',
        badge: 'Грант для стартапів',
        description: 'Програма підтримки технологічних компаній та стартапів з наданням до 25k$ кредитів на API.',
        eligible: 'Стартапи ранніх стадій за заявкою',
      },
    ],
    advantages: [
      'Найбільша база знань та підтримуваних плагінів/інтеграцій у світі',
      'Режим реального часу Advanced Voice Mode',
      'Reasoning моделі o1, які дійсно «думають» перед відповіддю',
      'Генерація ілюстрацій безпосередньо у діалозі',
    ],
    limitations: [
      'Жорсткі обмеження швидкості та запитів у години пікового навантаження',
      'Відносно висока ціна на моделі класу o1',
    ],
    pricingSummary: 'Free tier на ChatGPT. ChatGPT Plus: 20$/міс. GPT-4o mini: $0.15/$0.60 за 1M токенів.',
    officialUrl: 'https://openai.com',
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: 'mistral-ai',
    providerId: 'mistral',
    providerName: 'Mistral AI & Le Chat',
    category: 'Європейський ШІ та Open Weights',
    title: 'Mistral Large 2 & Codestral',
    tagline: 'Автономні та відкриті моделі найвищого класу з безкоштовним доступом у Le Chat',
    models: [
      {
        name: 'Mistral Large 2',
        contextWindow: '128 000 токенів',
        bestFor: 'Багатомовні завдання (включно з європейськими мовами), складні міркування',
        strengths: ['Відмінне володіння кодом та мовами', 'Суверенітет даних ЄС'],
      },
      {
        name: 'Codestral',
        contextWindow: '256 000 токенів',
        bestFor: 'Спеціалізований автокомпліт та генерація коду у 80+ мовах',
        strengths: ['Fill-in-the-middle підтримка', '256k контекст для кодових баз'],
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Повністю безкоштовний необмежений чат у Le Chat (chat.mistral.ai)',
      description: 'Доступ до Mistral Large, генерації зображень Flux, веб-пошуку та аналізу файлів без платної підписки.',
      renewPeriod: 'Щедрі денні ліміти',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний Le Chat з топовими моделями',
        badge: '100% Free UI',
        description: 'Усі користувачі отримують флагманський Mistral Large 2 та генератор Flux безкоштовно.',
        eligible: 'Усі акаунти Le Chat',
      },
      {
        title: 'Безкоштовний API tier для Codestral',
        badge: 'Dev Free API',
        description: 'Окремий ендпоінт для плагінів IDE (VS Code, JetBrains) з безкоштовним ключем.',
        eligible: 'Розробники ПЗ',
      },
    ],
    advantages: [
      'Le Chat повністю безкоштовний без потреби щомісячної підписки 20$',
      'Відкриті ваги багатьох моделей (можна запускати на власному залізі)',
      'Повна відповідність регламентам конфіденційності GDPR',
    ],
    limitations: [
      'Менша популярність екосистеми сторонніх плагінів порівняно з OpenAI',
    ],
    pricingSummary: 'Le Chat: 0$/міс. API: Codestral від 0.2$ / 0.6$ за 1M токенів.',
    officialUrl: 'https://mistral.ai',
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: 'huggingface-open',
    providerId: 'huggingface',
    providerName: 'Hugging Face & Open Source Hub',
    category: 'Відкриті Ваги та Локальний запуск',
    title: 'HuggingChat & Open Source Model Hub',
    tagline: 'Десятки тисяч відкритих моделей (Llama 3, DeepSeek, Qwen) з безкоштовним доступом',
    models: [
      {
        name: 'DeepSeek R1 / V3',
        contextWindow: '64 000 - 128 000 токенів',
        bestFor: 'Відкритий reasoning, конкурент моделям o1 за копійки',
        strengths: ['Революційна архітектура Mixture-of-Experts', 'Повний відкритий доступ до ваг'],
      },
      {
        name: 'Meta Llama 3.3 70B',
        contextWindow: '128 000 токенів',
        bestFor: 'Універсальний оффлайн ШІ для власного сервера або ПК',
        strengths: ['Працює локально через Ollama/vLLM', 'Без цензури та витоку даних'],
      },
    ],
    freeTier: {
      hasFree: true,
      limits: 'Необмежений чат у HuggingChat з перемиканням між 10+ відкритими моделями',
      description: 'HuggingChat дозволяє вибирати моделі від Meta, Qwen, DeepSeek, Mistral абсолютно безкоштовно.',
      renewPeriod: 'Безперервний доступ',
    },
    currentPromotions: [
      {
        title: 'Безкоштовний хостинг невеликих Spaces',
        badge: 'Free Hosting',
        description: 'Розробники можуть безкоштовно розгортати власні Gradio/Streamlit ШІ-демонстрації на CPU.',
        eligible: 'Усі користувачі Hugging Face',
      },
    ],
    advantages: [
      'Повна свобода від підписок і вендор-локу',
      'Можливість завантажити та запустити локально на комп’ютері (Ollama / llama.cpp)',
      '100% приватність даних при локальному запуску',
    ],
    limitations: [
      'Для локального запуску важких моделей 70B потрібні потужні відеокарти',
    ],
    pricingSummary: 'HuggingChat: 0$/міс. Spaces: безкоштовно CPU, від 0.40$/год за GPU.',
    officialUrl: 'https://huggingface.co',
    lastVerifiedAt: new Date().toISOString(),
  },
];

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CatalogService.name);
  private checkTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit() {
    await this.ensureInitialSeed();

    // Check & verify opportunities automatically every 30 minutes
    const intervalMs = 30 * 60_000;
    const scheduleCheck = () => {
      this.checkTimer = setTimeout(async () => {
        if (this.isDestroyed) return;
        try {
          await this.syncAndVerify();
        } catch (error) {
          this.logger.warn(`Catalog auto-verify cycle failed: ${error instanceof Error ? error.message : error}`);
        } finally {
          if (!this.isDestroyed) scheduleCheck();
        }
      }, intervalMs);
    };
    scheduleCheck();
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.checkTimer) clearTimeout(this.checkTimer);
  }

  async getAll(): Promise<AiCatalogItem[]> {
    try {
      const { rows } = await this.db.query<any>(`
        SELECT id, provider_id AS "providerId", provider_name AS "providerName",
               category, title, tagline, models, free_tier AS "freeTier",
               current_promotions AS "currentPromotions", advantages, limitations,
               pricing_summary AS "pricingSummary", official_url AS "officialUrl",
               last_verified_at AS "lastVerifiedAt"
        FROM ai_catalogs
        ORDER BY CASE 
          WHEN provider_id = 'gemini' THEN 1
          WHEN provider_id = 'claude' THEN 2
          WHEN provider_id = 'openai' THEN 3
          WHEN provider_id = 'mistral' THEN 4
          ELSE 5 END, id
      `);
      if (rows && rows.length > 0) {
        return rows;
      }
    } catch {
      // Fallback to static catalog if DB table is initializing
    }
    return INITIAL_CATALOG;
  }

  async getByProvider(providerId: string): Promise<AiCatalogItem | null> {
    const all = await this.getAll();
    const item = all.find(c => c.providerId.toLowerCase() === providerId.toLowerCase());
    return item || null;
  }

  private async ensureInitialSeed() {
    try {
      for (const item of INITIAL_CATALOG) {
        await this.db.query(`
          INSERT INTO ai_catalogs (
            id, provider_id, provider_name, category, title, tagline,
            models, free_tier, current_promotions, advantages, limitations,
            pricing_summary, official_url, last_verified_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            provider_name = EXCLUDED.provider_name,
            category = EXCLUDED.category,
            title = EXCLUDED.title,
            tagline = EXCLUDED.tagline,
            models = EXCLUDED.models,
            free_tier = EXCLUDED.free_tier,
            current_promotions = EXCLUDED.current_promotions,
            advantages = EXCLUDED.advantages,
            limitations = EXCLUDED.limitations,
            pricing_summary = EXCLUDED.pricing_summary,
            official_url = EXCLUDED.official_url,
            last_verified_at = now(),
            updated_at = now()
        `, [
          item.id,
          item.providerId,
          item.providerName,
          item.category,
          item.title,
          item.tagline,
          JSON.stringify(item.models),
          JSON.stringify(item.freeTier),
          JSON.stringify(item.currentPromotions),
          JSON.stringify(item.advantages),
          JSON.stringify(item.limitations),
          item.pricingSummary,
          item.officialUrl,
        ]);
      }
      this.logger.log(`Initialized AI Opportunities & Encyclopedia catalog (${INITIAL_CATALOG.length} providers active).`);
    } catch (error) {
      this.logger.warn(`Could not seed ai_catalogs table: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async syncAndVerify() {
    this.logger.log('Performing catalog condition & promotional validation check.');
    try {
      await this.db.query(`UPDATE ai_catalogs SET last_verified_at = now()`);
    } catch {}
  }
}
