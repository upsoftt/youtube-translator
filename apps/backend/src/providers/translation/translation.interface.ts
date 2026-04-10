/**
 * Интерфейс провайдера перевода текста.
 * Каждый провайдер реализует этот интерфейс.
 */

export interface TranslationOptions {
  /** Исходный язык (ISO код) */
  sourceLanguage: string;
  /** Целевой язык (ISO код) */
  targetLanguage: string;
  /** API ключ (если требуется) */
  apiKey?: string;
}

export interface TranslationProvider {
  /** Название провайдера */
  readonly name: string;

  /**
   * Инициализация провайдера
   */
  initialize(options: TranslationOptions): Promise<void>;

  /**
   * Переводит текст
   * @param text - исходный текст
   * @returns переведённый текст
   */
  translate(text: string): Promise<string>;

  /**
   * Завершение работы провайдера
   */
  destroy(): Promise<void>;
}
