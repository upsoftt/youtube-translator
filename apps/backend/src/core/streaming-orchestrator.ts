import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { YouTubeStreamer } from './youtube-streamer';
import { DeepgramSTTProvider } from '../providers/stt/deepgram.provider';
import { OpenAITranslationProvider } from '../providers/translation/openai.provider';
import { DeepgramTTSProvider } from '../providers/tts/deepgram-tts.provider';
import { OpenAITTSProvider } from '../providers/tts/openai-tts.provider';
import { TTSProvider } from '../providers/tts/tts.interface';
import { GenderDetector } from '../utils/gender-detector';
import { TranslationSettings, TranslationSegment } from './orchestrator';
import { SpeakerGender } from '../providers/stt/stt.interface';
import { config } from '../config';
import { fetchYouTubeSubtitles, SubtitleSegment } from '../utils/youtube-subtitles';
import { getMp3Duration } from '../utils/mp3-duration';

/**
 * Стриминговый оркестратор — минимальная задержка через платные API.
 *
 * Поток:
 * 1. pause_video → клиент ставит видео на паузу
 * 2. YouTube Audio → DeepGram STT (streaming WebSocket) + GenderDetector (параллельно)
 * 3. Первый распознанный текст → OpenAI перевод → DeepGram TTS (с учётом пола)
 * 4. resume_video → клиент начинает воспроизведение
 * 5. Далее сегменты приходят в реальном времени с таймштампами
 */
export class StreamingOrchestrator extends EventEmitter {
  private youtubeStreamer: YouTubeStreamer;
  private sttProvider: DeepgramSTTProvider | null = null;
  private translationProvider: OpenAITranslationProvider | null = null;
  private ttsProvider: TTSProvider | null = null;
  private genderDetector: GenderDetector | null = null;
  private isRunning = false;
  private segmentCounter = 0;
  private firstSegmentSent = false;
  private playbackTime = 0;
  private currentVideoUrl = '';
  private currentSettings: TranslationSettings | null = null;
  private seekOffset = 0; // Смещение seek в секундах
  private usingSubtitles = false; // Используем субтитры вместо STT
  private subtitleSegments: SubtitleSegment[] = [];
  private subtitlePipelineVersion = 0; // Инкрементируется при seek — прерывает старый цикл
  private resumeTimeout: ReturnType<typeof setTimeout> | null = null;
  private resumeTimeoutMs = 15000; // Таймаут принудительного resume_video
  private consecutiveErrors = 0; // Счётчик ошибок подряд
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor() {
    super();
    this.youtubeStreamer = new YouTubeStreamer();
  }

  setPlaybackTime(timeSec: number): void {
    this.playbackTime = timeSec;
  }

  getPlaybackTime(): number {
    return this.playbackTime;
  }

  async start(videoUrl: string, settings: TranslationSettings): Promise<void> {
    if (this.isRunning) {
      await this.stop();
    }

    this.isRunning = true;
    this.segmentCounter = 0;
    this.firstSegmentSent = false;
    this.consecutiveErrors = 0;
    this.currentVideoUrl = videoUrl;
    this.currentSettings = settings;
    this.seekOffset = settings.seekTime || 0;
    this.usingSubtitles = false;
    this.subtitleSegments = [];

    try {
      // Говорим клиенту встать на паузу (спиннер)
      this.emit('pause_video');
      this.startResumeTimeout();
      this.emit('status', 'Инициализация провайдеров...');

      // 1. Инициализируем провайдеры перевода и TTS
      await this.initProviders(settings);

      // 2. Пробуем получить субтитры YouTube (если настройка включена)
      if (settings.preferSubtitles !== false) {
        this.emit('status', 'Инициализация провайдеров...');
        console.log('[StreamingOrch] Пробуем получить субтитры YouTube...');
        const subtitles = await fetchYouTubeSubtitles(videoUrl, 'en');
        if (subtitles && subtitles.length > 0) {
          this.usingSubtitles = true;
          this.subtitleSegments = subtitles;
          console.log(`[StreamingOrch] Субтитры YouTube получены: ${subtitles.length} сегментов`);
          this.emitProviderInfo('YouTube Subtitles');
          // Запускаем обработку субтитров
          this.emit('status', 'Запуск распознавания...');
          await this.startSubtitlePipeline(this.seekOffset);
          return;
        }
        console.log('[StreamingOrch] Субтитры недоступны, fallback на STT');
      }

      // 3. Fallback: STT через DeepGram
      this.emitProviderInfo('DeepGram STT');
      this.emit('status', 'Инициализация провайдеров...');
      await this.sttProvider!.waitReady();

      // 4. Запускаем аудио-стрим с позиции seek
      this.emit('status', 'Запуск распознавания...');
      await this.startPipeline(videoUrl, this.seekOffset);

    } catch (error) {
      console.error('[StreamingOrch] Ошибка запуска:', error);
      this.emit('error', `Ошибка: ${error instanceof Error ? error.message : String(error)}`);
      this.isRunning = false;
    }
  }

  private async initProviders(settings: TranslationSettings): Promise<void> {
    // Fallback на серверные ключи из .env если клиент не передал
    const deepgramKey = settings.apiKeys.deepgram || config.deepgramApiKey;
    const openaiKey = settings.apiKeys.openai || config.openaiApiKey;

    console.log(`[StreamingOrch] API Keys: deepgram=${deepgramKey ? 'YES' : 'MISSING'}, openai=${openaiKey ? 'YES' : 'MISSING'}`);

    if (!deepgramKey) {
      throw new Error('DeepGram API key не указан — задайте его в настройках или .env');
    }
    if (!openaiKey) {
      throw new Error('OpenAI API key не указан — задайте его в настройках или .env');
    }

    // STT — DeepGram streaming
    this.sttProvider = new DeepgramSTTProvider();
    await this.sttProvider.initialize({
      apiKey: deepgramKey,
      language: 'en',
    });

    // Translation — OpenAI
    this.translationProvider = new OpenAITranslationProvider();
    await this.translationProvider.initialize({
      apiKey: openaiKey,
      sourceLanguage: 'en',
      targetLanguage: settings.targetLanguage,
    });

    // TTS — OpenAI TTS для языков без поддержки DeepGram Aura-2, DeepGram для остальных
    const openaiTtsLanguages = ['ru', 'zh', 'ko'];
    if (openaiTtsLanguages.includes(settings.targetLanguage) && openaiKey) {
      this.ttsProvider = new OpenAITTSProvider();
      await this.ttsProvider.initialize({ apiKey: openaiKey, language: settings.targetLanguage });
    } else {
      this.ttsProvider = new DeepgramTTSProvider();
      await this.ttsProvider.initialize({ apiKey: deepgramKey, language: settings.targetLanguage });
    }

    // Gender Detector — параллельный MP3→PCM через ffmpeg + pitch анализ
    this.genderDetector = new GenderDetector();
    this.genderDetector.start();

    console.log('[StreamingOrch] Провайдеры + GenderDetector инициализированы');
  }

  private emitProviderInfo(sttSource: string): void {
    const ttsName = this.ttsProvider?.name || 'unknown';
    this.emit('provider_info', {
      stt: sttSource,
      translation: 'OpenAI GPT',
      tts: ttsName,
    });
  }

  /**
   * Pipeline на основе субтитров YouTube — без STT, без аудио-стрима.
   *
   * Обрабатывает сегменты с lookahead-буфером: не уходит вперёд более чем
   * на SUBTITLE_LOOKAHEAD_SEC секунд от текущей позиции воспроизведения.
   * Если видео на паузе — pipeline тоже ждёт, не тратя токены TTS.
   */
  private async startSubtitlePipeline(seekSec: number): Promise<void> {
    // Lookahead: обрабатываем не более чем на N секунд вперёд от playbackTime
    const SUBTITLE_LOOKAHEAD_SEC = 7;
    // Интервал опроса когда pipeline ждёт догонки видео (мс)
    const WAIT_POLL_MS = 2000;

    // Фиксируем версию при запуске — при seek она изменится и цикл прервётся
    const myVersion = this.subtitlePipelineVersion;

    // Фильтруем сегменты — только от позиции seek
    const relevantSegments = this.subtitleSegments.filter(
      s => s.startTime + s.duration > seekSec
    );

    console.log(`[StreamingOrch] Субтитры v${myVersion}: ${relevantSegments.length} сегментов от ${seekSec.toFixed(1)}s`);

    // Разбиваем на batch'ы по 3 сегмента
    const batches = chunkArray(relevantSegments, 3);

    for (const batch of batches) {
      // Прерываемся если сервер остановлен или пришёл новый seek (новая версия)
      if (!this.isRunning || this.subtitlePipelineVersion !== myVersion) return;

      // Первый сегмент batch'а определяет момент начала группы
      const batchStartTime = batch[0].startTime;

      // Ждём пока видео не приблизится к этой позиции (с учётом lookahead)
      while (this.isRunning && this.subtitlePipelineVersion === myVersion) {
        const currentPlayback = this.playbackTime;
        if (batchStartTime <= currentPlayback + SUBTITLE_LOOKAHEAD_SEC) break;

        console.log(
          `[StreamingOrch] Субтитры v${myVersion}: ждём playback (${currentPlayback.toFixed(1)}s), ` +
          `следующий batch @ ${batchStartTime.toFixed(1)}s (lookahead ${SUBTITLE_LOOKAHEAD_SEC}s)`
        );
        await new Promise(r => setTimeout(r, WAIT_POLL_MS));
      }

      // Повторная проверка после ожидания
      if (!this.isRunning || this.subtitlePipelineVersion !== myVersion) return;

      await Promise.all(
        batch.map(sub => this.processSegment(sub.text, sub.startTime, sub.duration, 'unknown'))
      );
    }

    if (this.isRunning && this.subtitlePipelineVersion === myVersion) {
      console.log(`[StreamingOrch] Субтитры v${myVersion}: все сегменты обработаны`);
    }
  }

  private async startPipeline(videoUrl: string, seekSec = 0): Promise<void> {
    let chunkCount = 0;

    this.youtubeStreamer.on('data', async (chunk: Buffer) => {
      if (!this.isRunning || !this.sttProvider) return;

      chunkCount++;
      if (chunkCount % 50 === 0) {
        console.log(`[StreamingOrch] Чанков: ${chunkCount}`);
      }

      // Подаём аудио и в DeepGram STT, и в GenderDetector параллельно
      this.genderDetector?.feedAudio(chunk);

      try {
        await this.sttProvider.processChunk(chunk, async (segment) => {
          // Берём текущий пол из детектора
          const gender = this.genderDetector?.getCurrentGender() || 'unknown';
          // DeepGram возвращает время относительно начала потока, прибавляем seekOffset
          const absoluteStart = segment.startTime + seekSec;
          await this.processSegment(segment.text, absoluteStart, segment.duration, gender);
        });
      } catch (error) {
        console.error('[StreamingOrch] Ошибка чанка:', error);
      }
    });

    this.youtubeStreamer.on('end', () => {
      console.log('[StreamingOrch] ffmpeg поток завершён (сегменты могут ещё обрабатываться)');
      // НЕ меняем статус — ffmpeg закончился, но сегменты ещё в pipeline STT→Translation→TTS
    });

    this.youtubeStreamer.on('error', (error: Error) => {
      this.emit('error', `Ошибка стрима: ${error.message}`);
    });

    await this.youtubeStreamer.startAudioStream(videoUrl, seekSec);
    this.emit('status', 'Запуск распознавания...');
  }

  private splitIntoSentences(text: string): string[] {
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

  private async processSegment(text: string, startTime: number, duration?: number, gender?: SpeakerGender): Promise<void> {
    if (!this.translationProvider || !this.ttsProvider || !this.isRunning) return;

    // Проверка лимита ошибок подряд
    if (this.consecutiveErrors >= StreamingOrchestrator.MAX_CONSECUTIVE_ERRORS) {
      console.error(`[StreamingOrch] ${this.consecutiveErrors} ошибок подряд — останавливаем трансляцию`);
      this.emit('error', `Трансляция остановлена: ${this.consecutiveErrors} ошибок подряд`);
      await this.stop();
      return;
    }

    // Перевод с 1 retry
    let translatedText: string | null = null;
    try {
      translatedText = await this.translationProvider.translate(text);
    } catch (error) {
      console.warn(`[StreamingOrch] Перевод fail #1, retry через 500мс:`, error);
      await new Promise(r => setTimeout(r, 500));
      try {
        translatedText = await this.translationProvider.translate(text);
      } catch (retryError) {
        console.error(`[StreamingOrch] Перевод fail #2, пропускаем сегмент @ ${startTime.toFixed(1)}s:`, retryError);
        this.consecutiveErrors++;
        return;
      }
    }

    if (!translatedText?.trim()) return;

    // Разбиваем на предложения
    const sentences = this.splitIntoSentences(translatedText);
    const segDuration = (duration || 5) / sentences.length;

    for (let i = 0; i < sentences.length; i++) {
      if (!this.isRunning) return;

      const sentenceText = sentences[i];
      const sentenceStartTime = startTime + i * segDuration;

      // TTS с 1 retry; при провале — отправляем сегмент без аудио (только субтитр)
      let audioBuffer: Buffer = Buffer.alloc(0);
      try {
        audioBuffer = await this.ttsProvider.synthesize(sentenceText, gender);
      } catch (error) {
        console.warn(`[StreamingOrch] TTS fail #1, retry через 500мс:`, error);
        await new Promise(r => setTimeout(r, 500));
        try {
          audioBuffer = await this.ttsProvider.synthesize(sentenceText, gender);
        } catch (retryError) {
          console.error(`[StreamingOrch] TTS fail #2, отправляем без аудио @ ${sentenceStartTime.toFixed(1)}s:`, retryError);
          this.consecutiveErrors++;
        }
      }

      // Измеряем реальную длину TTS аудио для rate-fitting на клиенте
      const audioDuration = audioBuffer.length > 0
        ? getMp3Duration(audioBuffer)
        : 0;

      const segment: TranslationSegment = {
        id: uuidv4(),
        text: sentenceText,
        startTime: sentenceStartTime,
        duration: segDuration,
        audioDuration,
        audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
      };

      this.segmentCounter++;
      // Успешный сегмент С аудио сбрасывает счётчик ошибок
      if (audioBuffer.length > 0) {
        this.consecutiveErrors = 0;
      }
      this.emit('segment', segment);

      if (!this.firstSegmentSent) {
        this.firstSegmentSent = true;
        this.clearResumeTimeout();
        this.emit('resume_video');
        this.emit('status', 'Перевод активен');
        console.log('[StreamingOrch] Первый сегмент → resume_video');
      }

      console.log(`[StreamingOrch] #${this.segmentCounter}: "${sentenceText.substring(0, 50)}" [${gender}] @ ${sentenceStartTime.toFixed(1)}s`);
    }
  }

  /**
   * Перемотка на новую позицию.
   *
   * Субтитровый режим: прерываем старый цикл через subtitlePipelineVersion,
   *   обновляем playbackTime и запускаем новый pipeline с нужной позиции.
   *   Это быстро (~мс) — субтитры уже загружены, не нужно пересоздавать STT.
   *
   * STT режим: останавливаем ffmpeg + DeepGram, пересоздаём с -ss offset.
   */
  async seekTo(timeSec: number): Promise<void> {
    if (!this.currentVideoUrl || !this.currentSettings) return;

    console.log(`[StreamingOrch] Seek → ${timeSec.toFixed(1)}s (mode: ${this.usingSubtitles ? 'subtitles' : 'stt'})`);
    this.clearResumeTimeout();
    this.firstSegmentSent = false;
    this.emit('pause_video');
    this.startResumeTimeout();

    if (this.usingSubtitles) {
      // --- Субтитровый режим ---
      // 1. Обновляем playbackTime немедленно — lookahead-ожидание разблокируется
      this.playbackTime = timeSec;
      // 2. Инкрементируем версию — текущий цикл startSubtitlePipeline увидит изменение
      //    и завершится на ближайшей проверке (в течение WAIT_POLL_MS)
      this.subtitlePipelineVersion++;
      const newVersion = this.subtitlePipelineVersion;

      console.log(`[StreamingOrch] Subtitle seek: версия ${newVersion}, старт с ${timeSec.toFixed(1)}s`);
      this.emit('status', 'Запуск распознавания...');

      // Небольшая пауза — даём старому циклу выйти на следующей итерации
      await new Promise(r => setTimeout(r, 100));

      if (!this.isRunning || this.subtitlePipelineVersion !== newVersion) return;

      // 3. Запускаем новый pipeline с новой позиции
      await this.startSubtitlePipeline(timeSec);
      return;
    }

    // --- STT режим ---
    this.emit('status', 'Инициализация провайдеров...');

    // Останавливаем текущий стрим и STT
    await this.youtubeStreamer.stopStream();
    this.youtubeStreamer.removeAllListeners();
    if (this.sttProvider) {
      await this.sttProvider.destroy();
    }
    if (this.genderDetector) {
      this.genderDetector.destroy();
    }

    // Пересоздаём STT и GenderDetector
    this.seekOffset = Math.max(0, timeSec - 1); // 1с до для контекста

    const deepgramKey = this.currentSettings.apiKeys.deepgram || config.deepgramApiKey;
    this.sttProvider = new DeepgramSTTProvider();
    await this.sttProvider.initialize({ apiKey: deepgramKey, language: 'en' });
    await this.sttProvider.waitReady();

    this.genderDetector = new GenderDetector();
    this.genderDetector.start();

    // Перезапускаем pipeline с новой позиции
    this.emit('status', 'Запуск распознавания...');
    await this.startPipeline(this.currentVideoUrl, this.seekOffset);
  }

  /**
   * Запускает таймаут принудительного resume_video.
   * Если за resumeTimeoutMs первый сегмент не отправлен — возобновляем видео.
   */
  private startResumeTimeout(): void {
    this.clearResumeTimeout();
    this.resumeTimeout = setTimeout(() => {
      if (!this.firstSegmentSent && this.isRunning) {
        this.firstSegmentSent = true;
        this.emit('resume_video');
        this.emit('status', 'Перевод активен');
        console.warn(`[StreamingOrch] TIMEOUT: resume_video forced after ${this.resumeTimeoutMs / 1000}s`);
      }
    }, this.resumeTimeoutMs);
  }

  private clearResumeTimeout(): void {
    if (this.resumeTimeout) {
      clearTimeout(this.resumeTimeout);
      this.resumeTimeout = null;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.clearResumeTimeout();
    await this.youtubeStreamer.stopStream();
    this.youtubeStreamer.removeAllListeners();

    if (this.genderDetector) {
      this.genderDetector.destroy();
      this.genderDetector = null;
    }

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

    console.log('[StreamingOrch] Остановлен');
  }
}

/** Разбивает массив на chunk'и заданного размера */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
