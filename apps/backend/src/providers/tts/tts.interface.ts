/**
 * Интерфейс провайдера синтеза речи (Text-to-Speech).
 * Каждый провайдер реализует этот интерфейс.
 */

export interface TTSOptions {
  /** Язык синтеза (ISO код) */
  language: string;
  /** Голос (название или ID) */
  voice?: string;
  /** API ключ (если требуется) */
  apiKey?: string;
}

export type SpeakerGender = 'male' | 'female' | 'unknown';

export interface TTSProvider {
  /** Название провайдера */
  readonly name: string;

  /**
   * Инициализация провайдера
   */
  initialize(options: TTSOptions): Promise<void>;

  /**
   * Синтезирует речь из текста
   * @param text - текст для озвучивания
   * @param gender - пол говорящего для выбора голоса
   * @returns буфер аудио-данных (MP3)
   */
  synthesize(text: string, gender?: SpeakerGender): Promise<Buffer>;

  /**
   * Завершение работы провайдера
   */
  destroy(): Promise<void>;
}
