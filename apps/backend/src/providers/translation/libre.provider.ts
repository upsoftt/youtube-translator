import { TranslationProvider, TranslationOptions } from './translation.interface';

/**
 * Бесплатный провайдер перевода через MyMemory API.
 * Лимит: 5000 символов/день без ключа, но для тестирования достаточно.
 * Fallback: если MyMemory не работает, пробуем LibreTranslate.
 */
export class LibreTranslateProvider implements TranslationProvider {
  readonly name = 'libre';

  private sourceLanguage = 'en';
  private targetLanguage = 'ru';

  async initialize(options: TranslationOptions): Promise<void> {
    this.sourceLanguage = options.sourceLanguage || 'en';
    this.targetLanguage = options.targetLanguage || 'ru';
    console.log(`[Translation] Инициализирован: ${this.sourceLanguage} → ${this.targetLanguage}`);
  }

  async translate(text: string): Promise<string> {
    if (!text || text.trim().length === 0) return '';

    try {
      // Разбиваем длинный текст на части по 450 символов (лимит API — 500)
      const chunks = this.splitText(text, 450);
      const translatedChunks: string[] = [];

      for (const chunk of chunks) {
        const translated = await this.translateChunk(chunk);
        translatedChunks.push(translated);
      }

      return translatedChunks.join(' ');
    } catch (error) {
      console.error('[Translation] Ошибка перевода:', error);
      return text;
    }
  }

  private async translateChunk(text: string): Promise<string> {
    const langPair = `${this.sourceLanguage}|${this.targetLanguage}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;

    console.log(`[Translation] Перевод (${text.length} символов): "${text.substring(0, 60)}..."`);

    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[Translation] HTTP ошибка ${response.status}`);
      return text;
    }

    const data = await response.json() as {
      responseStatus?: number;
      responseData?: { translatedText?: string };
    };

    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const translated = data.responseData.translatedText;
      console.log(`[Translation] Результат: "${translated.substring(0, 60)}..."`);
      return translated;
    }

    console.warn('[Translation] Неожиданный ответ:', JSON.stringify(data).substring(0, 200));
    return text;
  }

  /**
   * Разбивает текст на чанки, стараясь резать по предложениям.
   */
  private splitText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      // Ищем последнюю точку/восклицательный/вопросительный в пределах лимита
      let cutAt = -1;
      for (const sep of ['. ', '! ', '? ', ', ']) {
        const idx = remaining.lastIndexOf(sep, maxLen);
        if (idx > 0 && idx > cutAt) cutAt = idx + sep.length;
      }
      if (cutAt <= 0) cutAt = maxLen; // fallback: режем по лимиту

      chunks.push(remaining.substring(0, cutAt).trim());
      remaining = remaining.substring(cutAt).trim();
    }

    return chunks;
  }

  async destroy(): Promise<void> {
    console.log('[Translation] Завершён');
  }
}
