import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { STTProvider, STTProviderOptions, STTSegment, SpeakerGender } from './stt.interface';
import { config } from '../../config';

/**
 * Локальный STT провайдер на основе whisper.cpp (через pywhispercpp).
 * Запускает Python-воркер в subprocess и передает ему аудио для распознавания на GPU.
 *
 * Архитектура потока данных:
 * YouTube (MP3 chunks) → ffmpeg (persistent pipe, MP3→PCM) → PCM buffer → whisper worker
 *
 * ffmpeg запускается один раз и работает как постоянный конвертер потока,
 * а не перезапускается на каждый чанк (иначе чанки из середины MP3 потока невалидны).
 */
export class LocalWhisperProvider implements STTProvider {
  readonly name = 'local-whisper';

  private workerProcess: ChildProcess | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private language = 'ru';
  private pcmBuffer: Buffer[] = [];
  private pcmBufferSize = 0;
  private readonly pcmChunkThreshold = 320000; // ~5 сек при 16kHz float32 mono (64KB/сек)
  private readonly pcmChunkMax = 1920000; // ~30 сек максимум на один чанк
  private currentTime = 0;
  private processing = false;
  private modelPath: string;
  private pythonPath: string;
  private responseBuffer = '';
  private onSegmentCallback: ((segment: STTSegment) => void) | null = null;
  private getPlaybackTime: (() => number) | null = null;
  private pacingWaitStart: number | null = null;

  constructor() {
    this.modelPath = path.join(process.cwd(), 'models', 'ggml', 'ggml-base.bin');

    // Используем локальный venv Python 3.10
    const localVenvPython = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
    const envPython = process.env.PYTHON_PATH;

    if (envPython && fs.existsSync(envPython)) {
      this.pythonPath = envPython;
    } else if (fs.existsSync(localVenvPython)) {
      this.pythonPath = localVenvPython;
    } else {
      this.pythonPath = 'python';
    }
  }

  async initialize(options: STTProviderOptions): Promise<void> {
    this.language = options.language || 'ru';
    this.pcmBuffer = [];
    this.pcmBufferSize = 0;
    this.currentTime = 0;
    this.responseBuffer = '';
    this.getPlaybackTime = options.getPlaybackTime || null;

    await this.startWorker();
    this.startFfmpeg();

    console.log(`[LocalWhisper] Инициализирован, язык: ${this.language}`);
  }

  /**
   * Запускает постоянный ffmpeg процесс для конвертации MP3→PCM.
   * MP3 данные пишутся в stdin, PCM читается из stdout.
   */
  private startFfmpeg(): void {
    const ffmpegPath = config.ffmpegPath;
    if (!ffmpegPath) {
      throw new Error('[LocalWhisper] ffmpeg path not configured');
    }

    console.log(`[LocalWhisper] Запуск ffmpeg: ${ffmpegPath}`);

    this.ffmpegProcess = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', 'pipe:0',        // читаем MP3 из stdin
      '-f', 'f32le',         // выход: raw float32
      '-acodec', 'pcm_f32le',
      '-ar', '16000',        // 16kHz
      '-ac', '1',            // mono
      'pipe:1'               // пишем PCM в stdout
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Читаем PCM данные из ffmpeg stdout — накапливаем в буфер
    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
      this.pcmBuffer.push(chunk);
      this.pcmBufferSize += chunk.length;

      // Когда набралось достаточно PCM — отправляем на распознавание
      if (this.pcmBufferSize >= this.pcmChunkThreshold && !this.processing) {
        this.processAccumulatedPcm();
      }
    });

    this.ffmpegProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`[LocalWhisper/ffmpeg] ${msg}`);
      }
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`[LocalWhisper] ffmpeg завершился, код: ${code}`);
      // Обработать оставшийся буфер
      if (this.pcmBufferSize > 16000) { // минимум ~0.25 сек
        this.processAccumulatedPcm();
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('[LocalWhisper] Ошибка ffmpeg:', err.message);
    });

    this.ffmpegProcess.stdin?.on('error', () => {
      // Игнорируем write EOF при закрытии
    });

    console.log('[LocalWhisper] ffmpeg запущен (persistent pipe MP3→PCM)');
  }

  private async startWorker(): Promise<void> {
    if (this.workerProcess) return;

    const workerScript = path.join(process.cwd(), 'lib', 'whisper', 'whisper_worker.py');

    if (!fs.existsSync(this.pythonPath)) {
      throw new Error(`[LocalWhisper] Python не найден: ${this.pythonPath}`);
    }
    if (!fs.existsSync(workerScript)) {
      throw new Error(`[LocalWhisper] Worker script не найден: ${workerScript}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`[LocalWhisper] Модель не найдена: ${this.modelPath}`);
    }

    console.log(`[LocalWhisper] Запуск воркера: ${this.pythonPath} ${workerScript}`);

    this.workerProcess = spawn(this.pythonPath, ['-u', workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      }
    });

    this.workerProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.log(`[LocalWhisper/stderr] ${text}`);
    });

    this.workerProcess.on('error', (err) => {
      console.error('[LocalWhisper] Ошибка запуска воркера:', err);
    });

    this.workerProcess.on('exit', (code) => {
      console.log(`[LocalWhisper] Воркер завершился с кодом ${code}`);
      this.workerProcess = null;
    });

    this.workerProcess.stdin?.on('error', () => {});

    // Ждём "ready" от воркера
    const readyResp = await this.readResponse(30000);
    if (!readyResp?.ok) {
      throw new Error(`[LocalWhisper] Worker failed to start: ${JSON.stringify(readyResp)}`);
    }
    console.log('[LocalWhisper] Worker готов');

    // Загружаем модель
    const loadResp = await this.sendCommand({
      cmd: 'load',
      model_path: this.modelPath,
      model_name: 'base',
    });
    console.log(`[LocalWhisper] Модель загружена за ${loadResp.load_time_ms?.toFixed(0)}ms`);
  }

  private async sendCommand(cmd: any): Promise<any> {
    if (!this.workerProcess?.stdin) {
      throw new Error('Worker process not available');
    }
    this.workerProcess.stdin.write(JSON.stringify(cmd) + '\n');
    return this.readResponse(300000);
  }

  private readResponse(timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.workerProcess?.stdout) {
        return reject(new Error('Worker stdout not available'));
      }

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Worker response timeout'));
      }, timeoutMs);

      const onData = (data: Buffer) => {
        this.responseBuffer += data.toString();
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('{')) continue;
          try {
            const resp = JSON.parse(trimmed);
            cleanup();
            resolve(resp);
            return;
          } catch {
            // Не JSON
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.workerProcess?.stdout?.removeListener('data', onData);
      };

      this.workerProcess.stdout.on('data', onData);
    });
  }

  /**
   * Принимает MP3 чанк от YouTubeStreamer и пишет его в ffmpeg stdin.
   * ffmpeg конвертирует в PCM и выдаёт через stdout → pcmBuffer.
   */
  async processChunk(audioChunk: Buffer, onSegment: (segment: STTSegment) => void): Promise<void> {
    this.onSegmentCallback = onSegment;

    // Пишем MP3 данные в ffmpeg — он сам конвертирует
    if (this.ffmpegProcess?.stdin?.writable) {
      try {
        this.ffmpegProcess.stdin.write(audioChunk);
      } catch (err) {
        console.error('[LocalWhisper] Ошибка записи в ffmpeg:', err);
      }
    }
  }

  /**
   * Обрабатывает накопленные PCM данные — отправляет на распознавание.
   */
  private async processAccumulatedPcm(): Promise<void> {
    if (this.pcmBuffer.length === 0 || this.processing) return;

    // Ограничение опережения: ждём, пока плеер догонит (макс 15 сек ожидания)
    const MAX_AHEAD_SEC = 5;
    if (this.getPlaybackTime) {
      const pbTime = this.getPlaybackTime();
      if (pbTime > 0 && this.currentTime > pbTime + MAX_AHEAD_SEC) {
        // Ждём максимум 15 секунд, потом продолжаем
        if (!this.pacingWaitStart) {
          this.pacingWaitStart = Date.now();
          console.log(`[LocalWhisper] Ожидание плеера: audio=${this.currentTime.toFixed(1)}с, playback=${pbTime.toFixed(1)}с`);
        }
        if (Date.now() - this.pacingWaitStart < 15000) {
          setTimeout(() => this.processAccumulatedPcm(), 1000);
          return;
        }
        console.log(`[LocalWhisper] Таймаут ожидания плеера, продолжаем`);
        this.pacingWaitStart = null;
      } else {
        this.pacingWaitStart = null;
      }
    }

    this.processing = true;

    // Берём не больше pcmChunkMax за раз, остальное оставляем в буфере
    const allPcm = Buffer.concat(this.pcmBuffer);
    let pcmData: Buffer;
    if (allPcm.length > this.pcmChunkMax) {
      pcmData = allPcm.subarray(0, this.pcmChunkMax);
      this.pcmBuffer = [allPcm.subarray(this.pcmChunkMax)];
      this.pcmBufferSize = this.pcmBuffer[0].length;
    } else {
      pcmData = allPcm;
      this.pcmBuffer = [];
      this.pcmBufferSize = 0;
    }

    try {
      // Сохраняем во временный файл
      const tempRawFile = path.join(os.tmpdir(), `whisper_${Date.now()}.raw`);
      fs.writeFileSync(tempRawFile, pcmData);

      console.log(`[LocalWhisper] Отправка на распознавание: ${pcmData.length} байт (${(pcmData.length / 64000).toFixed(1)}с)`);

      const resp = await this.sendCommand({
        cmd: 'transcribe',
        audio_file: tempRawFile,
        language: this.language,
        quality: 'balanced',
      });

      if (resp.text && resp.text.trim()) {
        const startTime = this.currentTime;
        const duration = pcmData.length / 64000;
        this.currentTime += duration;

        // Определяем пол говорящего по pitch PCM-данных
        const gender = this.detectGender(pcmData);

        console.log(
          `[LocalWhisper] Распознано за ${resp.processing_time_ms?.toFixed(0)}ms: "${resp.text.substring(0, 80)}"`
        );

        if (this.onSegmentCallback) {
          this.onSegmentCallback({
            text: resp.text,
            startTime,
            endTime: this.currentTime,
            gender,
            isFinal: true
          });
        }
      } else {
        console.log('[LocalWhisper] Пустой результат распознавания (тишина?)');
      }

      try { fs.unlinkSync(tempRawFile); } catch {}
    } catch (error) {
      console.error('[LocalWhisper] Ошибка транскрипции:', error);
    } finally {
      this.processing = false;

      // Если за время обработки накопился новый буфер — обработать
      if (this.pcmBufferSize >= this.pcmChunkThreshold) {
        this.processAccumulatedPcm();
      }
    }
  }

  /**
   * Определяет пол говорящего по частоте основного тона (pitch).
   * PCM формат: float32le, 16kHz, mono.
   * Мужской голос: 85-180 Hz, женский: 165-300 Hz.
   * Используем автокорреляцию на фрагменте ~1 секунда.
   */
  private detectGender(pcmData: Buffer): SpeakerGender {
    const sampleRate = 16000;
    const samples = new Float32Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 4);

    // Берём 1 секунду из середины
    const start = Math.floor(Math.max(0, (samples.length - sampleRate) / 2));
    const end = Math.min(samples.length, start + sampleRate);
    const segment = samples.slice(start, end);

    if (segment.length < 1600) return 'unknown'; // слишком мало данных

    // Автокорреляция для определения pitch
    const minLag = Math.floor(sampleRate / 300); // 300Hz max (high female)
    const maxLag = Math.floor(sampleRate / 75);  // 75Hz min (low male)

    let bestLag = 0;
    let bestCorr = -1;

    // Анализируем окно 20ms с шагом
    const windowSize = Math.floor(sampleRate * 0.03); // 30ms
    const numWindows = Math.floor(segment.length / windowSize) - 1;
    const pitches: number[] = [];

    for (let w = 0; w < Math.min(numWindows, 20); w++) {
      const wStart = w * windowSize;
      let bestWCorr = -1;
      let bestWLag = 0;

      for (let lag = minLag; lag <= maxLag && wStart + lag + windowSize < segment.length; lag++) {
        let corr = 0;
        let energy1 = 0;
        let energy2 = 0;

        for (let i = 0; i < windowSize; i++) {
          corr += segment[wStart + i] * segment[wStart + i + lag];
          energy1 += segment[wStart + i] * segment[wStart + i];
          energy2 += segment[wStart + i + lag] * segment[wStart + i + lag];
        }

        const norm = Math.sqrt(energy1 * energy2);
        if (norm > 0.001) {
          const normalizedCorr = corr / norm;
          if (normalizedCorr > bestWCorr) {
            bestWCorr = normalizedCorr;
            bestWLag = lag;
          }
        }
      }

      // Считаем только уверенные результаты (корреляция > 0.5)
      if (bestWCorr > 0.5 && bestWLag > 0) {
        pitches.push(sampleRate / bestWLag);
      }
    }

    if (pitches.length < 3) return 'unknown';

    // Медианный pitch
    pitches.sort((a, b) => a - b);
    const medianPitch = pitches[Math.floor(pitches.length / 2)];

    // Порог: < 165 Hz = мужской, > 165 Hz = женский
    const gender: SpeakerGender = medianPitch < 165 ? 'male' : 'female';
    console.log(`[LocalWhisper] Pitch: ${medianPitch.toFixed(0)}Hz → ${gender} (из ${pitches.length} окон)`);
    return gender;
  }

  async destroy(): Promise<void> {
    // Закрываем ffmpeg
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.stdin?.end(); } catch {}
      setTimeout(() => {
        this.ffmpegProcess?.kill();
        this.ffmpegProcess = null;
      }, 1000);
    }

    // Закрываем whisper worker
    if (this.workerProcess) {
      try {
        this.workerProcess.stdin?.write(JSON.stringify({ cmd: 'quit' }) + '\n');
      } catch {}
      setTimeout(() => {
        this.workerProcess?.kill();
        this.workerProcess = null;
      }, 2000);
    }
  }
}
