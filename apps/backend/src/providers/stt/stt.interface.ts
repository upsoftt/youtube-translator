/**
 * Интерфейс провайдера распознавания речи (Speech-to-Text).
 * Каждый провайдер реализует этот интерфейс.
 */

export type SpeakerGender = 'male' | 'female' | 'unknown';

export interface STTSegment {
  /** Распознанный текст */
  text: string;
  /** Время начала сегмента в секундах */
  startTime: number;
  /** Время окончания сегмента в секундах */
  endTime: number;
  /** Финальный ли это результат (не промежуточный) */
  isFinal: boolean;
  /** Определённый пол говорящего */
  gender?: SpeakerGender;
  /** Длительность сегмента в секундах (от DeepGram) */
  duration?: number;
}

export interface STTProviderOptions {
  /** Язык аудио (ISO код, например 'en', 'ru') */
  language?: string;
  /** API ключ (если требуется) */
  apiKey?: string;
  /** Callback для получения текущей позиции воспроизведения (сек) */
  getPlaybackTime?: () => number;
}

export interface STTProvider {
  /** Название провайдера */
  readonly name: string;

  /**
   * Обрабатывает аудио-чанк и возвращает распознанные сегменты.
   * @param audioChunk - буфер аудио-данных
   * @param onSegment - коллбэк при получении сегмента
   */
  processChunk(audioChunk: Buffer, onSegment: (segment: STTSegment) => void): Promise<void>;

  /**
   * Инициализация провайдера (открытие соединений и т.д.)
   */
  initialize(options: STTProviderOptions): Promise<void>;

  /**
   * Завершение работы провайдера
   */
  destroy(): Promise<void>;
}
