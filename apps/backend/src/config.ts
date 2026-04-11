import dotenv from 'dotenv';
import path from 'path';

// Загружаем переменные окружения
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface AppConfig {
  port: number;
  host: string;
  deepgramApiKey: string;
  openaiApiKey: string;
  libreTranslateUrl: string;
  ytdlpPath: string;
  ffmpegPath: string;
  pythonPath: string;
  defaultSttProvider: string;
  defaultTranslationProvider: string;
  defaultTtsProvider: string;
  /** URL локального CosyVoice сервера в WSL2 */
  cosyvoiceUrl: string;
  /** Bearer-токен для авторизации на CosyVoice сервере */
  cosyvoiceApiKey: string;
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  libreTranslateUrl: process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.com/translate',
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  pythonPath: process.env.PYTHON_PATH || '',
  defaultSttProvider: process.env.DEFAULT_STT_PROVIDER || 'local-whisper',
  defaultTranslationProvider: process.env.DEFAULT_TRANSLATION_PROVIDER || 'libre',
  defaultTtsProvider: process.env.DEFAULT_TTS_PROVIDER || 'edge-tts',
  cosyvoiceUrl: process.env.COSYVOICE_URL || 'http://localhost:8020',
  cosyvoiceApiKey: process.env.COSYVOICE_API_KEY || '',
};
