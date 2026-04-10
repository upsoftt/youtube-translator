import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import path from 'path';
import os from 'os';
import { STTProvider, STTProviderOptions, STTSegment } from './stt.interface';

/**
 * Бесплатный STT провайдер на основе OpenAI Whisper.
 * Использует whisper CLI через child_process.
 * Обрабатывает аудио чанками — накапливает буфер и периодически отправляет на распознавание.
 */
export class WhisperProvider implements STTProvider {
  readonly name = 'whisper';

  private buffer: Buffer[] = [];
  private bufferSize = 0;
  private readonly chunkThreshold = 64000; // ~4 сек аудио при 16kHz mono
  private currentTime = 0;
  private language = 'en';
  private processing = false;
  private tempDir: string = '';

  async initialize(options: STTProviderOptions): Promise<void> {
    this.language = options.language || 'en';
    this.tempDir = mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    this.buffer = [];
    this.bufferSize = 0;
    this.currentTime = 0;
    console.log(`[WhisperProvider] Инициализирован, язык: ${this.language}`);
  }

  async processChunk(audioChunk: Buffer, onSegment: (segment: STTSegment) => void): Promise<void> {
    this.buffer.push(audioChunk);
    this.bufferSize += audioChunk.length;

    // Накапливаем буфер до порога, затем отправляем на распознавание
    if (this.bufferSize >= this.chunkThreshold && !this.processing) {
      await this.processBuffer(onSegment);
    }
  }

  private async processBuffer(onSegment: (segment: STTSegment) => void): Promise<void> {
    if (this.buffer.length === 0) return;

    this.processing = true;
    const audioData = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferSize = 0;

    const startTime = this.currentTime;
    // Примерная длительность чанка (MP3 ~128kbps = 16KB/сек)
    const estimatedDuration = audioData.length / 16000;
    this.currentTime += estimatedDuration;

    try {
      const text = await this.transcribeWithWhisper(audioData);
      if (text && text.trim().length > 0) {
        onSegment({
          text: text.trim(),
          startTime,
          endTime: this.currentTime,
          isFinal: true,
        });
      }
    } catch (error) {
      console.error('[WhisperProvider] Ошибка распознавания:', error);
    } finally {
      this.processing = false;
    }
  }

  private transcribeWithWhisper(audioData: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const tempFile = path.join(this.tempDir, `chunk_${Date.now()}.mp3`);
      writeFileSync(tempFile, audioData);

      // Пробуем использовать whisper CLI
      const whisperProcess: ChildProcess = spawn('whisper', [
        tempFile,
        '--model', 'base',
        '--language', this.language,
        '--output_format', 'txt',
        '--output_dir', this.tempDir,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let output = '';
      let errorOutput = '';

      whisperProcess.stdout?.on('data', (data) => {
        output += data.toString();
      });

      whisperProcess.stderr?.on('data', (data) => {
        errorOutput += data.toString();
      });

      whisperProcess.on('close', (code) => {
        // Очистка временного файла
        try { unlinkSync(tempFile); } catch { /* игнорируем */ }
        try {
          const txtFile = tempFile.replace('.mp3', '.txt');
          const fs = require('fs');
          if (fs.existsSync(txtFile)) {
            const text = fs.readFileSync(txtFile, 'utf-8');
            unlinkSync(txtFile);
            resolve(text);
            return;
          }
        } catch { /* игнорируем */ }

        if (code === 0) {
          resolve(output.trim());
        } else {
          // Если whisper CLI не установлен, возвращаем пустую строку
          console.warn('[WhisperProvider] Whisper CLI недоступен, текст не распознан');
          resolve('');
        }
      });

      whisperProcess.on('error', () => {
        try { unlinkSync(tempFile); } catch { /* игнорируем */ }
        console.warn('[WhisperProvider] Whisper CLI не найден в системе');
        resolve('');
      });
    });
  }

  async destroy(): Promise<void> {
    // Обрабатываем оставшийся буфер
    if (this.buffer.length > 0) {
      await this.processBuffer(() => {});
    }
    // Очистка temp директории
    try {
      const fs = require('fs');
      if (this.tempDir && fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch { /* игнорируем */ }
    console.log('[WhisperProvider] Завершён');
  }
}
