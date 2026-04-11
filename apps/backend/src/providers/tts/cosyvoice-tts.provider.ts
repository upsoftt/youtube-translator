import { TTSProvider, TTSOptions, SpeakerGender } from './tts.interface';

/**
 * TTS провайдер на основе локального CosyVoice3 сервера (WSL2).
 *
 * Поддерживает zero-shot клонирование голоса:
 * при наличии referenceAudio в TTSOptions — передаёт его серверу
 * как эталонный образец и синтезирует голосом оригинального спикера.
 *
 * Сервер должен быть запущен в WSL2 и слушать на заданном URL.
 * Совместим с OpenAI /v1/audio/speech API.
 */
export class CosyVoiceTTSProvider implements TTSProvider {
  readonly name = 'CosyVoice TTS';

  private serverUrl = 'http://localhost:8020';
  private apiKey = '';
  private language = 'ru';
  private referenceAudioBase64: string | null = null;

  async initialize(options: TTSOptions): Promise<void> {
    this.serverUrl = (options.serverUrl || 'http://localhost:8020').replace(/\/$/, '');
    this.apiKey    = options.apiKey || '';
    this.language  = options.language || 'ru';

    if (!this.apiKey) {
      throw new Error('[CosyVoiceTTS] API ключ не указан');
    }

    // Сохраняем референсное аудио в base64 (чтобы не конвертировать при каждом запросе)
    if (options.referenceAudio && options.referenceAudio.length > 0) {
      this.referenceAudioBase64 = options.referenceAudio.toString('base64');
      console.log(`[CosyVoiceTTS] Референсное аудио загружено: ${options.referenceAudio.length} байт`);
    }

    // Проверяем доступность сервера
    await this.healthCheck();
    console.log(`[CosyVoiceTTS] Инициализирован: ${this.serverUrl}, язык: ${this.language}, ` +
      `клонирование голоса: ${this.referenceAudioBase64 ? 'ДА' : 'НЕТ'}`);
  }

  async synthesize(text: string, _gender?: SpeakerGender): Promise<Buffer> {
    if (!text.trim()) return Buffer.alloc(0);

    try {
      const body: Record<string, unknown> = {
        model:           'cosyvoice3',
        input:           text,
        language:        this.language,
        response_format: 'mp3',
      };

      // Если есть референсное аудио — передаём для клонирования голоса
      if (this.referenceAudioBase64) {
        body.reference_audio = this.referenceAudioBase64;
        body.voice_clone     = true;
      }

      const response = await fetch(`${this.serverUrl}/v1/audio/speech`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.error(`[CosyVoiceTTS] Ошибка сервера ${response.status}: ${errText.slice(0, 200)}`);
        return Buffer.alloc(0);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`[CosyVoiceTTS] Синтезировано ${buffer.length} байт: "${text.substring(0, 50)}"`);
      return buffer;

    } catch (error) {
      console.error('[CosyVoiceTTS] Ошибка синтеза:', error);
      return Buffer.alloc(0);
    }
  }

  async destroy(): Promise<void> {
    this.referenceAudioBase64 = null;
  }

  /** Проверяет доступность CosyVoice сервера */
  async healthCheck(): Promise<void> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    try {
      const response = await fetch(`${this.serverUrl}/health`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: ac.signal,
      });
      if (!response.ok) {
        throw new Error(`CosyVoice сервер недоступен: HTTP ${response.status}`);
      }
      const data = await response.json() as Record<string, unknown>;
      console.log(`[CosyVoiceTTS] Сервер: ${JSON.stringify(data)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
