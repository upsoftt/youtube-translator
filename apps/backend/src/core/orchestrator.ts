import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { YouTubeStreamer } from './youtube-streamer';
import { STTProvider, SpeakerGender } from '../providers/stt/stt.interface';
import { TranslationProvider } from '../providers/translation/translation.interface';
import { TTSProvider } from '../providers/tts/tts.interface';
import { WhisperProvider } from '../providers/stt/whisper.provider';
import { LocalWhisperProvider } from '../providers/stt/local-whisper.provider';
import { DeepgramSTTProvider } from '../providers/stt/deepgram.provider';
import { LibreTranslateProvider } from '../providers/translation/libre.provider';
import { OpenAITranslationProvider } from '../providers/translation/openai.provider';
import { EdgeTTSProvider } from '../providers/tts/edge-tts.provider';
import { DeepgramTTSProvider } from '../providers/tts/deepgram-tts.provider';
import { config } from '../config';
import { getMp3Duration } from '../utils/mp3-duration';

/**
 * Настройки сессии перевода от клиента
 */
export interface TranslationSettings {
  targetLanguage: string;
  sttProvider: string;
  translationProvider: string;
  ttsProvider: string;
  translationMode?: 'free' | 'streaming';
  seekTime?: number;
  preferSubtitles?: boolean;
  apiKeys: {
    deepgram?: string;
    openai?: string;
  };
}

/**
 * Сегмент перевода для отправки клиенту
 */
export interface TranslationSegment {
  id: string;
  text: string;
  startTime: number;
  duration: number;      // Длительность оригинального сегмента (секунды видео)
  audioDuration: number; // Реальная длительность TTS аудио (секунды при 1x)
  audioBase64: string;
}

/**
 * Оркестратор — координирует весь конвейер обработки:
 * YouTube Audio → STT → Translation → TTS → Клиент
 */
export class Orchestrator extends EventEmitter {
  private youtubeStreamer: YouTubeStreamer;
  private sttProvider: STTProvider | null = null;
  private translationProvider: TranslationProvider | null = null;
  private ttsProvider: TTSProvider | null = null;
  private isRunning = false;
  private segmentCounter = 0;
  private playbackTime = 0; // Текущая позиция воспроизведения на клиенте (секунды)

  constructor() {
    super();
    this.youtubeStreamer = new YouTubeStreamer();
  }

  /**
   * Обновляет текущую позицию воспроизведения (от клиента).
   */
  setPlaybackTime(timeSec: number): void {
    this.playbackTime = timeSec;
  }

  getPlaybackTime(): number {
    return this.playbackTime;
  }

  /**
   * Запускает конвейер перевода
   */
  async start(videoUrl: string, settings: TranslationSettings): Promise<void> {
    if (this.isRunning) {
      await this.stop();
    }

    this.isRunning = true;
    this.segmentCounter = 0;

    try {
      // 1. Инициализируем провайдеры
      this.emit('status', 'Инициализация провайдеров...');
      await this.initializeProviders(settings);

      // 2. Получаем прямой URL видео
      this.emit('status', 'Получение ссылки на видео...');
      try {
        const directVideoUrl = await this.youtubeStreamer.getVideoUrl(videoUrl);
        this.emit('video_url', directVideoUrl);
      } catch (error) {
        console.error('[Оркестратор] Не удалось получить URL видео:', error);
        this.emit('error', 'Не удалось получить ссылку на видео. Проверьте URL.');
        return;
      }

      // 3. Запускаем аудио-стрим и конвейер обработки
      this.emit('status', 'Запуск распознавания...');
      this.startPipeline(videoUrl);

    } catch (error) {
      console.error('[Оркестратор] Ошибка запуска:', error);
      this.emit('error', `Ошибка запуска: ${error instanceof Error ? error.message : String(error)}`);
      this.isRunning = false;
    }
  }

  /**
   * Инициализирует провайдеры на основе настроек клиента
   */
  private async initializeProviders(settings: TranslationSettings): Promise<void> {
    // Fallback на серверные ключи из .env
    const deepgramKey = settings.apiKeys.deepgram || config.deepgramApiKey;
    const openaiKey = settings.apiKeys.openai || config.openaiApiKey;

    // STT провайдер
    switch (settings.sttProvider) {
      case 'deepgram':
        this.sttProvider = new DeepgramSTTProvider();
        await this.sttProvider.initialize({
          apiKey: deepgramKey,
          language: 'en', // Исходный язык видео
        });
        break;
      case 'local-whisper':
        this.sttProvider = new LocalWhisperProvider();
        await this.sttProvider.initialize({ language: 'en', getPlaybackTime: () => this.playbackTime });
        break;
      case 'whisper':
      default:
        this.sttProvider = new WhisperProvider();
        await this.sttProvider.initialize({ language: 'en' });
        break;
    }

    // Translation провайдер
    switch (settings.translationProvider) {
      case 'openai':
        this.translationProvider = new OpenAITranslationProvider();
        await this.translationProvider.initialize({
          apiKey: openaiKey,
          sourceLanguage: 'en',
          targetLanguage: settings.targetLanguage,
        });
        break;
      case 'libre':
      default:
        this.translationProvider = new LibreTranslateProvider();
        await this.translationProvider.initialize({
          sourceLanguage: 'en',
          targetLanguage: settings.targetLanguage,
        });
        break;
    }

    // TTS провайдер
    switch (settings.ttsProvider) {
      case 'deepgram-tts':
        this.ttsProvider = new DeepgramTTSProvider();
        await this.ttsProvider.initialize({
          apiKey: deepgramKey,
          language: settings.targetLanguage,
        });
        break;
      case 'edge-tts':
      default:
        this.ttsProvider = new EdgeTTSProvider();
        await this.ttsProvider.initialize({
          language: settings.targetLanguage,
        });
        break;
    }

    console.log(`[Оркестратор] Провайдеры: STT=${this.sttProvider.name}, ` +
      `Translation=${this.translationProvider.name}, TTS=${this.ttsProvider.name}`);
  }

  /**
   * Запускает конвейер: Audio Stream → STT → Translation → TTS
   */
  private async startPipeline(videoUrl: string): Promise<void> {
    let chunkCount = 0;
    // Обработчик аудио-чанков от YouTube
    this.youtubeStreamer.on('data', async (chunk: Buffer) => {
      if (!this.isRunning || !this.sttProvider) return;
      
      chunkCount++;
      if (chunkCount % 50 === 0) {
        console.log(`[Оркестратор] Получено чанков от YouTube: ${chunkCount} (размер: ${chunk.length} байт)`);
      }

      try {
        await this.sttProvider.processChunk(chunk, async (segment) => {
          console.log(`[Оркестратор] STT распознал текст: "${segment.text}" (${segment.gender || 'unknown'})`);
          await this.processSegment(segment.text, segment.startTime, segment.gender);
        });
      } catch (error) {
        console.error('[Оркестратор] Ошибка обработки чанка:', error);
      }
    });

    this.youtubeStreamer.on('end', () => {
      console.log('[Оркестратор] Аудио-стрим завершён');
      this.emit('status', 'Стрим завершён');
    });

    this.youtubeStreamer.on('error', (error: Error) => {
      console.error('[Оркестратор] Ошибка стрима:', error.message);
      this.emit('error', `Ошибка аудио-стрима: ${error.message}`);
    });

    // Запускаем аудио-стрим
    await this.youtubeStreamer.startAudioStream(videoUrl);
    this.emit('status', 'Перевод активен');
  }

  /**
   * Разбивает длинный текст на предложения для более равномерных субтитров.
   * Каждый кусок — 1-2 предложения, не больше ~120 символов.
   */
  private splitIntoSentences(text: string): string[] {
    // Разбиваем по концу предложения
    const raw = text.match(/[^.!?]+[.!?]+/g) || [text];
    const result: string[] = [];
    let current = '';

    for (const sentence of raw) {
      const trimmed = sentence.trim();
      if (!trimmed) continue;

      if (current.length + trimmed.length > 120 && current.length > 0) {
        result.push(current.trim());
        current = trimmed;
      } else {
        current += (current ? ' ' : '') + trimmed;
      }
    }
    if (current.trim()) result.push(current.trim());

    return result.length > 0 ? result : [text];
  }

  /**
   * Обрабатывает один сегмент: перевод → TTS → отправка клиенту.
   * Длинные тексты разбиваются на предложения.
   */
  private async processSegment(text: string, startTime: number, gender?: SpeakerGender): Promise<void> {
    if (!this.translationProvider || !this.ttsProvider) return;

    // Ограничение опережения: ждём, пока плеер догонит (макс 10 секунд ожидания)
    const MAX_AHEAD_SEC = 5;
    const MAX_WAIT_MS = 10000;
    if (startTime > this.playbackTime + MAX_AHEAD_SEC && this.playbackTime > 0) {
      const waitStart = Date.now();
      while (startTime > this.playbackTime + MAX_AHEAD_SEC && this.isRunning) {
        if (Date.now() - waitStart > MAX_WAIT_MS) {
          console.log(`[Оркестратор] Таймаут ожидания плеера, продолжаем (audio=${startTime.toFixed(1)}с, playback=${this.playbackTime.toFixed(1)}с)`);
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!this.isRunning) return;
    }

    try {
      // Перевод текста
      const translatedText = await this.translationProvider.translate(text);
      if (!translatedText || translatedText.trim().length === 0) return;

      // Разбиваем длинный перевод на предложения
      const sentences = this.splitIntoSentences(translatedText);
      const durationPerSentence = 5 / sentences.length; // Распределяем startTime

      for (let i = 0; i < sentences.length; i++) {
        if (!this.isRunning) return;

        const sentenceText = sentences[i];
        const sentenceStartTime = startTime + i * durationPerSentence;

        // Синтез речи для каждого предложения (с учётом пола говорящего)
        const audioBuffer = await this.ttsProvider.synthesize(sentenceText, gender);

        const audioDuration = audioBuffer.length > 0
          ? getMp3Duration(audioBuffer)
          : 0;

        const segment: TranslationSegment = {
          id: uuidv4(),
          text: sentenceText,
          startTime: sentenceStartTime,
          duration: durationPerSentence,
          audioDuration,
          audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
        };

        this.segmentCounter++;
        this.emit('segment', segment);

        console.log(`[Оркестратор] Сегмент #${this.segmentCounter}: "${sentenceText.substring(0, 60)}" @ ${sentenceStartTime.toFixed(1)}с`);
      }
    } catch (error) {
      console.error('[Оркестратор] Ошибка обработки сегмента:', error);
    }
  }

  /**
   * Останавливает конвейер
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.youtubeStreamer.stopStream();
    this.youtubeStreamer.removeAllListeners();

    if (this.sttProvider) {
      await this.sttProvider.destroy();
      this.sttProvider = null;
    }
    if (this.translationProvider) {
      await this.translationProvider.destroy();
      this.translationProvider = null;
    }
    if (this.ttsProvider) {
      await this.ttsProvider.destroy();
      this.ttsProvider = null;
    }

    console.log('[Оркестратор] Конвейер остановлен');
  }
}
