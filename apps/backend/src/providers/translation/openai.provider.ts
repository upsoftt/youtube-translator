import { TranslationProvider, TranslationOptions } from './translation.interface';

/**
 * Платный провайдер перевода через OpenAI GPT-4o-mini.
 * Высокое качество перевода с учётом контекста.
 */
export class OpenAITranslationProvider implements TranslationProvider {
  readonly name = 'openai';

  private client: any = null;
  private targetLanguage = 'ru';
  private sourceLanguage = 'en';

  // Маппинг кодов языков в названия
  private static readonly languageNames: Record<string, string> = {
    ru: 'русский',
    en: 'английский',
    es: 'испанский',
    de: 'немецкий',
    fr: 'французский',
    zh: 'китайский',
    ja: 'японский',
    ko: 'корейский',
  };

  async initialize(options: TranslationOptions): Promise<void> {
    const apiKey = options.apiKey || '';
    if (!apiKey) {
      throw new Error('[OpenAI Translation] API ключ обязателен');
    }

    const { default: OpenAI } = await import('openai');
    this.client = new OpenAI({ apiKey });
    this.targetLanguage = options.targetLanguage || 'ru';
    this.sourceLanguage = options.sourceLanguage || 'en';
    console.log(`[OpenAI Translation] Инициализирован: ${this.sourceLanguage} → ${this.targetLanguage}`);
  }

  async translate(text: string): Promise<string> {
    if (!text || text.trim().length === 0) return '';
    if (!this.client) throw new Error('[OpenAI Translation] Провайдер не инициализирован');

    const targetLangName = OpenAITranslationProvider.languageNames[this.targetLanguage] || this.targetLanguage;

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Ты — профессиональный переводчик. Переведи текст на ${targetLangName} максимально кратко и точно, сохраняя смысл. Отвечай ТОЛЬКО переводом, без пояснений.`,
          },
          {
            role: 'user',
            content: text,
          },
        ],
        temperature: 0.3,
        max_tokens: 500,
      });

      return response.choices[0]?.message?.content?.trim() || text;
    } catch (error) {
      console.error('[OpenAI Translation] Ошибка перевода:', error);
      return text;
    }
  }

  async destroy(): Promise<void> {
    this.client = null;
    console.log('[OpenAI Translation] Завершён');
  }
}
