import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import { YouTubeStreamer } from './youtube-streamer';
import { DeepgramSTTProvider } from '../providers/stt/deepgram.provider';
import { OpenAITranslationProvider } from '../providers/translation/openai.provider';
import { DeepgramTTSProvider } from '../providers/tts/deepgram-tts.provider';
import { OpenAITTSProvider } from '../providers/tts/openai-tts.provider';
import { EdgeTTSProvider } from '../providers/tts/edge-tts.provider';
import { CosyVoiceTTSProvider } from '../providers/tts/cosyvoice-tts.provider';
import { ElevenLabsTTSProvider } from '../providers/tts/elevenlabs-tts.provider';
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
  // --- Константы ---
  /** Максимальное количество ошибок подряд до остановки трансляции */
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;
  /** Таймаут принудительного resume_video (мс) */
  private static readonly RESUME_TIMEOUT_MS = 15000;
  /** Lookahead: обрабатываем не более чем на N секунд вперёд от playbackTime */
  private static readonly SUBTITLE_LOOKAHEAD_SEC = 15;
  /** Интервал опроса когда pipeline ждёт догонки видео (мс) */
  private static readonly WAIT_POLL_MS = 500;
  /** Задержка перед retry при ошибке перевода/TTS (мс) */
  private static readonly RETRY_DELAY_MS = 500;
  /** Длительность сегмента по умолчанию если не указана (сек) */
  private static readonly DEFAULT_SEGMENT_DURATION_SEC = 5;
  /** Сколько секунд "в прошлом" допускается для сегмента */
  private static readonly STALE_SEGMENT_THRESHOLD_SEC = 1;
  /** Секунд контекста перед seek-позицией */
  private static readonly SEEK_CONTEXT_SEC = 1;
  /** Пауза между seek и стартом нового pipeline (мс) */
  private static readonly SEEK_SETTLE_MS = 100;
  /** Длительность голосового сэмпла для клонирования (сек) */
  private static readonly VOICE_SAMPLE_DURATION_SEC = 15;

  // --- Состояние ---
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
  private seekOffset = 0;
  private usingSubtitles = false;
  private subtitleSegments: SubtitleSegment[] = [];
  private subtitlePipelineVersion = 0;
  private resumeTimeout: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;

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

    // TTS — выбирается по settings.ttsProvider (модульный реестр)
    const cfg = settings.ttsProviderConfig || {};

    // Если выбран CosyVoice с клонированием голоса — извлекаем сэмпл
    let referenceAudio: Buffer | undefined;
    if (settings.voiceClone && settings.ttsProvider === 'cosyvoice') {
      console.log('[StreamingOrch] Извлекаем голосовой сэмпл...');
      referenceAudio = await this.extractVoiceSample(this.currentVideoUrl, StreamingOrchestrator.VOICE_SAMPLE_DURATION_SEC);
    }

    switch (settings.ttsProvider) {
      case 'openai-tts':
        this.ttsProvider = new OpenAITTSProvider();
        await this.ttsProvider.initialize({ apiKey: cfg.apiKey || openaiKey, language: settings.targetLanguage });
        break;

      case 'cosyvoice': {
        const cosyProvider = new CosyVoiceTTSProvider();
        await cosyProvider.initialize({
          serverUrl:      cfg.serverUrl || config.cosyvoiceUrl,
          apiKey:         cfg.apiKey    || config.cosyvoiceApiKey,
          language:       settings.targetLanguage,
          referenceAudio,
        });
        this.ttsProvider = cosyProvider;
        break;
      }

      case 'elevenlabs':
        this.ttsProvider = new ElevenLabsTTSProvider();
        await this.ttsProvider.initialize({
          apiKey: cfg.apiKey,
          voice: cfg.voiceId,
          language: settings.targetLanguage,
        });
        break;

      case 'deepgram-tts':
        this.ttsProvider = new DeepgramTTSProvider();
        await this.ttsProvider.initialize({ apiKey: cfg.apiKey || deepgramKey, language: settings.targetLanguage });
        break;

      case 'edge-tts':
        this.ttsProvider = new EdgeTTSProvider();
        await this.ttsProvider.initialize({ language: settings.targetLanguage });
        break;

      default: {
        // Умолчание: для ru/zh/ko — OpenAI, для остальных — DeepGram (обратная совместимость)
        const openaiTtsLanguages = ['ru', 'zh', 'ko'];
        if (openaiTtsLanguages.includes(settings.targetLanguage) && openaiKey) {
          this.ttsProvider = new OpenAITTSProvider();
          await this.ttsProvider.initialize({ apiKey: openaiKey, language: settings.targetLanguage });
        } else {
          this.ttsProvider = new DeepgramTTSProvider();
          await this.ttsProvider.initialize({ apiKey: deepgramKey, language: settings.targetLanguage });
        }
        break;
      }
    }

    // Gender Detector — параллельный MP3→PCM через ffmpeg + pitch анализ
    this.genderDetector = new GenderDetector();
    this.genderDetector.start();

    console.log(`[StreamingOrch] TTS провайдер: ${this.ttsProvider?.name} (запрошен: ${settings.ttsProvider})`);
    console.log('[StreamingOrch] Провайдеры + GenderDetector инициализированы');
  }

  /**
   * Извлекает аудио-сэмпл из начала видео через yt-dlp + ffmpeg.
   * Используется для zero-shot клонирования голоса через CosyVoice.
   */
  private extractVoiceSample(videoUrl: string, durationSec: number): Promise<Buffer> {
    return new Promise((resolve) => {
      const ytdlp = spawn(config.ytdlpPath, ['-f', 'bestaudio', '-g', '--no-playlist', videoUrl]);
      let audioUrl = '';
      ytdlp.stdout.on('data', (d: Buffer) => { audioUrl += d.toString(); });
      ytdlp.on('close', (code) => {
        if (code !== 0 || !audioUrl.trim()) {
          console.warn('[StreamingOrch] Не удалось получить URL аудио для сэмпла');
          resolve(Buffer.alloc(0));
          return;
        }
        const url = audioUrl.trim().split('\n')[0];
        const chunks: Buffer[] = [];
        const ffmpeg = spawn(config.ffmpegPath, [
          '-i', url, '-t', String(durationSec),
          '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        ffmpeg.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        ffmpeg.on('close', () => {
          const buf = Buffer.concat(chunks);
          console.log(`[StreamingOrch] Голосовой сэмпл: ${buf.length} байт`);
          resolve(buf.length > 0 ? buf : Buffer.alloc(0));
        });
        ffmpeg.on('error', () => resolve(Buffer.alloc(0)));
      });
      ytdlp.on('error', () => resolve(Buffer.alloc(0)));
    });
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
    const SUBTITLE_LOOKAHEAD_SEC = StreamingOrchestrator.SUBTITLE_LOOKAHEAD_SEC;
    const WAIT_POLL_MS = StreamingOrchestrator.WAIT_POLL_MS;

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

      // Обрабатываем сегменты последовательно — порядок по таймкодам критичен для клиента
      for (const sub of batch) {
        if (!this.isRunning || this.subtitlePipelineVersion !== myVersion) return;
        await this.processSegment(sub.text, sub.startTime, sub.duration, 'unknown');
      }
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

  private async processSegment(text: string, startTime: number, duration?: number, gender?: SpeakerGender): Promise<void> {
    if (!this.translationProvider || !this.ttsProvider || !this.isRunning) return;

    // Пропускаем сегменты, которые уже полностью в прошлом
    const segEndTime = startTime + (duration || StreamingOrchestrator.DEFAULT_SEGMENT_DURATION_SEC);
    if (this.firstSegmentSent && segEndTime < this.playbackTime - StreamingOrchestrator.STALE_SEGMENT_THRESHOLD_SEC) {
      console.log(`[StreamingOrch] Пропуск устаревшего сегмента @ ${startTime.toFixed(1)}s (video @ ${this.playbackTime.toFixed(1)}s)`);
      return;
    }

    // Проверка лимита ошибок подряд
    if (this.consecutiveErrors >= StreamingOrchestrator.MAX_CONSECUTIVE_ERRORS) {
      console.error(`[StreamingOrch] ${this.consecutiveErrors} ошибок подряд — останавливаем трансляцию`);
      this.emit('error', `Трансляция остановлена: ${this.consecutiveErrors} ошибок подряд`);
      await this.stop();
      return;
    }

    // Перевод с 1 retry
    if (!this.firstSegmentSent) this.emit('status', 'Перевод текста…');
    let translatedText: string | null = null;
    try {
      translatedText = await this.translationProvider.translate(text);
    } catch (error) {
      console.warn(`[StreamingOrch] Перевод fail #1, retry через 500мс:`, error);
      await new Promise(r => setTimeout(r, StreamingOrchestrator.RETRY_DELAY_MS));
      try {
        translatedText = await this.translationProvider.translate(text);
      } catch (retryError) {
        console.error(`[StreamingOrch] Перевод fail #2, пропускаем сегмент @ ${startTime.toFixed(1)}s:`, retryError);
        this.consecutiveErrors++;
        return;
      }
    }

    if (!translatedText?.trim()) return;

    const segDuration = duration || StreamingOrchestrator.DEFAULT_SEGMENT_DURATION_SEC;

    // TTS с 1 retry; при провале — отправляем сегмент без аудио (только субтитр)
    if (!this.firstSegmentSent) this.emit('status', 'Озвучивание…');
    let audioBuffer: Buffer = Buffer.alloc(0);
    try {
      audioBuffer = await this.ttsProvider.synthesize(translatedText, gender);
    } catch (error) {
      console.warn(`[StreamingOrch] TTS fail #1, retry через 500мс:`, error);
      await new Promise(r => setTimeout(r, StreamingOrchestrator.RETRY_DELAY_MS));
      try {
        audioBuffer = await this.ttsProvider.synthesize(translatedText, gender);
      } catch (retryError) {
        console.error(`[StreamingOrch] TTS fail #2, отправляем без аудио @ ${startTime.toFixed(1)}s:`, retryError);
        this.consecutiveErrors++;
      }
    }

    // Измеряем реальную длину TTS аудио для rate-fitting на клиенте
    const audioDuration = audioBuffer.length > 0
      ? getMp3Duration(audioBuffer)
      : 0;

    const segment: TranslationSegment = {
      id: uuidv4(),
      text: translatedText,
      startTime,
      duration: segDuration,
      audioDuration,
      audioBase64: audioBuffer.length > 0 ? audioBuffer.toString('base64') : '',
    };

    this.segmentCounter++;
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

    console.log(`[StreamingOrch] #${this.segmentCounter}: "${translatedText.substring(0, 50)}" [${gender}] @ ${startTime.toFixed(1)}s dur=${segDuration.toFixed(1)}s audioDur=${audioDuration.toFixed(1)}s (video @ ${this.playbackTime.toFixed(1)}s)`);
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
      await new Promise(r => setTimeout(r, StreamingOrchestrator.SEEK_SETTLE_MS));

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
    this.seekOffset = Math.max(0, timeSec - StreamingOrchestrator.SEEK_CONTEXT_SEC);

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
        console.warn(`[StreamingOrch] TIMEOUT: resume_video forced after ${StreamingOrchestrator.RESUME_TIMEOUT_MS / 1000}s`);
      }
    }, StreamingOrchestrator.RESUME_TIMEOUT_MS);
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

    // Очищаем кэш субтитров
    this.subtitleSegments = [];
    this.currentSettings = null;

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
