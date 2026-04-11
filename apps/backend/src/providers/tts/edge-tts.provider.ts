import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { TTSProvider, TTSOptions, SpeakerGender } from './tts.interface';

/**
 * Бесплатный TTS провайдер на основе Microsoft Edge TTS.
 * Использует Python пакет edge-tts (v7+) из локального venv.
 */
export class EdgeTTSProvider implements TTSProvider {
  readonly name = 'edge-tts';

  private voice = 'ru-RU-DmitryNeural';
  private language = 'ru';
  private pythonPath: string;

  // Голоса по языку и полу
  private static readonly voiceMap: Record<string, { male: string; female: string }> = {
    ru: { male: 'ru-RU-DmitryNeural', female: 'ru-RU-SvetlanaNeural' },
    en: { male: 'en-US-GuyNeural', female: 'en-US-JennyNeural' },
    es: { male: 'es-ES-AlvaroNeural', female: 'es-ES-ElviraNeural' },
    de: { male: 'de-DE-ConradNeural', female: 'de-DE-KatjaNeural' },
    fr: { male: 'fr-FR-HenriNeural', female: 'fr-FR-DeniseNeural' },
    zh: { male: 'zh-CN-YunxiNeural', female: 'zh-CN-XiaoxiaoNeural' },
    ja: { male: 'ja-JP-KeitaNeural', female: 'ja-JP-NanamiNeural' },
    ko: { male: 'ko-KR-InJoonNeural', female: 'ko-KR-SunHiNeural' },
  };

  constructor() {
    const localVenvPython = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe');
    this.pythonPath = fs.existsSync(localVenvPython) ? localVenvPython : 'python';
  }

  async initialize(options: TTSOptions): Promise<void> {
    this.language = options.language || 'ru';
    const voices = EdgeTTSProvider.voiceMap[this.language];
    this.voice = options.voice || voices?.male || 'en-US-GuyNeural';
    console.log(`[EdgeTTS] Инициализирован, голос: ${this.voice}, язык: ${this.language}`);
  }

  private getVoiceForGender(gender: SpeakerGender): string {
    const voices = EdgeTTSProvider.voiceMap[this.language];
    if (!voices) return this.voice;
    if (gender === 'female') return voices.female;
    return voices.male;
  }

  async synthesize(text: string, gender?: SpeakerGender): Promise<Buffer> {
    if (!text || text.trim().length === 0) {
      return Buffer.alloc(0);
    }

    // Пишем текст во временный файл (избегаем проблем с кавычками в командной строке)
    const textFile = path.join(os.tmpdir(), `tts_text_${Date.now()}.txt`);
    const audioFile = path.join(os.tmpdir(), `tts_audio_${Date.now()}.mp3`);

    const voice = gender ? this.getVoiceForGender(gender) : this.voice;
    fs.writeFileSync(textFile, text, 'utf-8');

    try {
      await this.runPythonTts(textFile, audioFile, voice);

      if (fs.existsSync(audioFile)) {
        const audioData = fs.readFileSync(audioFile);
        console.log(`[EdgeTTS] Синтезировано ${audioData.length} байт для: "${text.substring(0, 50)}..."`);
        return audioData;
      }

      console.warn('[EdgeTTS] Аудиофайл не создан');
      return Buffer.alloc(0);
    } catch (error) {
      console.error('[EdgeTTS] Ошибка синтеза:', error);
      return Buffer.alloc(0);
    } finally {
      try { fs.unlinkSync(textFile); } catch {}
      try { fs.unlinkSync(audioFile); } catch {}
    }
  }

  private runPythonTts(textFile: string, audioFile: string, voice?: string): Promise<void> {
    const useVoice = voice || this.voice;
    const TIMEOUT_MS = 20000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const script = `
import asyncio, sys, edge_tts

async def main():
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        text = f.read()
    comm = edge_tts.Communicate(text, sys.argv[2])
    await comm.save(sys.argv[3])

asyncio.run(main())
`;

      const proc = spawn(this.pythonPath, ['-c', script, textFile, useVoice, audioFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

      // Принудительный таймаут — убиваем процесс если завис
      const timer = setTimeout(() => {
        try { proc.kill(); } catch {}
        settle(() => reject(new Error(`[EdgeTTS] Таймаут синтеза (${TIMEOUT_MS / 1000}с)`)));
      }, TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          settle(() => resolve());
        } else {
          settle(() => reject(new Error(`Python edge-tts exited with code ${code}: ${stderr.substring(0, 200)}`)));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        settle(() => reject(new Error(`Python spawn error: ${err.message}`)));
      });
    });
  }

  async destroy(): Promise<void> {
    console.log('[EdgeTTS] Завершён');
  }
}
