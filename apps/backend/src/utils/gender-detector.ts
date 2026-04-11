import { spawn, ChildProcess } from 'child_process';
import { SpeakerGender } from '../providers/stt/stt.interface';
import { config } from '../config';

/**
 * Определяет пол говорящего по pitch аудио.
 *
 * Запускает постоянный ffmpeg-процесс для декодирования MP3→PCM.
 * Накапливает PCM-буфер и по запросу анализирует pitch
 * через автокорреляцию (< 165Hz = мужской, > 165Hz = женский).
 */
export class GenderDetector {
  private ffmpegProcess: ChildProcess | null = null;
  private pcmBuffer: Buffer[] = [];
  private pcmBufferSize = 0;
  private lastGender: SpeakerGender = 'unknown';
  private readonly maxBufferSize = 64000; // ~1 сек при 16kHz float32 mono

  /**
   * Запускает ffmpeg для конвертации MP3→PCM
   */
  start(): void {
    this.ffmpegProcess = spawn(config.ffmpegPath, [
      '-i', 'pipe:0',
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.ffmpegProcess.stdout?.on('data', (chunk: Buffer) => {
      this.pcmBuffer.push(chunk);
      this.pcmBufferSize += chunk.length;

      // Анализируем при накоплении ~1 сек PCM
      if (this.pcmBufferSize >= this.maxBufferSize) {
        const pcmData = Buffer.concat(this.pcmBuffer);
        this.lastGender = this.detectGender(pcmData);
        // Оставляем только последние 0.5 сек для перекрытия
        const keepSize = 32000;
        if (pcmData.length > keepSize) {
          this.pcmBuffer = [pcmData.slice(pcmData.length - keepSize)];
          this.pcmBufferSize = keepSize;
        }
      }
    });

    this.ffmpegProcess.stderr?.on('data', () => {}); // подавляем stderr
    this.ffmpegProcess.stdout?.on('error', () => {});
    this.ffmpegProcess.stderr?.on('error', () => {});
    this.ffmpegProcess.on('error', () => {});
  }

  /**
   * Подаёт MP3-чанк на декодирование
   */
  feedAudio(mp3Chunk: Buffer): void {
    if (this.ffmpegProcess?.stdin?.writable) {
      try {
        this.ffmpegProcess.stdin.write(mp3Chunk);
      } catch {}
    }
  }

  /**
   * Возвращает последний определённый пол
   */
  getCurrentGender(): SpeakerGender {
    return this.lastGender;
  }

  private detectGender(pcmData: Buffer): SpeakerGender {
    return detectGenderFromPCM(pcmData, this.lastGender);
  }

  /**
   * Останавливает ffmpeg
   */
  destroy(): void {
    if (this.ffmpegProcess) {
      try { this.ffmpegProcess.stdin?.end(); } catch {}
      setTimeout(() => {
        this.ffmpegProcess?.kill();
        this.ffmpegProcess = null;
      }, 500);
    }
    this.pcmBuffer = [];
    this.pcmBufferSize = 0;
  }
}

/**
 * Определяет пол говорящего по PCM-данным через автокорреляцию pitch.
 * PCM формат: float32le, 16kHz, mono.
 * Мужской голос: < 165 Hz, женский: >= 165 Hz.
 *
 * @param pcmData - буфер PCM f32le 16kHz mono
 * @param fallback - значение по умолчанию при недостатке данных
 */
export function detectGenderFromPCM(pcmData: Buffer, fallback: SpeakerGender = 'unknown'): SpeakerGender {
  const sampleRate = 16000;
  const samples = new Float32Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 4);

  // Берём 1 секунду из середины
  const start = Math.floor(Math.max(0, (samples.length - sampleRate) / 2));
  const end = Math.min(samples.length, start + sampleRate);
  const segment = samples.slice(start, end);

  if (segment.length < 1600) return fallback;

  const minLag = Math.floor(sampleRate / 300); // 300Hz max
  const maxLag = Math.floor(sampleRate / 75);  // 75Hz min
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

    if (bestWCorr > 0.5 && bestWLag > 0) {
      pitches.push(sampleRate / bestWLag);
    }
  }

  if (pitches.length < 3) return fallback;

  pitches.sort((a, b) => a - b);
  const medianPitch = pitches[Math.floor(pitches.length / 2)];

  const gender: SpeakerGender = medianPitch < 165 ? 'male' : 'female';
  console.log(`[GenderDetector] Pitch: ${medianPitch.toFixed(0)}Hz → ${gender}`);
  return gender;
}
