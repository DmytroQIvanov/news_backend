/**
 * "Top AI" taxonomy: groups -> subcategories.
 *
 * - Subcategories with `arena` are ranked automatically from the official LMArena leaderboard dataset
 *   (huggingface.co/datasets/lmarena-ai/leaderboard-dataset, CC-BY-4.0): blind human-preference votes.
 * - The rest start from an editorial `seed` list (order = starting position) and are re-ranked by how often the
 *   tools are mentioned in our own news; new tools found in the news are added automatically.
 *
 * Adding a subcategory or a tool here is enough: the service upserts it on start.
 */

export interface ArenaSource {
  /** Dataset config, e.g. text, text_to_image, image_edit, text_to_video, webdev, vision, search, agent. */
  config: string;
  /** Value of the `category` column inside that config, e.g. overall, coding, photorealistic. */
  category: string;
  /** Only open-weights models (license other than Proprietary). */
  openOnly?: boolean;
}

export interface AiGroup {
  slug: string;
  icon: string;
  nameUk: string;
  nameEn: string;
}

export interface AiSubcategory {
  slug: string;
  group: string;
  nameUk: string;
  nameEn: string;
  descriptionUk: string;
  descriptionEn: string;
  arena?: ArenaSource;
  /** Tool slugs in starting (editorial) order. */
  seed?: string[];
}

export interface SeedTool {
  name: string;
  vendor: string;
  url: string;
  /** Has a free plan / free usage. */
  free: boolean;
  /** Open source / open weights. */
  open?: boolean;
}

export const AI_GROUPS: AiGroup[] = [
  { slug: 'llm', icon: '🧠', nameUk: 'Текстові моделі (LLM)', nameEn: 'Language models (LLM)' },
  { slug: 'assistants', icon: '💬', nameUk: 'Чат-асистенти', nameEn: 'Chat assistants' },
  { slug: 'image', icon: '🖼️', nameUk: 'Зображення', nameEn: 'Images' },
  { slug: 'video', icon: '🎬', nameUk: 'Відео', nameEn: 'Video' },
  { slug: 'audio', icon: '🎧', nameUk: 'Аудіо, голос і музика', nameEn: 'Audio, voice & music' },
  { slug: 'code', icon: '💻', nameUk: 'Код і розробка', nameEn: 'Coding' },
  { slug: 'agents', icon: '🤖', nameUk: 'Агенти та автоматизація', nameEn: 'Agents & automation' },
  { slug: 'search', icon: '🔎', nameUk: 'Пошук і дослідження', nameEn: 'Search & research' },
  { slug: 'vision', icon: '👁️', nameUk: 'Розуміння зображень і документів', nameEn: 'Vision & documents' },
  { slug: 'productivity', icon: '📝', nameUk: 'Продуктивність', nameEn: 'Productivity' },
  { slug: 'design', icon: '🎨', nameUk: 'Дизайн і 3D', nameEn: 'Design & 3D' },
  { slug: 'business', icon: '📈', nameUk: 'Бізнес і маркетинг', nameEn: 'Business & marketing' },
  { slug: 'education', icon: '🎓', nameUk: 'Навчання', nameEn: 'Education' },
  { slug: 'science', icon: '🔬', nameUk: 'Наука', nameEn: 'Science' },
  { slug: 'devinfra', icon: '🛠️', nameUk: 'Інфраструктура для розробників', nameEn: 'Developer infrastructure' },
  { slug: 'safety', icon: '🛡️', nameUk: 'Безпека та детектори', nameEn: 'Safety & detection' },
  { slug: 'fun', icon: '🎭', nameUk: 'Співрозмовники та розваги', nameEn: 'Companions & fun' },
];

const arena = (config: string, category = 'overall', openOnly = false): ArenaSource => ({ config, category, openOnly });

export const AI_SUBCATEGORIES: AiSubcategory[] = [
  // ---------------------------------------------------------------- LLM (LMArena text)
  { slug: 'llm-overall', group: 'llm', nameUk: 'Загальний рейтинг', nameEn: 'Overall', descriptionUk: 'Найкращі мовні моделі за сліпим голосуванням людей', descriptionEn: 'Best language models by blind human votes', arena: arena('text') },
  { slug: 'llm-open', group: 'llm', nameUk: 'Відкриті моделі (open weights)', nameEn: 'Open-weights models', descriptionUk: 'Моделі, які можна завантажити й запускати самому', descriptionEn: 'Models you can download and run yourself', arena: arena('text', 'overall', true) },
  { slug: 'llm-coding', group: 'llm', nameUk: 'Програмування', nameEn: 'Coding', descriptionUk: 'Хто краще пише й пояснює код', descriptionEn: 'Best at writing and explaining code', arena: arena('text', 'coding') },
  { slug: 'llm-math', group: 'llm', nameUk: 'Математика', nameEn: 'Math', descriptionUk: 'Задачі, обчислення, доведення', descriptionEn: 'Problems, calculation, proofs', arena: arena('text', 'math') },
  { slug: 'llm-hard', group: 'llm', nameUk: 'Складні запити', nameEn: 'Hard prompts', descriptionUk: 'Багатокрокові, нестандартні задачі', descriptionEn: 'Multi-step, unusual tasks', arena: arena('text', 'hard_prompts') },
  { slug: 'llm-expert', group: 'llm', nameUk: 'Експертні питання', nameEn: 'Expert questions', descriptionUk: 'Запити рівня фахівця', descriptionEn: 'Specialist-level questions', arena: arena('text', 'expert') },
  { slug: 'llm-creative', group: 'llm', nameUk: 'Творче письмо', nameEn: 'Creative writing', descriptionUk: 'Історії, вірші, сценарії', descriptionEn: 'Stories, poems, scripts', arena: arena('text', 'creative_writing') },
  { slug: 'llm-instructions', group: 'llm', nameUk: 'Виконання інструкцій', nameEn: 'Instruction following', descriptionUk: 'Наскільки точно дотримується вимог', descriptionEn: 'How precisely it follows requirements', arena: arena('text', 'instruction_following') },
  { slug: 'llm-multiturn', group: 'llm', nameUk: 'Довгі діалоги', nameEn: 'Multi-turn chat', descriptionUk: 'Тримає контекст розмови', descriptionEn: 'Keeps conversation context', arena: arena('text', 'multi_turn') },
  { slug: 'llm-long', group: 'llm', nameUk: 'Довгі запити', nameEn: 'Long queries', descriptionUk: 'Великі тексти на вході', descriptionEn: 'Long inputs', arena: arena('text', 'longer_query') },
  { slug: 'llm-factuality', group: 'llm', nameUk: 'Точність фактів', nameEn: 'Factuality', descriptionUk: 'Менше вигадок і помилок', descriptionEn: 'Fewer hallucinations', arena: arena('text_factuality') },
  { slug: 'llm-non-english', group: 'llm', nameUk: 'Не англійською мовою', nameEn: 'Non-English', descriptionUk: 'Найближче до української: якість іншими мовами', descriptionEn: 'Quality in languages other than English', arena: arena('text', 'non_english') },
  { slug: 'llm-lang-polish', group: 'llm', nameUk: 'Польська мова', nameEn: 'Polish', descriptionUk: 'Рейтинг польською', descriptionEn: 'Polish-language ranking', arena: arena('text', 'polish') },
  { slug: 'llm-lang-german', group: 'llm', nameUk: 'Німецька мова', nameEn: 'German', descriptionUk: 'Рейтинг німецькою', descriptionEn: 'German-language ranking', arena: arena('text', 'german') },
  { slug: 'llm-lang-french', group: 'llm', nameUk: 'Французька мова', nameEn: 'French', descriptionUk: 'Рейтинг французькою', descriptionEn: 'French-language ranking', arena: arena('text', 'french') },
  { slug: 'llm-lang-spanish', group: 'llm', nameUk: 'Іспанська мова', nameEn: 'Spanish', descriptionUk: 'Рейтинг іспанською', descriptionEn: 'Spanish-language ranking', arena: arena('text', 'spanish') },
  { slug: 'llm-lang-chinese', group: 'llm', nameUk: 'Китайська мова', nameEn: 'Chinese', descriptionUk: 'Рейтинг китайською', descriptionEn: 'Chinese-language ranking', arena: arena('text', 'chinese') },
  { slug: 'llm-lang-japanese', group: 'llm', nameUk: 'Японська мова', nameEn: 'Japanese', descriptionUk: 'Рейтинг японською', descriptionEn: 'Japanese-language ranking', arena: arena('text', 'japanese') },
  { slug: 'llm-lang-korean', group: 'llm', nameUk: 'Корейська мова', nameEn: 'Korean', descriptionUk: 'Рейтинг корейською', descriptionEn: 'Korean-language ranking', arena: arena('text', 'korean') },
  { slug: 'llm-ind-software', group: 'llm', nameUk: 'Галузь: IT і софт', nameEn: 'Industry: software & IT', descriptionUk: 'Запити з розробки та IT', descriptionEn: 'Software & IT questions', arena: arena('text', 'industry_software_and_it_services') },
  { slug: 'llm-ind-business', group: 'llm', nameUk: 'Галузь: бізнес і фінанси', nameEn: 'Industry: business & finance', descriptionUk: 'Менеджмент, фінанси, операції', descriptionEn: 'Management, finance, operations', arena: arena('text', 'industry_business_and_management_and_financial_operations') },
  { slug: 'llm-ind-medicine', group: 'llm', nameUk: 'Галузь: медицина', nameEn: 'Industry: medicine', descriptionUk: 'Медичні й health-запити (не замінює лікаря)', descriptionEn: 'Medical questions (not a doctor)', arena: arena('text', 'industry_medicine_and_healthcare') },
  { slug: 'llm-ind-legal', group: 'llm', nameUk: 'Галузь: право і держсектор', nameEn: 'Industry: legal & government', descriptionUk: 'Юридичні й державні теми', descriptionEn: 'Legal & government topics', arena: arena('text', 'industry_legal_and_government') },
  { slug: 'llm-ind-science', group: 'llm', nameUk: 'Галузь: природничі й соціальні науки', nameEn: 'Industry: sciences', descriptionUk: 'Біологія, фізика, соціологія', descriptionEn: 'Life, physical and social sciences', arena: arena('text', 'industry_life_and_physical_and_social_science') },
  { slug: 'llm-ind-writing', group: 'llm', nameUk: 'Галузь: тексти й мова', nameEn: 'Industry: writing & language', descriptionUk: 'Література, редагування, лінгвістика', descriptionEn: 'Literature, editing, linguistics', arena: arena('text', 'industry_writing_and_literature_and_language') },
  { slug: 'llm-ind-media', group: 'llm', nameUk: 'Галузь: медіа, спорт, розваги', nameEn: 'Industry: media & entertainment', descriptionUk: 'Медіа, спорт, шоу-бізнес', descriptionEn: 'Media, sports, entertainment', arena: arena('text', 'industry_entertainment_and_sports_and_media') },
  { slug: 'llm-small-local', group: 'llm', nameUk: 'Малі моделі для свого ПК/телефона', nameEn: 'Small local models', descriptionUk: 'Працюють офлайн на звичайному залізі', descriptionEn: 'Run offline on ordinary hardware', seed: ['qwen', 'gemma', 'llama', 'mistral-small', 'phi', 'gpt-oss'] },

  // ---------------------------------------------------------------- Assistants
  { slug: 'assistants-general', group: 'assistants', nameUk: 'Універсальні чат-боти', nameEn: 'General chatbots', descriptionUk: 'Застосунки для щоденних питань', descriptionEn: 'Everyday assistant apps', seed: ['chatgpt', 'gemini-app', 'claude', 'grok', 'deepseek-chat', 'copilot', 'le-chat', 'meta-ai'] },
  { slug: 'assistants-voice', group: 'assistants', nameUk: 'Голосові асистенти', nameEn: 'Voice assistants', descriptionUk: 'Розмова голосом у реальному часі', descriptionEn: 'Real-time voice conversation', seed: ['chatgpt-voice', 'gemini-live', 'grok', 'sesame', 'alexa-plus'] },
  { slug: 'assistants-browser', group: 'assistants', nameUk: 'AI-браузери', nameEn: 'AI browsers', descriptionUk: 'Браузер з вбудованим асистентом', descriptionEn: 'Browsers with a built-in assistant', seed: ['comet', 'chatgpt-atlas', 'dia', 'edge-copilot', 'opera-neon'] },

  // ---------------------------------------------------------------- Images
  { slug: 'image-overall', group: 'image', nameUk: 'Генерація фото: загальний', nameEn: 'Text-to-image: overall', descriptionUk: 'Найкращі моделі «текст → картинка»', descriptionEn: 'Best text-to-image models', arena: arena('text_to_image') },
  { slug: 'image-photoreal', group: 'image', nameUk: 'Фотореалізм', nameEn: 'Photorealistic', descriptionUk: 'Не відрізнити від фото', descriptionEn: 'Indistinguishable from photos', arena: arena('text_to_image', 'photorealistic') },
  { slug: 'image-portraits', group: 'image', nameUk: 'Портрети', nameEn: 'Portraits', descriptionUk: 'Люди, обличчя, емоції', descriptionEn: 'People, faces, emotions', arena: arena('text_to_image', 'portraits') },
  { slug: 'image-art', group: 'image', nameUk: 'Арт та ілюстрація', nameEn: 'Art & illustration', descriptionUk: 'Художні стилі', descriptionEn: 'Artistic styles', arena: arena('text_to_image', 'art') },
  { slug: 'image-cartoon', group: 'image', nameUk: 'Мультяшний стиль і аніме', nameEn: 'Cartoon & anime', descriptionUk: 'Мультфільми, комікси, аніме', descriptionEn: 'Cartoons, comics, anime', arena: arena('text_to_image', 'cartoon') },
  { slug: 'image-text', group: 'image', nameUk: 'Текст на зображенні', nameEn: 'Text rendering', descriptionUk: 'Постери, написи, меми без помилок', descriptionEn: 'Posters and captions without typos', arena: arena('text_to_image', 'text_rendering') },
  { slug: 'image-commercial', group: 'image', nameUk: 'Комерційний дизайн', nameEn: 'Commercial design', descriptionUk: 'Реклама, банери, упаковка', descriptionEn: 'Ads, banners, packaging', arena: arena('text_to_image', 'commercial_design') },
  { slug: 'image-3d-style', group: 'image', nameUk: '3D-рендер стиль', nameEn: '3D-style renders', descriptionUk: 'Картинки у стилі 3D-моделей', descriptionEn: '3D-modeling style images', arena: arena('text_to_image', '3d_modeling') },
  { slug: 'image-open', group: 'image', nameUk: 'Відкриті моделі для фото', nameEn: 'Open image models', descriptionUk: 'Можна запускати локально', descriptionEn: 'Run locally', arena: arena('text_to_image', 'overall', true) },
  { slug: 'image-edit', group: 'image', nameUk: 'Редагування фото', nameEn: 'Image editing', descriptionUk: 'Змінити фото текстовою командою', descriptionEn: 'Edit photos with a text prompt', arena: arena('image_edit') },
  { slug: 'image-multi-edit', group: 'image', nameUk: 'Редагування кількох фото', nameEn: 'Multi-image editing', descriptionUk: 'Поєднати кілька зображень в одне', descriptionEn: 'Combine several images', arena: arena('image_edit', 'multi_image_edit') },
  { slug: 'image-apps', group: 'image', nameUk: 'Застосунки для генерації', nameEn: 'Image generation apps', descriptionUk: 'Готові сервіси, де генерують картинки', descriptionEn: 'Ready-to-use image services', seed: ['midjourney', 'chatgpt-images', 'gemini-app', 'ideogram', 'leonardo', 'adobe-firefly', 'krea', 'freepik-ai'] },
  { slug: 'image-local', group: 'image', nameUk: 'Локальний запуск', nameEn: 'Run locally', descriptionUk: 'Інтерфейси для генерації на своєму ПК', descriptionEn: 'UIs for generating on your own PC', seed: ['comfyui', 'forge', 'invokeai', 'fooocus', 'flux'] },
  { slug: 'image-upscale', group: 'image', nameUk: 'Збільшення якості (апскейл)', nameEn: 'Upscaling', descriptionUk: 'Зробити фото чіткішим і більшим', descriptionEn: 'Make photos sharper and larger', seed: ['magnific', 'topaz-photo', 'krea', 'upscayl', 'letsenhance'] },
  { slug: 'image-bg-remove', group: 'image', nameUk: 'Видалення фону', nameEn: 'Background removal', descriptionUk: 'Вирізати об’єкт одним кліком', descriptionEn: 'Cut out the subject in one click', seed: ['remove-bg', 'photoroom', 'clipdrop', 'canva-ai', 'pixelcut'] },
  { slug: 'image-restore', group: 'image', nameUk: 'Реставрація старих фото', nameEn: 'Photo restoration', descriptionUk: 'Розфарбувати, прибрати подряпини', descriptionEn: 'Colorize, remove scratches', seed: ['remini', 'myheritage-photos', 'hotpot', 'gfpgan'] },
  { slug: 'image-avatars', group: 'image', nameUk: 'Аватарки та бізнес-фото', nameEn: 'Avatars & headshots', descriptionUk: 'Профільні фото зі своїх селфі', descriptionEn: 'Profile photos from your selfies', seed: ['aragon', 'headshotpro', 'lensa', 'photoai'] },
  { slug: 'image-logo', group: 'image', nameUk: 'Логотипи та брендинг', nameEn: 'Logos & branding', descriptionUk: 'Лого, айдентика, іконки', descriptionEn: 'Logos, identity, icons', seed: ['recraft', 'looka', 'ideogram', 'canva-ai', 'brandmark'] },
  { slug: 'image-vector', group: 'image', nameUk: 'Векторна графіка (SVG)', nameEn: 'Vector graphics (SVG)', descriptionUk: 'Іконки й ілюстрації у векторі', descriptionEn: 'Vector icons and illustrations', seed: ['recraft', 'adobe-illustrator-ai', 'vectorizer-ai', 'svgai'] },

  // ---------------------------------------------------------------- Video
  { slug: 'video-t2v', group: 'video', nameUk: 'Відео з тексту', nameEn: 'Text-to-video', descriptionUk: 'Найкращі моделі «текст → відео»', descriptionEn: 'Best text-to-video models', arena: arena('text_to_video') },
  { slug: 'video-i2v', group: 'video', nameUk: 'Відео з фото (оживлення)', nameEn: 'Image-to-video', descriptionUk: 'Оживити картинку', descriptionEn: 'Animate a still image', arena: arena('image_to_video') },
  { slug: 'video-edit', group: 'video', nameUk: 'Редагування відео моделями', nameEn: 'Video editing models', descriptionUk: 'Змінити відео текстовою командою', descriptionEn: 'Edit video with a prompt', arena: arena('video_edit') },
  { slug: 'video-apps', group: 'video', nameUk: 'Застосунки для генерації відео', nameEn: 'Video generation apps', descriptionUk: 'Готові сервіси для створення відео', descriptionEn: 'Ready-to-use video services', seed: ['veo-flow', 'sora', 'kling', 'runway', 'hailuo', 'luma', 'pika', 'higgsfield'] },
  { slug: 'video-avatars', group: 'video', nameUk: 'Відео-аватари й ведучі', nameEn: 'Avatars & presenters', descriptionUk: 'Говорячий ведучий з тексту', descriptionEn: 'Talking presenter from text', seed: ['heygen', 'synthesia', 'd-id', 'captions', 'hedra'] },
  { slug: 'video-lipsync', group: 'video', nameUk: 'Синхронізація губ (lip-sync)', nameEn: 'Lip-sync', descriptionUk: 'Підігнати губи під нову доріжку', descriptionEn: 'Match lips to new audio', seed: ['sync-so', 'hedra', 'heygen', 'kling'] },
  { slug: 'video-clipping', group: 'video', nameUk: 'Нарізка коротких відео', nameEn: 'Short clips from long videos', descriptionUk: 'Shorts/Reels з довгого відео', descriptionEn: 'Shorts/Reels from long videos', seed: ['opus-clip', 'vizard', 'descript', 'capcut'] },
  { slug: 'video-editors', group: 'video', nameUk: 'Відеоредактори з AI', nameEn: 'AI video editors', descriptionUk: 'Монтаж, субтитри, ефекти', descriptionEn: 'Editing, subtitles, effects', seed: ['capcut', 'descript', 'runway', 'premiere-ai', 'veed'] },
  { slug: 'video-upscale', group: 'video', nameUk: 'Покращення якості відео', nameEn: 'Video upscaling', descriptionUk: 'Апскейл, згладжування, FPS', descriptionEn: 'Upscale, denoise, frame rate', seed: ['topaz-video', 'krea', 'magnific'] },
  { slug: 'video-animation', group: 'video', nameUk: 'Анімація персонажів', nameEn: 'Character animation', descriptionUk: 'Рух персонажів, motion capture', descriptionEn: 'Character motion, mocap', seed: ['viggle', 'runway', 'wonder-studio', 'kling'] },

  // ---------------------------------------------------------------- Audio
  { slug: 'audio-tts', group: 'audio', nameUk: 'Озвучка тексту (TTS)', nameEn: 'Text-to-speech', descriptionUk: 'Природний голос з тексту', descriptionEn: 'Natural voice from text', seed: ['elevenlabs', 'gemini-tts', 'openai-tts', 'cartesia', 'minimax-audio', 'kokoro'] },
  { slug: 'audio-voice-clone', group: 'audio', nameUk: 'Клонування голосу', nameEn: 'Voice cloning', descriptionUk: 'Власний голос для озвучки', descriptionEn: 'Your own voice for narration', seed: ['elevenlabs', 'resemble', 'minimax-audio', 'rvc'] },
  { slug: 'audio-music', group: 'audio', nameUk: 'Генерація музики', nameEn: 'Music generation', descriptionUk: 'Пісні з вокалом за описом', descriptionEn: 'Songs with vocals from a prompt', seed: ['suno', 'udio', 'elevenlabs-music', 'lyria', 'stable-audio'] },
  { slug: 'audio-stt', group: 'audio', nameUk: 'Розпізнавання мови (STT)', nameEn: 'Speech-to-text', descriptionUk: 'Транскрипція аудіо й відео', descriptionEn: 'Transcribe audio & video', seed: ['whisper', 'elevenlabs-scribe', 'deepgram', 'assemblyai', 'gemini-app'] },
  { slug: 'audio-dubbing', group: 'audio', nameUk: 'Дубляж і переклад відео', nameEn: 'Dubbing & video translation', descriptionUk: 'Перекласти відео іншою мовою зі своїм голосом', descriptionEn: 'Translate video keeping the voice', seed: ['elevenlabs', 'heygen', 'rask', 'captions'] },
  { slug: 'audio-sfx', group: 'audio', nameUk: 'Звукові ефекти', nameEn: 'Sound effects', descriptionUk: 'Звуки за описом', descriptionEn: 'Sounds from a description', seed: ['elevenlabs', 'stable-audio', 'adobe-firefly'] },
  { slug: 'audio-cleanup', group: 'audio', nameUk: 'Очищення звуку', nameEn: 'Audio cleanup', descriptionUk: 'Прибрати шум, покращити голос', descriptionEn: 'Remove noise, enhance voice', seed: ['adobe-podcast', 'krisp', 'auphonic', 'descript'] },
  { slug: 'audio-podcasts', group: 'audio', nameUk: 'AI-подкасти', nameEn: 'AI podcasts', descriptionUk: 'Подкаст з документа чи статті', descriptionEn: 'Podcast from a document', seed: ['notebooklm', 'elevenlabs', 'wondercraft'] },

  // ---------------------------------------------------------------- Code
  { slug: 'code-webdev', group: 'code', nameUk: 'Створення сайтів моделями', nameEn: 'Web development models', descriptionUk: 'Хто краще робить сайти й застосунки', descriptionEn: 'Best at building websites & apps', arena: arena('webdev') },
  { slug: 'code-react', group: 'code', nameUk: 'React-застосунки', nameEn: 'React apps', descriptionUk: 'Генерація React-інтерфейсів', descriptionEn: 'Generating React UIs', arena: arena('webdev', 'webdev-react') },
  { slug: 'code-html', group: 'code', nameUk: 'HTML/CSS сторінки', nameEn: 'HTML/CSS pages', descriptionUk: 'Статичні сторінки', descriptionEn: 'Static pages', arena: arena('webdev', 'webdev-html') },
  { slug: 'code-screenshot', group: 'code', nameUk: 'Скріншот → код', nameEn: 'Screenshot to code', descriptionUk: 'Сайт за картинкою', descriptionEn: 'Website from an image', arena: arena('webdev', 'image_to_webdev') },
  { slug: 'code-ide', group: 'code', nameUk: 'AI-редактори коду (IDE)', nameEn: 'AI code editors (IDE)', descriptionUk: 'Редактори з вбудованим AI', descriptionEn: 'Editors with built-in AI', seed: ['cursor', 'github-copilot', 'windsurf', 'jetbrains-ai', 'zed', 'kiro'] },
  { slug: 'code-agents', group: 'code', nameUk: 'Агенти для коду', nameEn: 'Coding agents', descriptionUk: 'Самостійно виконують задачі в репозиторії', descriptionEn: 'Complete tasks in your repo on their own', seed: ['claude-code', 'openai-codex', 'gemini-cli', 'devin', 'jules', 'cline', 'aider'] },
  { slug: 'code-app-builders', group: 'code', nameUk: 'Застосунок без коду', nameEn: 'No-code app builders', descriptionUk: 'Описав словами — отримав застосунок', descriptionEn: 'Describe it, get an app', seed: ['lovable', 'bolt', 'v0', 'replit', 'base44', 'firebase-studio'] },
  { slug: 'code-review', group: 'code', nameUk: 'Рев’ю коду', nameEn: 'Code review', descriptionUk: 'Автоматична перевірка pull request', descriptionEn: 'Automated pull-request review', seed: ['coderabbit', 'greptile', 'qodo', 'github-copilot'] },
  { slug: 'code-local', group: 'code', nameUk: 'Локальні помічники коду', nameEn: 'Local code assistants', descriptionUk: 'Без хмари, з власними моделями', descriptionEn: 'No cloud, your own models', seed: ['continue', 'tabby', 'cline', 'aider'] },

  // ---------------------------------------------------------------- Agents
  { slug: 'agents-models', group: 'agents', nameUk: 'Моделі для агентів', nameEn: 'Agentic models', descriptionUk: 'Хто краще виконує багатокрокові задачі з інструментами', descriptionEn: 'Best at multi-step tool use', arena: arena('agent') },
  { slug: 'agents-general', group: 'agents', nameUk: 'Універсальні агенти', nameEn: 'General agents', descriptionUk: 'Виконують задачі за вас від початку до кінця', descriptionEn: 'Do tasks end to end', seed: ['chatgpt-agent', 'manus', 'genspark', 'claude', 'gemini-agent'] },
  { slug: 'agents-browser', group: 'agents', nameUk: 'Агенти в браузері', nameEn: 'Browser agents', descriptionUk: 'Клікають і заповнюють сайти', descriptionEn: 'Click through and fill in websites', seed: ['comet', 'chatgpt-atlas', 'browser-use', 'opera-neon'] },
  { slug: 'agents-automation', group: 'agents', nameUk: 'Автоматизація процесів', nameEn: 'Workflow automation', descriptionUk: 'З’єднати сервіси й автоматизувати рутину', descriptionEn: 'Connect apps, automate routine', seed: ['n8n', 'zapier', 'make', 'gumloop', 'lindy'] },
  { slug: 'agents-research', group: 'agents', nameUk: 'Глибоке дослідження', nameEn: 'Deep research', descriptionUk: 'Звіт з десятків джерел', descriptionEn: 'Reports from dozens of sources', seed: ['openai-deep-research', 'gemini-deep-research', 'perplexity', 'claude'] },

  // ---------------------------------------------------------------- Search
  { slug: 'search-models', group: 'search', nameUk: 'Моделі з пошуком', nameEn: 'Search-augmented models', descriptionUk: 'Відповіді з інтернету', descriptionEn: 'Answers grounded in the web', arena: arena('search') },
  { slug: 'search-factuality', group: 'search', nameUk: 'Точність пошукових відповідей', nameEn: 'Search factuality', descriptionUk: 'Менше помилок у фактах', descriptionEn: 'Fewer factual errors', arena: arena('search_factuality') },
  { slug: 'search-apps', group: 'search', nameUk: 'AI-пошуковики', nameEn: 'AI search engines', descriptionUk: 'Пошук з готовою відповіддю', descriptionEn: 'Search with direct answers', seed: ['perplexity', 'google-ai-mode', 'chatgpt-search', 'you-com', 'kagi'] },
  { slug: 'search-academic', group: 'search', nameUk: 'Наукові статті', nameEn: 'Academic research', descriptionUk: 'Пошук і аналіз досліджень', descriptionEn: 'Find and analyze papers', seed: ['elicit', 'consensus', 'scite', 'semantic-scholar', 'notebooklm'] },

  // ---------------------------------------------------------------- Vision & documents
  { slug: 'vision-overall', group: 'vision', nameUk: 'Розуміння зображень', nameEn: 'Image understanding', descriptionUk: 'Хто краще описує й аналізує картинки', descriptionEn: 'Best at analyzing images', arena: arena('vision') },
  { slug: 'vision-ocr', group: 'vision', nameUk: 'Розпізнавання тексту (OCR)', nameEn: 'OCR', descriptionUk: 'Текст з фото й сканів', descriptionEn: 'Text from photos and scans', arena: arena('vision', 'ocr') },
  { slug: 'vision-diagram', group: 'vision', nameUk: 'Графіки й діаграми', nameEn: 'Charts & diagrams', descriptionUk: 'Читає схеми й графіки', descriptionEn: 'Reads charts and diagrams', arena: arena('vision', 'diagram') },
  { slug: 'vision-homework', group: 'vision', nameUk: 'Домашка з фото', nameEn: 'Homework from a photo', descriptionUk: 'Розв’язати задачу з фото', descriptionEn: 'Solve a problem from a photo', arena: arena('vision', 'homework') },
  { slug: 'vision-captioning', group: 'vision', nameUk: 'Опис зображень', nameEn: 'Captioning', descriptionUk: 'Детальний опис фото', descriptionEn: 'Detailed photo descriptions', arena: arena('vision', 'captioning') },
  { slug: 'vision-entities', group: 'vision', nameUk: 'Впізнавання об’єктів і місць', nameEn: 'Entity recognition', descriptionUk: 'Що/хто/де на фото', descriptionEn: 'What, who, where in a photo', arena: arena('vision', 'entity_recognition') },
  { slug: 'docs-understanding', group: 'vision', nameUk: 'Робота з документами', nameEn: 'Document understanding', descriptionUk: 'PDF, звіти, договори', descriptionEn: 'PDFs, reports, contracts', arena: arena('document') },
  { slug: 'docs-parsing', group: 'vision', nameUk: 'Парсинг документів', nameEn: 'Document parsing', descriptionUk: 'PDF → структуровані дані', descriptionEn: 'PDF to structured data', seed: ['mistral-ocr', 'llamaparse', 'docling', 'reducto', 'unstructured'] },

  // ---------------------------------------------------------------- Productivity
  { slug: 'prod-writing', group: 'productivity', nameUk: 'Письмо й редагування', nameEn: 'Writing & editing', descriptionUk: 'Граматика, стиль, перефразування', descriptionEn: 'Grammar, style, rewriting', seed: ['grammarly', 'quillbot', 'notion-ai', 'languagetool', 'wordtune'] },
  { slug: 'prod-slides', group: 'productivity', nameUk: 'Презентації', nameEn: 'Presentations', descriptionUk: 'Слайди з опису чи документа', descriptionEn: 'Slides from a prompt or doc', seed: ['gamma', 'beautiful-ai', 'canva-ai', 'pitch', 'genspark'] },
  { slug: 'prod-notes', group: 'productivity', nameUk: 'Нотатки й база знань', nameEn: 'Notes & knowledge', descriptionUk: 'Розумні нотатки, питання до своїх документів', descriptionEn: 'Smart notes, ask your documents', seed: ['notebooklm', 'notion-ai', 'mem', 'reflect'] },
  { slug: 'prod-meetings', group: 'productivity', nameUk: 'Протоколи зустрічей', nameEn: 'Meeting notes', descriptionUk: 'Запис, транскрипт і підсумки дзвінків', descriptionEn: 'Record, transcribe, summarize calls', seed: ['granola', 'otter', 'fireflies', 'tldv', 'fathom'] },
  { slug: 'prod-email', group: 'productivity', nameUk: 'Пошта', nameEn: 'Email', descriptionUk: 'Розбір і відповіді на листи', descriptionEn: 'Triage and reply to email', seed: ['superhuman', 'shortwave', 'gemini-gmail', 'spark'] },
  { slug: 'prod-data', group: 'productivity', nameUk: 'Таблиці й аналіз даних', nameEn: 'Spreadsheets & data', descriptionUk: 'Аналіз Excel/CSV і графіки', descriptionEn: 'Analyze Excel/CSV, charts', seed: ['julius', 'excel-copilot', 'gemini-sheets', 'rows'] },
  { slug: 'prod-translate', group: 'productivity', nameUk: 'Переклад', nameEn: 'Translation', descriptionUk: 'Тексти й документи іншими мовами', descriptionEn: 'Translate texts and documents', seed: ['deepl', 'google-translate', 'chatgpt', 'reverso'] },
  { slug: 'prod-calendar', group: 'productivity', nameUk: 'Планування й календар', nameEn: 'Planning & calendar', descriptionUk: 'Автоматичне планування часу', descriptionEn: 'Automatic scheduling', seed: ['motion', 'reclaim', 'clockwise'] },

  // ---------------------------------------------------------------- Design & 3D
  { slug: 'design-ui', group: 'design', nameUk: 'UI/UX дизайн', nameEn: 'UI/UX design', descriptionUk: 'Макети інтерфейсів з опису', descriptionEn: 'Interface mockups from a prompt', seed: ['figma-make', 'google-stitch', 'uizard', 'v0'] },
  { slug: 'design-3d', group: 'design', nameUk: '3D-моделі', nameEn: '3D models', descriptionUk: '3D-об’єкт з тексту чи фото', descriptionEn: '3D object from text or photo', seed: ['meshy', 'tripo', 'rodin', 'hunyuan3d', 'spline'] },
  { slug: 'design-interior', group: 'design', nameUk: 'Інтер’єр і архітектура', nameEn: 'Interior & architecture', descriptionUk: 'Редизайн кімнати з фото', descriptionEn: 'Redesign a room from a photo', seed: ['interior-ai', 'reimagine-home', 'roomgpt'] },
  { slug: 'design-game-assets', group: 'design', nameUk: 'Ігрові асети', nameEn: 'Game assets', descriptionUk: 'Спрайти, текстури, персонажі', descriptionEn: 'Sprites, textures, characters', seed: ['scenario', 'layer-ai', 'meshy', 'leonardo'] },
  { slug: 'design-all-in-one', group: 'design', nameUk: 'Дизайн «все в одному»', nameEn: 'All-in-one design', descriptionUk: 'Пости, банери, документи', descriptionEn: 'Posts, banners, docs', seed: ['canva-ai', 'adobe-express', 'microsoft-designer', 'kittl'] },

  // ---------------------------------------------------------------- Business
  { slug: 'biz-marketing', group: 'business', nameUk: 'Маркетингові тексти', nameEn: 'Marketing copy', descriptionUk: 'Пости, лендінги, розсилки', descriptionEn: 'Posts, landing pages, newsletters', seed: ['jasper', 'copy-ai', 'writesonic', 'chatgpt'] },
  { slug: 'biz-ads', group: 'business', nameUk: 'Рекламні креативи', nameEn: 'Ad creatives', descriptionUk: 'Банери й відео для реклами', descriptionEn: 'Banners and video ads', seed: ['adcreative', 'arcads', 'creatify', 'canva-ai'] },
  { slug: 'biz-seo', group: 'business', nameUk: 'SEO', nameEn: 'SEO', descriptionUk: 'Оптимізація під пошук і AI-видачу', descriptionEn: 'Optimize for search & AI answers', seed: ['surfer', 'semrush-ai', 'frase', 'clearscope'] },
  { slug: 'biz-social', group: 'business', nameUk: 'Соцмережі', nameEn: 'Social media', descriptionUk: 'Контент-план і пости', descriptionEn: 'Content plans and posts', seed: ['buffer', 'predis', 'ocoya', 'canva-ai'] },
  { slug: 'biz-support', group: 'business', nameUk: 'Підтримка клієнтів', nameEn: 'Customer support', descriptionUk: 'AI-агенти служби підтримки', descriptionEn: 'AI support agents', seed: ['intercom-fin', 'zendesk-ai', 'decagon', 'sierra'] },
  { slug: 'biz-sales', group: 'business', nameUk: 'Продажі й ліди', nameEn: 'Sales & leads', descriptionUk: 'Пошук клієнтів, персоналізовані листи', descriptionEn: 'Prospecting, personalized outreach', seed: ['clay', 'apollo', 'lemlist', 'instantly'] },
  { slug: 'biz-legal', group: 'business', nameUk: 'Юридичні помічники', nameEn: 'Legal assistants', descriptionUk: 'Аналіз договорів і документів', descriptionEn: 'Contract and document review', seed: ['harvey', 'spellbook', 'legora'] },

  // ---------------------------------------------------------------- Education
  { slug: 'edu-tutors', group: 'education', nameUk: 'AI-репетитори', nameEn: 'AI tutors', descriptionUk: 'Пояснюють тему крок за кроком', descriptionEn: 'Explain topics step by step', seed: ['chatgpt-study', 'gemini-learning', 'khanmigo', 'claude'] },
  { slug: 'edu-languages', group: 'education', nameUk: 'Вивчення мов', nameEn: 'Language learning', descriptionUk: 'Розмовна практика з AI', descriptionEn: 'Conversation practice with AI', seed: ['duolingo-max', 'speak', 'praktika', 'talkpal'] },
  { slug: 'edu-math', group: 'education', nameUk: 'Математика й задачі', nameEn: 'Math solvers', descriptionUk: 'Розв’язання з поясненням', descriptionEn: 'Step-by-step solutions', seed: ['photomath', 'wolfram-alpha', 'mathway', 'gauth'] },
  { slug: 'edu-flashcards', group: 'education', nameUk: 'Картки й конспекти', nameEn: 'Flashcards & study notes', descriptionUk: 'Картки й тести з лекцій', descriptionEn: 'Cards and quizzes from lectures', seed: ['quizlet', 'notebooklm', 'knowt', 'turbolearn'] },

  // ---------------------------------------------------------------- Science
  { slug: 'sci-bio', group: 'science', nameUk: 'Біологія й білки', nameEn: 'Biology & proteins', descriptionUk: 'Структура білків, ліки', descriptionEn: 'Protein structure, drug discovery', seed: ['alphafold', 'boltz', 'esm', 'chai'] },
  { slug: 'sci-weather', group: 'science', nameUk: 'Погода й клімат', nameEn: 'Weather & climate', descriptionUk: 'Прогнози погоди на AI', descriptionEn: 'AI weather forecasting', seed: ['weathernext', 'aurora', 'aifs'] },
  { slug: 'sci-math', group: 'science', nameUk: 'Математичні відкриття', nameEn: 'Math discovery', descriptionUk: 'Доведення й нові алгоритми', descriptionEn: 'Proofs and new algorithms', seed: ['alphaevolve', 'alphaproof', 'lean-copilot'] },

  // ---------------------------------------------------------------- Developer infrastructure
  { slug: 'dev-llm-api', group: 'devinfra', nameUk: 'API великих моделей', nameEn: 'Model APIs', descriptionUk: 'Офіційні API провідних лабораторій', descriptionEn: 'Official APIs of leading labs', seed: ['gemini-api', 'openai-api', 'anthropic-api', 'deepseek-api', 'mistral-api', 'xai-api'] },
  { slug: 'dev-inference', group: 'devinfra', nameUk: 'Швидкий інференс і шлюзи', nameEn: 'Inference & gateways', descriptionUk: 'Дешеві та швидкі open-source моделі через API', descriptionEn: 'Fast, cheap open models via API', seed: ['openrouter', 'groq', 'cerebras', 'together', 'fireworks'] },
  { slug: 'dev-local', group: 'devinfra', nameUk: 'Запуск моделей локально', nameEn: 'Local model runners', descriptionUk: 'Свої моделі на своєму ПК чи сервері', descriptionEn: 'Run models on your PC/server', seed: ['ollama', 'lm-studio', 'llama-cpp', 'vllm', 'jan'] },
  { slug: 'dev-embeddings', group: 'devinfra', nameUk: 'Ембединги', nameEn: 'Embeddings', descriptionUk: 'Векторні представлення для пошуку й RAG', descriptionEn: 'Vectors for search & RAG', seed: ['voyage', 'gemini-embedding', 'openai-embeddings', 'cohere-embed', 'jina'] },
  { slug: 'dev-vector-db', group: 'devinfra', nameUk: 'Векторні бази даних', nameEn: 'Vector databases', descriptionUk: 'Зберігання й пошук ембедингів', descriptionEn: 'Store and search embeddings', seed: ['pgvector', 'qdrant', 'pinecone', 'weaviate', 'chroma'] },
  { slug: 'dev-frameworks', group: 'devinfra', nameUk: 'Фреймворки для агентів і RAG', nameEn: 'Agent & RAG frameworks', descriptionUk: 'Бібліотеки для побудови AI-застосунків', descriptionEn: 'Libraries for building AI apps', seed: ['langgraph', 'openai-agents-sdk', 'claude-agent-sdk', 'llamaindex', 'crewai', 'mastra'] },
  { slug: 'dev-mcp', group: 'devinfra', nameUk: 'MCP та інструменти для агентів', nameEn: 'MCP & agent tools', descriptionUk: 'Підключення агентів до сервісів', descriptionEn: 'Connect agents to services', seed: ['mcp', 'composio', 'smithery'] },
  { slug: 'dev-observability', group: 'devinfra', nameUk: 'Моніторинг і оцінка LLM', nameEn: 'LLM observability & evals', descriptionUk: 'Логи, трасування, тести якості', descriptionEn: 'Logs, tracing, quality evals', seed: ['langfuse', 'langsmith', 'braintrust', 'helicone'] },
  { slug: 'dev-finetune', group: 'devinfra', nameUk: 'Донавчання моделей', nameEn: 'Fine-tuning', descriptionUk: 'Навчити модель на своїх даних', descriptionEn: 'Train a model on your data', seed: ['unsloth', 'axolotl', 'together', 'openpipe'] },
  { slug: 'dev-gpu-cloud', group: 'devinfra', nameUk: 'GPU-хмари', nameEn: 'GPU clouds', descriptionUk: 'Оренда відеокарт для AI', descriptionEn: 'Rent GPUs for AI', seed: ['runpod', 'modal', 'lambda', 'vast-ai'] },

  // ---------------------------------------------------------------- Safety
  { slug: 'safety-detectors', group: 'safety', nameUk: 'Детектори AI-тексту', nameEn: 'AI text detectors', descriptionUk: 'Перевірка, чи писав текст AI', descriptionEn: 'Check if text was AI-written', seed: ['gptzero', 'originality', 'copyleaks', 'turnitin'] },
  { slug: 'safety-deepfake', group: 'safety', nameUk: 'Виявлення дипфейків', nameEn: 'Deepfake detection', descriptionUk: 'Перевірка фото, відео й голосу', descriptionEn: 'Check photos, video and voice', seed: ['hive', 'reality-defender', 'sensity', 'synthid'] },
  { slug: 'safety-privacy', group: 'safety', nameUk: 'Приватний AI', nameEn: 'Private AI', descriptionUk: 'Асистенти без збору ваших даних', descriptionEn: 'Assistants that don’t collect your data', seed: ['proton-lumo', 'duckduckgo-ai', 'ollama', 'venice'] },

  // ---------------------------------------------------------------- Fun
  { slug: 'fun-companions', group: 'fun', nameUk: 'AI-співрозмовники', nameEn: 'AI companions', descriptionUk: 'Персонажі для розмов', descriptionEn: 'Characters to chat with', seed: ['character-ai', 'replika', 'kindroid', 'talkie'] },
  { slug: 'fun-games', group: 'fun', nameUk: 'Ігри з AI', nameEn: 'AI games', descriptionUk: 'Текстові пригоди й ігри з AI', descriptionEn: 'Text adventures & AI games', seed: ['ai-dungeon', 'inworld', 'infinite-craft'] },
];

export const SEED_TOOLS: Record<string, SeedTool> = {
  // LLM families
  qwen: { name: 'Qwen', vendor: 'Alibaba', url: 'https://qwen.ai', free: true, open: true },
  gemma: { name: 'Gemma', vendor: 'Google', url: 'https://ai.google.dev/gemma', free: true, open: true },
  llama: { name: 'Llama', vendor: 'Meta', url: 'https://www.llama.com', free: true, open: true },
  'mistral-small': { name: 'Mistral Small', vendor: 'Mistral AI', url: 'https://mistral.ai', free: true, open: true },
  phi: { name: 'Phi', vendor: 'Microsoft', url: 'https://azure.microsoft.com/products/phi', free: true, open: true },
  'gpt-oss': { name: 'gpt-oss', vendor: 'OpenAI', url: 'https://openai.com/open-models', free: true, open: true },
  // Assistants
  chatgpt: { name: 'ChatGPT', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  'gemini-app': { name: 'Gemini', vendor: 'Google', url: 'https://gemini.google.com', free: true },
  claude: { name: 'Claude', vendor: 'Anthropic', url: 'https://claude.ai', free: true },
  grok: { name: 'Grok', vendor: 'xAI', url: 'https://grok.com', free: true },
  'deepseek-chat': { name: 'DeepSeek Chat', vendor: 'DeepSeek', url: 'https://chat.deepseek.com', free: true },
  copilot: { name: 'Microsoft Copilot', vendor: 'Microsoft', url: 'https://copilot.microsoft.com', free: true },
  'le-chat': { name: 'Le Chat', vendor: 'Mistral AI', url: 'https://chat.mistral.ai', free: true },
  'meta-ai': { name: 'Meta AI', vendor: 'Meta', url: 'https://www.meta.ai', free: true },
  'chatgpt-voice': { name: 'ChatGPT Voice', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  'gemini-live': { name: 'Gemini Live', vendor: 'Google', url: 'https://gemini.google.com', free: true },
  sesame: { name: 'Sesame', vendor: 'Sesame', url: 'https://www.sesame.com', free: true },
  'alexa-plus': { name: 'Alexa+', vendor: 'Amazon', url: 'https://www.amazon.com/alexa', free: false },
  comet: { name: 'Comet', vendor: 'Perplexity', url: 'https://www.perplexity.ai/comet', free: true },
  'chatgpt-atlas': { name: 'ChatGPT Atlas', vendor: 'OpenAI', url: 'https://chatgpt.com/atlas', free: true },
  dia: { name: 'Dia', vendor: 'The Browser Company', url: 'https://www.diabrowser.com', free: true },
  'edge-copilot': { name: 'Edge Copilot Mode', vendor: 'Microsoft', url: 'https://www.microsoft.com/edge', free: true },
  'opera-neon': { name: 'Opera Neon', vendor: 'Opera', url: 'https://www.operaneon.com', free: false },
  // Images
  midjourney: { name: 'Midjourney', vendor: 'Midjourney', url: 'https://www.midjourney.com', free: false },
  'chatgpt-images': { name: 'ChatGPT Images', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  ideogram: { name: 'Ideogram', vendor: 'Ideogram', url: 'https://ideogram.ai', free: true },
  leonardo: { name: 'Leonardo.Ai', vendor: 'Canva', url: 'https://leonardo.ai', free: true },
  'adobe-firefly': { name: 'Adobe Firefly', vendor: 'Adobe', url: 'https://firefly.adobe.com', free: true },
  krea: { name: 'Krea', vendor: 'Krea', url: 'https://www.krea.ai', free: true },
  'freepik-ai': { name: 'Freepik AI Suite', vendor: 'Freepik', url: 'https://www.freepik.com/ai', free: true },
  comfyui: { name: 'ComfyUI', vendor: 'Comfy Org', url: 'https://www.comfy.org', free: true, open: true },
  forge: { name: 'Stable Diffusion WebUI Forge', vendor: 'Community', url: 'https://github.com/lllyasviel/stable-diffusion-webui-forge', free: true, open: true },
  invokeai: { name: 'InvokeAI', vendor: 'Invoke', url: 'https://www.invoke.com', free: true, open: true },
  fooocus: { name: 'Fooocus', vendor: 'Community', url: 'https://github.com/lllyasviel/Fooocus', free: true, open: true },
  flux: { name: 'FLUX', vendor: 'Black Forest Labs', url: 'https://bfl.ai', free: true, open: true },
  magnific: { name: 'Magnific', vendor: 'Freepik', url: 'https://magnific.ai', free: false },
  'topaz-photo': { name: 'Topaz Photo AI', vendor: 'Topaz Labs', url: 'https://www.topazlabs.com', free: false },
  upscayl: { name: 'Upscayl', vendor: 'Community', url: 'https://upscayl.org', free: true, open: true },
  letsenhance: { name: 'Let’s Enhance', vendor: 'Let’s Enhance', url: 'https://letsenhance.io', free: true },
  'remove-bg': { name: 'remove.bg', vendor: 'Canva', url: 'https://www.remove.bg', free: true },
  photoroom: { name: 'Photoroom', vendor: 'Photoroom', url: 'https://www.photoroom.com', free: true },
  clipdrop: { name: 'Clipdrop', vendor: 'Jasper', url: 'https://clipdrop.co', free: true },
  'canva-ai': { name: 'Canva AI', vendor: 'Canva', url: 'https://www.canva.com/ai', free: true },
  pixelcut: { name: 'Pixelcut', vendor: 'Pixelcut', url: 'https://www.pixelcut.ai', free: true },
  remini: { name: 'Remini', vendor: 'Bending Spoons', url: 'https://remini.ai', free: true },
  'myheritage-photos': { name: 'MyHeritage Photo Enhancer', vendor: 'MyHeritage', url: 'https://www.myheritage.com/photo-enhancer', free: true },
  hotpot: { name: 'Hotpot.ai', vendor: 'Hotpot', url: 'https://hotpot.ai', free: true },
  gfpgan: { name: 'GFPGAN', vendor: 'Tencent ARC', url: 'https://github.com/TencentARC/GFPGAN', free: true, open: true },
  aragon: { name: 'Aragon', vendor: 'Aragon', url: 'https://www.aragon.ai', free: false },
  headshotpro: { name: 'HeadshotPro', vendor: 'HeadshotPro', url: 'https://www.headshotpro.com', free: false },
  lensa: { name: 'Lensa', vendor: 'Prisma Labs', url: 'https://lensa-ai.com', free: true },
  photoai: { name: 'Photo AI', vendor: 'Photo AI', url: 'https://photoai.com', free: false },
  recraft: { name: 'Recraft', vendor: 'Recraft', url: 'https://www.recraft.ai', free: true },
  looka: { name: 'Looka', vendor: 'Looka', url: 'https://looka.com', free: true },
  brandmark: { name: 'Brandmark', vendor: 'Brandmark', url: 'https://brandmark.io', free: true },
  'adobe-illustrator-ai': { name: 'Illustrator Generative Vector', vendor: 'Adobe', url: 'https://www.adobe.com/products/illustrator.html', free: false },
  'vectorizer-ai': { name: 'Vectorizer.AI', vendor: 'Vectorizer.AI', url: 'https://vectorizer.ai', free: false },
  svgai: { name: 'SVG.io', vendor: 'SVG.io', url: 'https://svg.io', free: true },
  // Video
  'veo-flow': { name: 'Veo / Google Flow', vendor: 'Google', url: 'https://labs.google/flow', free: false },
  sora: { name: 'Sora', vendor: 'OpenAI', url: 'https://sora.com', free: true },
  kling: { name: 'Kling AI', vendor: 'Kuaishou', url: 'https://klingai.com', free: true },
  runway: { name: 'Runway', vendor: 'Runway', url: 'https://runwayml.com', free: true },
  hailuo: { name: 'Hailuo AI', vendor: 'MiniMax', url: 'https://hailuoai.video', free: true },
  luma: { name: 'Luma Dream Machine', vendor: 'Luma AI', url: 'https://lumalabs.ai', free: true },
  pika: { name: 'Pika', vendor: 'Pika', url: 'https://pika.art', free: true },
  higgsfield: { name: 'Higgsfield', vendor: 'Higgsfield', url: 'https://higgsfield.ai', free: true },
  heygen: { name: 'HeyGen', vendor: 'HeyGen', url: 'https://www.heygen.com', free: true },
  synthesia: { name: 'Synthesia', vendor: 'Synthesia', url: 'https://www.synthesia.io', free: true },
  'd-id': { name: 'D-ID', vendor: 'D-ID', url: 'https://www.d-id.com', free: true },
  captions: { name: 'Captions', vendor: 'Captions', url: 'https://www.captions.ai', free: true },
  hedra: { name: 'Hedra', vendor: 'Hedra', url: 'https://www.hedra.com', free: true },
  'sync-so': { name: 'sync.', vendor: 'Sync Labs', url: 'https://sync.so', free: true },
  'opus-clip': { name: 'OpusClip', vendor: 'OpusClip', url: 'https://www.opus.pro', free: true },
  vizard: { name: 'Vizard', vendor: 'Vizard', url: 'https://vizard.ai', free: true },
  descript: { name: 'Descript', vendor: 'Descript', url: 'https://www.descript.com', free: true },
  capcut: { name: 'CapCut', vendor: 'ByteDance', url: 'https://www.capcut.com', free: true },
  'premiere-ai': { name: 'Premiere Pro (Generative Extend)', vendor: 'Adobe', url: 'https://www.adobe.com/products/premiere.html', free: false },
  veed: { name: 'VEED', vendor: 'VEED', url: 'https://www.veed.io', free: true },
  'topaz-video': { name: 'Topaz Video AI', vendor: 'Topaz Labs', url: 'https://www.topazlabs.com', free: false },
  viggle: { name: 'Viggle', vendor: 'Viggle', url: 'https://viggle.ai', free: true },
  'wonder-studio': { name: 'Flow Studio (Wonder)', vendor: 'Autodesk', url: 'https://wonderdynamics.com', free: true },
  // Audio
  elevenlabs: { name: 'ElevenLabs', vendor: 'ElevenLabs', url: 'https://elevenlabs.io', free: true },
  'gemini-tts': { name: 'Gemini TTS', vendor: 'Google', url: 'https://ai.google.dev', free: true },
  'openai-tts': { name: 'OpenAI TTS', vendor: 'OpenAI', url: 'https://platform.openai.com', free: false },
  cartesia: { name: 'Cartesia', vendor: 'Cartesia', url: 'https://cartesia.ai', free: true },
  'minimax-audio': { name: 'MiniMax Audio', vendor: 'MiniMax', url: 'https://www.minimax.io/audio', free: true },
  kokoro: { name: 'Kokoro TTS', vendor: 'Community', url: 'https://huggingface.co/hexgrad/Kokoro-82M', free: true, open: true },
  resemble: { name: 'Resemble AI', vendor: 'Resemble AI', url: 'https://www.resemble.ai', free: true },
  rvc: { name: 'RVC', vendor: 'Community', url: 'https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI', free: true, open: true },
  suno: { name: 'Suno', vendor: 'Suno', url: 'https://suno.com', free: true },
  udio: { name: 'Udio', vendor: 'Udio', url: 'https://www.udio.com', free: true },
  'elevenlabs-music': { name: 'Eleven Music', vendor: 'ElevenLabs', url: 'https://elevenlabs.io/music', free: true },
  lyria: { name: 'Lyria', vendor: 'Google', url: 'https://deepmind.google/models/lyria', free: true },
  'stable-audio': { name: 'Stable Audio', vendor: 'Stability AI', url: 'https://stableaudio.com', free: true },
  whisper: { name: 'Whisper', vendor: 'OpenAI', url: 'https://github.com/openai/whisper', free: true, open: true },
  'elevenlabs-scribe': { name: 'ElevenLabs Scribe', vendor: 'ElevenLabs', url: 'https://elevenlabs.io/speech-to-text', free: true },
  deepgram: { name: 'Deepgram', vendor: 'Deepgram', url: 'https://deepgram.com', free: true },
  assemblyai: { name: 'AssemblyAI', vendor: 'AssemblyAI', url: 'https://www.assemblyai.com', free: true },
  rask: { name: 'Rask AI', vendor: 'Rask', url: 'https://www.rask.ai', free: true },
  'adobe-podcast': { name: 'Adobe Podcast Enhance', vendor: 'Adobe', url: 'https://podcast.adobe.com', free: true },
  krisp: { name: 'Krisp', vendor: 'Krisp', url: 'https://krisp.ai', free: true },
  auphonic: { name: 'Auphonic', vendor: 'Auphonic', url: 'https://auphonic.com', free: true },
  notebooklm: { name: 'NotebookLM', vendor: 'Google', url: 'https://notebooklm.google.com', free: true },
  wondercraft: { name: 'Wondercraft', vendor: 'Wondercraft', url: 'https://www.wondercraft.ai', free: true },
  // Code
  cursor: { name: 'Cursor', vendor: 'Anysphere', url: 'https://cursor.com', free: true },
  'github-copilot': { name: 'GitHub Copilot', vendor: 'GitHub', url: 'https://github.com/features/copilot', free: true },
  windsurf: { name: 'Windsurf', vendor: 'Cognition', url: 'https://windsurf.com', free: true },
  'jetbrains-ai': { name: 'JetBrains AI / Junie', vendor: 'JetBrains', url: 'https://www.jetbrains.com/ai', free: true },
  zed: { name: 'Zed', vendor: 'Zed Industries', url: 'https://zed.dev', free: true, open: true },
  kiro: { name: 'Kiro', vendor: 'AWS', url: 'https://kiro.dev', free: true },
  'claude-code': { name: 'Claude Code', vendor: 'Anthropic', url: 'https://claude.com/product/claude-code', free: false },
  'openai-codex': { name: 'Codex', vendor: 'OpenAI', url: 'https://openai.com/codex', free: false },
  'gemini-cli': { name: 'Gemini CLI', vendor: 'Google', url: 'https://github.com/google-gemini/gemini-cli', free: true, open: true },
  devin: { name: 'Devin', vendor: 'Cognition', url: 'https://devin.ai', free: false },
  jules: { name: 'Jules', vendor: 'Google', url: 'https://jules.google', free: true },
  cline: { name: 'Cline', vendor: 'Cline', url: 'https://cline.bot', free: true, open: true },
  aider: { name: 'Aider', vendor: 'Community', url: 'https://aider.chat', free: true, open: true },
  lovable: { name: 'Lovable', vendor: 'Lovable', url: 'https://lovable.dev', free: true },
  bolt: { name: 'Bolt.new', vendor: 'StackBlitz', url: 'https://bolt.new', free: true },
  v0: { name: 'v0', vendor: 'Vercel', url: 'https://v0.app', free: true },
  replit: { name: 'Replit Agent', vendor: 'Replit', url: 'https://replit.com', free: true },
  base44: { name: 'Base44', vendor: 'Wix', url: 'https://base44.com', free: true },
  'firebase-studio': { name: 'Firebase Studio', vendor: 'Google', url: 'https://firebase.studio', free: true },
  coderabbit: { name: 'CodeRabbit', vendor: 'CodeRabbit', url: 'https://www.coderabbit.ai', free: true },
  greptile: { name: 'Greptile', vendor: 'Greptile', url: 'https://www.greptile.com', free: false },
  qodo: { name: 'Qodo', vendor: 'Qodo', url: 'https://www.qodo.ai', free: true },
  continue: { name: 'Continue', vendor: 'Continue', url: 'https://www.continue.dev', free: true, open: true },
  tabby: { name: 'Tabby', vendor: 'TabbyML', url: 'https://www.tabbyml.com', free: true, open: true },
  // Agents
  'chatgpt-agent': { name: 'ChatGPT Agent', vendor: 'OpenAI', url: 'https://chatgpt.com', free: false },
  manus: { name: 'Manus', vendor: 'Manus', url: 'https://manus.im', free: true },
  genspark: { name: 'Genspark', vendor: 'Genspark', url: 'https://www.genspark.ai', free: true },
  'gemini-agent': { name: 'Gemini Agent', vendor: 'Google', url: 'https://gemini.google.com', free: false },
  'browser-use': { name: 'Browser Use', vendor: 'Browser Use', url: 'https://browser-use.com', free: true, open: true },
  n8n: { name: 'n8n', vendor: 'n8n', url: 'https://n8n.io', free: true, open: true },
  zapier: { name: 'Zapier', vendor: 'Zapier', url: 'https://zapier.com', free: true },
  make: { name: 'Make', vendor: 'Make', url: 'https://www.make.com', free: true },
  gumloop: { name: 'Gumloop', vendor: 'Gumloop', url: 'https://www.gumloop.com', free: true },
  lindy: { name: 'Lindy', vendor: 'Lindy', url: 'https://www.lindy.ai', free: true },
  'openai-deep-research': { name: 'ChatGPT Deep Research', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  'gemini-deep-research': { name: 'Gemini Deep Research', vendor: 'Google', url: 'https://gemini.google.com', free: true },
  perplexity: { name: 'Perplexity', vendor: 'Perplexity', url: 'https://www.perplexity.ai', free: true },
  // Search
  'google-ai-mode': { name: 'Google AI Mode', vendor: 'Google', url: 'https://www.google.com', free: true },
  'chatgpt-search': { name: 'ChatGPT Search', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  'you-com': { name: 'You.com', vendor: 'You.com', url: 'https://you.com', free: true },
  kagi: { name: 'Kagi Assistant', vendor: 'Kagi', url: 'https://kagi.com', free: false },
  elicit: { name: 'Elicit', vendor: 'Elicit', url: 'https://elicit.com', free: true },
  consensus: { name: 'Consensus', vendor: 'Consensus', url: 'https://consensus.app', free: true },
  scite: { name: 'scite', vendor: 'Research Solutions', url: 'https://scite.ai', free: false },
  'semantic-scholar': { name: 'Semantic Scholar', vendor: 'Ai2', url: 'https://www.semanticscholar.org', free: true },
  // Documents
  'mistral-ocr': { name: 'Mistral OCR', vendor: 'Mistral AI', url: 'https://mistral.ai', free: false },
  llamaparse: { name: 'LlamaParse', vendor: 'LlamaIndex', url: 'https://www.llamaindex.ai/llamaparse', free: true },
  docling: { name: 'Docling', vendor: 'IBM', url: 'https://github.com/docling-project/docling', free: true, open: true },
  reducto: { name: 'Reducto', vendor: 'Reducto', url: 'https://reducto.ai', free: false },
  unstructured: { name: 'Unstructured', vendor: 'Unstructured', url: 'https://unstructured.io', free: true, open: true },
  // Productivity
  grammarly: { name: 'Grammarly', vendor: 'Superhuman', url: 'https://www.grammarly.com', free: true },
  quillbot: { name: 'QuillBot', vendor: 'Learneo', url: 'https://quillbot.com', free: true },
  'notion-ai': { name: 'Notion AI', vendor: 'Notion', url: 'https://www.notion.com/product/ai', free: false },
  languagetool: { name: 'LanguageTool', vendor: 'LanguageTool', url: 'https://languagetool.org', free: true, open: true },
  wordtune: { name: 'Wordtune', vendor: 'AI21 Labs', url: 'https://www.wordtune.com', free: true },
  gamma: { name: 'Gamma', vendor: 'Gamma', url: 'https://gamma.app', free: true },
  'beautiful-ai': { name: 'Beautiful.ai', vendor: 'Beautiful.ai', url: 'https://www.beautiful.ai', free: false },
  pitch: { name: 'Pitch', vendor: 'Pitch', url: 'https://pitch.com', free: true },
  mem: { name: 'Mem', vendor: 'Mem', url: 'https://get.mem.ai', free: true },
  reflect: { name: 'Reflect', vendor: 'Reflect', url: 'https://reflect.app', free: false },
  granola: { name: 'Granola', vendor: 'Granola', url: 'https://www.granola.ai', free: true },
  otter: { name: 'Otter.ai', vendor: 'Otter.ai', url: 'https://otter.ai', free: true },
  fireflies: { name: 'Fireflies.ai', vendor: 'Fireflies', url: 'https://fireflies.ai', free: true },
  tldv: { name: 'tl;dv', vendor: 'tl;dv', url: 'https://tldv.io', free: true },
  fathom: { name: 'Fathom', vendor: 'Fathom', url: 'https://www.fathom.video', free: true },
  superhuman: { name: 'Superhuman', vendor: 'Superhuman', url: 'https://superhuman.com', free: false },
  shortwave: { name: 'Shortwave', vendor: 'Shortwave', url: 'https://www.shortwave.com', free: true },
  'gemini-gmail': { name: 'Gemini in Gmail', vendor: 'Google', url: 'https://workspace.google.com', free: false },
  spark: { name: 'Spark Mail', vendor: 'Readdle', url: 'https://sparkmailapp.com', free: true },
  julius: { name: 'Julius AI', vendor: 'Julius', url: 'https://julius.ai', free: true },
  'excel-copilot': { name: 'Copilot in Excel', vendor: 'Microsoft', url: 'https://www.microsoft.com/microsoft-365/excel', free: false },
  'gemini-sheets': { name: 'Gemini in Sheets', vendor: 'Google', url: 'https://workspace.google.com', free: false },
  rows: { name: 'Rows', vendor: 'Rows', url: 'https://rows.com', free: true },
  deepl: { name: 'DeepL', vendor: 'DeepL', url: 'https://www.deepl.com', free: true },
  'google-translate': { name: 'Google Translate', vendor: 'Google', url: 'https://translate.google.com', free: true },
  reverso: { name: 'Reverso', vendor: 'Reverso', url: 'https://www.reverso.net', free: true },
  motion: { name: 'Motion', vendor: 'Motion', url: 'https://www.usemotion.com', free: false },
  reclaim: { name: 'Reclaim.ai', vendor: 'Dropbox', url: 'https://reclaim.ai', free: true },
  clockwise: { name: 'Clockwise', vendor: 'Clockwise', url: 'https://www.getclockwise.com', free: true },
  // Design
  'figma-make': { name: 'Figma Make', vendor: 'Figma', url: 'https://www.figma.com/make', free: true },
  'google-stitch': { name: 'Stitch', vendor: 'Google', url: 'https://stitch.withgoogle.com', free: true },
  uizard: { name: 'Uizard', vendor: 'Miro', url: 'https://uizard.io', free: true },
  meshy: { name: 'Meshy', vendor: 'Meshy', url: 'https://www.meshy.ai', free: true },
  tripo: { name: 'Tripo', vendor: 'VAST', url: 'https://www.tripo3d.ai', free: true },
  rodin: { name: 'Rodin (Hyper3D)', vendor: 'Deemos', url: 'https://hyper3d.ai', free: true },
  hunyuan3d: { name: 'Hunyuan3D', vendor: 'Tencent', url: 'https://3d.hunyuan.tencent.com', free: true, open: true },
  spline: { name: 'Spline AI', vendor: 'Spline', url: 'https://spline.design', free: true },
  'interior-ai': { name: 'Interior AI', vendor: 'Interior AI', url: 'https://interiorai.com', free: false },
  'reimagine-home': { name: 'ReimagineHome', vendor: 'ReimagineHome', url: 'https://www.reimaginehome.ai', free: true },
  roomgpt: { name: 'RoomGPT', vendor: 'Community', url: 'https://www.roomgpt.io', free: true, open: true },
  scenario: { name: 'Scenario', vendor: 'Scenario', url: 'https://www.scenario.com', free: true },
  'layer-ai': { name: 'Layer', vendor: 'Layer', url: 'https://www.layer.ai', free: true },
  'adobe-express': { name: 'Adobe Express', vendor: 'Adobe', url: 'https://www.adobe.com/express', free: true },
  'microsoft-designer': { name: 'Microsoft Designer', vendor: 'Microsoft', url: 'https://designer.microsoft.com', free: true },
  kittl: { name: 'Kittl', vendor: 'Kittl', url: 'https://www.kittl.com', free: true },
  // Business
  jasper: { name: 'Jasper', vendor: 'Jasper', url: 'https://www.jasper.ai', free: false },
  'copy-ai': { name: 'Copy.ai', vendor: 'Copy.ai', url: 'https://www.copy.ai', free: true },
  writesonic: { name: 'Writesonic', vendor: 'Writesonic', url: 'https://writesonic.com', free: true },
  adcreative: { name: 'AdCreative.ai', vendor: 'AdCreative', url: 'https://www.adcreative.ai', free: false },
  arcads: { name: 'Arcads', vendor: 'Arcads', url: 'https://www.arcads.ai', free: false },
  creatify: { name: 'Creatify', vendor: 'Creatify', url: 'https://creatify.ai', free: true },
  surfer: { name: 'Surfer', vendor: 'Surfer', url: 'https://surferseo.com', free: false },
  'semrush-ai': { name: 'Semrush AI', vendor: 'Semrush', url: 'https://www.semrush.com', free: true },
  frase: { name: 'Frase', vendor: 'Frase', url: 'https://www.frase.io', free: false },
  clearscope: { name: 'Clearscope', vendor: 'Clearscope', url: 'https://www.clearscope.io', free: false },
  buffer: { name: 'Buffer AI Assistant', vendor: 'Buffer', url: 'https://buffer.com', free: true },
  predis: { name: 'Predis.ai', vendor: 'Predis', url: 'https://predis.ai', free: true },
  ocoya: { name: 'Ocoya', vendor: 'Ocoya', url: 'https://www.ocoya.com', free: false },
  'intercom-fin': { name: 'Fin', vendor: 'Intercom', url: 'https://fin.ai', free: false },
  'zendesk-ai': { name: 'Zendesk AI', vendor: 'Zendesk', url: 'https://www.zendesk.com/service/ai', free: false },
  decagon: { name: 'Decagon', vendor: 'Decagon', url: 'https://decagon.ai', free: false },
  sierra: { name: 'Sierra', vendor: 'Sierra', url: 'https://sierra.ai', free: false },
  clay: { name: 'Clay', vendor: 'Clay', url: 'https://www.clay.com', free: true },
  apollo: { name: 'Apollo.io', vendor: 'Apollo', url: 'https://www.apollo.io', free: true },
  lemlist: { name: 'lemlist', vendor: 'lemlist', url: 'https://www.lemlist.com', free: false },
  instantly: { name: 'Instantly', vendor: 'Instantly', url: 'https://instantly.ai', free: false },
  harvey: { name: 'Harvey', vendor: 'Harvey', url: 'https://www.harvey.ai', free: false },
  spellbook: { name: 'Spellbook', vendor: 'Spellbook', url: 'https://www.spellbook.legal', free: false },
  legora: { name: 'Legora', vendor: 'Legora', url: 'https://legora.com', free: false },
  // Education
  'chatgpt-study': { name: 'ChatGPT Study Mode', vendor: 'OpenAI', url: 'https://chatgpt.com', free: true },
  'gemini-learning': { name: 'Gemini Guided Learning', vendor: 'Google', url: 'https://gemini.google.com', free: true },
  khanmigo: { name: 'Khanmigo', vendor: 'Khan Academy', url: 'https://www.khanmigo.ai', free: true },
  'duolingo-max': { name: 'Duolingo Max', vendor: 'Duolingo', url: 'https://www.duolingo.com', free: false },
  speak: { name: 'Speak', vendor: 'Speak', url: 'https://www.speak.com', free: false },
  praktika: { name: 'Praktika', vendor: 'Praktika', url: 'https://praktika.ai', free: true },
  talkpal: { name: 'Talkpal', vendor: 'Talkpal', url: 'https://talkpal.ai', free: true },
  photomath: { name: 'Photomath', vendor: 'Google', url: 'https://photomath.com', free: true },
  'wolfram-alpha': { name: 'Wolfram|Alpha', vendor: 'Wolfram', url: 'https://www.wolframalpha.com', free: true },
  mathway: { name: 'Mathway', vendor: 'Chegg', url: 'https://www.mathway.com', free: true },
  gauth: { name: 'Gauth', vendor: 'ByteDance', url: 'https://www.gauthmath.com', free: true },
  quizlet: { name: 'Quizlet', vendor: 'Quizlet', url: 'https://quizlet.com', free: true },
  knowt: { name: 'Knowt', vendor: 'Knowt', url: 'https://knowt.com', free: true },
  turbolearn: { name: 'TurboLearn', vendor: 'TurboLearn', url: 'https://www.turbolearn.ai', free: true },
  // Science
  alphafold: { name: 'AlphaFold', vendor: 'Google DeepMind', url: 'https://alphafoldserver.com', free: true },
  boltz: { name: 'Boltz', vendor: 'MIT', url: 'https://github.com/jwohlwend/boltz', free: true, open: true },
  esm: { name: 'ESM', vendor: 'EvolutionaryScale', url: 'https://www.evolutionaryscale.ai', free: true, open: true },
  chai: { name: 'Chai Discovery', vendor: 'Chai Discovery', url: 'https://www.chaidiscovery.com', free: true },
  weathernext: { name: 'WeatherNext', vendor: 'Google DeepMind', url: 'https://deepmind.google/science/weathernext', free: true },
  aurora: { name: 'Aurora', vendor: 'Microsoft', url: 'https://github.com/microsoft/aurora', free: true, open: true },
  aifs: { name: 'AIFS', vendor: 'ECMWF', url: 'https://www.ecmwf.int', free: true, open: true },
  alphaevolve: { name: 'AlphaEvolve', vendor: 'Google DeepMind', url: 'https://deepmind.google', free: false },
  alphaproof: { name: 'AlphaProof', vendor: 'Google DeepMind', url: 'https://deepmind.google', free: false },
  'lean-copilot': { name: 'Lean Copilot', vendor: 'Community', url: 'https://github.com/lean-dojo/LeanCopilot', free: true, open: true },
  // Dev infra
  'gemini-api': { name: 'Gemini API', vendor: 'Google', url: 'https://ai.google.dev', free: true },
  'openai-api': { name: 'OpenAI API', vendor: 'OpenAI', url: 'https://platform.openai.com', free: false },
  'anthropic-api': { name: 'Claude API', vendor: 'Anthropic', url: 'https://www.anthropic.com/api', free: false },
  'deepseek-api': { name: 'DeepSeek API', vendor: 'DeepSeek', url: 'https://platform.deepseek.com', free: false },
  'mistral-api': { name: 'Mistral API', vendor: 'Mistral AI', url: 'https://console.mistral.ai', free: true },
  'xai-api': { name: 'xAI API', vendor: 'xAI', url: 'https://x.ai/api', free: false },
  openrouter: { name: 'OpenRouter', vendor: 'OpenRouter', url: 'https://openrouter.ai', free: true },
  groq: { name: 'Groq', vendor: 'Groq', url: 'https://groq.com', free: true },
  cerebras: { name: 'Cerebras Inference', vendor: 'Cerebras', url: 'https://www.cerebras.ai', free: true },
  together: { name: 'Together AI', vendor: 'Together AI', url: 'https://www.together.ai', free: false },
  fireworks: { name: 'Fireworks AI', vendor: 'Fireworks', url: 'https://fireworks.ai', free: false },
  ollama: { name: 'Ollama', vendor: 'Ollama', url: 'https://ollama.com', free: true, open: true },
  'lm-studio': { name: 'LM Studio', vendor: 'LM Studio', url: 'https://lmstudio.ai', free: true },
  'llama-cpp': { name: 'llama.cpp', vendor: 'ggml', url: 'https://github.com/ggml-org/llama.cpp', free: true, open: true },
  vllm: { name: 'vLLM', vendor: 'vLLM', url: 'https://github.com/vllm-project/vllm', free: true, open: true },
  jan: { name: 'Jan', vendor: 'Menlo', url: 'https://jan.ai', free: true, open: true },
  voyage: { name: 'Voyage AI', vendor: 'MongoDB', url: 'https://www.voyageai.com', free: true },
  'gemini-embedding': { name: 'Gemini Embedding', vendor: 'Google', url: 'https://ai.google.dev', free: true },
  'openai-embeddings': { name: 'OpenAI Embeddings', vendor: 'OpenAI', url: 'https://platform.openai.com', free: false },
  'cohere-embed': { name: 'Cohere Embed', vendor: 'Cohere', url: 'https://cohere.com/embed', free: true },
  jina: { name: 'Jina Embeddings', vendor: 'Elastic', url: 'https://jina.ai', free: true, open: true },
  pgvector: { name: 'pgvector', vendor: 'Community', url: 'https://github.com/pgvector/pgvector', free: true, open: true },
  qdrant: { name: 'Qdrant', vendor: 'Qdrant', url: 'https://qdrant.tech', free: true, open: true },
  pinecone: { name: 'Pinecone', vendor: 'Pinecone', url: 'https://www.pinecone.io', free: true },
  weaviate: { name: 'Weaviate', vendor: 'Weaviate', url: 'https://weaviate.io', free: true, open: true },
  chroma: { name: 'Chroma', vendor: 'Chroma', url: 'https://www.trychroma.com', free: true, open: true },
  langgraph: { name: 'LangGraph', vendor: 'LangChain', url: 'https://www.langchain.com/langgraph', free: true, open: true },
  'openai-agents-sdk': { name: 'OpenAI Agents SDK', vendor: 'OpenAI', url: 'https://openai.github.io/openai-agents-python', free: true, open: true },
  'claude-agent-sdk': { name: 'Claude Agent SDK', vendor: 'Anthropic', url: 'https://docs.claude.com/en/api/agent-sdk/overview', free: true, open: true },
  llamaindex: { name: 'LlamaIndex', vendor: 'LlamaIndex', url: 'https://www.llamaindex.ai', free: true, open: true },
  crewai: { name: 'CrewAI', vendor: 'CrewAI', url: 'https://www.crewai.com', free: true, open: true },
  mastra: { name: 'Mastra', vendor: 'Mastra', url: 'https://mastra.ai', free: true, open: true },
  mcp: { name: 'Model Context Protocol', vendor: 'Anthropic / community', url: 'https://modelcontextprotocol.io', free: true, open: true },
  composio: { name: 'Composio', vendor: 'Composio', url: 'https://composio.dev', free: true },
  smithery: { name: 'Smithery', vendor: 'Smithery', url: 'https://smithery.ai', free: true },
  langfuse: { name: 'Langfuse', vendor: 'Langfuse', url: 'https://langfuse.com', free: true, open: true },
  langsmith: { name: 'LangSmith', vendor: 'LangChain', url: 'https://www.langchain.com/langsmith', free: true },
  braintrust: { name: 'Braintrust', vendor: 'Braintrust', url: 'https://www.braintrust.dev', free: true },
  helicone: { name: 'Helicone', vendor: 'Helicone', url: 'https://www.helicone.ai', free: true, open: true },
  unsloth: { name: 'Unsloth', vendor: 'Unsloth', url: 'https://unsloth.ai', free: true, open: true },
  axolotl: { name: 'Axolotl', vendor: 'Axolotl', url: 'https://github.com/axolotl-ai-cloud/axolotl', free: true, open: true },
  openpipe: { name: 'OpenPipe', vendor: 'CoreWeave', url: 'https://openpipe.ai', free: false },
  runpod: { name: 'RunPod', vendor: 'RunPod', url: 'https://www.runpod.io', free: false },
  modal: { name: 'Modal', vendor: 'Modal', url: 'https://modal.com', free: true },
  lambda: { name: 'Lambda', vendor: 'Lambda', url: 'https://lambda.ai', free: false },
  'vast-ai': { name: 'Vast.ai', vendor: 'Vast.ai', url: 'https://vast.ai', free: false },
  // Safety
  gptzero: { name: 'GPTZero', vendor: 'GPTZero', url: 'https://gptzero.me', free: true },
  originality: { name: 'Originality.ai', vendor: 'Originality.ai', url: 'https://originality.ai', free: false },
  copyleaks: { name: 'Copyleaks', vendor: 'Copyleaks', url: 'https://copyleaks.com', free: true },
  turnitin: { name: 'Turnitin', vendor: 'Turnitin', url: 'https://www.turnitin.com', free: false },
  hive: { name: 'Hive AI Detection', vendor: 'Hive', url: 'https://thehive.ai', free: true },
  'reality-defender': { name: 'Reality Defender', vendor: 'Reality Defender', url: 'https://www.realitydefender.com', free: false },
  sensity: { name: 'Sensity', vendor: 'Sensity', url: 'https://sensity.ai', free: false },
  synthid: { name: 'SynthID Detector', vendor: 'Google DeepMind', url: 'https://deepmind.google/models/synthid', free: true },
  'proton-lumo': { name: 'Lumo', vendor: 'Proton', url: 'https://lumo.proton.me', free: true },
  'duckduckgo-ai': { name: 'Duck.ai', vendor: 'DuckDuckGo', url: 'https://duck.ai', free: true },
  venice: { name: 'Venice', vendor: 'Venice', url: 'https://venice.ai', free: true },
  // Fun
  'character-ai': { name: 'Character.AI', vendor: 'Character.AI', url: 'https://character.ai', free: true },
  replika: { name: 'Replika', vendor: 'Luka', url: 'https://replika.com', free: true },
  kindroid: { name: 'Kindroid', vendor: 'Kindroid', url: 'https://kindroid.ai', free: true },
  talkie: { name: 'Talkie', vendor: 'MiniMax', url: 'https://www.talkie-ai.com', free: true },
  'ai-dungeon': { name: 'AI Dungeon', vendor: 'Latitude', url: 'https://aidungeon.com', free: true },
  inworld: { name: 'Inworld', vendor: 'Inworld AI', url: 'https://inworld.ai', free: true },
  'infinite-craft': { name: 'Infinite Craft', vendor: 'Neal Agarwal', url: 'https://neal.fun/infinite-craft', free: true },
};

export function getSubcategory(slug: string): AiSubcategory | undefined {
  return AI_SUBCATEGORIES.find((s) => s.slug === slug);
}

/** URL-safe slug for tool names coming from leaderboards or the news. */
export function slugifyToolName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}
