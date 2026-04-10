import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { config } from '../config';

/**
 * YouTube стример — извлекает аудио в реальном времени.
 *
 * Подход для стриминга с минимальной задержкой:
 * 1. yt-dlp -g → получаем прямой URL аудиопотока
 * 2. ffmpeg читает этот URL и выдаёт mp3 чанки в stdout в реальном времени
 */
export class YouTubeStreamer extends EventEmitter {
  private process: ChildProcess | null = null;
  private readonly ytdlpPath: string;

  constructor() {
    super();
    this.ytdlpPath = config.ytdlpPath;
  }

  /**
   * Получает прямой URL видео для воспроизведения на клиенте
   */
  async getVideoUrl(youtubeUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ytdlpPath, [
        '-g',
        '-f', 'best',
        youtubeUrl,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { errorOutput += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          const urls = output.trim().split('\n');
          resolve(urls[0]);
        } else {
          reject(new Error(`yt-dlp не удалось получить URL видео: ${errorOutput}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Не удалось запустить yt-dlp: ${err.message}`));
      });
    });
  }

  /**
   * Получает прямой URL аудио-потока
   */
  private async getAudioUrl(youtubeUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.ytdlpPath, [
        '-g',
        '-f', 'bestaudio',
        youtubeUrl,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { errorOutput += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0 && output.trim()) {
          resolve(output.trim().split('\n')[0]);
        } else {
          reject(new Error(`yt-dlp audio URL failed: ${errorOutput}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });
  }

  /**
   * Запускает стриминг аудио из YouTube видео.
   * Двухшаговый подход: yt-dlp -g → ffmpeg → stdout (реальный стриминг).
   */
  private cachedAudioUrl: string | null = null;
  private cachedYoutubeUrl: string | null = null;

  /**
   * Запускает стриминг аудио. seekSec — позиция старта в секундах.
   */
  async startAudioStream(youtubeUrl: string, seekSec = 0): Promise<void> {
    if (this.process) {
      await this.stopStream();
    }

    // Кэшируем аудио URL чтобы не запрашивать при каждом seek
    if (!this.cachedAudioUrl || this.cachedYoutubeUrl !== youtubeUrl) {
      try {
        this.cachedAudioUrl = await this.getAudioUrl(youtubeUrl);
        this.cachedYoutubeUrl = youtubeUrl;
        console.log('[YouTubeStreamer] Аудио URL получен и закэширован');
      } catch (error) {
        console.error('[YouTubeStreamer] Ошибка получения аудио URL:', error);
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    const args: string[] = [];

    // -ss перед -i = быстрый seek (input seeking)
    if (seekSec > 0) {
      args.push('-ss', seekSec.toString());
    }

    args.push(
      '-i', this.cachedAudioUrl,
      '-vn',
      '-acodec', 'libmp3lame',
      '-ab', '64k',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'mp3',
      '-flush_packets', '1',
      'pipe:1',
    );

    this.process = spawn(config.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`[YouTubeStreamer] ffmpeg запущен @ ${seekSec.toFixed(1)}s`);

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.emit('data', chunk);
    });

    this.process.stdout?.on('error', () => {});
    this.process.stderr?.on('error', () => {});

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        // Пропускаем стандартный вывод ffmpeg (time=, size= и т.д.)
        if (!msg.includes('time=') && !msg.includes('size=')) {
          console.error('[YouTubeStreamer] ffmpeg:', msg.trim());
        }
      }
    });

    this.process.on('close', (code) => {
      console.log(`[YouTubeStreamer] ffmpeg завершён, код: ${code}`);
      this.emit('end');
      this.process = null;
    });

    this.process.on('error', (err) => {
      console.error('[YouTubeStreamer] Ошибка процесса:', err.message);
      this.emit('error', err);
      this.process = null;
    });

    console.log('[YouTubeStreamer] Realtime аудио-стрим запущен');
  }

  /**
   * Останавливает текущий стрим. Ждёт завершения процесса.
   * SIGTERM → 2с → SIGKILL если не завершился.
   */
  async stopStream(): Promise<void> {
    const proc = this.process;
    if (!proc) return;

    const pid = proc.pid;
    this.process = null;

    // Очищаем listeners перед kill чтобы не получать stale data events
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners();

    // Убиваем процесс и ждём завершения
    await new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      proc.on('close', () => {
        console.log(`[YouTubeStreamer] ffmpeg killed (PID: ${pid})`);
        done();
      });

      proc.on('error', done);

      // SIGTERM
      try { proc.kill('SIGTERM'); } catch {}

      // Fallback: SIGKILL через 2с если не завершился
      setTimeout(() => {
        if (!resolved) {
          try { proc.kill('SIGKILL'); } catch {}
          console.warn(`[YouTubeStreamer] ffmpeg SIGKILL (PID: ${pid})`);
          // Если close не сработает, всё равно разблокируем
          setTimeout(done, 500);
        }
      }, 2000);
    });
  }
}
