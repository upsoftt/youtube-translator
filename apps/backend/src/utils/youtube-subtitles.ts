import { spawn } from 'child_process';
import { config } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SubtitleSegment {
  text: string;
  startTime: number; // секунды
  duration: number;  // секунды
}

/**
 * Загружает автоматические субтитры YouTube через yt-dlp.
 * Возвращает массив сегментов с таймингами или null если субтитры недоступны.
 */
export async function fetchYouTubeSubtitles(
  youtubeUrl: string,
  language = 'en',
): Promise<SubtitleSegment[] | null> {
  const tmpDir = os.tmpdir();
  const tmpBase = path.join(tmpDir, `yt-subs-${Date.now()}`);

  try {
    // Пробуем скачать субтитры (авто + загруженные)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(config.ytdlpPath, [
        '--write-auto-sub',
        '--write-sub',
        '--sub-lang', language,
        '--sub-format', 'json3',
        '--skip-download',
        '-o', tmpBase,
        youtubeUrl,
      ], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp subtitles exit ${code}: ${stderr.slice(0, 200)}`));
      });

      proc.on('error', reject);

      // Таймаут 15с
      setTimeout(() => {
        proc.kill();
        reject(new Error('yt-dlp subtitles timeout'));
      }, 15000);
    });

    // Ищем файл с субтитрами
    const candidates = [
      `${tmpBase}.${language}.json3`,
    ];

    // Также проверяем варианты с суффиксами
    const dir = path.dirname(tmpBase);
    const base = path.basename(tmpBase);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.json3'));

    let subtitleFile: string | null = null;
    for (const f of files) {
      const fullPath = path.join(dir, f);
      if (fs.existsSync(fullPath)) {
        subtitleFile = fullPath;
        break;
      }
    }

    if (!subtitleFile) {
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          subtitleFile = c;
          break;
        }
      }
    }

    if (!subtitleFile) {
      console.log('[Subtitles] Файл субтитров не найден');
      return null;
    }

    // Парсим json3 формат YouTube
    const raw = fs.readFileSync(subtitleFile, 'utf-8');
    const json = JSON.parse(raw);

    // Удаляем временный файл
    try { fs.unlinkSync(subtitleFile); } catch {}

    return parseJson3Subtitles(json);
  } catch (error) {
    console.log(`[Subtitles] Не удалось получить субтитры: ${error instanceof Error ? error.message : error}`);
    // Чистим временные файлы
    try {
      const dir = path.dirname(tmpBase);
      const base = path.basename(tmpBase);
      const files = fs.readdirSync(dir).filter(f => f.startsWith(base));
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    } catch {}
    return null;
  }
}

/**
 * Парсит YouTube json3 формат субтитров.
 * Формат: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
 */
function parseJson3Subtitles(json: any): SubtitleSegment[] {
  if (!json?.events) return [];

  const segments: SubtitleSegment[] = [];

  for (const event of json.events) {
    if (!event.segs || !event.tStartMs) continue;

    const text = event.segs
      .map((s: any) => s.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();

    if (!text || text === '\n') continue;

    const startTime = event.tStartMs / 1000;
    const duration = (event.dDurationMs || 3000) / 1000;

    segments.push({ text, startTime, duration });
  }

  // Объединяем короткие сегменты (< 2 слов) с соседними
  const merged: SubtitleSegment[] = [];
  let buffer = '';
  let bufferStart = 0;
  let bufferContentDuration = 0;

  for (const seg of segments) {
    if (buffer.length === 0) {
      buffer = seg.text;
      bufferStart = seg.startTime;
      bufferContentDuration = seg.duration;
    } else {
      buffer += ' ' + seg.text;
      bufferContentDuration += seg.duration;
    }

    // Flush если достаточно длинный или это конец предложения
    const wordCount = buffer.split(/\s+/).length;
    const endsWithPunctuation = /[.!?]$/.test(buffer);

    if (wordCount >= 8 || endsWithPunctuation || bufferContentDuration > 5) {
      merged.push({
        text: buffer.trim(),
        startTime: bufferStart,
        duration: bufferContentDuration,
      });
      buffer = '';
      bufferContentDuration = 0;
    }
  }

  if (buffer.trim()) {
    merged.push({
      text: buffer.trim(),
      startTime: bufferStart,
      duration: bufferContentDuration,
    });
  }

  console.log(`[Subtitles] Получено ${segments.length} сегментов → объединено в ${merged.length}`);
  return merged;
}
